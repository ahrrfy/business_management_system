import mysql from "mysql2/promise";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import * as database from "../../db";
import * as productGuards from "../catalog/productUpdateGuards";
import { updateProductWithVariants } from "../productEditService";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import {
  createStockTransfer,
  cancelStockTransfer,
  receiveStockTransfer,
} from "../transferService";
import {
  lockEconomicInventoryScope,
  readEconomicOwnedPositions,
} from "../inventory/economicOwnership";
// @ts-expect-error Raw mysql deployment ESM deliberately has no runtime TS dependency.
import * as activation from "../../../scripts/lib/inventory-projection-activation.mjs";
const { activateInventoryProjection, deriveInventoryTransitProjection, assertInventoryTransitParity, invalidateInventoryProjection } = activation;
const db = () => getDb()!;
const actor = { userId: 1, role: "admin", branchId: 1 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Sales", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "projection-race",
      name: "Owner",
      role: "admin",
      branchId: 1,
    });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
      { id: 3, name: "Bundle", isBundle: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "race-1", costPrice: "100" },
      { id: 2, productId: 2, sku: "race-2", costPrice: "200" },
      { id: 3, productId: 3, sku: "race-bundle" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 10 },
      { variantId: 2, branchId: 1, quantity: 10 },
    ]);
  await db()
    .insert(s.bundleComponents)
    .values([
      { bundleVariantId: 3, componentVariantId: 1, componentBaseQuantity: 2 },
      { bundleVariantId: 3, componentVariantId: 2, componentBaseQuantity: 1 },
    ]);
});
const dispatch = (variantId = 1, baseQuantity = 5) =>
  withTx((tx) =>
    createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId, baseQuantity }],
      createdBy: 1,
    }),
  );

it("does not block unrelated existing variant FIRST dispatch while scope is held", async () => {
  await withTx(async (tx) => {
    await lockEconomicInventoryScope(tx, [1]);
    const result = await dispatch(2);
    expect(result.transferId).toBeGreaterThan(0);
  });
});

it("held native receive does not next-gap block unrelated FIRST transfer inserts", async () => {
  const sent = await dispatch(1);
  const [line] = await db().select().from(s.stockTransferLines).where(eq(s.stockTransferLines.transferId, sent.transferId));
  await withTx(async tx => {
    await receiveStockTransfer(tx, { transferId: sent.transferId, actor, lines: [{ lineId: line.id, quantityReceived: 5 }] });
    const unrelated = await dispatch(2);
    expect(unrelated.transferId).toBeGreaterThan(sent.transferId);
  });
});

it("actual product editor and helper complete without product/variant ABBA", async () => {
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "Unit", conversionFactor: "1", isBaseUnit: true });
  const productHeld = deferred(), releaseEditor = deferred(), helperRequestsProduct = deferred();
  const bounded = async <T,>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("product/scope barrier timeout")), 6000); })]); }
    finally { clearTimeout(timer); }
  };
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL!, connectionLimit: 1 });
  const queries: string[] = [];
  const helperDb = drizzle(pool, { schema: s, mode: "default", logger: { logQuery(query) { queries.push(query); if (query.includes("`products`") && /for share/i.test(query)) helperRequestsProduct.resolve(); } } });
  const originalLoad = productGuards.loadProductForUpdateOrThrow;
  const spy = vi.spyOn(productGuards, "loadProductForUpdateOrThrow").mockImplementationOnce(async (tx, id) => {
    await tx.execute(sql`SET SESSION innodb_lock_wait_timeout=4`);
    const product = await originalLoad(tx, id);
    productHeld.resolve(); await bounded(releaseEditor.promise); return product;
  });
  let dbSpy: ReturnType<typeof vi.spyOn> | undefined;
  const tasks: Promise<unknown>[] = [];
  try {
    await pool.query("SET SESSION innodb_lock_wait_timeout=4");
    const editor = updateProductWithVariants({ productId: 1, name: "One edited", unitTemplate: [{ unitName: "Unit", conversionFactor: "1", isBaseUnit: true, prices: [] }], variants: [{ id: 1, sku: "race-1", costPrice: "100", unitBarcodes: {} }] }, actor);
    tasks.push(editor); const editOutcome = Promise.allSettled([editor]);
    await bounded(productHeld.promise);
    dbSpy = vi.spyOn(database, "getDb").mockReturnValue(helperDb);
    const helper = withTx(tx => lockEconomicInventoryScope(tx, [1]));
    tasks.push(helper); const helperOutcome = Promise.allSettled([helper]);
    await bounded(helperRequestsProduct.promise); releaseEditor.resolve();
    const outcomes = (await bounded(Promise.all([editOutcome, helperOutcome]))).flat();
    expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(queries.find(query => query.includes("`products`") && /for share/i.test(query))).not.toContain("`productVariants`");
  } finally { releaseEditor.resolve(); dbSpy?.mockRestore(); spy.mockRestore(); await Promise.allSettled(tasks); await pool.end(); }
});

it("uses current shelf/transit/cost after deliberately old RR snapshot and mutex wait", async () => {
  const snapshotTaken = deferred(),
    continueRead = deferred(),
    ownerLocked = deferred(),
    releaseOwner = deferred();
  const reader = withTx(async (tx) => {
    await tx.select().from(s.productVariants); // establish old RR snapshot
    snapshotTaken.resolve();
    await continueRead.promise;
    const scope = await lockEconomicInventoryScope(tx, [1]);
    const result = await readEconomicOwnedPositions(tx, scope, 1);
    expect(result.variant.costPrice).toBe("150.00");
    expect(result.positions[0]).toMatchObject({
      shelfQuantity: 5,
      inTransitQuantity: 5,
      ownedQuantity: 10,
    });
  });
  await snapshotTaken.promise;
  const owner = withTx(async (tx) => {
    await createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: 5 }],
      createdBy: 1,
    });
    await tx
      .update(s.productVariants)
      .set({ costPrice: "150.00" })
      .where(eq(s.productVariants.id, 1));
    ownerLocked.resolve();
    await releaseOwner.promise;
  });
  await ownerLocked.promise;
  continueRead.resolve();
  await new Promise((r) => setTimeout(r, 100));
  releaseOwner.resolve();
  await Promise.all([owner, reader]);
});

it("serializes native receive/cancel on one saved closure without double settlement", async () => {
  const sent = await dispatch();
  const [line] = await db()
    .select()
    .from(s.stockTransferLines)
    .where(eq(s.stockTransferLines.transferId, sent.transferId));
  const result = await Promise.allSettled([
    withTx((tx) =>
      receiveStockTransfer(tx, {
        transferId: sent.transferId,
        actor,
        lines: [{ lineId: line.id, quantityReceived: 5 }],
      }),
    ),
    withTx((tx) =>
      cancelStockTransfer(tx, { transferId: sent.transferId, actor }),
    ),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const [variant] = await db()
    .select()
    .from(s.productVariants)
    .where(eq(s.productVariants.id, 1));
  expect(variant.transitBaseBySourceBranch).toEqual({});
  expect(
    (await db().select().from(s.inventoryMovements)).filter(
      (m) => m.movementType === "TRANSFER_IN",
    ),
  ).toHaveLength(1);
});

it("derives saved recipe, validates all-zero parity and backfills atomically while A holds company gate", async () => {
  const closed = await dispatch(2, 1);
  await withTx((tx) =>
    cancelStockTransfer(tx, { transferId: closed.transferId, actor }),
  );
  await dispatch(3, 2);
  await db().delete(s.bundleComponents);
  await db()
    .insert(s.bundleComponents)
    .values({
      bundleVariantId: 3,
      componentVariantId: 2,
      componentBaseQuantity: 9,
    });
  const a = await mysql.createConnection(process.env.DATABASE_URL!);
  const b = await mysql.createConnection(process.env.DATABASE_URL!);
  try {
    await db().update(s.inventoryProjectionState).set({ readyVersion: 0 });
    await db()
      .update(s.productVariants)
      .set({ transitBaseBySourceBranch: null });
    await a.beginTransaction();
    await a.query("SELECT id FROM monthCloseSequence WHERE id=1 FOR UPDATE");
    const [[identity]] = await b.query<mysql.RowDataPacket[]>(
      "SELECT DATABASE() AS db,@@server_uuid AS uuid",
    );
    let checks = 0;
    const options = {
      expectedDatabase: identity.db,
      expectedServerUuid: identity.uuid,
      commit: "a".repeat(40),
      fence: {
        async assertQuiescentAndLocked() {
          await a.query("SELECT 1");
          checks++;
        },
      },
    };
    const derived = await deriveInventoryTransitProjection(b);
    expect(derived.projection.get(1)).toEqual({ "1": "4" });
    expect(derived.projection.get(2)).toEqual({ "1": "2" });
    expect(derived.projection.get(3)).toEqual({});
    expect((await activateInventoryProjection(b, options)).variants).toBe(3);
    expect(checks).toBe(2);
    expect((await assertInventoryTransitParity(b)).sourcePositions).toBe(2);
    await b.query(
      "UPDATE productVariants SET transitBaseBySourceBranch=JSON_OBJECT() WHERE id=1",
    );
    await expect(assertInventoryTransitParity(b)).rejects.toThrow(
      /parity mismatch/,
    );
    await invalidateInventoryProjection(b, options);
    expect(
      (
        await b.query<mysql.RowDataPacket[]>(
          "SELECT readyVersion FROM inventoryProjectionState",
        )
      )[0][0].readyVersion,
    ).toBe(0);
  } finally {
    await a.rollback();
    await a.end();
    await b.end();
  }
});

it("refuses inconsistent old saved evidence without writing a projection or READY", async () => {
  const sent = await dispatch(3, 1);
  const [line] = await db()
    .select()
    .from(s.stockTransferLines)
    .where(eq(s.stockTransferLines.transferId, sent.transferId));
  await db()
    .delete(s.stockTransferLineBundleComponents)
    .where(eq(s.stockTransferLineBundleComponents.transferLineId, line.id));
  await db().update(s.inventoryProjectionState).set({ readyVersion: 0 });
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  try {
    await expect(deriveInventoryTransitProjection(conn)).rejects.toThrow(
      /missing saved/,
    );
  } finally {
    await conn.end();
  }
  expect(
    (await db().select().from(s.inventoryProjectionState))[0].readyVersion,
  ).toBe(0);
  expect(
    (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0].transitBaseBySourceBranch,
  ).toEqual({ "1": "2" });
});

it("rolls back every partial backfill write and keeps UNREADY on injected B failure", async () => {
  await dispatch();
  await db().update(s.inventoryProjectionState).set({ readyVersion: 0 });
  await db().update(s.productVariants).set({ transitBaseBySourceBranch: null });
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  try {
    const [[identity]] = await conn.query<mysql.RowDataPacket[]>("SELECT DATABASE() AS db,@@server_uuid AS uuid");
    const realQuery = conn.query.bind(conn);
    let updates = 0;
    const wrapped = { beginTransaction: () => conn.beginTransaction(), commit: () => conn.commit(), rollback: () => conn.rollback(), async query(query: string, args?: unknown[]) { if (query.startsWith("UPDATE productVariants") && ++updates === 2) throw new Error("injected B update fault"); return realQuery(query, args); } };
    await expect(activateInventoryProjection(wrapped, { expectedDatabase: identity.db, expectedServerUuid: identity.uuid, commit: "a".repeat(40), fence: { async assertQuiescentAndLocked() {} } })).rejects.toThrow("injected B update fault");
    expect(updates).toBe(2);
    expect((await db().select().from(s.productVariants)).map(v => v.transitBaseBySourceBranch)).toEqual([null, null, null]);
    expect((await db().select().from(s.inventoryProjectionState))[0].readyVersion).toBe(0);
  } finally { await conn.end(); }
});

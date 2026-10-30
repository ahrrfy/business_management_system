import { and, eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import {
  ensureBranchStockRows,
  lockInventoryVariants,
} from "../inventory/stockLock";
import { applyMovement, setStock } from "../inventoryService";
import { truncateAllTables } from "./__testUtils__";

const db = () => getDb()!;
beforeEach(async () => {
  await truncateAllTables();
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Stock test", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "STOCK-1" },
      { id: 2, productId: 2, sku: "STOCK-2" },
    ]);
});

async function heldEnsure(existing: number[]) {
  if (existing.length)
    await db()
      .insert(s.branchStock)
      .values(
        existing.map((variantId) => ({ variantId, branchId: 1, quantity: 7 })),
      );
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    release.resolve();
  }, 4000);
  const first = withTx(async (tx) => {
    await lockInventoryVariants(tx, [1]);
    await ensureBranchStockRows(tx, [1], 1);
    held.resolve();
    await release.promise;
  });
  const outcome = Promise.allSettled([first]);
  try {
    await Promise.race([held.promise, first]);
    await withTx(async (tx) => {
      await lockInventoryVariants(tx, [2]);
      await ensureBranchStockRows(tx, [2], 1);
    });
    expect(timedOut).toBe(false);
    const rows = await db()
      .select()
      .from(s.branchStock)
      .where(eq(s.branchStock.variantId, 2));
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(existing.includes(2) ? 7 : 0);
  } finally {
    clearTimeout(timer);
    release.resolve();
    expect((await outcome)[0].status).toBe("fulfilled");
  }
}

it("clusters natural stock identities and preserves unique generated IDs without covering ID scans", async () => {
  const [rows] = await db().execute(sql`
    SELECT INDEX_NAME AS indexName, COLUMN_NAME AS columnName,
      NON_UNIQUE AS nonUnique, IS_VISIBLE AS isVisible
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock'
      AND INDEX_NAME IN ('PRIMARY', 'uq_stock_id')
    ORDER BY INDEX_NAME, SEQ_IN_INDEX
  `);
  expect(rows).toEqual([
    { indexName: "PRIMARY", columnName: "variantId", nonUnique: 0, isVisible: "YES" },
    { indexName: "PRIMARY", columnName: "branchId", nonUnique: 0, isVisible: "YES" },
    { indexName: "uq_stock_id", columnName: "id", nonUnique: 0, isVisible: "NO" },
  ]);
});

it("existing independent variant does not wait on a stock ensure table-tail gap", () =>
  heldEnsure([1, 2]));
it("missing independent variants create real rows without locking a shared absent range", () =>
  heldEnsure([]));
it("existing stock ensure does not block an unrelated first stock row", () =>
  heldEnsure([1]));

it("old RR snapshot sees subsequently committed stock without blocking unrelated creation", async () => {
  const snapshot = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const reader = withTx(async (tx) => {
    await tx.select().from(s.branchStock);
    snapshot.resolve();
    await resume.promise;
    await lockInventoryVariants(tx, [1]);
    await ensureBranchStockRows(tx, [1], 1);
    const [row] = await tx
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)))
      .for("update")
      .limit(1);
    expect(row.quantity).toBe(9);
    await ensureBranchStockRows(tx, [1], 1);
    // The duplicate caused by the old snapshot must not retain an UPSERT tail
    // gap that blocks a different variant's first row until this tx commits.
    await withTx(async (other) => {
      await other.execute(sql`SET SESSION innodb_lock_wait_timeout = 3`);
      try {
        await ensureBranchStockRows(other, [2], 1);
      } finally {
        await other.execute(
          sql`SET SESSION innodb_lock_wait_timeout = DEFAULT`,
        );
      }
    });
    await applyMovement(tx, {
      variantId: 1,
      branchId: 1,
      baseQuantity: 2,
      movementType: "IN",
    });
  });
  const outcome = Promise.allSettled([reader]);
  try {
    await snapshot.promise;
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 9 }),
    );
  } finally {
    resume.resolve();
  }
  const result = (await outcome)[0];
  if (result.status === "rejected") throw result.reason;
  expect(
    (
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.variantId, 1))
    )[0].quantity,
  ).toBe(11);
});

it("does not swallow missing-variant foreign-key failures while ensuring stock", async () => {
  await expect(
    withTx((tx) => ensureBranchStockRows(tx, [999], 1)),
  ).rejects.toMatchObject({ cause: { code: "ER_NO_REFERENCED_ROW_2" } });
  expect(await db().select().from(s.branchStock)).toHaveLength(0);
});

it("same-variant concurrent first movements preserve both effects and rollback stays atomic", async () => {
  await Promise.all(
    [2, 3].map((baseQuantity) =>
      withTx((tx) =>
        applyMovement(tx, {
          variantId: 1,
          branchId: 1,
          baseQuantity,
          movementType: "IN",
        }),
      ),
    ),
  );
  expect((await db().select().from(s.branchStock))[0].quantity).toBe(5);
  expect(await db().select().from(s.inventoryMovements)).toHaveLength(2);
  await expect(
    withTx(async (tx) => {
      await applyMovement(tx, {
        variantId: 2,
        branchId: 1,
        baseQuantity: 4,
        movementType: "IN",
      });
      throw Error("rollback synthetic stock creation");
    }),
  ).rejects.toThrow("rollback synthetic stock creation");
  expect(
    await db()
      .select()
      .from(s.branchStock)
      .where(eq(s.branchStock.variantId, 2)),
  ).toHaveLength(0);
  expect(await db().select().from(s.inventoryMovements)).toHaveLength(2);
});

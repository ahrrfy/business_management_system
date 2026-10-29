import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import * as database from "../../db";
import * as stockLock from "../inventory/stockLock";
import { withTx } from "../tx";
import { createProduction, cancelProduction } from "../productionService";
import { createStockTransfer } from "../transferService";
import { readInventoryValuation } from "../inventory/valuation";
import { createProductionInTx } from "../production/create";
import { applyValuedInboundMovement } from "../inventoryService";
import { replaceBundleComponents } from "../bundleService";
import { createPurchaseOrder, confirmPurchaseOrder } from "../purchaseService";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { receivePurchase } from "../purchase/receive";

const db = () => database.getDb()!;
const actor = { userId: 1, branchId: 1, role: "admin" };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("production closure barrier timeout")),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
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
      openId: "production-closure",
      name: "Owner",
      role: "admin",
      branchId: 1,
    });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "Bundle", isBundle: true },
      { id: 2, name: "Output" },
      { id: 3, name: "Input" },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "closure-b" },
      { id: 2, productId: 2, sku: "closure-c", costPrice: "0" },
      { id: 3, productId: 3, sku: "closure-in", costPrice: "200" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 2, branchId: 1, quantity: 10 },
      { variantId: 3, branchId: 1, quantity: 10 },
    ]);
  await db()
    .insert(s.bundleComponents)
    .values({
      bundleVariantId: 1,
      componentVariantId: 2,
      componentBaseQuantity: 1,
    });
});
const produce = () =>
  createProduction(
    {
      branchId: 1,
      inputs: [{ variantId: 3, baseQuantity: 10 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    },
    actor,
  );
const variantCost = async (id: number) =>
  (
    await db()
      .select()
      .from(s.productVariants)
      .where(eq(s.productVariants.id, id))
  )[0].costPrice;
it("native production and cancel preserve free owned transit quantity and exact value", async () => {
  await withTx((tx) =>
    createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 2, baseQuantity: 10 }],
      createdBy: 1,
    }),
  );
  const production = await produce();
  expect(await variantCost(2)).toBe("100.00");
  expect(await variantCost(1)).toBe("100.00");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "2000.00",
  );
  await cancelProduction(production.productionOrderId, actor);
  expect(await variantCost(2)).toBe("0.00");
  expect(await variantCost(1)).toBe("0.00");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "2000.00",
  );
  expect(
    await db()
      .select()
      .from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1)),
  ).toHaveLength(0);
});

it("native legacy receipt preserves free owned transit quantity and replay", async () => {
  await withTx((tx) =>
    createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 2, baseQuantity: 10 }],
      createdBy: 1,
    }),
  );
  await db().insert(s.suppliers).values({ id: 1, name: "Supplier" });
  await db()
    .insert(s.users)
    .values({
      id: 2,
      openId: "closure-reviewer",
      name: "Reviewer",
      role: "manager",
      branchId: 1,
    });
  await db()
    .insert(s.productUnits)
    .values({
      id: 1,
      variantId: 2,
      unitName: "Unit",
      conversionFactor: "1",
      isBaseUnit: true,
    });
  const draft = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      clientRequestId: "closure-legacy-po",
      items: [
        { variantId: 2, productUnitId: 1, quantity: "10", unitPrice: "200" },
      ],
    },
    actor,
  );
  const sent = await confirmPurchaseOrder(
    {
      purchaseOrderId: draft.purchaseOrderId,
      expectedVersion: draft.version,
      reason: "Verify legacy receipt source",
      clientRequestId: "closure-confirm",
    },
    actor,
  );
  await decidePurchaseOrderControl(
    {
      requestId: sent.requestId,
      decisionKey: "closure-approve",
      approve: true,
      reason: "Verified source and receipt",
    },
    { userId: 2, branchId: 1, role: "manager" },
    { legacyConfirmOnly: true },
  );
  const [item] = await db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, draft.purchaseOrderId));
  const args = {
    purchaseOrderId: draft.purchaseOrderId,
    clientRequestId: "closure-legacy-receive",
    lines: [{ purchaseOrderItemId: item.id, receivedBaseQuantity: 10 }],
  };
  await receivePurchase(args, actor);
  await receivePurchase(args, actor);
  expect(await variantCost(2)).toBe("100.00");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "4000.00",
  ); // input inventory still owns 2000
  expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
    "2000.00",
  );
});

it("bundle cache uses current other-component costs after an old RR snapshot", async () => {
  await db().insert(s.products).values({ id: 4, name: "Other component" });
  await db()
    .insert(s.productVariants)
    .values({ id: 4, productId: 4, sku: "closure-other", costPrice: "10" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 4, branchId: 1, quantity: 10 });
  await withTx((tx) =>
    replaceBundleComponents(tx, 1, [
      { componentVariantId: 2, componentBaseQuantity: 1 },
      { componentVariantId: 4, componentBaseQuantity: 1 },
    ]),
  );
  await withTx(async (tx) => {
    await tx.select().from(s.productVariants); // deliberately old RR snapshot
    await withTx((writer) =>
      applyValuedInboundMovement(writer, {
        variantId: 4,
        branchId: 1,
        baseQuantity: 10,
        historicalValue: "300",
        referenceType: "PURCHASE",
        referenceId: 1,
        createdBy: 1,
      }),
    );
    await createProductionInTx(
      tx,
      {
        branchId: 1,
        inputs: [{ variantId: 3, baseQuantity: 10 }],
        outputs: [{ variantId: 2, baseQuantity: 10 }],
      },
      actor,
    );
  });
  expect(await variantCost(4)).toBe("20.00");
  expect(await variantCost(1)).toBe("120.00");
});

it.each(["replace", "new-reference"])(
  "rejects current bundle %s drift before production without expanding scope",
  async (mode) => {
    if (mode === "new-reference") {
      await db()
        .insert(s.products)
        .values({ id: 4, name: "New Bundle", isBundle: true });
      await db()
        .insert(s.productVariants)
        .values({ id: 4, productId: 4, sku: "closure-new-bundle" });
    }
    await expect(
      withTx(async (tx) => {
        await tx.select().from(s.bundleComponents);
        await withTx((writer) =>
          replaceBundleComponents(writer, mode === "replace" ? 1 : 4, [
            {
              componentVariantId: mode === "replace" ? 3 : 2,
              componentBaseQuantity: 2,
            },
          ]),
        );
        return createProductionInTx(
          tx,
          {
            branchId: 1,
            inputs: [{ variantId: 3, baseQuantity: 10 }],
            outputs: [{ variantId: 2, baseQuantity: 10 }],
          },
          actor,
        );
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.productionOrders)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  },
);

it("native producer and bundle transfer complete without a late header ABBA", async () => {
  const producerHeld = deferred(),
    releaseProducer = deferred(),
    transferHeldHeader = deferred(),
    transferRequestsHeader = deferred();
  const originalLock = stockLock.lockInventoryVariants;
  let producerTx: unknown;
  let producerIncludesHeader = false;
  const spy = vi
    .spyOn(stockLock, "lockInventoryVariants")
    .mockImplementation(async (tx, ids) => {
      if (!producerTx) {
        producerTx = tx;
        producerIncludesHeader = ids.includes(1);
        const result = await originalLock(tx, ids);
        producerHeld.resolve();
        await bounded(releaseProducer.promise);
        return result;
      }
      if (tx !== producerTx && ids.includes(1)) {
        await originalLock(tx, [1]);
        transferHeldHeader.resolve();
        await originalLock(
          tx,
          ids.filter((id) => id !== 1),
        );
        return ids;
      }
      return originalLock(tx, ids);
    });
  const pool = mysql.createPool({
    uri: process.env.DATABASE_URL!,
    connectionLimit: 1,
  });
  const transferDb = drizzle(pool, {
    schema: s,
    mode: "default",
    logger: {
      logQuery(query, params) {
        if (
          query.includes("`productVariants`") &&
          /for update/i.test(query) &&
          params[0] === 1
        )
          transferRequestsHeader.resolve();
      },
    },
  });
  let dbSpy: ReturnType<typeof vi.spyOn> | undefined;
  const tasks: Promise<unknown>[] = [];
  try {
    await pool.query("SET SESSION innodb_lock_wait_timeout=5");
    const producer = produce();
    tasks.push(producer);
    const producerOutcome = Promise.allSettled([producer]);
    await bounded(producerHeld.promise);
    dbSpy = vi.spyOn(database, "getDb").mockReturnValue(transferDb);
    const transfer = withTx((tx) =>
      createStockTransfer(tx, {
        fromBranchId: 1,
        toBranchId: 2,
        items: [{ variantId: 1, baseQuantity: 1 }],
        createdBy: 1,
      }),
    );
    tasks.push(transfer);
    const transferOutcome = Promise.allSettled([transfer]);
    await bounded(
      producerIncludesHeader
        ? transferRequestsHeader.promise
        : transferHeldHeader.promise,
    );
    releaseProducer.resolve();
    const outcomes = (
      await bounded(Promise.all([producerOutcome, transferOutcome]))
    ).flat();
    console.info(
      "native production/transfer outcomes",
      outcomes.map((o) =>
        o.status === "fulfilled"
          ? { status: o.status }
          : {
              status: o.status,
              code: o.reason?.cause?.code ?? o.reason?.code,
              message: o.reason?.message,
            },
      ),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await variantCost(1)).toBe("100.00");
    expect(await db().select().from(s.productionOrders)).toHaveLength(1);
    expect(await db().select().from(s.stockTransfers)).toHaveLength(1);
    const [output] = await db()
      .select()
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 2));
    expect(output.transitBaseBySourceBranch).toEqual({ "1": "1" });
    expect(
      (
        await db()
          .select()
          .from(s.branchStock)
          .where(eq(s.branchStock.variantId, 2))
      )[0].quantity,
    ).toBe(19);
  } finally {
    releaseProducer.resolve();
    dbSpy?.mockRestore();
    spy.mockRestore();
    await Promise.allSettled(tasks);
    await pool.end();
  }
});

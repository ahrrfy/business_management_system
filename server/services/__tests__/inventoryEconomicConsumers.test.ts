import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createStockTransfer, receiveStockTransfer } from "../transferService";
import { applyMovement, applyValuedInboundMovement } from "../inventoryService";
import { readInventoryValuation } from "../inventory/valuation";
import { receiveInboundGift } from "../gifts/inbound";
import { createProduction, cancelProduction } from "../productionService";
import { createPurchaseOrder, confirmPurchaseOrder } from "../purchaseService";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { postCostRevaluation } from "../costRevaluation";
import {
  requestCostRevaluation,
  approveCostRevaluation,
  getCostRevaluationPreview,
} from "../inventory/costRevaluationRequest";
import { lockEconomicInventoryScope } from "../inventory/economicOwnership";
import { updateProductWithVariants } from "../productEditService";
import { createSale } from "../saleService";
import { correctSale } from "../sale/correct";
import { getFinancialPosition } from "../reportsFinancialService";
import { getInventoryValuation } from "../reportsInventoryService";

function db() {
  const d = getDb();
  if (!d) throw new Error("missing test DB");
  return d;
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
    .values([
      {
        id: 1,
        openId: "economic-consumers",
        name: "Admin",
        role: "admin",
        branchId: 1,
      },
      {
        id: 2,
        openId: "economic-reviewer",
        name: "Reviewer",
        role: "manager",
        branchId: 1,
      },
    ]);
  await db().insert(s.products).values({ id: 1, name: "Owned" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "economic-1", costPrice: "100.00" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 10 });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
});

async function dispatch() {
  return withTx((tx) =>
    createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: 10 }],
      createdBy: 1,
    }),
  );
}
async function cost() {
  return (
    await db()
      .select()
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 1))
  )[0].costPrice;
}

it("native full GRN approval conserves transit plus receipt at 150 and 3000", async () => {
  const transfer = await dispatch();
  await db().insert(s.suppliers).values({ id: 1, name: "Supplier" });
  const maker = { userId: 1, branchId: 1, role: "admin" as const };
  const reviewer = { userId: 2, branchId: 1, role: "manager" as const };
  const draft = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      clientRequestId: "economic-po",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "200.00" },
      ],
    },
    maker,
  );
  const sent = await confirmPurchaseOrder(
    {
      purchaseOrderId: draft.purchaseOrderId,
      expectedVersion: draft.version,
      reason: "Confirmed source receipt",
      clientRequestId: "economic-po-send",
    },
    maker,
  );
  const args = {
    requestId: sent.requestId,
    decisionKey: "economic-po-approve",
    approve: true,
    confirmedFullReceipt: true,
    reason: "Full goods arrived and checked",
  };
  await decidePurchaseOrderControl(args, reviewer);
  await decidePurchaseOrderControl(args, reviewer);
  expect(await cost()).toBe("150.00");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "3000.00",
  );
  expect(
    (await db().select().from(s.goodsReceiptItems)).map((i) => i.netAmount),
  ).toEqual(["2000.00"]);
  expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
    "2000.00",
  );
  expect(await db().select().from(s.goodsReceipts)).toHaveLength(1);
  const [line] = await db()
    .select()
    .from(s.stockTransferLines)
    .where(eq(s.stockTransferLines.transferId, transfer.transferId));
  await withTx((tx) =>
    receiveStockTransfer(tx, {
      transferId: transfer.transferId,
      actor: maker,
      lines: [{ lineId: line.id, quantityReceived: 8, note: "two missing" }],
    }),
  );
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "2700.00",
  );
  const [loss] = await db()
    .select()
    .from(s.accountingEntries)
    .where(
      eq(s.accountingEntries.dedupeKey, `TRANSFER_LOSS:${transfer.transferId}`),
    );
  expect(loss.cost).toBe("300.00");
});

it("a free sellable gift dilutes owned transit without changing ownership or ledger", async () => {
  await dispatch();
  await receiveInboundGift(
    {
      branchId: 2,
      clientRequestId: "economic-gift",
      lines: [{ variantId: 1, productUnitId: 1, quantity: 10 }],
    },
    { userId: 1, branchId: 2, role: "admin" },
  );
  expect(await cost()).toBe("50.00");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "1000.00",
  );
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
});

it("production output and inverse cancel retain the old transit cost pool", async () => {
  await dispatch();
  await db().insert(s.products).values({ id: 2, name: "Input" });
  await db().insert(s.productVariants).values({
    id: 2,
    productId: 2,
    sku: "economic-input",
    costPrice: "200.00",
  });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 2, branchId: 2, quantity: 10 });
  const actor = { userId: 1, branchId: 2, role: "admin" };
  const produced = await createProduction(
    {
      branchId: 2,
      inputs: [{ variantId: 2, baseQuantity: 10 }],
      outputs: [{ variantId: 1, baseQuantity: 10 }],
    },
    actor,
  );
  expect(await cost()).toBe("150.00");
  await cancelProduction(produced.productionOrderId, actor);
  expect(await cost()).toBe("100.00");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "3000.00",
  );
});

it("transit-only manual editing is blocked and governed revalue posts once to source", async () => {
  await dispatch();
  const maker = { userId: 1, branchId: 1, role: "admin" as const };
  const reviewer = { userId: 2, branchId: 1, role: "manager" as const };
  await expect(
    withTx((tx) =>
      postCostRevaluation(
        tx,
        1,
        "100",
        "150",
        maker,
        "Correct inventory source cost",
      ),
    ),
  ).rejects.toThrow(/إعادة تقييم/);
  const preview = await getCostRevaluationPreview(1, maker);
  expect(preview.branches.map((b) => [b.branchId, b.quantity])).toEqual([
    [1, 10],
  ]);
  const request = await requestCostRevaluation(
    {
      variantId: 1,
      newCost: "150",
      purpose: "CORRECTION",
      reason: "Correct documented original cost",
    },
    maker,
  );
  expect(request.expectedQuantity).toBe(10);
  const result = await approveCostRevaluation(request.requestId, reviewer);
  expect(result.totalValueDelta).toBe("500.00");
  const entries = await db().select().from(s.accountingEntries);
  expect(entries).toHaveLength(1);
  expect(entries[0].branchId).toBe(1);
  await expect(
    approveCostRevaluation(request.requestId, reviewer),
  ).rejects.toThrow();
  expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
});

it("refreshes current cost after an older RR snapshot and after each own write", async () => {
  await dispatch();
  await withTx(async (tx) => {
    await tx.select().from(s.productVariants);
    await withTx(async (other) => {
      await other
        .update(s.productVariants)
        .set({ costPrice: "120.00" })
        .where(eq(s.productVariants.id, 1));
    });
    await lockEconomicInventoryScope(tx, [1]);
    expect(
      (
        await applyValuedInboundMovement(tx, {
          variantId: 1,
          branchId: 2,
          baseQuantity: 10,
          historicalValue: "2000",
        })
      ).newCost,
    ).toBe("160.00");
    expect(
      (
        await applyValuedInboundMovement(tx, {
          variantId: 1,
          branchId: 2,
          baseQuantity: 10,
          historicalValue: "2200",
        })
      ).newCost,
    ).toBe("180.00");
  });
});

it("native editor preserves financial classification for an all-transit item", async () => {
  await dispatch();
  const input = {
    productId: 1,
    unitTemplate: [
      {
        unitName: "piece",
        conversionFactor: "1",
        isBaseUnit: true,
        prices: [],
      },
    ],
    variants: [
      { id: 1, sku: "economic-1", costPrice: "100.00", unitBarcodes: {} },
    ],
  };
  const actor = { userId: 1, branchId: 1, role: "admin" };
  for (const flags of [
    { isConsignment: true, consignorId: 1 },
    { isService: true },
    { productType: "DIGITAL_CARD" },
  ]) {
    await expect(
      updateProductWithVariants({ ...input, ...flags }, actor),
    ).rejects.toThrow(/تاريخ تشغيلي/);
  }
  expect(
    (await db().select().from(s.products).where(eq(s.products.id, 1)))[0],
  ).toMatchObject({
    isConsignment: false,
    isService: false,
    productType: null,
  });
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "1000.00",
  );
});

it("governed revalue rejects a foreign transit source and stale economic quantity", async () => {
  await dispatch();
  const maker = { userId: 1, branchId: 1, role: "admin" as const };
  const input = {
    variantId: 1,
    newCost: "150",
    purpose: "CORRECTION" as const,
    reason: "Correct documented original cost",
  };
  await expect(
    requestCostRevaluation(input, { userId: 2, branchId: 2, role: "manager" }),
  ).rejects.toThrow(/فرع/);
  const requested = await requestCostRevaluation(input, maker);
  await withTx((tx) =>
    applyValuedInboundMovement(tx, {
      variantId: 1,
      branchId: 1,
      baseQuantity: 2,
      historicalValue: "200",
    }),
  );
  await expect(
    approveCostRevaluation(requested.requestId, {
      userId: 2,
      branchId: 1,
      role: "manager",
    }),
  ).rejects.toThrow(/كمي/);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect(await cost()).toBe("100.00");
});

it("native service correction scopes saved issue materials before restoring and reissuing", async () => {
  const actor = { userId: 1, branchId: 1, role: "admin" as const };
  await db()
    .insert(s.products)
    .values({ id: 2, name: "Printed service", isService: true });
  await db().insert(s.productVariants).values({
    id: 2,
    productId: 2,
    sku: "economic-service",
    costPrice: "0.00",
  });
  await db().insert(s.productUnits).values({
    id: 2,
    variantId: 2,
    unitName: "print",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 2, priceTier: "RETAIL", price: "500.00" });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "Customer", creditLimit: null });
  await db().insert(s.productionRecipes).values({
    id: 1,
    name: "Print materials",
    outputVariantId: 2,
    outputProductUnitId: 2,
    isActive: true,
  });
  await db()
    .insert(s.productionRecipeLines)
    .values({ recipeId: 1, inputVariantId: 1, qtyPerOutputBase: "2" });
  const lines = [{ variantId: 2, productUnitId: 2, quantity: "1" }];
  const original = await createSale(
    { branchId: 1, customerId: 1, sourceType: "ORDER", lines },
    actor,
  );
  await db()
    .update(s.productVariants)
    .set({ costPrice: "200.00" })
    .where(eq(s.productVariants.id, 1));
  const corrected = await correctSale(
    {
      originalInvoiceId: original.invoiceId,
      customerId: 1,
      lines,
      clientRequestId: "economic-service-correct",
    },
    actor,
  );
  expect(corrected.correctedInvoiceId).not.toBe(original.invoiceId);
  expect(
    (
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.variantId, 1))
    )[0].quantity,
  ).toBe(8);
  expect(await cost()).toBe("180.00");
  const restored = (await db().select().from(s.inventoryMovements)).filter(
    (m) => m.movementType === "RETURN",
  );
  expect(restored.map((m) => [m.variantId, m.quantity])).toEqual([[1, 2]]);
});

it("source, inventory report and balance sheet exclude service and operational bundle headers", async () => {
  await db()
    .insert(s.products)
    .values([
      { id: 2, name: "Service", isService: true },
      { id: 3, name: "Bundle", isBundle: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 2, productId: 2, sku: "parity-service", costPrice: "777.00" },
      { id: 3, productId: 3, sku: "parity-bundle", costPrice: "999.00" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 2, branchId: 1, quantity: 5 },
      { variantId: 3, branchId: 1, quantity: 5 },
    ]);
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "1000.00",
  );
  expect((await getInventoryValuation()).totals.totalValue).toBe("1000.00");
  expect((await getFinancialPosition()).inventory).toBe("1000.00");
});

it("scoped physical inbound uses current classification after a real editor and stale RR snapshot", async () => {
  await db().update(s.branchStock).set({ quantity: 0 });
  await db()
    .update(s.products)
    .set({ isService: true })
    .where(eq(s.products.id, 1));
  await withTx(async (tx) => {
    await tx.select().from(s.products);
    await updateProductWithVariants(
      {
        productId: 1,
        isService: false,
        unitTemplate: [
          {
            unitName: "piece",
            conversionFactor: "1",
            isBaseUnit: true,
            prices: [],
          },
        ],
        variants: [
          { id: 1, sku: "economic-1", costPrice: "100.00", unitBarcodes: {} },
        ],
      },
      { userId: 1, branchId: 1, role: "admin" },
    );
    const returned = await applyValuedInboundMovement(tx, {
      variantId: 1,
      branchId: 1,
      baseQuantity: 1,
      historicalValue: "100",
    });
    expect(returned.movementId).toBeGreaterThan(0);
    expect(returned.newQuantity).toBe(1);
  });
});

it("physical movement rejects expired and uncovered explicit economic capabilities", async () => {
  await db().insert(s.products).values({ id: 2, name: "Other" });
  await db()
    .insert(s.productVariants)
    .values({ id: 2, productId: 2, sku: "scope-other", costPrice: "10" });
  let expired!: Awaited<ReturnType<typeof lockEconomicInventoryScope>>;
  await withTx(async (tx) => {
    expired = await lockEconomicInventoryScope(tx, [1]);
  });
  await expect(
    withTx((tx) =>
      applyMovement(tx, {
        economicScope: expired,
        variantId: 1,
        branchId: 1,
        baseQuantity: 1,
        movementType: "IN",
      }),
    ),
  ).rejects.toThrow(/نطاق/);
  await withTx(async (tx) => {
    const scope = await lockEconomicInventoryScope(tx, [1]);
    await expect(
      applyMovement(tx, {
        economicScope: scope,
        variantId: 2,
        branchId: 1,
        baseQuantity: 1,
        movementType: "IN",
      }),
    ).rejects.toThrow(/نطاق/);
  });
  expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
});

it("retains all-transit owned value in WAVG for a valued inbound", async () => {
  await withTx((tx) =>
    createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: 10 }],
      createdBy: 1,
    }),
  );
  const result = await withTx((tx) =>
    applyValuedInboundMovement(tx, {
      variantId: 1,
      branchId: 2,
      baseQuantity: 10,
      historicalValue: "2000.00",
      createdBy: 1,
    }),
  );
  expect(result.newCost).toBe("150.00");
  expect(result.previousGlobalQuantity).toBe("10");
  expect((await withTx((tx) => readInventoryValuation(tx))).total).toBe(
    "3000.00",
  );
  expect(
    (
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.branchId, 1))
    )[0].quantity,
  ).toBe(0);
});

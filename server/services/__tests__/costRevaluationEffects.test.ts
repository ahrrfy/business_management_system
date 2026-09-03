/**
 * الأثر الممتد لإعادة تقييم التكلفة: COGS التاريخي ثابت، والبيع اللاحق يلتقط التكلفة
 * الجديدة، ثم يبني استلام الشراء WAVG عليها لا على التكلفة التي سبقتها.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveCostRevaluation,
  requestCostRevaluation,
} from "../inventory/costRevaluationRequest";
import { money } from "../money";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "costRevaluationRequests",
  "financialPeriods",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "idempotencyKeys",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "purchaseOrderItems",
  "purchaseOrders",
  "shifts",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
];

const requester = { userId: 1, branchId: 1, role: "manager" as const };
const approver = { userId: 2, branchId: 1, role: "manager" as const };
const REASON = "تصحيح تكلفة المخزون بحسب مستند المورد الأصلي";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function seed(): Promise<void> {
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values([
    {
      id: 1,
      openId: "cost-requester",
      name: "مدير الطالب",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "cost-approver",
      name: "مدير المعتمد",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "NOTE-1",
    costPrice: "100.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(s.productPrices).values({
    productUnitId: 1,
    priceTier: "RETAIL",
    price: "200.00",
  });
  await db().insert(s.branchStock).values({
    variantId: 1,
    branchId: 1,
    quantity: 10,
  });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    openingBalance: "0.00",
    status: "OPEN",
    shiftType: "RECEPTION",
  });
}

async function revalue(newCost: string): Promise<void> {
  const request = await requestCostRevaluation(
    { variantId: 1, newCost, purpose: "CORRECTION", reason: REASON },
    requester,
  );
  await approveCostRevaluation(request.requestId, approver);
}

async function sell(quantity: string): Promise<number> {
  const total = money("200.00").times(quantity).toFixed(2);
  const result = await createSale(
    {
      branchId: 1,
      shiftId: 1,
      priceTier: "RETAIL",
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity }],
      payment: { amount: total, method: "CASH" },
    },
    requester,
  );
  return result.invoiceId;
}

async function preparePurchase(unitPrice = "120.00"): Promise<{
  purchaseOrderId: number;
  purchaseOrderItemId: number;
}> {
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد الدفاتر",
    currentBalance: "0.00",
  });
  const purchase = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "10",
          unitPrice,
        },
      ],
    },
    requester,
  );
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: purchase.purchaseOrderId,
      expectedVersion: purchase.version,
      reason: "إرسال أمر اختبار إعادة التقييم للمراجعة المستقلة",
      requestKey: `cost-revaluation-po-submit:${randomUUID()}`,
    },
    requester,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `cost-revaluation-po-approve:${randomUUID()}`,
      approve: true,
      reason: "راجعت المورد والكميات والأسعار قبل اختبار أثر التكلفة",
    },
    approver,
    { legacyConfirmOnly: true },
  );
  const line = (
    await db()
      .select({ id: s.purchaseOrderItems.id })
      .from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, purchase.purchaseOrderId))
  )[0];
  return {
    purchaseOrderId: purchase.purchaseOrderId,
    purchaseOrderItemId: Number(line.id),
  };
}

async function receivePreparedPurchase(purchase: {
  purchaseOrderId: number;
  purchaseOrderItemId: number;
}): Promise<void> {
  await receivePurchase(
    {
      purchaseOrderId: purchase.purchaseOrderId,
      lines: [{ purchaseOrderItemId: purchase.purchaseOrderItemId, receivedBaseQuantity: 10 }],
    },
    approver,
  );
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("إعادة تقييم costPrice — أثر المخزون وCOGS وWAVG", () => {
  it("لا تعيد كتابة COGS السابق، والبيع اللاحق يلتقط التكلفة الجديدة", async () => {
    const oldInvoiceId = await sell("2");
    const oldItemBefore = (
      await db()
        .select({ unitCost: s.invoiceItems.unitCost })
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, oldInvoiceId))
    )[0];
    expect(money(oldItemBefore.unitCost ?? 0).toFixed(2)).toBe("100.00");

    await revalue("80.00");

    const oldItemAfter = (
      await db()
        .select({ unitCost: s.invoiceItems.unitCost })
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, oldInvoiceId))
    )[0];
    const oldSaleEntry = (
      await db()
        .select({ cost: s.accountingEntries.cost })
        .from(s.accountingEntries)
        .where(
          and(
            eq(s.accountingEntries.entryType, "SALE"),
            eq(s.accountingEntries.invoiceId, oldInvoiceId),
          ),
        )
    )[0];
    expect(money(oldItemAfter.unitCost ?? 0).toFixed(2)).toBe("100.00");
    expect(money(oldSaleEntry.cost ?? 0).toFixed(2)).toBe("200.00");

    const newInvoiceId = await sell("1");
    const newItem = (
      await db()
        .select({ unitCost: s.invoiceItems.unitCost })
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, newInvoiceId))
    )[0];
    const newSaleEntry = (
      await db()
        .select({ cost: s.accountingEntries.cost })
        .from(s.accountingEntries)
        .where(
          and(
            eq(s.accountingEntries.entryType, "SALE"),
            eq(s.accountingEntries.invoiceId, newInvoiceId),
          ),
        )
    )[0];
    expect(money(newItem.unitCost ?? 0).toFixed(2)).toBe("80.00");
    expect(money(newSaleEntry.cost ?? 0).toFixed(2)).toBe("80.00");
  });

  it("يبني استلام الشراء اللاحق WAVG على التكلفة المُعاد تقييمها", async () => {
    await revalue("80.00");
    const purchase = await preparePurchase();
    await receivePreparedPurchase(purchase);

    const variant = (
      await db()
        .select({ costPrice: s.productVariants.costPrice })
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0];
    const stock = (
      await db()
        .select({ quantity: s.branchStock.quantity })
        .from(s.branchStock)
        .where(
          and(
            eq(s.branchStock.variantId, 1),
            eq(s.branchStock.branchId, 1),
          ),
        )
    )[0];
    // ١٠ @ ٨٠ بعد إعادة التقييم + ١٠ @ ١٢٠ من المورد = ١٠٠ WAVG.
    expect(stock.quantity).toBe(20);
    expect(money(variant.costPrice ?? 0).toFixed(2)).toBe("100.00");
  });

  it("يسلسل اعتماد إعادة التقييم مع أول استلام بلا deadlock أو طمس WAVG", async () => {
    await db().delete(s.branchStock).where(eq(s.branchStock.variantId, 1));
    const request = await requestCostRevaluation(
      { variantId: 1, newCost: "80.00", purpose: "CORRECTION", reason: REASON },
      requester,
    );
    const purchase = await preparePurchase();

    const [approval, receipt] = await Promise.allSettled([
      approveCostRevaluation(request.requestId, approver),
      receivePreparedPurchase(purchase),
    ]);

    expect(receipt.status).toBe("fulfilled");
    if (approval.status === "rejected") {
      // الاستلام سبق الاعتماد فغيّر لقطة التكلفة/الكمية؛ الرفض المتحكم هو النتيجة التسلسلية الصحيحة.
      expect(approval.reason).toMatchObject({ code: "CONFLICT" });
    }

    const variant = (
      await db()
        .select({ costPrice: s.productVariants.costPrice })
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0];
    const stock = (
      await db()
        .select({ quantity: s.branchStock.quantity })
        .from(s.branchStock)
        .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)))
    )[0];
    // أول استلام لا يخلط تكلفةً بلا كمية: ١٠ @ ١٢٠ ⇒ WAVG = ١٢٠ في الترتيبين الممكنين.
    expect(stock.quantity).toBe(10);
    expect(money(variant.costPrice ?? 0).toFixed(2)).toBe("120.00");
  });
});

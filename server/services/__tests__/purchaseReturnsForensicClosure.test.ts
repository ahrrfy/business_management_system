import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { approveVoucher } from "../voucherService";
import { truncateTables } from "./__testUtils__";

const PURCHASING = {
  userId: 1,
  branchId: 1,
  role: "purchasing" as const,
};
const WAREHOUSE = {
  userId: 2,
  branchId: 1,
  role: "warehouse" as const,
};
const APPROVER = {
  userId: 3,
  branchId: 1,
  role: "manager" as const,
};

const TABLES = [
  "documentPrintEvents",
  "journalLines",
  "journalEntries",
  "purchaseReturnItems",
  "purchaseReturns",
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "branchStock",
  "purchaseOrderItems",
  "purchaseOrders",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function purchasingCaller() {
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: {
      id: PURCHASING.userId,
      role: PURCHASING.role,
      branchId: PURCHASING.branchId,
      permissionsOverride: { purchases: "FULL" },
    },
  } as any);
}

async function seedBase() {
  await db().insert(s.branches).values({
    id: 1,
    name: "الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "return-closure-purchasing",
        name: "مسؤول المشتريات",
        role: "purchasing",
        loginMethod: "local",
        branchId: 1,
        permissionsOverride: { purchases: "FULL" },
      },
      {
        id: 2,
        openId: "return-closure-warehouse",
        name: "أمين المخزن",
        role: "warehouse",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "return-closure-approver",
        name: "مالك معتمد",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد إغلاق المرتجعات",
    currentBalance: "0.00",
  });
  await db().insert(s.products).values({ id: 1, name: "ورق تصوير" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "RETURN-CLOSURE-1",
    costPrice: "0.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

async function makeOrder(args: {
  status: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  receivedBaseQuantity: 0 | 1 | 2;
  unitPrice?: string;
}) {
  const created = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "CONFIRMED",
      settlementType: "CREDIT",
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "2",
          unitPrice: args.unitPrice ?? "100.00",
        },
      ],
    },
    PURCHASING,
  );
  const [item] = await db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));

  if (args.receivedBaseQuantity > 0) {
    await receivePurchase(
      {
        purchaseOrderId: created.purchaseOrderId,
        lines: [
          {
            purchaseOrderItemId: Number(item.id),
            receivedBaseQuantity: args.receivedBaseQuantity,
          },
        ],
        clientRequestId: `return-closure-receive-${created.purchaseOrderId}`,
      },
      WAREHOUSE,
    );
  }
  await db()
    .update(s.purchaseOrders)
    .set({ status: args.status })
    .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
  return {
    purchaseOrderId: created.purchaseOrderId,
    poNumber: created.poNumber,
    purchaseOrderItemId: Number(item.id),
  };
}

async function returnEffectCounts() {
  const [documents, items, movements, entries, receipts, idempotency] =
    await Promise.all([
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.purchaseReturns),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.purchaseReturnItems),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.inventoryMovements)
        .where(eq(s.inventoryMovements.referenceType, "PURCHASE_RETURN")),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "RETURN")),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.receipts),
      db()
        .select({ count: sql<number>`COUNT(*)` })
        .from(s.idempotencyKeys),
    ]);
  return {
    documents: Number(documents[0]?.count ?? 0),
    items: Number(items[0]?.count ?? 0),
    movements: Number(movements[0]?.count ?? 0),
    entries: Number(entries[0]?.count ?? 0),
    receipts: Number(receipts[0]?.count ?? 0),
    idempotency: Number(idempotency[0]?.count ?? 0),
  };
}

describe("إغلاق جنائي لمرتجع الشراء", () => {
  it.each([
    ["DRAFT", 0],
    ["SENT", 0],
    ["CANCELLED", 0],
    ["CONFIRMED", 0],
    ["RECEIVED", 0],
  ] as const)(
    "يرفض الأمر %s غير القابل للإرجاع/غير المستلم بلا مستند أو حركة أو قيد",
    async (status, receivedBaseQuantity) => {
      const order = await makeOrder({ status, receivedBaseQuantity });
      const before = await returnEffectCounts();

      await expect(
        purchasingCaller().purchaseReturns.create({
          clientRequestId: `return-closure-rejected-${status}`,
          supplierId: 1,
          branchId: 1,
          purchaseOrderRefId: order.purchaseOrderId,
          items: [
            { purchaseOrderItemId: order.purchaseOrderItemId, quantity: "1" },
          ],
          settlement: "CREDIT",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(await returnEffectCounts()).toEqual(before);
    },
  );

  it.each([
    ["CONFIRMED", 1],
    ["RECEIVED", 2],
  ] as const)(
    "يقبل الأمر %s المستلم ويثبت مستنداً وحركةً وقيداً واحداً",
    async (status, receivedBaseQuantity) => {
      const order = await makeOrder({ status, receivedBaseQuantity });
      const before = await returnEffectCounts();

      const result = await purchasingCaller().purchaseReturns.create({
        clientRequestId: `return-closure-accepted-${status}`,
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: order.purchaseOrderId,
        items: [
          { purchaseOrderItemId: order.purchaseOrderItemId, quantity: "1" },
        ],
        settlement: "CREDIT",
      });

      expect(result).toMatchObject({
        returnedTotal: "100.00",
        cashRefundAmount: "0.00",
        creditOffsetAmount: "100.00",
      });
      expect(await returnEffectCounts()).toEqual({
        documents: 1,
        items: 1,
        movements: 1,
        entries: 1,
        receipts: 0,
        idempotency: before.idempotency + 1,
      });
    },
  );

  it("يسوّي CASH جزئياً بقدر المدفوع السابق ويحوّل الباقي إلى خصم ذمة صادق", async () => {
    const order = await makeOrder({
      status: "RECEIVED",
      receivedBaseQuantity: 2,
      unitPrice: "100.00",
    });
    await db().insert(s.shifts).values({
      id: 1,
      branchId: 1,
      userId: PURCHASING.userId,
      openingBalance: "500.00",
      status: "OPEN",
      openGuard: "1:1:RETAIL",
    });
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "500.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "RETURN-CLOSURE-TREASURY-FUND",
      createdBy: PURCHASING.userId,
    });

    const requested = await purchasingCaller().purchases.pay({
      purchaseOrderId: order.purchaseOrderId,
      amount: "50.00",
      method: "CASH",
      clientRequestId: "return-closure-prior-cash-payment",
    });
    await approveVoucher(Number(requested.paymentRequestReceiptId), APPROVER);

    const result = await purchasingCaller().purchaseReturns.create({
      clientRequestId: "return-closure-partial-cash-refund",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: order.purchaseOrderId,
      items: [
        { purchaseOrderItemId: order.purchaseOrderItemId, quantity: "2" },
      ],
      settlement: "CASH",
      paymentMethod: "CASH",
    });

    expect(result).toMatchObject({
      returnedTotal: "200.00",
      cashRefundAmount: "50.00",
      creditOffsetAmount: "150.00",
    });
    const [document] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, result.purchaseReturnId));
    expect(document).toMatchObject({
      totalAmount: "200.00",
      cashRefundAmount: "50.00",
      creditOffsetAmount: "150.00",
    });

    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("0.00");

    const linkedEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, order.purchaseOrderId));
    expect(
      linkedEntries.map((entry) => [entry.entryType, entry.amount]),
    ).toEqual(
      expect.arrayContaining([
        ["PURCHASE", "200.00"],
        ["PAYMENT_OUT", "50.00"],
        ["RETURN", "-200.00"],
        ["PAYMENT_IN", "50.00"],
      ]),
    );
    const refundEntry = linkedEntries.find(
      (entry) => entry.entryType === "PAYMENT_IN",
    );
    expect(refundEntry?.supplierId).toBe(1);
    const [refundReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.id, Number(refundEntry?.receiptId)),
          eq(s.receipts.direction, "IN"),
        ),
      );
    expect(refundReceipt).toMatchObject({
      amount: "50.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      shiftId: 1,
      cashBucket: "DRAWER",
    });
    const [returnMovement] = await db()
      .select()
      .from(s.inventoryMovements)
      .where(
        and(
          eq(s.inventoryMovements.referenceType, "PURCHASE_RETURN"),
          eq(s.inventoryMovements.referenceId, result.purchaseReturnId),
        ),
      );
    expect(returnMovement).toMatchObject({ movementType: "OUT", quantity: 2 });
  });

  it("يمكّن purchasing بصلاحية purchases:FULL من الحل والإنشاء دون سعر من purchases.get العام", async () => {
    const order = await makeOrder({
      status: "RECEIVED",
      receivedBaseQuantity: 2,
      unitPrice: "125.00",
    });
    const caller = purchasingCaller();

    const publicOrder = await caller.purchases.get({
      purchaseOrderId: order.purchaseOrderId,
    });
    expect(publicOrder?.items[0]?.unitPrice).toBeNull();

    const resolved = await caller.purchaseReturns.resolveOrder({
      branchId: 1,
      reference: order.poNumber,
    });
    expect(resolved.items[0]).toMatchObject({
      purchaseOrderItemId: order.purchaseOrderItemId,
      unitPrice: "125.00",
    });
    expect(Number(resolved.items[0].remainingQuantity)).toBe(2);

    const created = await caller.purchaseReturns.create({
      clientRequestId: "return-closure-purchasing-router",
      supplierId: resolved.supplierId,
      branchId: 1,
      purchaseOrderRefId: resolved.id,
      items: [
        {
          purchaseOrderItemId: resolved.items[0].purchaseOrderItemId,
          quantity: "1",
        },
      ],
      settlement: "CREDIT",
    });
    expect(created.returnedTotal).toBe("125.00");
  });
});

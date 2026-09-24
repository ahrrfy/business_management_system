import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseOrder,
  receivePurchase as receivePurchaseRaw,
} from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import { settlePurchaseShippingFromShift } from "../purchase/pay";
import {
  closeShift,
  getShiftReport,
  openShift,
} from "../shiftService";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import { withTx } from "../tx";

const adminActor = { userId: 1, branchId: 1, role: "admin" as const };
const ownerActor = { userId: 2, branchId: 1, role: "manager" as const };
const cashierActor = { userId: 3, branchId: 1, role: "cashier" as const };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function receivePurchase(
  input: Parameters<typeof receivePurchaseRaw>[0],
  currentActor: Parameters<typeof receivePurchaseRaw>[1],
) {
  return receivePurchaseRaw(
    {
      shippingBeneficiaryName: "شركة الشحن السريع",
      shippingEvidenceReference: `SHIP-EVIDENCE-PO-${input.purchaseOrderId}`,
      ...input,
    },
    currentActor,
  );
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "idempotencyKeys",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "accrualCorrectionRequests",
    "accrualObligationEvents",
    "accrualObligations",
    "accountingEntries",
    "expenses",
    "receipts",
    "shifts",
    "inventoryMovements",
    "purchaseOrderItems",
    "purchaseOrders",
    "branchStock",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d
    .insert(s.branches)
    .values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin-1", name: "المدير العام", role: "admin", loginMethod: "local", branchId: 1 },
    {
      id: 2,
      openId: "owner-2",
      name: "المالك المعتمد",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 3,
      openId: "cashier-3",
      name: "كاشير الوردية",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد البضاعة", currentBalance: "0" });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
  await d.insert(s.products).values([
    { id: 1, name: "منتج تجريبي 1" },
    { id: 2, name: "منتج تجريبي 2" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SKU-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "SKU-2", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

async function createApprovedPurchaseOrder(
  input: Parameters<typeof createPurchaseOrder>[0],
) {
  const created = await createPurchaseOrder(input, adminActor);
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "اعتماد أمر الشراء لاختبار حوكمة صرف الشحن من درج الوردية",
      requestKey: `shipping-shift-submit:${randomUUID()}`,
    },
    adminActor,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `shipping-shift-approve:${randomUUID()}`,
      approve: true,
      reason: "اعتماد أمر الشراء",
    },
    ownerActor,
    { legacyConfirmOnly: true },
  );
  return created;
}

async function itemsOf(poId: number) {
  return db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, poId))
    .orderBy(s.purchaseOrderItems.id);
}

describe("حوكمة صرف مصاريف الشحن من درج نقدية الوردية (DRAWER Cash)", () => {
  it("(١) صرف أجور الشحن مباشرة من الدرج عند الاستلام — ينقص نقد الدرج المتوقع ويغلق الوردية بفارق 0.00 د.ع", async () => {
    // 1. فتح وردية كاشير برصيد افتتاحي 100,000 د.ع
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000.00", shiftType: "RETAIL" },
      cashierActor,
    );
    expect(shift.shiftId).toBeGreaterThan(0);

    // الرصيد المتوقع للدرج لحظة الافتتاح
    const balanceInitial = await withTx((tx) =>
      computeDrawerCashBalance(tx, shift.shiftId, "100000.00"),
    );
    expect(balanceInitial.toFixed(2)).toBe("100000.00");

    // 2. إنشاء واعتماد أمر شراء بشحن 3,000 د.ع وكمرك 2,000 د.ع (إجمالي الشحن = 5,000 د.ع)
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // 1,000
        { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" }, // 3,000
      ],
      shippingCost: "3000.00",
      customsCost: "2000.00",
    });

    const items = await itemsOf(po.purchaseOrderId);

    // 3. استلام أمر الشراء مع تحديد مصدر تمويل الشحن من الدرج (DRAWER) للوردية المفتوحة
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        shippingFundingSource: "DRAWER",
        shippingShiftId: shift.shiftId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      cashierActor,
    );

    // 4. التحقق من رصيد الدرج المتوقع بعد الصرف: 100,000 - 5,000 = 95,000 د.ع
    const balanceAfter = await withTx((tx) =>
      computeDrawerCashBalance(tx, shift.shiftId, "100000.00"),
    );
    expect(balanceAfter.toFixed(2)).toBe("95000.00");

    // 5. التحقق من التزام الشحن: تحول إلى PAID
    const obligations = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(obligations).toHaveLength(1);
    expect(obligations[0].kind).toBe("PURCHASE_SHIPPING");
    expect(obligations[0].status).toBe("PAID");
    expect(obligations[0].recognizedAmount).toBe("5000.00");

    // 6. التحقق من إيصال الصرف وسجل المصروف
    const [expRow] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligations[0].expenseId)));
    expect(expRow).toBeTruthy();
    expect(expRow.cashBucket).toBe("DRAWER");
    expect(expRow.shiftId).toBe(shift.shiftId);
    expect(expRow.paymentMethod).toBe("CASH");
    expect(expRow.receiptId).toBeGreaterThan(0);

    const [rcptRow] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(expRow.receiptId)));
    expect(rcptRow).toBeTruthy();
    expect(rcptRow.direction).toBe("OUT");
    expect(rcptRow.cashBucket).toBe("DRAWER");
    expect(rcptRow.shiftId).toBe(shift.shiftId);
    expect(rcptRow.amount).toBe("5000.00");
    expect(rcptRow.status).toBe("COMPLETED");
    expect(rcptRow.approvalStatus).toBe("APPROVED");

    // 7. التحقق من مطابقة تسوية الوردية (Z-report): المصروف 5,000 د.ع والمتوقع 95,000 د.ع
    const report = await getShiftReport(shift.shiftId);
    expect(report?.cashReconciliation.expenses).toBe("5000.00");
    expect(report?.cashReconciliation.expectedCash).toBe("95000.00");

    // 8. إغلاق الوردية بالمبلغ الفعلي في الدرج (95,000 د.ع) — فارق العجز صفر تماماً!
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "95000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("95000.00");
    expect(closed.variance).toBe("0.00");
    expect(closed.reconciliationStatus).toBe("MATCHED");
  });

  it("(٢) تسوية أجور الشحن لاحقاً من وردية الكاشير (settlePurchaseShippingFromShift) — ينقص نقد الدرج ويغلق الوردية بفارق 0.00 د.ع", async () => {
    // 1. إنشاء أمر شراء بشحن 5,000 وكمرك 3,000 (الإجمالي 8,000 د.ع) واستلامه بدون صرف مباشر من الدرج
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "5000.00",
      customsCost: "3000.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // التزام الشحن معلق بمبلغ 8,000 د.ع
    const [initialObligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(initialObligation.status).toMatch(/ACCRUED_UNPAID|PAYMENT_PENDING/);
    expect(initialObligation.recognizedAmount).toBe("8000.00");

    // 2. الكاشير يفتح وردية برصيد 50,000 د.ع
    const shift = await openShift(
      { branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // 3. صرف وتسوية أجور الشحن نقداً من درج الوردية المفتوحة
    const settleRes = await settlePurchaseShippingFromShift(
      {
        purchaseOrderId: po.purchaseOrderId,
        shiftId: shift.shiftId,
      },
      cashierActor,
    );

    expect(settleRes.status).toBe("PAID");
    expect(settleRes.amount).toBe("8000.00");
    expect(settleRes.shiftId).toBe(shift.shiftId);
    expect(settleRes.receiptId).toBeGreaterThan(0);

    // 4. التحقق من هبوط نقد الدرج المتوقع: 50,000 - 8,000 = 42,000 د.ع
    const balanceAfter = await withTx((tx) =>
      computeDrawerCashBalance(tx, shift.shiftId, "50000.00"),
    );
    expect(balanceAfter.toFixed(2)).toBe("42000.00");

    // 5. التحقق من التزام الشحن بعد التسوية
    const [settledObligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.id, initialObligation.id));
    expect(settledObligation.status).toBe("PAID");

    // 6. التحقق من إضافة حدث PO-SHIPPING-DRAWER-SETTLED
    const poEvents = await db()
      .select()
      .from(s.purchaseOrderEvents)
      .where(eq(s.purchaseOrderEvents.purchaseOrderId, po.purchaseOrderId));
    const settleEvent = poEvents.find((e) => e.eventType === "SHIPPING_SETTLED_FROM_DRAWER");
    expect(settleEvent).toBeTruthy();
    expect(settleEvent?.reason).toContain("صرف أجور الشحن");

    // 7. إغلاق الوردية بالمبلغ الفعلي (42,000 د.ع) — فارق العجز صفر تماماً!
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "42000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("42000.00");
    expect(closed.variance).toBe("0.00");
    expect(closed.reconciliationStatus).toBe("MATCHED");
  });

  it("(٣) حارس سقف النثرية النقدية يمنع صرف الشحن ≥ ٥٠٠٬٠٠٠ د.ع من الدرج", async () => {
    // إنشاء أمر شراء بشحن 500,000 د.ع
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "500000.00",
      customsCost: "0.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    const shift = await openShift(
      { branchId: 1, openingBalance: "600000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // محاولة الصرف من الدرج يجب أن ترفض بسبب سقف النثرية
    await expect(
      settlePurchaseShippingFromShift(
        {
          purchaseOrderId: po.purchaseOrderId,
          shiftId: shift.shiftId,
        },
        cashierActor,
      ),
    ).rejects.toThrow(/سقف النثرية/);
  });

  it("(٤) حارس وجود الوردية المفتوحة يمنع الصرف من الدرج عند عدم وجود وردية مفتوحة", async () => {
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "5000.00",
      customsCost: "0.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // محاولة الصرف بدون فتح وردية
    await expect(
      settlePurchaseShippingFromShift(
        {
          purchaseOrderId: po.purchaseOrderId,
        },
        cashierActor,
      ),
    ).rejects.toThrow(/افتح وردية/);
  });
});

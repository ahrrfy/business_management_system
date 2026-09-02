/**
 * **رافدُ الردّ عند الاعتماد** — بلاغ المالك (٢/٩/٢٦) على الأمر 5033.
 *
 * الطالبُ اختار الدرج ساعةَ الطلب، وفُرِّغ الدرجُ بالبيع قبل الاعتماد، فوقف المديرُ أمام
 * «رصيد الدرج المتاح 25٬000 أقل من المطلوب 70٬000» وحمولةُ الطلب مبصومةٌ لا تُعدَّل:
 * **لا يعتمد ولا يُغيّر** — بابٌ مسدودٌ على مالِ زبونٍ محتجَز.
 *
 * هذه الاختبارات تُعيد إنتاج الحالة بالأرقام نفسها، وتُثبت أنّ المخرج صار موجوداً — وأنّ
 * الشروطَ المادّية بقيت مبصومةً كما هي.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { openShift } from "../shiftService";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";

const TABLES = [
  "workOrderControlRequests", "workOrderEvents", "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "orderPayments",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0.00" });
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "500.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
});

/** عربونٌ نقديّ ٧٠٬٠٠٠ — نفسُ رقم البلاغ. */
async function orderWithDeposit(shiftId: number) {
  const result = await createWorkOrder({
    branchId: 1,
    customerId: 1,
    title: "لوحة إعلانية",
    quantity: 1,
    salePrice: "120000.00",
    deposit: "70000.00",
    paymentMethod: "CASH" as const,
    materials: [],
  } as never, { ...CASHIER, shiftId } as never);
  return Number((result as { workOrderId: number }).workOrderId);
}

async function openReception(userId: number) {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    { userId, branchId: 1 },
  );
  return Number((shift as { shiftId: number }).shiftId);
}

async function fileCancelRequest(workOrderId: number, shiftId: number, key: string) {
  const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)).limit(1))[0];
  return requestWorkOrderControl({
    requestKey: key,
    workOrderId,
    requestType: "CANCEL",
    baseVersion: Number(wo.version),
    reason: "العميل ألغى الطلب",
    payload: { refundRail: "DRAWER", refundShiftId: shiftId },
  }, CASHIER);
}

/** تمويلُ خزينة الفرع — رصيدُها مجموعُ إيصالات `cashBucket=TREASURY` النقدية. */
async function fundTreasury(amount: string) {
  await db().insert(s.receipts).values({
    branchId: 1, shiftId: null, direction: "IN", amount, status: "COMPLETED",
    paymentMethod: "CASH", cashBucket: "TREASURY", receiptType: "OTHER",
    createdBy: MANAGER.userId, internalNote: "رصيد خزينة افتتاحيّ للتجربة",
  } as never);
}

/** يُفرِغ الدرج كما يُفرغه البيعُ بين الطلب والاعتماد. */
async function drainDrawer(shiftId: number, keep: string) {
  await db().update(s.shifts).set({ expectedCash: keep }).where(eq(s.shifts.id, shiftId));
  await db().insert(s.receipts).values({
    branchId: 1, shiftId, direction: "OUT", amount: "45000.00", status: "COMPLETED",
    paymentMethod: "CASH", cashBucket: "DRAWER", receiptType: "EXPENSE",
    createdBy: CASHIER.userId, internalNote: "سحبٌ نقديّ بين الطلب والاعتماد",
  } as never);
}

describe("رافد الردّ عند اعتماد طلب الإلغاء", () => {
  it("⭐ الدرجُ لا يغطّي المبلغ ⇒ المعتمِد يحوّله إلى الخزينة فيتمّ الإلغاء", async () => {
    const shiftId = await openReception(CASHIER.userId);
    const workOrderId = await orderWithDeposit(shiftId);
    const req = await fileCancelRequest(workOrderId, shiftId, "rail-treasury-1");
    await drainDrawer(shiftId, "25000.00");
    await fundTreasury("200000.00");

    await approveWorkOrderControlRequest(Number(req.id), MANAGER, null, {
      refundRail: "TREASURY",
      refundShiftId: null,
      refundReference: null,
    });

    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)).limit(1))[0];
    expect(wo.status).toBe("CANCELLED");

    // خرج المالُ من الخزينة لا من الدرج — الفارقُ محاسبيّ لا تجميليّ.
    const refunds = await db().select().from(s.receipts)
      .where(eq(s.receipts.workOrderId, workOrderId));
    const out = refunds.filter((r) => r.direction === "OUT");
    expect(out).toHaveLength(1);
    expect(out[0].cashBucket).toBe("TREASURY");
    expect(Number(out[0].amount)).toBe(70000);
  });

  it("⛔ وبلا تحويلٍ يبقى البابُ مسدوداً — الحارسُ الماليّ لم يُخفَّف", async () => {
    const shiftId = await openReception(CASHIER.userId);
    const workOrderId = await orderWithDeposit(shiftId);
    const req = await fileCancelRequest(workOrderId, shiftId, "rail-blocked-1");
    await drainDrawer(shiftId, "25000.00");

    await expect(approveWorkOrderControlRequest(Number(req.id), MANAGER))
      .rejects.toThrow(/رصيد الدرج|غير ممول/);
    // والطلبُ يبقى معلّقاً كما كان — لا حالةٌ نصفُ مطبَّقة.
    const row = (await db().select().from(s.workOrderControlRequests)
      .where(eq(s.workOrderControlRequests.id, Number(req.id))).limit(1))[0];
    expect(row.status).toBe("PENDING");
  });

  it("⭐ الفارقُ يُسجَّل في سجلّ الأمر — لا يضيع أنّ الرافد تبدّل", async () => {
    const shiftId = await openReception(CASHIER.userId);
    const workOrderId = await orderWithDeposit(shiftId);
    const req = await fileCancelRequest(workOrderId, shiftId, "rail-trail-1");
    await drainDrawer(shiftId, "25000.00");
    await fundTreasury("200000.00");

    await approveWorkOrderControlRequest(Number(req.id), MANAGER, null, {
      refundRail: "TREASURY", refundShiftId: null, refundReference: null,
    });

    const events = await db().select().from(s.workOrderEvents)
      .where(eq(s.workOrderEvents.workOrderId, workOrderId));
    const approved = events.find((e) => e.eventType === "CONTROL_APPROVED");
    expect(approved).toBeTruthy();
    const payload = approved!.payload as Record<string, unknown>;
    expect(payload.refundOverride).toMatchObject({ refundRail: "TREASURY" });
    expect(payload.refundRailAsRequested).toBe("DRAWER");
  });

  it("⛔ التجاوزُ محصورٌ بطلبات الإلغاء — ولا يمسّ الشروط المادّية", async () => {
    const shiftId = await openReception(CASHIER.userId);
    const workOrderId = await orderWithDeposit(shiftId);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)).limit(1))[0];
    const edit = await requestWorkOrderControl({
      requestKey: "rail-scope-1",
      workOrderId,
      requestType: "COMMERCIAL_EDIT",
      baseVersion: Number(wo.version),
      reason: "تصحيح العنوان",
      payload: { title: "عنوان معتمد" },
    }, CASHIER);

    await expect(approveWorkOrderControlRequest(Number(edit.id), MANAGER, null, {
      refundRail: "TREASURY", refundShiftId: null, refundReference: null,
    })).rejects.toThrow(/طلبات الإلغاء وحدها/);
  });

  it("⛔ رافدُ الدرج بلا وردية، والبطاقةُ بلا مرجع: مرفوضان قبل أيّ أثر", async () => {
    const shiftId = await openReception(CASHIER.userId);
    const workOrderId = await orderWithDeposit(shiftId);
    const req = await fileCancelRequest(workOrderId, shiftId, "rail-invalid-1");

    await expect(approveWorkOrderControlRequest(Number(req.id), MANAGER, null, {
      refundRail: "DRAWER", refundShiftId: null, refundReference: null,
    })).rejects.toThrow(/يلزمه تحديد وردية/);

    await expect(approveWorkOrderControlRequest(Number(req.id), MANAGER, null, {
      refundRail: "CARD", refundShiftId: null, refundReference: "ab",
    })).rejects.toThrow(/مرجعُ تنفيذٍ خارجيّ/);

    expect((await db().select().from(s.workOrders).where(eq(s.workOrders.id, workOrderId)).limit(1))[0].status)
      .toBe("RECEIVED");
  });
});

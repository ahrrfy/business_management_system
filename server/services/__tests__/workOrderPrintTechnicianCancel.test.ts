/**
 * **صلاحيةُ إلغاء الطلب لفنّي المطبعة** (قرار المالك ١/٩/٢٦).
 *
 * الفنّيُّ أقربُ الناس إلى العميل: هو أوّلُ من يتحدّث معه عن الطلب والتنفيذ، وإليه يتّصل
 * ليُلغي. فله الإلغاء — على أن يمرّ **باعتماد مديرٍ متى كان في الطلب عربونٌ أو نقد**، لأنّ
 * المال لا يخرج إلّا بيد من يملك الدرج (§٥).
 *
 * وهذه الاختبارات تحرس الحدَّ الفاصل نفسه: **المال**، لا الدور ولا أسطر الخامة المخطَّطة.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { extractInsertId } from "../../lib/insertId";
import { createWorkOrder } from "../workOrder/create";
import { openShift } from "../shiftService";
import { cancelWorkOrder } from "../workOrder/cancel";
import {
  approveWorkOrderControlRequest,
  getWorkOrderControlPreflight,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";

const TABLES = [
  "workOrderControlRequests", "workOrderEvents", "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "orderPayments",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const TECH = { userId: 5, branchId: 1, role: "print_operator" };
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr-1", name: "مدير", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh-1", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "tech-1", name: "فنّي مطبعة", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل ١", currentBalance: "0.00" });
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-1", costPrice: "500.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 100 });
}

/** أمرُ طباعةٍ نموذجيّ: **يحمل أسطرَ خامةٍ مخطَّطة منذ الإنشاء** — وهو الحال الغالب. */
async function createOrder(opts: { deposit?: string } = {}) {
  const result = await createWorkOrder({
    branchId: 1,
    customerId: 1,
    title: "بطاقات تعريفية",
    salePrice: "10000.00",
    quantity: 1,
    materials: [{ variantId: 1, baseQuantity: 2 }],
    ...(opts.deposit ? { deposit: opts.deposit, paymentMethod: "CASH" as const } : {}),
  } as never, CASHIER);
  return Number((result as { workOrderId: number }).workOrderId);
}

async function order(id: number) {
  return (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)).limit(1))[0];
}

/** عبر الخدمة نفسها — الإدراجُ الخام كان يُنتج معرّفاً صفرياً فتسقط الوردية من كل قارئ. */
async function openReceptionShift() {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    { userId: CASHIER.userId, branchId: 1 },
  );
  return Number((shift as { shiftId: number }).shiftId);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("إلغاء الطلب بيد فنّي المطبعة", () => {
  it("⭐ يُلغي مباشرةً أمراً لم يبدأ ولا مالَ فيه — ولو حمل أسطرَ خامةٍ مخطَّطة", async () => {
    const workOrderId = await createOrder();
    const before = await order(workOrderId);
    expect(before.status).toBe("RECEIVED");
    // شرطُ المالك هو المال؛ والخامةُ المخطَّطة لم تُستهلَك بعد فلا حركةَ مخزون أصلاً.
    const materials = await db().select().from(s.workOrderMaterials)
      .where(eq(s.workOrderMaterials.workOrderId, workOrderId));
    expect(materials.length).toBeGreaterThan(0);

    const stockBefore = (await db().select().from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1)).limit(1))[0];

    const res = await cancelWorkOrder(workOrderId, TECH, {
      expectedVersion: Number(before.version),
      reason: "العميل ألغى الطلب هاتفياً",
    });
    expect(res.status).toBe("CANCELLED");
    expect((await order(workOrderId)).status).toBe("CANCELLED");

    // صفرُ أثرٍ مخزنيّ: لا حركةَ ولا تغيّرَ رصيد — الاستهلاك يقع في البدء وحده.
    const stockAfter = (await db().select().from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1)).limit(1))[0];
    expect(Number(stockAfter.quantity)).toBe(Number(stockBefore.quantity));
    const movements = await db().select().from(s.inventoryMovements);
    expect(movements).toHaveLength(0);
  });

  it("⭐ يُرفض إلغاؤه المباشر متى كان في الطلب عربون — والرسالة تدلّه على طلب الاعتماد", async () => {
    await openReceptionShift();
    const workOrderId = await createOrder({ deposit: "2000.00" });
    const before = await order(workOrderId);

    await expect(cancelWorkOrder(workOrderId, TECH, {
      expectedVersion: Number(before.version),
      reason: "العميل ألغى الطلب",
    })).rejects.toThrow(/عربون|مبلغ مقبوض/);

    // ولم يقع أثر: الأمر باقٍ كما هو ولا إيصالَ صرفٍ نشأ.
    expect((await order(workOrderId)).status).toBe("RECEIVED");
    const outbound = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(outbound).toHaveLength(0);
  });

  it("⛔⭐ الكاشير لا يُلغي مباشرةً ولو خلا الأمرُ من المال — عقدُ RBAC القائم", async () => {
    const workOrderId = await createOrder();
    const before = await order(workOrderId);
    await expect(cancelWorkOrder(workOrderId, CASHIER, {
      expectedVersion: Number(before.version),
      reason: "العميل ألغى الطلب",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await order(workOrderId)).status).toBe("RECEIVED");
  });

  it("يُرفض إلغاؤه المباشر بعد بدء التنفيذ — مصيرُ الخامة قرارُ مدير", async () => {
    const workOrderId = await createOrder();
    await db().update(s.workOrders).set({ status: "IN_PROGRESS" }).where(eq(s.workOrders.id, workOrderId));
    const current = await order(workOrderId);
    await expect(cancelWorkOrder(workOrderId, TECH, {
      expectedVersion: Number(current.version),
      reason: "تعذّر التنفيذ فنّياً",
    })).rejects.toThrow(/بدأ تنفيذ الطلب/);
  });

  it("⭐ يفتح طلبَ إلغاءٍ لأمرٍ فيه عربون، ويعتمده مديرٌ فيُلغى ويُردّ المبلغ", async () => {
    const shiftId = await openReceptionShift();
    const workOrderId = await createOrder({ deposit: "2000.00" });
    const before = await order(workOrderId);

    const req = await requestWorkOrderControl({
      requestKey: "wo-tech-cancel-1",
      workOrderId,
      requestType: "CANCEL",
      baseVersion: Number(before.version),
      reason: "العميل ألغى الطلب وطلب استرداد العربون",
      payload: { refundShiftId: shiftId },
    }, TECH);
    expect(req.status).toBe("PENDING");
    expect(Number(req.requestedBy)).toBe(TECH.userId);
    // الطلبُ وحده صفرُ أثر — لا إلغاء ولا صرف.
    expect((await order(workOrderId)).status).toBe("RECEIVED");

    await approveWorkOrderControlRequest(Number(req.id), MANAGER);
    expect((await order(workOrderId)).status).toBe("CANCELLED");
    const refunds = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(2000);
  });

  it("⛔ لا يفتح الفنّيُّ تعديلاً تجارياً ولا تعديلَ خامةٍ ولا عكسَ تسليم", async () => {
    const workOrderId = await createOrder();
    const before = await order(workOrderId);
    const baseVersion = Number(before.version);

    await expect(requestWorkOrderControl({
      requestKey: "wo-tech-edit-1",
      workOrderId,
      requestType: "COMMERCIAL_EDIT",
      baseVersion,
      reason: "رفع السعر بطلب العميل",
      payload: { salePrice: "20000.00" },
    }, TECH)).rejects.toThrow(/كاشير أو مدير/);

    await expect(requestWorkOrderControl({
      requestKey: "wo-tech-mat-1",
      workOrderId,
      requestType: "MATERIAL_ADJUST",
      baseVersion,
      reason: "زيادة كمية الورق",
      payload: { materials: [{ variantId: 1, baseQuantity: 8 }] },
    }, TECH)).rejects.toThrow(/كاشير أو مدير/);

    await expect(requestWorkOrderControl({
      requestKey: "wo-tech-rev-1",
      workOrderId,
      requestType: "REVERSE_DELIVERY",
      baseVersion,
      reason: "عكس تسليم",
      payload: { expectedVersion: baseVersion, reopen: false, refundSources: [] },
    }, TECH)).rejects.toThrow(/كاشير أو مدير/);

    // ولا صفَّ طلبٍ واحد نشأ من المحاولات الثلاث.
    expect(await db().select().from(s.workOrderControlRequests)).toHaveLength(0);
  });
});

describe("تمهيدُ التحكّم كما يراه الفنّي", () => {
  it("⭐ يفصل «فيه مال» عن بوّابة المدير المتشدّدة", async () => {
    const clean = await createOrder();
    const cleanPre = await getWorkOrderControlPreflight(clean, TECH);
    // أسطرُ الخامة تُشعل بوّابةَ المدير القائمة…
    expect(cleanPre.controlRequired.cancel).toBe(true);
    // …ولا تُشعل شرطَ المال، وهو وحده ما يحكم الفنّي.
    expect(cleanPre.cancelMoneyAtStake).toBe(false);

    await openReceptionShift();
    const paid = await createOrder({ deposit: "2000.00" });
    const paidPre = await getWorkOrderControlPreflight(paid, TECH);
    expect(paidPre.cancelMoneyAtStake).toBe(true);
    expect(paidPre.cashRefundRequired).toBe(true);
  });

  /**
   * ⭐ **لا بابَ مسدوداً عند منتقي الدرج**: التمهيد يُعيد أدراجَ الفرع للفنّي كما يُعيدها
   * للكاشير، فطلبُ إلغاءِ أمرٍ فيه عربونٌ نقديّ يجد درجاً يختاره. وحجبُ **رقم** الرصيد شأنُ
   * `refundPreflight` وحدها (`exposeCash` بـ`treasury:READ`) — لا جوابان لسؤالٍ واحد.
   */
  it("⭐ يُعيد أدراج الفرع للفنّي كما للكاشير — فلا يقف طلبُه عند قائمةٍ فارغة", async () => {
    const shiftId = await openReceptionShift();
    const workOrderId = await createOrder({ deposit: "2000.00" });

    const techView = await getWorkOrderControlPreflight(workOrderId, TECH);
    const cashierView = await getWorkOrderControlPreflight(workOrderId, CASHIER);

    expect(techView.openReceptionShifts.map((shift) => shift.id)).toContain(shiftId);
    // نفسُ الأدراج للاثنين — الفارقُ في الإفصاح عن الرصيد وحده (`treasury:READ`).
    expect(techView.openReceptionShifts.map((shift) => shift.id))
      .toEqual(cashierView.openReceptionShifts.map((shift) => shift.id));
  });

  /**
   * ⭐ **سطحٌ ماليٌّ بلا فعلٍ يبرّره** (مراجعة Codex P1): توسيعُ التمهيد إلى أدوار التنفيذ كان
   * يُسلّم الفنّيَّ — بمجرّد فتح صفحة أمرٍ مُسلَّم — صافي المدفوع ومصادرَ الردّ وحالةَ تسوية
   * الإرسالية وأرصدةَ الأدراج، وهو **لا يملك طلبَ العكس أصلاً**.
   */
  it("⭐ لا يُسلّم الفنّيَّ سطحَ عكس التسليم ولا أرصدةَ الأدراج", async () => {
    await openReceptionShift();
    const workOrderId = await createOrder({ deposit: "2000.00" });
    // أمرٌ مُسلَّمٌ بفاتورة — الحالة الوحيدة التي يُحسَب فيها `reverseDelivery`.
    const invoiceId = extractInsertId(await db().insert(s.invoices).values({
      invoiceNumber: "INV-TECH-1", branchId: 1, customerId: 1, status: "PENDING",
      subtotal: "10000.00", total: "10000.00", paidAmount: "0.00", createdBy: CASHIER.userId,
    } as never));
    await db().update(s.workOrders)
      .set({ status: "DELIVERED", invoiceId })
      .where(eq(s.workOrders.id, workOrderId));

    const techView = await getWorkOrderControlPreflight(workOrderId, TECH);
    expect(techView.reverseDelivery).toBeNull();
    for (const shift of techView.openReceptionShifts) expect(shift.expectedCash).toBeNull();

    // والكاشير — صاحبُ طلب العكس — يراه كاملاً بأرصدته. والرصيدُ **حيٌّ** (`computeDrawerCashBalance`)
    // لا من عمود `shifts.expectedCash` اللقطيّ الذي يكون NULL لكلّ وردية مفتوحة — إصلاحُ «0 د.ع» (#930):
    // يكفي إثباتُ أنّه ظاهرٌ للكاشير (غيرُ null) محجوبٌ عن الفنّي.
    const cashierView = await getWorkOrderControlPreflight(workOrderId, CASHIER);
    expect(cashierView.reverseDelivery).not.toBeNull();
    expect(cashierView.openReceptionShifts.length).toBeGreaterThan(0);
    for (const shift of cashierView.openReceptionShifts) expect(shift.expectedCash).not.toBeNull();
  });

  it("⭐ الفنّي يختار درج الردّ في طلبه فيصرف المديرُ منه عند الاعتماد", async () => {
    const shiftId = await openReceptionShift();
    const workOrderId = await createOrder({ deposit: "2000.00" });
    const preflight = await getWorkOrderControlPreflight(workOrderId, TECH);
    // الدرجُ المعروض للفنّي هو الدرجُ الحقيقيّ نفسه — لا معرّفاً مموّهاً.
    expect(preflight.openReceptionShifts.map((shift) => shift.id)).toContain(shiftId);

    const req = await requestWorkOrderControl({
      requestKey: "wo-tech-cancel-drawer-1",
      workOrderId,
      requestType: "CANCEL",
      baseVersion: preflight.version,
      reason: "العميل ألغى الطلب واستلم عربونه",
      payload: { refundShiftId: preflight.openReceptionShifts[0].id },
    }, TECH);
    await approveWorkOrderControlRequest(Number(req.id), MANAGER);

    const refund = (await db().select().from(s.receipts)
      .where(eq(s.receipts.direction, "OUT")).limit(1))[0];
    expect(Number(refund.shiftId)).toBe(shiftId);
    expect(Number(refund.amount)).toBe(2000);
  });
});

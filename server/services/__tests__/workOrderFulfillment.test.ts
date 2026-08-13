/**
 * اختبارات updateWorkOrderDeliveryMethod (اِستقبال — تكامل التوصيل، ٤/٨):
 * تصنيف/إعادة تصنيف طريقة التسليم (استلام مباشر ⇄ توصيل) — السيناريو (ج): زبون غيّر رأيه.
 * حراسها: يُرفَض بعد DELIVERED/CANCELLED، يُرفَض عبر فرعٍ آخر، يتطلّب عنوان توصيل عند التفعيل،
 * لا يُعدَّل salePrice أبداً، ويحفظ deliveryPhone/deliveryCost بدلالة صريحة (لا تصفير صامت عند الحذف).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createWorkOrder } from "../workOrderService";
import { deliverWorkOrder } from "../workOrder/deliver";
import { updateWorkOrderDeliveryMethod } from "../workOrder/fulfillment";
import { openShift } from "../shiftService";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "shifts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "productPrices", "productUnits", "productVariants", "products",
  "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const CASHIER_B1 = { userId: 2, branchId: 1, role: "cashier" };
const CASHIER_B2 = { userId: 3, branchId: 2, role: "cashier" };
const MANAGER_B1 = { userId: 1, branchId: 1, role: "manager" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "mgr@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_c1", name: "كاشير ١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_c2", name: "كاشير ٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
}

/** أمر شغل بأجرة توصيل COUNTER + إيصال قبض الأمانة نقداً في الوردية المعطاة — كما يتركه create.ts. */
async function woWithCounterFee(id: number, shiftId: number, fee = "5000.00", createdBy = 2) {
  await db().insert(s.workOrders).values({
    id, orderNumber: `WO-${id}`, title: "طباعة", branchId: 1,
    status: "READY", hasDelivery: true, quantity: 1,
    salePrice: "10000.00", materialsCost: "0.00", laborCost: "0.00", deposit: "0.00",
    deliveryFeeCollection: "COUNTER", deliveryCost: fee, deliveryAddress: "بغداد", createdBy,
  });
  await db().insert(s.receipts).values({
    branchId: 1, shiftId, workOrderId: id,
    direction: "IN", amount: fee, paymentMethod: "CASH", cashBucket: "DRAWER",
    status: "COMPLETED", partyType: "OTHER", referenceNumber: `DLV-FEE-WO-${id}`, createdBy,
  });
}

/** صافي أمانة الأجرة المتبقّية (Σ IN−OUT) لأمر شغل. */
async function feeHeldNet(id: number): Promise<number> {
  const r = (await db()
    .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END),0)` })
    .from(s.receipts)
    .where(and(eq(s.receipts.workOrderId, id), eq(s.receipts.referenceNumber, `DLV-FEE-WO-${id}`))))[0];
  return Number(r.v);
}
async function feeOutCount(id: number): Promise<number> {
  const r = (await db()
    .select({ n: sql<number>`COUNT(*)` })
    .from(s.receipts)
    .where(and(eq(s.receipts.workOrderId, id), eq(s.receipts.referenceNumber, `DLV-FEE-WO-${id}`), eq(s.receipts.direction, "OUT"))))[0];
  return Number(r.n);
}

async function newWorkOrder(overrides?: Partial<{ hasDelivery: boolean; deliveryAddress: string | null; deliveryCost: string }>) {
  const res = await createWorkOrder(
    {
      branchId: 1,
      title: "أمر اختبار",
      salePrice: "10000",
      quantity: 1,
      hasDelivery: overrides?.hasDelivery ?? false,
      deliveryAddress: overrides?.deliveryAddress ?? null,
      deliveryCost: overrides?.deliveryCost,
    },
    CASHIER_B1,
  );
  return (res as { workOrderId: number }).workOrderId;
}

async function loadWo(id: number) {
  return (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)).limit(1))[0];
}

describe("updateWorkOrderDeliveryMethod — إعادة تصنيف التسليم", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يرفض التسليم المباشر لطلب مخصص للتوصيل ويبقيه READY بلا فاتورة", async () => {
    const woId = await newWorkOrder({ hasDelivery: true, deliveryAddress: "بغداد" });
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
    await expect(deliverWorkOrder({ workOrderId: woId }, CASHIER_B1)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const wo = await loadWo(woId);
    expect(wo.status).toBe("READY");
    expect(wo.invoiceId).toBeNull();
  });

  it("يرفض التعديل بعد DELIVERED", async () => {
    const woId = await newWorkOrder();
    await db().update(s.workOrders).set({ status: "DELIVERED" }).where(eq(s.workOrders.id, woId));
    await expect(
      updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد" }, CASHIER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض التعديل بعد CANCELLED", async () => {
    const woId = await newWorkOrder();
    await db().update(s.workOrders).set({ status: "CANCELLED" }).where(eq(s.workOrders.id, woId));
    await expect(
      updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد" }, CASHIER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض تعديل أمر فرعٍ آخر (عزل الفرع)", async () => {
    const woId = await newWorkOrder(); // فرع ١
    await expect(
      updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد" }, CASHIER_B2),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يتطلّب عنوان توصيل عند تفعيل التوصيل", async () => {
    const woId = await newWorkOrder();
    await expect(
      updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: true, deliveryAddress: "" }, CASHIER_B1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يسمح بالتصنيف في أي حالة نشطة (RECEIVED/IN_PROGRESS/READY) ولا يُعدَّل salePrice أبداً", async () => {
    const woId = await newWorkOrder();
    for (const status of ["RECEIVED", "IN_PROGRESS", "READY"] as const) {
      await db().update(s.workOrders).set({ status }).where(eq(s.workOrders.id, woId));
      const res = await updateWorkOrderDeliveryMethod(
        { workOrderId: woId, hasDelivery: true, deliveryAddress: `عنوان ${status}`, deliveryPhone: "+9647701111111" },
        CASHIER_B1,
      );
      expect(res.hasDelivery).toBe(true);
      const wo = await loadWo(woId);
      expect(wo.salePrice).toBe("10000.00"); // لم يُمسّ إطلاقاً بإعادة التصنيف
    }
  });

  it("يحفظ deliveryPhone ويُعيده عند إعادة التصنيف إلى توصيل", async () => {
    const woId = await newWorkOrder();
    await updateWorkOrderDeliveryMethod(
      { workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد - الكرادة", deliveryPhone: "07701234567" },
      CASHIER_B1,
    );
    const wo = await loadWo(woId);
    expect(wo.hasDelivery).toBe(true);
    expect(wo.deliveryAddress).toBe("بغداد - الكرادة");
    expect(wo.deliveryPhone).toBe("07701234567");
  });

  it("لا يُصفِّر deliveryCost صامتاً حين يُحذَف من المدخل — يبقى كما هو", async () => {
    const woId = await newWorkOrder({ hasDelivery: true, deliveryAddress: "بغداد", deliveryCost: "5000" });
    expect((await loadWo(woId)).deliveryCost).toBe("5000.00");

    // إعادة تصنيف بلا ذكر deliveryCost إطلاقاً (undefined) ⇒ يجب أن يبقى ٥٠٠٠ لا أن يُصفَّر.
    await updateWorkOrderDeliveryMethod(
      { workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد - عنوان محدَّث" },
      CASHIER_B1,
    );
    expect((await loadWo(woId)).deliveryCost).toBe("5000.00");

    // تمرير صريح يُطبَّق كالمعتاد.
    await updateWorkOrderDeliveryMethod(
      { workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد", deliveryCost: "2000" },
      CASHIER_B1,
    );
    expect((await loadWo(woId)).deliveryCost).toBe("2000.00");
  });

  it("إعادة تصنيف توصيل ⇄ استلام مباشر متعدّدة المرّات (السيناريو ج) تبقى متّسقة", async () => {
    const woId = await newWorkOrder();
    await updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد" }, CASHIER_B1);
    expect((await loadWo(woId)).hasDelivery).toBe(true);

    await updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: false, deliveryAddress: null }, CASHIER_B1);
    expect((await loadWo(woId)).hasDelivery).toBe(false);

    await updateWorkOrderDeliveryMethod({ workOrderId: woId, hasDelivery: true, deliveryAddress: "بغداد مجدداً" }, CASHIER_B1);
    const wo = await loadWo(woId);
    expect(wo.hasDelivery).toBe(true);
    expect(wo.deliveryAddress).toBe("بغداد مجدداً");
  });
});

// ردّ أمانة أجرة COUNTER عند التحوّل لاستلامٍ مباشر — شريحةٌ محكومة (١٠/٨، بعد سحب المحاولة
// التلقائية الصامتة من PR #531): تأكيدٌ صريح + حوكمة refundDeposit + معالجة إعادة التفعيل + idempotent.
describe("updateWorkOrderDeliveryMethod — ردّ أمانة أجرة COUNTER بحوكمة", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("بلا تأكيد الصرف ⇒ يُرفض ولا حركة نقد (لا عجز درجٍ صامت)", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER_B1);
    await woWithCounterFee(960, shift.shiftId);
    await expect(
      updateWorkOrderDeliveryMethod({ workOrderId: 960, hasDelivery: false, deliveryAddress: null }, CASHIER_B1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await feeHeldNet(960)).toBe(5000); // لم تُردّ
    expect((await loadWo(960)).hasDelivery).toBe(true); // ولم يتحوّل (تراجع كامل)
  });

  it("تأكيد الصرف ضمن وردية القبض المفتوحة ⇒ ردٌّ ذاتيّ (OUT+قيد سالب) + إعادة الوسم COURIER + idempotent", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER_B1);
    await woWithCounterFee(961, shift.shiftId);
    const res = await updateWorkOrderDeliveryMethod(
      { workOrderId: 961, hasDelivery: false, deliveryAddress: null, confirmFeeRefund: true, refundShiftId: shift.shiftId },
      CASHIER_B1,
    );
    expect((res as { refundedFee: string }).refundedFee).toBe("5000.00");
    expect(await feeHeldNet(961)).toBe(0);
    expect(await feeOutCount(961)).toBe(1);
    const wo = await loadWo(961);
    expect(wo.hasDelivery).toBe(false);
    expect(wo.deliveryFeeCollection).toBe("COURIER"); // إعادة التفعيل لن يرفضها مسار الإرسال
    const entry = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "DELIVERY_FEE_HELD")))[0];
    expect(String(entry.amount)).toBe("-5000.00");

    // idempotent: إعادة توصيل ثم تحوّل ثانٍ لا يردّ مرّتين.
    await updateWorkOrderDeliveryMethod({ workOrderId: 961, hasDelivery: true, deliveryAddress: "بغداد" }, CASHIER_B1);
    const again = await updateWorkOrderDeliveryMethod(
      { workOrderId: 961, hasDelivery: false, deliveryAddress: null, confirmFeeRefund: true, refundShiftId: shift.shiftId },
      CASHIER_B1,
    );
    expect((again as { refundedFee: string }).refundedFee).toBe("0.00");
    expect(await feeOutCount(961)).toBe(1); // لا OUT ثانٍ
  });

  it("ردٌّ عبر ورديةٍ ليست وردية القبض ⇒ FORBIDDEN بلا اعتماد، ويمرّ باعتماد مدير", async () => {
    // القبض في وردية مدير (user 1) — الكاشير (user 2) ليس صاحبها المفتوح.
    const collShift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, MANAGER_B1);
    await woWithCounterFee(962, collShift.shiftId, "5000.00", 1);
    await expect(
      updateWorkOrderDeliveryMethod(
        { workOrderId: 962, hasDelivery: false, deliveryAddress: null, confirmFeeRefund: true, refundShiftId: collShift.shiftId },
        CASHIER_B1,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await feeHeldNet(962)).toBe(5000); // لم تُردّ

    const res = await updateWorkOrderDeliveryMethod(
      { workOrderId: 962, hasDelivery: false, deliveryAddress: null, confirmFeeRefund: true, refundShiftId: collShift.shiftId, authorizedByManager: true },
      CASHIER_B1,
    );
    expect((res as { refundedFee: string }).refundedFee).toBe("5000.00");
    expect(await feeHeldNet(962)).toBe(0);
  });

  it("المدير يتجاوز الحوكمة (elevated) — يردّ حتى عبر ورديةٍ ليست له، مع تأكيد الصرف", async () => {
    const collShift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER_B1);
    await woWithCounterFee(963, collShift.shiftId, "5000.00", 2);
    const res = await updateWorkOrderDeliveryMethod(
      { workOrderId: 963, hasDelivery: false, deliveryAddress: null, confirmFeeRefund: true, refundShiftId: collShift.shiftId },
      MANAGER_B1,
    );
    expect((res as { refundedFee: string }).refundedFee).toBe("5000.00");
    expect(await feeHeldNet(963)).toBe(0);
  });
});

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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 2, openId: "local_c1", name: "كاشير ١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_c2", name: "كاشير ٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
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

  // Fee-F1 (مراجعة نهائية ١٠/٨): أمانة أجرة COUNTER تُقبَض في الدرج عند الإنشاء ومبرِّئوها الإرسال
  // أو الإلغاء فقط. التحوّل لاستلامٍ مباشر (hasDelivery:false) ثم التسليم كان يترك الأمانة عالقةً في
  // الدرج للأبد (Σ FEE_HELD موجب دائم + نقد زبونٍ بلا مسار ردّ). الآن يردّها هذا المسار idempotent.
  it("التحوّل لاستلام مباشر يردّ أمانة أجرة COUNTER غير المصروفة (نقداً من الدرج) — مرّةً واحدة", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER_B1);
    // أمر شغل بأجرة COUNTER (٥٠٠٠) + إيصال القبض الأمانة في الدرج — كما يتركه create.ts.
    await db().insert(s.workOrders).values({
      id: 950, orderNumber: "WO-950", title: "طباعة", branchId: 1,
      status: "READY", hasDelivery: true, quantity: 1,
      salePrice: "10000.00", materialsCost: "0.00", laborCost: "0.00", deposit: "0.00",
      deliveryFeeCollection: "COUNTER", deliveryCost: "5000.00", deliveryAddress: "بغداد", createdBy: 2,
    });
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: shift.shiftId, workOrderId: 950,
      direction: "IN", amount: "5000.00", paymentMethod: "CASH", cashBucket: "DRAWER",
      status: "COMPLETED", partyType: "OTHER", referenceNumber: "DLV-FEE-WO-950", createdBy: 2,
    });

    const res = await updateWorkOrderDeliveryMethod(
      { workOrderId: 950, hasDelivery: false, deliveryAddress: null, refundShiftId: shift.shiftId },
      CASHIER_B1,
    );
    expect((res as { refundedFee: string }).refundedFee).toBe("5000.00");
    expect((await loadWo(950)).hasDelivery).toBe(false);
    // إيصال ردّ OUT بنفس مرجع الأمانة + قيد FEE_HELD سالب (Σ الأمانة عاد صفراً).
    const outR = (await db().select().from(s.receipts)
      .where(and(eq(s.receipts.referenceNumber, "DLV-FEE-WO-950"), eq(s.receipts.direction, "OUT"))))[0];
    expect(outR).toBeTruthy();
    expect(String(outR.amount)).toBe("5000.00");
    const feeHeldNet = (await db()
      .select({ v: sql<string>`COALESCE(SUM(${s.accountingEntries.amount}), 0)` })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DELIVERY_FEE_HELD")))[0];
    expect(Number(feeHeldNet.v)).toBe(-5000); // قيد الردّ السالب وحده (لم نُدرِج قيد القبض الموجب في التجهيز)

    // idempotent: تحوّلٌ ثانٍ (تذبذب التصنيف) لا يردّ مرّةً ثانية.
    await updateWorkOrderDeliveryMethod({ workOrderId: 950, hasDelivery: true, deliveryAddress: "بغداد" }, CASHIER_B1);
    const again = await updateWorkOrderDeliveryMethod(
      { workOrderId: 950, hasDelivery: false, deliveryAddress: null, refundShiftId: shift.shiftId },
      CASHIER_B1,
    );
    expect((again as { refundedFee: string }).refundedFee).toBe("0.00"); // Σ(IN−OUT)=0 ⇒ لا ردّ ثانٍ
    const outCount = (await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.receipts)
      .where(and(eq(s.receipts.referenceNumber, "DLV-FEE-WO-950"), eq(s.receipts.direction, "OUT"))))[0];
    expect(Number(outCount.n)).toBe(1); // إيصال ردٍّ واحد فقط
  });
});

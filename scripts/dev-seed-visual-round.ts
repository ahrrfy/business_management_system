/**
 * بذرةُ **الجولة البصرية** لحملة الفواتير/الطلبات — تطويريّة محضة (٢٠/٨).
 *
 * تبني السيناريوهات الأربعة التي تحتاج عيناً لا اختباراً:
 *  ① أمرٌ **قيد التنفيذ بخامةٍ مستهلَكة فعلاً** ⇒ جدولُ الهدر في حوار الإلغاء له صفوف.
 *  ② أمرٌ **خدميّ خالصٌ مُسلَّم** ⇒ زرّ «استرجاع الطلب المُسلَّم» يظهر.
 *  ③ أمرٌ **بلا منفّذ** + ④ أمرٌ **جاهزٌ منذ ١٠ أيّام** ⇒ طابورا الكوكبِت.
 *  ⑤ مهمّةٌ **حاجزة مفتوحة** ⇒ طابور «بانتظار موافقة العميل».
 *
 * يرفض العمل على قاعدةٍ غير تطويرية.
 */
import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { getDb } from "../server/db";
import { createWorkOrder } from "../server/services/workOrder/create";
import { startWorkOrder } from "../server/services/workOrder/lifecycle";
import { deliverWorkOrder } from "../server/services/workOrder/deliver";

if (!/_dev(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("قاعدة غير تطويرية — أوقفت.");
  process.exit(1);
}
const db = getDb()!;
const SARA = { userId: 3, branchId: 1, role: "cashier" as const };

async function main() {
  // عميلٌ بلا سقف ائتمان (يسمح بالآجل) — البذرةُ العامّة تُنشئ الجميع نقديّاً فقط.
  let custId: number;
  const existing = (await db.select().from(s.customers).where(eq(s.customers.name, "زبون الجولة البصرية")).limit(1))[0];
  if (existing) custId = Number(existing.id);
  else {
    const r = await db.insert(s.customers).values({
      name: "زبون الجولة البصرية", phone: "07701234567",
      currentBalance: "0.00", creditLimit: null, branchId: 1,
    } as never);
    custId = Number((r as unknown as { insertId: number }[])[0].insertId);
  }

  // خامةٌ حقيقيّة برصيدٍ كافٍ — بلا هذا لا صفوفَ في جدول الهدر.
  const variant = (await db.select().from(s.productVariants).limit(1))[0];
  if (!variant) throw new Error("لا متغيّرات منتجات — شغّل pnpm seed أوّلاً");
  const vId = Number(variant.id);
  await db.update(s.productVariants).set({ costPrice: "1500.00" }).where(eq(s.productVariants.id, vId));
  const stock = (await db.select().from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, vId), eq(s.branchStock.branchId, 1))).limit(1))[0];
  if (stock) await db.update(s.branchStock).set({ quantity: 500 })
    .where(and(eq(s.branchStock.variantId, vId), eq(s.branchStock.branchId, 1)));
  else await db.insert(s.branchStock).values({ variantId: vId, branchId: 1, quantity: 500 } as never);

  // ① قيد التنفيذ بخامةٍ مستهلَكة فعلاً (عبر startWorkOrder — لا تحديثِ حالةٍ مباشر).
  const a = await createWorkOrder({
    branchId: 1, customerId: custId, title: "لوحة إعلانية ٤×٢ — للجولة البصرية", quantity: 1,
    salePrice: "150000.00", deposit: "0", materials: [{ variantId: vId, baseQuantity: 12 }],
    receptionChannel: "WHATSAPP", channelHandle: "+9647701234567", priority: "URGENT",
    clientRequestId: "vr-inprogress",
  } as never, SARA);
  const aId = Number((a as { workOrderId: number }).workOrderId);
  // idempotent: إعادةُ التشغيل تُرجع الأمر القائم بحالته — فلا نُعيد بدأه.
  const aRow = (await db.select().from(s.workOrders).where(eq(s.workOrders.id, aId)).limit(1))[0];
  if (aRow?.status === "RECEIVED") await startWorkOrder(aId, SARA);

  // ② خدميّ خالصٌ مُسلَّم (بلا baseVariantId ⇒ فاتورةٌ بلا بنود = الحالة المسدودة سابقاً).
  const b = await createWorkOrder({
    branchId: 1, customerId: custId, title: "تصميم شعار — خدمة خالصة", quantity: 1,
    salePrice: "90000.00", deposit: "0", materials: [],
    receptionChannel: "PHONE", channelHandle: "+9647702223344",
    clientRequestId: "vr-delivered",
  } as never, SARA);
  const bId = Number((b as { workOrderId: number }).workOrderId);
  const bRow = (await db.select().from(s.workOrders).where(eq(s.workOrders.id, bId)).limit(1))[0];
  if (bRow?.status !== "DELIVERED") {
  await db.update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, bId));
  await deliverWorkOrder(
    { workOrderId: bId, payment: { amount: "40000.00", method: "CASH" }, clientRequestId: "vr-deliver" } as never,
    SARA as never,
  );
  }

  // ③ بلا منفّذ.
  const c = await createWorkOrder({
    branchId: 1, customerId: custId, title: "أختام مطاطية ×٥ — لم يسحبه أحد", quantity: 5,
    salePrice: "35000.00", deposit: "0", materials: [], receptionChannel: "WALK_IN",
    clientRequestId: "vr-unassigned",
  } as never, SARA);
  await db.update(s.workOrders).set({ assignedTo: null })
    .where(eq(s.workOrders.id, Number((c as { workOrderId: number }).workOrderId)));

  // ④ جاهزٌ منذ ١٠ أيّام (لحظةُ الجاهزية مشتقّة: workStartedAt + workSeconds).
  const d = await createWorkOrder({
    branchId: 1, customerId: custId, title: "كروت شخصية ١٠٠٠ — لم يحضر صاحبها", quantity: 1000,
    salePrice: "70000.00", deposit: "0", materials: [], receptionChannel: "WALK_IN",
    clientRequestId: "vr-stale",
  } as never, SARA);
  const dId = Number((d as { workOrderId: number }).workOrderId);
  await db.execute(sql`
    UPDATE workOrders
       SET workOrderStatus = 'READY',
           workStartedAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 DAY),
           workSeconds = 86400
     WHERE id = ${dId}
  `);

  // ⑤ مهمّةٌ حاجزةٌ مفتوحة على أمرٍ نشط.
  const st = (await db.select().from(s.serviceTypes).where(eq(s.serviceTypes.name, "موافقة تصميم")).limit(1))[0];
  if (st) {
    const e = await createWorkOrder({
      branchId: 1, customerId: custId, title: "بروشور A5 — بانتظار موافقة العميل", quantity: 200,
      salePrice: "60000.00", deposit: "0", materials: [], receptionChannel: "INSTAGRAM",
      clientRequestId: "vr-awaiting",
    } as never, SARA);
    const eId = Number((e as { workOrderId: number }).workOrderId);
    const existingTask = (await db.select().from(s.tasks).where(eq(s.tasks.linkedWorkOrderId, eId)).limit(1))[0];
    if (!existingTask) {
      await db.insert(s.tasks).values({
        taskNumber: `TSK-VR-${eId}`, branchId: 1, title: "موافقة العميل على التصميم",
        serviceTypeId: Number(st.id), taskStatus: "WAITING_CUSTOMER",
        linkedWorkOrderId: eId, customerId: custId, createdBy: 3,
      } as never);
    }
  } else {
    console.log("تنبيه: نوع الخدمة «موافقة تصميم» غير مبذور — تخطّيتُ السيناريو ⑤.");
  }

  const rows = await db.select({
    id: s.workOrders.id, n: s.workOrders.orderNumber, title: s.workOrders.title,
    st: s.workOrders.status, assigned: s.workOrders.assignedTo, inv: s.workOrders.invoiceId,
  }).from(s.workOrders);
  console.table(rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

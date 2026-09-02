// أدوات داخلية: ترقيم الأمر، تحميله تحت قفل صفّ، وعزل الفرع/المحطة — لا تُصدَّر من نقطة الدخول العامة.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { deliveryConsignments, serviceTypes, tasks, workOrders } from "../../../drizzle/schema";
import { nextCounterValue } from "../numbering";
import type { Actor } from "../tx";

/**
 * رقم أمر الشغل — **عددٌ تسلسليّ قصير** يبدأ من 5001 (طلب المالك ١٨/٨؛ نطاقٌ متباعدٌ عن
 * الفواتير 10001+ كي يُميَّز نوع المستند بالنظر). التفصيل والمقايضة في `services/numbering.ts`.
 *
 * الصيغة القديمة `WO-{فرع}-{YYYYMMDD}-{تسلسل}` كانت تُولَّد بمسح `LIKE` + `MAX+1` **بلا
 * GET_LOCK إطلاقاً** — أحدُ سبعة مولّدات على النمط الذي وُصف صراحةً بأنه غير كافٍ ضدّ السباق.
 * العدّاد الذرّيّ يُنهي ذلك بنيوياً (القيد الفريد يبقى الحارس الأخير).
 */
async function nextWorkOrderNumber(tx: any, _branchId: number): Promise<string> {
  return String(await nextCounterValue(tx, "workOrder"));
}

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  return rows[0];
}

/**
 * هويةُ مستند التسليم التجاريّ لأمر الشغل.
 *
 * لا يجوز استعمال `WO-{id}` وحده: الفاتورة المرتجعة تبقى سجلاً تاريخياً تحت القيد الفريد
 * `(sourceType, sourceId)`، فيصطدم بها التسليم المصحّح بعد `reopen`. نسخة الأمر ترتفع من
 * trigger لكل انتقال، والأمر مقفول قبل إنشاء الفاتورة، لذلك تشكّل revision مستقراً ومشتركاً
 * بين التسليم المباشر والإرسال للتوصيل بلا عدّادٍ ثانٍ قابل للانجراف.
 */
function workOrderInvoiceSourceId(wo: { id: number | string; version: number | string }): string {
  const id = Number(wo.id);
  const version = Number(wo.version);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(version) || version <= 0) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر اشتقاق نسخة مستند أمر الشغل" });
  }
  return `WO-${id}:R${version}`;
}

/** عزل الفرع: أيّ عملية مال على طلب الخدمة تُجبَر فرع الفاعل. عزل مدير الفرع (قرار المالك ١٢/٨):
 *  المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير صار مقيَّداً بفرعه. يُمرَّر actor.role من الراوتر. */
function assertWorkOrderBranch(wo: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin";
  if (elevated) return;
  if (Number(wo.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب الخدمة لا يخصّ فرعك" });
  }
}

/**
 * عزل المحطة: فني المطبعة (print_operator) ينفّذ أوامره المُسنَدة إليه فقط — لا أوامر زملائه.
 * الكاشير/المدير/الأدمن (مكتب الاستقبال) يُنفّذون أي أمر في فرعهم (مرونة تشغيلية). يُستدعى بعد
 * فحص الفرع في start/markReady. السحب (claim) هو ما يجعل أمراً «أمري» قبل التنفيذ.
 */
function assertOperatorOwns(
  wo: { assignedTo: number | string | null },
  actor: Actor & { role?: string },
) {
  if (actor.role !== "print_operator") return;
  if (wo.assignedTo == null || Number(wo.assignedTo) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "اسحب الأمر إلى قائمتك أولاً لتنفيذه" });
  }
}


/**
 * حارس **الإرسالية الحيّة** (١٨/٨) — يمنع كل عمليةٍ تفترض أنّ البضاعة ما زالت في المكتبة
 * بينما هي بيد المندوب فعلاً.
 *
 * لماذا لم يكن فحصُ الحالة كافياً: الإسناد **لا يمسّ** `workOrders.status` عمداً (يبقى READY
 * حتى إثبات التسليم)، فكلّ حارسٍ يفحص الحالة وحدها كان أعمى عن الطرد الخارج. النتائج التي
 * أثبتها الفحص: إلغاءُ أمرٍ خارجٍ مع مندوب يُعيد مواده للمخزون ويردّ عربونه بينما الفاتورة
 * وقيدُ البيع وذمّةُ العميل وعهدةُ COD كلّها حيّة؛ وقلبُ `hasDelivery` يردّ أمانة الأجرة
 * والطرد بالخارج؛ والتسليم المباشر يُنشئ فاتورةً وقيدَ بيعٍ **ثانيَين**.
 *
 * المخرج المشروع في كل هذه الحالات واحد: **استرجاع الإرسالية** (عكسٌ كامل Σ=0).
 */
async function assertNoLiveConsignment(
  tx: any,
  workOrderId: number,
  action: "cancel" | "reclassify" | "deliver" | "reverse",
) {
  const rows = await tx
    .select({ id: deliveryConsignments.id, number: deliveryConsignments.consignmentNumber })
    .from(deliveryConsignments)
    .where(
      and(
        eq(deliveryConsignments.workOrderId, workOrderId),
        notInArray(deliveryConsignments.status, ["CANCELLED", "RETURNED"]),
      ),
    )
    .limit(1);
  const live = rows[0];
  if (!live) return;
  const what = action === "cancel"
    ? "لا يُلغى أمرٌ خرج مع مندوب"
    : action === "reclassify"
      ? "لا تُغيَّر طريقة تسليم أمرٍ خرج مع مندوب"
      : action === "reverse"
        // العكسُ يُسقط الذمّة بينما عهدةُ المندوب وتحصيلُه قائمان ⇒ نقدٌ بلا مالك.
        ? "لا يُسترجَع أمرٌ ما زال مع مندوب"
        : "لا يُسلَّم مباشرةً أمرٌ خرج مع مندوب";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${what} (الإرسالية ${live.number ?? live.id}) — استرجع الإرسالية أولاً من إدارة التوصيل، وهي تعكس البيع والمخزون والعربون معاً.`,
  });
}

/**
 * **حارس المهمّة الحاجزة** (ش٢، ١٩/٨) — على نمط `assertNoLiveConsignment` حرفياً.
 *
 * الحجزُ يُقرأ من الواقع لا من عَلَم: «هل لهذا الأمر مهمّةٌ مفتوحةٌ نوعُها حاجز؟». وبهذا
 * **تبطل الموافقة السابقة بحكم البناء** حين تُفتَح مهمّةٌ جديدة لنسخة تصميمٍ جديدة — لا
 * عَلَمَ `approved` ثانٍ يمكن أن ينجرف عن الواقع فيُنتَج تصميمٌ لم يُقرَّ.
 *
 * ⛔ **يُستدعى قبل أيّ قفلٍ أو حركة** (قبل `branchStock` في `startWorkOrder`) ⇒ يفشل مغلقاً
 * بلا حركةِ مخزونٍ ولا قيدٍ ولا صفٍّ يُترك خلفه.
 *
 * `WAITING_CUSTOMER` **تحجز أيضاً**: انتظارُ ردّ العميل هو عينُ سبب الحجز، لا استثناءٌ منه.
 */
async function assertNoBlockingTask(
  tx: any,
  workOrderId: number,
  action: "start" | "ready",
) {
  const rows = await tx
    .select({ id: tasks.id, number: tasks.taskNumber, title: tasks.title })
    .from(tasks)
    .innerJoin(serviceTypes, eq(serviceTypes.id, tasks.serviceTypeId))
    .where(
      and(
        eq(tasks.linkedWorkOrderId, workOrderId),
        inArray(tasks.taskStatus, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"]),
        eq(serviceTypes.blocksExecution, true),
      ),
    )
    .limit(1);
  const blocking = rows[0];
  if (!blocking) return;
  const what = action === "start"
    ? "لا يبدأ التنفيذ قبل إغلاق"
    : "لا يُوسَم الأمر جاهزاً قبل إغلاق";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${what} «${blocking.title}» (${blocking.number}) — سجّل موافقة العميل من بطاقة التصميم، أو أغلق المهمّة بسببٍ من شاشة المهام.`,
  });
}

export { nextWorkOrderNumber, loadWorkOrder, workOrderInvoiceSourceId, assertWorkOrderBranch, assertOperatorOwns, assertNoLiveConsignment, assertNoBlockingTask };

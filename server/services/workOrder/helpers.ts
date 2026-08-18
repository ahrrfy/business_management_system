// أدوات داخلية: ترقيم الأمر، تحميله تحت قفل صفّ، وعزل الفرع/المحطة — لا تُصدَّر من نقطة الدخول العامة.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, notInArray } from "drizzle-orm";
import { deliveryConsignments, workOrders } from "../../../drizzle/schema";
import { toDateStr } from "../money";
import type { Actor } from "../tx";

async function nextWorkOrderNumber(tx: any, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `WO-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: workOrders.orderNumber })
    .from(workOrders)
    .where(like(workOrders.orderNumber, `${prefix}%`))
    .orderBy(desc(workOrders.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  return rows[0];
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
  action: "cancel" | "reclassify" | "deliver",
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
      : "لا يُسلَّم مباشرةً أمرٌ خرج مع مندوب";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${what} (الإرسالية ${live.number ?? live.id}) — استرجع الإرسالية أولاً من إدارة التوصيل، وهي تعكس البيع والمخزون والعربون معاً.`,
  });
}

export { nextWorkOrderNumber, loadWorkOrder, assertWorkOrderBranch, assertOperatorOwns, assertNoLiveConsignment };

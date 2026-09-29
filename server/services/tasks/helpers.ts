// أدوات داخلية لنظام المهام: ترقيم المهمة، تحميلها تحت قفل صفّ، وعزل الفرع/الموظف — نمط
// server/services/workOrder/helpers.ts حرفياً (لا تُصدَّر من نقطة الدخول العامة index.ts).
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { desc, eq, like } from "drizzle-orm";
import { tasks } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDateStr } from "../money";
import type { Actor } from "../tx";

/** TSK-{فرع}-{YYYYMMDD}-{تسلسل ٥ خانات} — نفس نمط nextWorkOrderNumber/nextQuoteNumber
 *  (بادئة + LIKE + FOR UPDATE لمنع سباق الترقيم). التاريخ UTC عبر toDateStr (لا new Date محلي). */
export async function nextTaskNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `TSK-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: tasks.taskNumber })
    .from(tasks)
    .where(like(tasks.taskNumber, `${prefix}%`))
    .orderBy(desc(tasks.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** يحمّل المهمة تحت قفل صفّ (FOR UPDATE) — يرمي NOT_FOUND إن غابت. */
export async function loadTask(tx: Tx, id: number) {
  const rows = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update").limit(1);
  if (!rows[0]) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "المهمة غير موجودة",
        why: `لم يتم العثور على مهمة بالمعرّف ${id}`,
        doThis: "تحقق من رقم المهمة أو أعد تحميل القائمة",
      }),
    });
  }
  return rows[0];
}

/** عزل الفرع (قرار المالك ١٢/٨: عزل مدير الفرع): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛
 *  المدير مقيَّدٌ بفرعه فيُرفَض إن كانت المهمة لفرعٍ آخر (نمط assertWorkOrderBranch). */
export function assertTaskBranch(task: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin";
  if (elevated) return;
  if (Number(task.branchId) !== actor.branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "المهمة لا تخصّ فرعك",
        why: `المهمة مسندة للفرع ${task.branchId} بينما فرعك الحالي ${actor.branchId}`,
        doThis: "بدّل الفرع إذا كنت تملك صلاحية العبور أو راجع مسؤول الفرع المعني",
      }),
    });
  }
}

/**
 * عزل نطاق الموظف — **للكتابات الفعلية «بنطاق واسع» فقط** (addComment): غير المرتفع يعمل حصراً
 * على مهمّة أسندها لنفسه أو أنشأها (assignedTo=هو ∪ createdBy=هو) — **لا** يشمل الطابور غير المسند
 * (بخلاف `isTaskVisibleToOwnerScope` أدناه المُستعمَلة للقراءة والسحب). admin/manager يعبُران دائماً.
 */
export function assertTaskActorScope(
  task: { assignedTo: number | string | null; createdBy: number | string | null },
  actor: Actor & { role?: string },
) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  const isAssignee = task.assignedTo != null && Number(task.assignedTo) === actor.userId;
  const isCreator = task.createdBy != null && Number(task.createdBy) === actor.userId;
  if (!isAssignee && !isCreator) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "هذه المهمة لا تخصّك",
        why: "لست صاحب المهمة ولا الموظف المسند إليه",
        doThis: "يمكنك فقط تعديل أو التعليق على المهام المسندة إليك أو التي أنشأتها",
      }),
    });
  }
}

/**
 * شرط الرؤية للقراءة (listTasks/getTask) لغير المرتفع — **أوسع** من `assertTaskActorScope`: يضيف
 * الطابور الوارد غير المسند (مهمة NEW بلا assignedTo) — مرئيٌّ لكل منفّذي الفرع ليسحبه أيّهم (نمط
 * أمر الشغل RECEIVED غير المسند/claimWorkOrder). المسندة لغيرك أو المغلقة لغيرك تبقى محجوبة.
 * المُستدعي مسؤول عن عزل الفرع (scopedBranchId) بمعزل عن هذه الدالة.
 */
export function isTaskVisibleToOwnerScope(
  task: { assignedTo: number | string | null; createdBy: number | string | null; taskStatus: string },
  scopedOwnerId: number,
): boolean {
  const isAssignee = task.assignedTo != null && Number(task.assignedTo) === scopedOwnerId;
  const isCreator = task.createdBy != null && Number(task.createdBy) === scopedOwnerId;
  const isUnassignedQueue = task.assignedTo == null && task.taskStatus === "NEW";
  return isAssignee || isCreator || isUnassignedQueue;
}

/**
 * عزل أضيق لانتقالات تنفيذ العمل (setWaiting/resumeTask/resolveTask): المُسنَد إليه فعلياً وحده
 * (لا صاحب الإنشاء) — أو مدير/أدمن. `allowSystem` يسمح لفاعلٍ نظاميّ (role="system", بلا مستخدم
 * بشريّ) بالعبور أيضاً — يُستعمل مستقبلاً لاستئناف تلقائي عند ردّ العميل (لا مستدعٍ حالياً).
 */
export function assertTaskAssigneeOrElevated(
  task: { assignedTo: number | string | null },
  actor: Actor & { role?: string },
  opts?: { allowSystem?: boolean },
) {
  const elevated = actor.role === "admin" || actor.role === "manager" || (opts?.allowSystem && actor.role === "system");
  if (elevated) return;
  if (task.assignedTo == null || Number(task.assignedTo) !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "هذه المهمة مُسنَدة لموظف آخر",
        why: `المهمة قيد معالجة موظف آخر وليست مسندة لمعرفك (${actor.userId})`,
        doThis: "اطلب من المسؤول إعادة إسناد المهمة أو تواصل مع الموظف المكلّف",
      }),
    });
  }
}

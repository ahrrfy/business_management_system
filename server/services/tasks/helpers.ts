// أدوات داخلية لنظام المهام: ترقيم المهمة، تحميلها تحت قفل صفّ، وعزل الفرع/الموظف — نمط
// server/services/workOrder/helpers.ts حرفياً (لا تُصدَّر من نقطة الدخول العامة index.ts).
import { TRPCError } from "@trpc/server";
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
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "المهمة غير موجودة" });
  return rows[0];
}

/** عزل الفرع: admin/manager يعبُران؛ غيرهما يُرفَض إن كانت المهمة لفرع آخر (نمط assertWorkOrderBranch). */
export function assertTaskBranch(task: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(task.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المهمة لا تخصّ فرعك" });
  }
}

/**
 * عزل نطاق الموظف — للقراءة (list/get) وللكتابات «بنطاق واسع» (addComment): غير المرتفع يعمل فقط
 * على مهمّة أسندها لنفسه أو أنشأها (assignedTo=هو ∪ createdBy=هو). admin/manager يعبُران دائماً.
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
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه المهمة لا تخصّك" });
  }
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
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه المهمة مُسنَدة لموظف آخر" });
  }
}

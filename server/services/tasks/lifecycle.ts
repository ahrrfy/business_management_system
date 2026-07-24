// آلة حالات المهمة (FSM) — نمط server/services/workOrder/lifecycle.ts: كل دالة withTx + تحميل
// تحت قفل + فحص انتقال صريح (if) + assertTaskBranch + تسجيل taskEvent.
//
// جدول الانتقالات (راجع docs/whatsapp-hub-design-2026-07-23.md):
//   claim:       NEW → IN_PROGRESS            (أي منفّذ — لا سرقة: assignedTo null أو =الفاعل)
//   assign:      أي حالة مفتوحة، بلا تغيير حالة (مدير)
//   setWaiting:  NEW/IN_PROGRESS → WAITING_CUSTOMER   (المُسنَد إليه أو مدير)
//   resumeTask:  WAITING_CUSTOMER → IN_PROGRESS        (المُسنَد/مدير/نظام)
//   resolveTask: IN_PROGRESS/WAITING_CUSTOMER → RESOLVED (المُسنَد/مدير)
//   reopenTask:  RESOLVED → IN_PROGRESS (≤٧ أيام)       (مدير)
//   cancelTask:  NEW/IN_PROGRESS/WAITING_CUSTOMER → CANCELLED (مدير)
//   addComment:  بلا تغيير حالة (تنفيذ بنطاق الموظف)
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { conversations, taskEvents, tasks, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { logger } from "../../logger";
import { type Actor, requireDb, withTx } from "../tx";
import { checkAutomationGate, enqueueAndDispatch } from "../whatsapp";
import { assertTaskActorScope, assertTaskAssigneeOrElevated, assertTaskBranch, loadTask } from "./helpers";

type TaskEventType = "COMMENT" | "STATUS" | "ASSIGN" | "LINK" | "SYSTEM" | "CSAT";
type TaskActor = Actor & { role?: string };

const OPEN_STATUSES = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"] as const;

async function insertEvent(
  tx: Tx,
  params: { taskId: number; eventType: TaskEventType; fromStatus?: string | null; toStatus?: string | null; note?: string | null; userId?: number | null },
) {
  await tx.insert(taskEvents).values({
    taskId: params.taskId,
    eventType: params.eventType,
    fromStatus: params.fromStatus ?? null,
    toStatus: params.toStatus ?? null,
    note: params.note ?? null,
    userId: params.userId ?? null,
  });
}

/** يحوّل Date|string|null القادم من drizzle إلى Date|null بأمان. */
function toDateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v as string);
}

/**
 * السحب الذاتي (claim): NEW → IN_PROGRESS. لا «سرقة» — assignedTo يجب أن يكون null أو الفاعل نفسه
 * (إعادة إسناد قسرية تبقى لـ`assignTask` المديرية). يضبط firstResponseAt=NOW أول مرّة فقط.
 */
export async function claimTask(taskId: number, actor: TaskActor) {
  return withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    if (task.taskStatus !== "NEW")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن سحب المهمة إلا وهي جديدة" });
    if (task.assignedTo != null && Number(task.assignedTo) !== actor.userId)
      throw new TRPCError({ code: "CONFLICT", message: "المهمة مُسنَدة بالفعل لموظف آخر" });

    const patch: Record<string, unknown> = { taskStatus: "IN_PROGRESS", assignedTo: actor.userId };
    if (task.firstResponseAt == null) patch.firstResponseAt = sql`NOW()`;
    await tx.update(tasks).set(patch).where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "ASSIGN", note: "سحب ذاتي", userId: actor.userId });
    await insertEvent(tx, { taskId, eventType: "STATUS", fromStatus: task.taskStatus, toStatus: "IN_PROGRESS", userId: actor.userId });
    return { taskId, status: "IN_PROGRESS" as const, assignedTo: actor.userId };
  });
}

/** إسناد/إعادة إسناد (مدير): أي حالة مفتوحة (غير RESOLVED/CANCELLED)، بلا تغيير الحالة — فقط الإسناد. */
export async function assignTask(taskId: number, assignedTo: number | null, actor: TaskActor) {
  return withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    if (!(OPEN_STATUSES as readonly string[]).includes(task.taskStatus))
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إعادة إسناد مهمة مغلقة (محلولة أو ملغاة)" });
    if (assignedTo != null) {
      const u = (await tx.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, assignedTo)).limit(1))[0];
      if (!u || !u.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير موجود أو معطّل" });
    }
    await tx.update(tasks).set({ assignedTo }).where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "ASSIGN", userId: actor.userId });
    return { taskId, assignedTo };
  });
}

/** NEW/IN_PROGRESS → WAITING_CUSTOMER — يوقف عدّاد SLA أثناء انتظار ردّ العميل. المُسنَد إليه أو مدير. */
export async function setWaiting(taskId: number, actor: TaskActor, note?: string | null) {
  return withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskAssigneeOrElevated(task, actor);
    if (task.taskStatus !== "NEW" && task.taskStatus !== "IN_PROGRESS")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الانتقال لحالة الانتظار من هذه الحالة" });
    await tx.update(tasks).set({ taskStatus: "WAITING_CUSTOMER", waitingSince: sql`NOW()` }).where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "STATUS", fromStatus: task.taskStatus, toStatus: "WAITING_CUSTOMER", note: note ?? null, userId: actor.userId });
    return { taskId, status: "WAITING_CUSTOMER" as const };
  });
}

/** WAITING_CUSTOMER → IN_PROGRESS — يراكم waitingAccumMs += (NOW − waitingSince) ثم يصفّر waitingSince. */
export async function resumeTask(taskId: number, actor: TaskActor) {
  return withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskAssigneeOrElevated(task, actor, { allowSystem: true });
    if (task.taskStatus !== "WAITING_CUSTOMER")
      throw new TRPCError({ code: "BAD_REQUEST", message: "المهمة ليست في حالة انتظار العميل" });

    const waitingSince = toDateOrNull(task.waitingSince);
    const deltaMs = waitingSince ? Math.max(0, Date.now() - waitingSince.getTime()) : 0;
    const waitingAccumMs = Number(task.waitingAccumMs ?? 0) + deltaMs;

    await tx.update(tasks).set({ taskStatus: "IN_PROGRESS", waitingAccumMs, waitingSince: null }).where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "STATUS", fromStatus: "WAITING_CUSTOMER", toStatus: "IN_PROGRESS", userId: actor.userId });
    return { taskId, status: "IN_PROGRESS" as const, waitingAccumMs };
  });
}

/** IN_PROGRESS/WAITING_CUSTOMER → RESOLVED. resolutionNote إلزامي لمهام SUPPORT. يراكم الانتظار أولاً إن كان جارياً. */
export async function resolveTask(taskId: number, actor: TaskActor, resolutionNote?: string | null) {
  const result = await withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskAssigneeOrElevated(task, actor);
    if (task.taskStatus !== "IN_PROGRESS" && task.taskStatus !== "WAITING_CUSTOMER")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن حلّ مهمة ليست قيد التنفيذ أو الانتظار" });
    if (task.taskKind === "SUPPORT" && !resolutionNote?.trim())
      throw new TRPCError({ code: "BAD_REQUEST", message: "ملاحظة الحلّ إلزامية لمهام الدعم (SUPPORT)" });

    const patch: Record<string, unknown> = {
      taskStatus: "RESOLVED",
      resolvedAt: sql`NOW()`,
      resolutionNote: resolutionNote?.trim() || null,
    };
    if (task.taskStatus === "WAITING_CUSTOMER") {
      const waitingSince = toDateOrNull(task.waitingSince);
      const deltaMs = waitingSince ? Math.max(0, Date.now() - waitingSince.getTime()) : 0;
      patch.waitingAccumMs = Number(task.waitingAccumMs ?? 0) + deltaMs;
      patch.waitingSince = null;
    }
    await tx.update(tasks).set(patch).where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "STATUS", fromStatus: task.taskStatus, toStatus: "RESOLVED", note: resolutionNote ?? null, userId: actor.userId });
    return {
      taskId,
      status: "RESOLVED" as const,
      taskKind: task.taskKind,
      branchId: Number(task.branchId),
      conversationId: task.conversationId != null ? Number(task.conversationId) : null,
    };
  });

  // CSAT (T4.2، خلف مفتاح csatOnResolve) — خارج المعاملة تماماً وبعد نجاحها فقط، محمي بذاته
  // (checkAutomationGate/enqueueAndDispatch لا يُتوقَّع أن يرميا هنا، لكن الغلاف دفاعيّ صريح فوقهما)
  // — **لا يُفشِل resolve أبداً** (القاعدة الحاكمة، راجع server/services/whatsapp/flowNotify.ts).
  try {
    await maybeRequestCsat(result);
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e), taskId: result.taskId }, "resolveTask: تعذّر إطلاق CSAT — تُجوهل");
  }

  return { taskId: result.taskId, status: result.status };
}

/**
 * يُطلق طلب تقييم CSAT (رسالة تفاعلية بأزرار ردّ سريع) عبر الصندوق الصادر — فقط لمهام SUPPORT
 * بمفتاح `csatOnResolve` مفعَّل ومحادثة مربوطة نافذتها الحرّة مفتوحة (آخر ٢٤ ساعة). Cloud API يسمح
 * بحدّ أقصى ٣ أزرار ردّ سريع لكل رسالة (حدّ منصّة صارم — `sendInteractiveButtons` يقصّ لأوّل ٣) ⇒
 * مقياس ١-٥ يُختزَل لثلاث درجات ممثِّلة (٥/٣/١، بعناوين «ممتاز/عادي/سيّئ» — أحد البديلين اللذين
 * تسمح بهما المواصفة صراحةً)؛ منطق **الالتقاط** في webhookProcessor.ts يبقى عاماً (يقبل ١..٥ أياً
 * كان المُرسَل فعلاً). dedupeKey `CSAT:{taskId}` ⇒ مرّة واحدة لكل مهمة (لا تتكرّر حتى بعد reopen). */
async function maybeRequestCsat(params: { taskId: number; taskKind: string; branchId: number; conversationId: number | null }): Promise<void> {
  if (params.taskKind !== "SUPPORT" || params.conversationId == null) return;

  const gate = await checkAutomationGate("csatOnResolve", params.branchId);
  if (!gate.ok) return;

  const db = requireDb();
  const conv = (
    await db
      .select({ channelHandle: conversations.channelHandle, lastInboundAt: conversations.lastInboundAt })
      .from(conversations)
      .where(eq(conversations.id, params.conversationId))
      .limit(1)
  )[0];
  if (!conv?.channelHandle || !conv.lastInboundAt) return;
  const windowOpen = Date.now() - conv.lastInboundAt.getTime() < 24 * 3600 * 1000;
  if (!windowOpen) return;

  const buttons = [
    { id: `csat:${params.taskId}:5`, title: "ممتاز" },
    { id: `csat:${params.taskId}:3`, title: "عادي" },
    { id: `csat:${params.taskId}:1`, title: "سيّئ" },
  ];
  await enqueueAndDispatch({
    dedupeKey: `CSAT:${params.taskId}`,
    branchId: params.branchId,
    conversationId: params.conversationId,
    toPhoneE164: conv.channelHandle,
    kind: "SESSION_TEXT",
    payloadJson: { text: "كيف كانت تجربتك معنا؟ نسعد بتقييمك.", buttons },
    taskId: params.taskId,
  });
  await db.update(tasks).set({ csatRequestedAt: sql`NOW()` }).where(eq(tasks.id, params.taskId));
}

/** RESOLVED → IN_PROGRESS خلال ≤٧ أيام من resolvedAt فقط (مدير). */
export async function reopenTask(taskId: number, actor: TaskActor, note?: string | null) {
  return withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    if (task.taskStatus !== "RESOLVED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إعادة فتح إلا مهمة محلولة" });
    const resolvedAt = toDateOrNull(task.resolvedAt);
    const sevenDaysMs = 7 * 24 * 3600_000;
    if (!resolvedAt || Date.now() - resolvedAt.getTime() > sevenDaysMs) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إعادة فتح مهمة مضى على حلّها أكثر من ٧ أيام" });
    }
    await tx
      .update(tasks)
      .set({ taskStatus: "IN_PROGRESS", resolvedAt: null, reopenCount: sql`${tasks.reopenCount} + 1` })
      .where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "STATUS", fromStatus: "RESOLVED", toStatus: "IN_PROGRESS", note: note ?? null, userId: actor.userId });
    return { taskId, status: "IN_PROGRESS" as const };
  });
}

/** NEW/IN_PROGRESS/WAITING_CUSTOMER → CANCELLED. سبب الإلغاء إلزامي (مدير). */
export async function cancelTask(taskId: number, note: string, actor: TaskActor) {
  return withTx(async (tx) => {
    if (!note?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الإلغاء مطلوب" });
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    if (!(OPEN_STATUSES as readonly string[]).includes(task.taskStatus))
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء مهمة بهذه الحالة" });
    await tx.update(tasks).set({ taskStatus: "CANCELLED" }).where(eq(tasks.id, taskId));
    await insertEvent(tx, { taskId, eventType: "STATUS", fromStatus: task.taskStatus, toStatus: "CANCELLED", note, userId: actor.userId });
    return { taskId, status: "CANCELLED" as const };
  });
}

/** تعليق — بلا تغيير حالة. بنطاق الموظف (assignedTo=هو ∪ createdBy=هو)، مدير/أدمن يعبُران دائماً. */
export async function addComment(taskId: number, note: string, actor: TaskActor) {
  return withTx(async (tx) => {
    if (!note?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "نصّ التعليق مطلوب" });
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskActorScope(task, actor);
    await insertEvent(tx, { taskId, eventType: "COMMENT", note: note.trim(), userId: actor.userId });
    return { taskId, ok: true as const };
  });
}

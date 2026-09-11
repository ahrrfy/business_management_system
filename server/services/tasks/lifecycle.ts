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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  conversations,
  taskEvents,
  tasks,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { logger } from "../../logger";
import { type Actor, requireDb, withTx } from "../tx";
import { checkAutomationGate, enqueueAndDispatch } from "../whatsapp";
import {
  assertTaskActorScope,
  assertTaskAssigneeOrElevated,
  assertTaskBranch,
  loadTask,
} from "./helpers";
import { canCrossBranches } from "../../lib/branchAuthority";
import { assertNotDesignApprovalTask } from "../workOrder/designApproval";
import { extractInsertId } from "../../lib/insertId";
import { enqueueTaskNotifications, reconcileTaskNotifications } from "./notifications";
import { withIdempotency } from "../idempotency";

type TaskEventType =
  | "COMMENT"
  | "STATUS"
  | "ASSIGN"
  | "LINK"
  | "SYSTEM"
  | "CSAT";
type TaskActor = Actor & { role?: string };
/** A company owner can be elevated without a fixed branch.  The mobile path
 * must derive that branch from its locked, already-assigned task; it must
 * never silently substitute a default branch. */
type MobileTaskActor = Omit<TaskActor, "branchId"> & { branchId: number | null };
type ClaimTaskOutcome = {
  taskId: number;
  status: "IN_PROGRESS";
  assignedTo: number;
  notificationOccurrenceId: string | null;
};
type ResolveTaskOutcome = {
  taskId: number;
  status: "RESOLVED";
  taskKind: string;
  branchId: number;
  conversationId: number | null;
  notificationOccurrenceId: string | null;
};

const OPEN_STATUSES = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"] as const;

async function insertEvent(
  tx: Tx,
  params: {
    taskId: number;
    eventType: TaskEventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string | null;
    userId?: number | null;
  },
) {
  const result = await tx.insert(taskEvents).values({
    taskId: params.taskId,
    eventType: params.eventType,
    fromStatus: params.fromStatus ?? null,
    toStatus: params.toStatus ?? null,
    note: params.note ?? null,
    userId: params.userId ?? null,
  });
  return extractInsertId(result);
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
async function claimTaskInTx(tx: Tx, taskId: number, actor: TaskActor): Promise<ClaimTaskOutcome> {
  const task = await loadTask(tx, taskId);
  assertTaskBranch(task, actor);
  if (task.taskStatus !== "NEW")
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن سحب المهمة إلا وهي جديدة",
    });
  if (task.assignedTo != null && Number(task.assignedTo) !== actor.userId)
    throw new TRPCError({
      code: "CONFLICT",
      message: "المهمة مُسنَدة بالفعل لموظف آخر",
    });

  const patch: Record<string, unknown> = {
    taskStatus: "IN_PROGRESS",
    assignedTo: actor.userId,
  };
  if (task.firstResponseAt == null) patch.firstResponseAt = sql`NOW()`;
  await tx.update(tasks).set(patch).where(eq(tasks.id, taskId));
  const statusEventId = await insertEvent(tx, {
    taskId,
    eventType: "ASSIGN",
    note: "سحب ذاتي",
    userId: actor.userId,
  });
  await insertEvent(tx, {
    taskId,
    eventType: "STATUS",
    fromStatus: task.taskStatus,
    toStatus: "IN_PROGRESS",
    userId: actor.userId,
  });
  const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
    task,
    eventId: statusEventId,
    action: { type: "CLAIMED" },
    actorUserId: actor.userId,
  });
  return { taskId, status: "IN_PROGRESS", assignedTo: actor.userId, notificationOccurrenceId };
}

export async function claimTask(taskId: number, actor: TaskActor) {
  const outcome = await withTx((tx) => claimTaskInTx(tx, taskId, actor));
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

/** The phone never supplies a task id. This is the same current-focus ordering
 * used by the mobile read model, locked inside the command transaction. */
async function loadCurrentMobileTask(tx: Tx, actor: MobileTaskActor) {
  const [task] = await tx
    .select({ id: tasks.id, taskStatus: tasks.taskStatus, branchId: tasks.branchId })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedTo, actor.userId),
        inArray(tasks.taskStatus, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(asc(tasks.dueAt), asc(tasks.createdAt))
    .for("update")
    .limit(1);
  return task ?? null;
}

function scopedMobileTaskActor(
  actor: MobileTaskActor,
  task: { branchId: number | string },
): TaskActor {
  if (actor.branchId != null) return { ...actor, branchId: actor.branchId };
  if (actor.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تنفيذ المهمة من الهاتف",
        why: "حسابك غير مرتبط بفرع عمل يسمح بتنفيذ هذه المهمة",
        doThis: "اطلب من مدير النظام ربط حسابك بالفرع الصحيح، ثم حدّث صفحة «يومي»",
      }),
    });
  }
  const branchId = Number(task.branchId);
  if (!Number.isSafeInteger(branchId) || branchId <= 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تنفيذ المهمة من الهاتف",
        why: "فرع المهمة المسندة غير صالح أو لم يعد متاحاً",
        doThis: "حدّث صفحة «يومي»، ثم أبلغ مدير النظام بمراجعة بيانات المهمة إن استمر الرفض",
      }),
    });
  }
  return { ...actor, branchId };
}

/**
 * Closed Expo command for starting the employee's current focus. Its result
 * never exposes the task id; the server stores it only in the idempotency
 * record and audit trail. A repeat sees the same in-progress focus, rather
 * than advancing another task.
 */
export async function startCurrentMobileTask(input: {
  actor: MobileTaskActor;
  clientRequestId: string;
}) {
  const result = await withTx((tx) =>
    withIdempotency(
      tx,
      {
        operation: `superapp.task.start.${input.actor.userId}`,
        clientRequestId: input.clientRequestId,
        payload: { action: "start-current-focus" },
      },
      async () => {
        const current = await loadCurrentMobileTask(tx, input.actor);
        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "لا توجد مهمة للبدء الآن",
              why: "لا توجد مهمة مفتوحة مسندة إلى حسابك في هذه اللحظة",
              doThis: "حدّث صفحة «يومي»، أو راجع مديرك إذا كنت تنتظر إسناد مهمة جديدة",
            }),
          });
        }
        if (current.taskStatus === "IN_PROGRESS") {
          return {
            refId: Number(current.id),
            result: { taskId: Number(current.id), notificationOccurrenceId: null, alreadyApplied: true },
          };
        }
        if (current.taskStatus !== "NEW") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر بدء المهمة الحالية",
              why: "حالة المهمة تغيّرت قبل تسجيل البدء",
              doThis: "حدّث صفحة «يومي» واعمل على المهمة الظاهرة هناك، ولا تعِد إرسال الطلب القديم",
            }),
          });
        }
        const claimed = await claimTaskInTx(
          tx,
          Number(current.id),
          scopedMobileTaskActor(input.actor, current),
        );
        return {
          refId: claimed.taskId,
          result: {
            taskId: claimed.taskId,
            notificationOccurrenceId: claimed.notificationOccurrenceId,
            alreadyApplied: false,
          },
        };
      },
    ),
  );
  if (!result.replay && result.result?.notificationOccurrenceId) {
    await reconcileTaskNotifications(result.result.notificationOccurrenceId);
  }
  return {
    taskId: result.refId,
    status: "IN_PROGRESS" as const,
    idempotent: result.replay || result.result?.alreadyApplied === true,
  };
}

function positiveTaskUserId(value: number | string | null): number | null {
  if (value == null) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** إسناد/إعادة إسناد (مدير): أي حالة مفتوحة (غير RESOLVED/CANCELLED)، بلا تغيير الحالة — فقط الإسناد. */
export async function assignTask(
  taskId: number,
  assignedTo: number | null,
  actor: TaskActor,
) {
  const outcome = await withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    if (!(OPEN_STATUSES as readonly string[]).includes(task.taskStatus))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إعادة إسناد مهمة مغلقة (محلولة أو ملغاة)",
      });
    if (assignedTo != null) {
      const u = (
        await tx
          .select({
            id: users.id,
            branchId: users.branchId,
            role: users.role,
            isActive: users.isActive,
            isOwner: users.isOwner,
          })
          .from(users)
          .where(eq(users.id, assignedTo))
          .limit(1)
      )[0];
      if (!u || !u.isActive)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الموظف غير موجود أو معطّل",
        });
      // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن وحدهما عابرا الفروع؛ مدير الفرع مقيَّدٌ بفرعه.
      // المُسنَد إليه صفٌّ خام غير مُطبَّع ⇒ نستشير isOwner صراحةً عبر canCrossBranches (P2 مراجعة Codex).
      const elevatedAssignee = canCrossBranches({
        role: u.role,
        isOwner: u.isOwner,
      });
      if (!elevatedAssignee && Number(u.branchId) !== Number(task.branchId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن إسناد المهمة إلى موظف من فرع آخر",
        });
      }
    }
    await tx.update(tasks).set({ assignedTo }).where(eq(tasks.id, taskId));
    const eventId = await insertEvent(tx, {
      taskId,
      eventType: "ASSIGN",
      userId: actor.userId,
    });
    const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
      task,
      eventId,
      action: {
        type: "ASSIGNED",
        assignedTo,
        previousAssignedTo: positiveTaskUserId(task.assignedTo),
      },
      actorUserId: actor.userId,
    });
    return { taskId, assignedTo, notificationOccurrenceId };
  });
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

/** NEW/IN_PROGRESS → WAITING_CUSTOMER — يوقف عدّاد SLA أثناء انتظار ردّ العميل. المُسنَد إليه أو مدير. */
export async function setWaiting(
  taskId: number,
  actor: TaskActor,
  note?: string | null,
) {
  const outcome = await withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskAssigneeOrElevated(task, actor);
    if (task.taskStatus !== "NEW" && task.taskStatus !== "IN_PROGRESS")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن الانتقال لحالة الانتظار من هذه الحالة",
      });
    await tx
      .update(tasks)
      .set({ taskStatus: "WAITING_CUSTOMER", waitingSince: sql`NOW()` })
      .where(eq(tasks.id, taskId));
    const eventId = await insertEvent(tx, {
      taskId,
      eventType: "STATUS",
      fromStatus: task.taskStatus,
      toStatus: "WAITING_CUSTOMER",
      note: note ?? null,
      userId: actor.userId,
    });
    const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
      task,
      eventId,
      action: { type: "WAITING" },
      actorUserId: actor.userId,
    });
    return { taskId, status: "WAITING_CUSTOMER" as const, notificationOccurrenceId };
  });
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

/** WAITING_CUSTOMER → IN_PROGRESS — يراكم waitingAccumMs += (NOW − waitingSince) ثم يصفّر waitingSince. */
export async function resumeTask(taskId: number, actor: TaskActor) {
  const outcome = await withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskAssigneeOrElevated(task, actor, { allowSystem: true });
    if (task.taskStatus !== "WAITING_CUSTOMER")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المهمة ليست في حالة انتظار العميل",
      });

    const waitingSince = toDateOrNull(task.waitingSince);
    const deltaMs = waitingSince
      ? Math.max(0, Date.now() - waitingSince.getTime())
      : 0;
    const waitingAccumMs = Number(task.waitingAccumMs ?? 0) + deltaMs;

    await tx
      .update(tasks)
      .set({ taskStatus: "IN_PROGRESS", waitingAccumMs, waitingSince: null })
      .where(eq(tasks.id, taskId));
    const eventId = await insertEvent(tx, {
      taskId,
      eventType: "STATUS",
      fromStatus: "WAITING_CUSTOMER",
      toStatus: "IN_PROGRESS",
      userId: actor.userId,
    });
    const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
      task,
      eventId,
      action: { type: "RESUMED" },
      actorUserId: actor.userId,
    });
    return { taskId, status: "IN_PROGRESS" as const, waitingAccumMs, notificationOccurrenceId };
  });
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

/** IN_PROGRESS/WAITING_CUSTOMER → RESOLVED. resolutionNote إلزامي لمهام SUPPORT. يراكم الانتظار أولاً إن كان جارياً. */
async function resolveTaskInTx(
  tx: Tx,
  taskId: number,
  actor: TaskActor,
  resolutionNote?: string | null,
): Promise<ResolveTaskOutcome> {
  const task = await loadTask(tx, taskId);
  assertTaskBranch(task, actor);
  await assertNotDesignApprovalTask(tx, taskId);
  assertTaskAssigneeOrElevated(task, actor);
  if (
    task.taskStatus !== "IN_PROGRESS" &&
    task.taskStatus !== "WAITING_CUSTOMER"
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن حلّ مهمة ليست قيد التنفيذ أو الانتظار",
    });
  if (task.taskKind === "SUPPORT" && !resolutionNote?.trim())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "ملاحظة الحلّ إلزامية لمهام الدعم (SUPPORT)",
    });

  const patch: Record<string, unknown> = {
    taskStatus: "RESOLVED",
    resolvedAt: sql`NOW()`,
    resolutionNote: resolutionNote?.trim() || null,
  };
  if (task.taskStatus === "WAITING_CUSTOMER") {
    const waitingSince = toDateOrNull(task.waitingSince);
    const deltaMs = waitingSince
      ? Math.max(0, Date.now() - waitingSince.getTime())
      : 0;
    patch.waitingAccumMs = Number(task.waitingAccumMs ?? 0) + deltaMs;
    patch.waitingSince = null;
  }
  await tx.update(tasks).set(patch).where(eq(tasks.id, taskId));
  const eventId = await insertEvent(tx, {
    taskId,
    eventType: "STATUS",
    fromStatus: task.taskStatus,
    toStatus: "RESOLVED",
    note: resolutionNote ?? null,
    userId: actor.userId,
  });
  const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
    task,
    eventId,
    action: { type: "RESOLVED" },
    actorUserId: actor.userId,
  });
  return {
    taskId,
    status: "RESOLVED",
    taskKind: task.taskKind,
    branchId: Number(task.branchId),
    conversationId:
      task.conversationId != null ? Number(task.conversationId) : null,
    notificationOccurrenceId,
  };
}

async function afterResolveTask(result: ResolveTaskOutcome) {

  await reconcileTaskNotifications(result.notificationOccurrenceId);

  // CSAT (T4.2، خلف مفتاح csatOnResolve) — خارج المعاملة تماماً وبعد نجاحها فقط، محمي بذاته
  // (checkAutomationGate/enqueueAndDispatch لا يُتوقَّع أن يرميا هنا، لكن الغلاف دفاعيّ صريح فوقهما)
  // — **لا يُفشِل resolve أبداً** (القاعدة الحاكمة، راجع server/services/whatsapp/flowNotify.ts).
  try {
    await maybeRequestCsat(result);
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        taskId: result.taskId,
      },
      "resolveTask: تعذّر إطلاق CSAT — تُجوهل",
    );
  }

  return { taskId: result.taskId, status: result.status };
}

export async function resolveTask(
  taskId: number,
  actor: TaskActor,
  resolutionNote?: string | null,
) {
  return afterResolveTask(await withTx((tx) => resolveTaskInTx(tx, taskId, actor, resolutionNote)));
}

/**
 * Resolves only the authenticated employee's current focus. The task id stays
 * inside the transaction/audit layer; an idempotency replay cannot select the
 * next task after the first one is closed.
 */
export async function resolveCurrentMobileTask(input: {
  actor: MobileTaskActor;
  clientRequestId: string;
  resolutionNote?: string | null;
}) {
  const result = await withTx((tx) =>
    withIdempotency(
      tx,
      {
        operation: `superapp.task.resolve.${input.actor.userId}`,
        clientRequestId: input.clientRequestId,
        payload: {
          action: "resolve-current-focus",
          resolutionNote: input.resolutionNote?.trim() || null,
        },
      },
      async () => {
        const current = await loadCurrentMobileTask(tx, input.actor);
        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: appErrorMessage({
              what: "لا توجد مهمة لإتمامها الآن",
              why: "لا توجد مهمة مفتوحة مسندة إلى حسابك في هذه اللحظة",
              doThis: "حدّث صفحة «يومي»، أو راجع مديرك إذا كانت المهمة قد أُعيد إسنادها أو حُسمت",
            }),
          });
        }
        const resolved = await resolveTaskInTx(
          tx,
          Number(current.id),
          scopedMobileTaskActor(input.actor, current),
          input.resolutionNote,
        );
        return { refId: resolved.taskId, result: resolved };
      },
    ),
  );
  if (result.replay) {
    return { taskId: result.refId, status: "RESOLVED" as const, idempotent: true };
  }
  if (!result.result) {
    throw new Error("تعذّر حفظ نتيجة المهمة");
  }
  const resolved = await afterResolveTask(result.result);
  return { ...resolved, idempotent: false };
}

/**
 * يُطلق طلب تقييم CSAT (رسالة تفاعلية بأزرار ردّ سريع) عبر الصندوق الصادر — فقط لمهام SUPPORT
 * بمفتاح `csatOnResolve` مفعَّل ومحادثة مربوطة نافذتها الحرّة مفتوحة (آخر ٢٤ ساعة). Cloud API يسمح
 * بحدّ أقصى ٣ أزرار ردّ سريع لكل رسالة (حدّ منصّة صارم — `sendInteractiveButtons` يقصّ لأوّل ٣) ⇒
 * مقياس ١-٥ يُختزَل لثلاث درجات ممثِّلة (٥/٣/١، بعناوين «ممتاز/عادي/سيّئ» — أحد البديلين اللذين
 * تسمح بهما المواصفة صراحةً)؛ منطق **الالتقاط** في webhookProcessor.ts يبقى عاماً (يقبل ١..٥ أياً
 * كان المُرسَل فعلاً). dedupeKey `CSAT:{taskId}` ⇒ مرّة واحدة لكل مهمة (لا تتكرّر حتى بعد reopen). */
async function maybeRequestCsat(params: {
  taskId: number;
  taskKind: string;
  branchId: number;
  conversationId: number | null;
}): Promise<void> {
  if (params.taskKind !== "SUPPORT" || params.conversationId == null) return;

  const gate = await checkAutomationGate("csatOnResolve", params.branchId);
  if (!gate.ok) return;

  const db = requireDb();
  const conv = (
    await db
      .select({
        channelHandle: conversations.channelHandle,
        lastInboundAt: conversations.lastInboundAt,
      })
      .from(conversations)
      .where(eq(conversations.id, params.conversationId))
      .limit(1)
  )[0];
  if (!conv?.channelHandle || !conv.lastInboundAt) return;
  const windowOpen =
    Date.now() - conv.lastInboundAt.getTime() < 24 * 3600 * 1000;
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
  await db
    .update(tasks)
    .set({ csatRequestedAt: sql`NOW()` })
    .where(eq(tasks.id, params.taskId));
}

/** RESOLVED → IN_PROGRESS خلال ≤٧ أيام من resolvedAt فقط (مدير). */
export async function reopenTask(
  taskId: number,
  actor: TaskActor,
  note?: string | null,
) {
  const outcome = await withTx(async (tx) => {
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    await assertNotDesignApprovalTask(tx, taskId);
    if (task.taskStatus !== "RESOLVED")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إعادة فتح إلا مهمة محلولة",
      });
    const resolvedAt = toDateOrNull(task.resolvedAt);
    const sevenDaysMs = 7 * 24 * 3600_000;
    if (!resolvedAt || Date.now() - resolvedAt.getTime() > sevenDaysMs) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إعادة فتح مهمة مضى على حلّها أكثر من ٧ أيام",
      });
    }
    await tx
      .update(tasks)
      .set({
        taskStatus: "IN_PROGRESS",
        resolvedAt: null,
        reopenCount: sql`${tasks.reopenCount} + 1`,
      })
      .where(eq(tasks.id, taskId));
    const eventId = await insertEvent(tx, {
      taskId,
      eventType: "STATUS",
      fromStatus: "RESOLVED",
      toStatus: "IN_PROGRESS",
      note: note ?? null,
      userId: actor.userId,
    });
    const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
      task,
      eventId,
      action: { type: "REOPENED" },
      actorUserId: actor.userId,
    });
    return { taskId, status: "IN_PROGRESS" as const, notificationOccurrenceId };
  });
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

/** NEW/IN_PROGRESS/WAITING_CUSTOMER → CANCELLED. سبب الإلغاء إلزامي (مدير). */
export async function cancelTask(
  taskId: number,
  note: string,
  actor: TaskActor,
) {
  const outcome = await withTx(async (tx) => {
    if (!note?.trim())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "سبب الإلغاء مطلوب",
      });
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    await assertNotDesignApprovalTask(tx, taskId);
    if (!(OPEN_STATUSES as readonly string[]).includes(task.taskStatus))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء مهمة بهذه الحالة",
      });
    await tx
      .update(tasks)
      .set({ taskStatus: "CANCELLED" })
      .where(eq(tasks.id, taskId));
    const eventId = await insertEvent(tx, {
      taskId,
      eventType: "STATUS",
      fromStatus: task.taskStatus,
      toStatus: "CANCELLED",
      note,
      userId: actor.userId,
    });
    const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
      task,
      eventId,
      action: { type: "CANCELLED" },
      actorUserId: actor.userId,
    });
    return { taskId, status: "CANCELLED" as const, notificationOccurrenceId };
  });
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

/** تعليق — بلا تغيير حالة. بنطاق الموظف (assignedTo=هو ∪ createdBy=هو)، مدير/أدمن يعبُران دائماً. */
export async function addComment(
  taskId: number,
  note: string,
  actor: TaskActor,
) {
  const outcome = await withTx(async (tx) => {
    if (!note?.trim())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "نصّ التعليق مطلوب",
      });
    const task = await loadTask(tx, taskId);
    assertTaskBranch(task, actor);
    assertTaskActorScope(task, actor);
    const eventId = await insertEvent(tx, {
      taskId,
      eventType: "COMMENT",
      note: note.trim(),
      userId: actor.userId,
    });
    const notificationOccurrenceId = await enqueueTaskNotifications(tx, {
      task,
      eventId,
      action: { type: "COMMENTED" },
      actorUserId: actor.userId,
    });
    return { taskId, ok: true as const, notificationOccurrenceId };
  });
  await reconcileTaskNotifications(outcome.notificationOccurrenceId);
  const { notificationOccurrenceId: _notificationOccurrenceId, ...publicResult } = outcome;
  void _notificationOccurrenceId;
  return publicResult;
}

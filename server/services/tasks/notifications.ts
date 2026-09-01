import type { Tx } from "../../db";
import { logger } from "../../logger";
import {
  enqueueAppNotificationOutbox,
  reconcileAppNotificationOutbox,
  type AppNotificationOutboxIntent,
} from "../appNotificationOutboxService";

type TaskNoticeState = {
  id: number | string;
  taskNumber: string;
  title: string;
  branchId: number | string;
  assignedTo: number | string | null;
  createdBy: number | string | null;
};

export type TaskNotificationAction =
  | { type: "ASSIGNED"; assignedTo: number | null; previousAssignedTo: number | null }
  | { type: "CLAIMED" }
  | { type: "WAITING" }
  | { type: "RESUMED" }
  | { type: "RESOLVED" }
  | { type: "REOPENED" }
  | { type: "CANCELLED" }
  | { type: "COMMENTED" };

type Recipient = {
  userId: number;
  family: "OPERATIONS" | "ADMIN";
  title: string;
  requiresAction: boolean;
};

const ACTION_TITLE: Record<Exclude<TaskNotificationAction["type"], "ASSIGNED">, string> = {
  CLAIMED: "بدأ تنفيذ المهمة",
  WAITING: "المهمة بانتظار العميل",
  RESUMED: "استؤنف تنفيذ المهمة",
  RESOLVED: "اكتملت المهمة",
  REOPENED: "أُعيد فتح المهمة",
  CANCELLED: "أُلغيت المهمة",
  COMMENTED: "تعليق جديد على المهمة",
};

function positiveUserId(value: number | string | null): number | null {
  const id = value == null ? 0 : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** يبني المستلمين بلا إشعار الفاعل لنفسه وبلا تكرار منشئ المهمة إن كان هو المنفّذ. */
export function buildTaskNotificationIntents(input: {
  task: TaskNoticeState;
  eventId: number;
  action: TaskNotificationAction;
  actorUserId: number;
}): AppNotificationOutboxIntent[] {
  const taskId = Number(input.task.id);
  const creatorId = positiveUserId(input.task.createdBy);
  const currentAssigneeId = positiveUserId(input.task.assignedTo);
  const recipients = new Map<number, Recipient>();
  const add = (recipient: Recipient | null) => {
    if (!recipient || recipient.userId === input.actorUserId || recipients.has(recipient.userId)) return;
    recipients.set(recipient.userId, recipient);
  };

  if (input.action.type === "ASSIGNED") {
    const nextId = positiveUserId(input.action.assignedTo);
    const previousId = positiveUserId(input.action.previousAssignedTo);
    if (nextId != null) {
      add({ userId: nextId, family: "OPERATIONS", title: "أُسندت إليك مهمة", requiresAction: true });
    }
    if (previousId != null && previousId !== nextId) {
      add({ userId: previousId, family: "OPERATIONS", title: "أُعيد إسناد المهمة", requiresAction: false });
    }
    if (creatorId != null && creatorId !== nextId && creatorId !== previousId) {
      add({
        userId: creatorId,
        family: "ADMIN",
        title: nextId == null ? "أُلغي إسناد المهمة" : "تم إسناد المهمة",
        requiresAction: false,
      });
    }
  } else if (input.action.type === "CLAIMED") {
    if (creatorId != null) {
      add({ userId: creatorId, family: "ADMIN", title: ACTION_TITLE.CLAIMED, requiresAction: false });
    }
  } else {
    const requiresAction = input.action.type === "RESUMED" || input.action.type === "REOPENED";
    if (currentAssigneeId != null) {
      add({
        userId: currentAssigneeId,
        family: "OPERATIONS",
        title: ACTION_TITLE[input.action.type],
        requiresAction,
      });
    }
    if (creatorId != null) {
      add({
        userId: creatorId,
        family: "ADMIN",
        title: ACTION_TITLE[input.action.type],
        requiresAction: false,
      });
    }
  }

  const occurrenceId = `task-event:${input.eventId}`;
  return Array.from(recipients.values()).map((recipient) => ({
    branchId: Number(input.task.branchId),
    streamKey: `task:${taskId}:user:${recipient.userId}`,
    occurrenceId,
    notification: {
      userId: recipient.userId,
      kind: "TASK_ASSIGNED",
      family: recipient.family,
      title: recipient.title,
      body: `${input.task.taskNumber} · ${input.task.title}`,
      route: `/tasks?task=${taskId}`,
      eventKey: `task:${taskId}:event:${input.eventId}:${input.action.type}:${recipient.userId}`,
      entityType: "task",
      entityId: taskId,
      requiresAction: recipient.requiresAction,
    },
  }));
}

export async function enqueueTaskNotifications(
  tx: Tx,
  input: Parameters<typeof buildTaskNotificationIntents>[0],
): Promise<string | null> {
  const intents = buildTaskNotificationIntents(input);
  if (intents.length === 0) return null;
  await enqueueAppNotificationOutbox(tx, intents);
  return intents[0].occurrenceId;
}

/** محاولة فورية بعد commit؛ النية تبقى PENDING كي يعيد العامل تسليمها إن تعذرت المحاولة. */
export async function reconcileTaskNotifications(occurrenceId: string | null): Promise<void> {
  if (!occurrenceId) return;
  try {
    await reconcileAppNotificationOutbox({ occurrenceId });
  } catch (error) {
    logger.warn({ err: error, occurrenceId }, "tasks.notifications.reconcile_failed");
  }
}

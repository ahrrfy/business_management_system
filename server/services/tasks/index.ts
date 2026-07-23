// نقطة الدخول العامة لخدمة نظام المهام — إعادة تصدير من الوحدات الفرعية (نمط workOrderService.ts).
// helpers.ts داخلي (ترقيم/تحميل تحت قفل/عزل) — لا يُصدَّر من هنا.
export type { CreateTaskActor, CreateTaskInput, TaskKind, TaskPriority, TaskSourceChannel } from "./create";
export { createTask } from "./create";

export {
  addComment,
  assignTask,
  cancelTask,
  claimTask,
  reopenTask,
  resolveTask,
  resumeTask,
  setWaiting,
} from "./lifecycle";

export type { ListTasksFilters, TaskKindFilter, TaskListCtx, TaskStatus } from "./list";
export { assignableStaff, computeEffectiveDueAt, getTask, isTaskOverdue, listTasks } from "./list";

export { maybeCreateTaskForInbound } from "./autoCreate";
export type { MaybeCreateTaskForInboundInput } from "./autoCreate";

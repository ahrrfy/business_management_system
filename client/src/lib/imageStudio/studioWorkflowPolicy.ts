export interface StudioWorkflowUser {
  userId: number;
  role: string;
  isOwner?: boolean;
}

export interface StudioWorkflowTask {
  status: string;
  assignedTo: number | null;
  submittedBy: number | null;
}

const EDITABLE = new Set(["ASSIGNED", "IN_PROGRESS", "REJECTED"]);

function isAdmin(user: StudioWorkflowUser): boolean {
  return user.role === "admin" || user.isOwner === true;
}

export function hasStudioOverrideReason(reason?: string | null): boolean {
  return (reason?.trim().length ?? 0) >= 5;
}

export function needsStudioEditOverride(task: StudioWorkflowTask, user: StudioWorkflowUser): boolean {
  return EDITABLE.has(task.status) && isAdmin(user) && Number(task.assignedTo) !== user.userId;
}

export function canEditStudioTask(
  task: StudioWorkflowTask,
  user: StudioWorkflowUser,
  adminOverrideReason?: string | null,
): boolean {
  if (!EDITABLE.has(task.status)) return false;
  if (Number(task.assignedTo) === user.userId) return true;
  return isAdmin(user) && hasStudioOverrideReason(adminOverrideReason);
}

function reviewConflicts(task: StudioWorkflowTask, user: StudioWorkflowUser): boolean {
  return Number(task.assignedTo) === user.userId || Number(task.submittedBy) === user.userId;
}

export function needsStudioReviewOverride(task: StudioWorkflowTask, user: StudioWorkflowUser): boolean {
  return task.status === "PENDING_REVIEW" && isAdmin(user) && reviewConflicts(task, user);
}

export function canReviewStudioTask(
  task: StudioWorkflowTask,
  user: StudioWorkflowUser,
  adminOverrideReason?: string | null,
): boolean {
  if (task.status !== "PENDING_REVIEW" || !["admin", "manager"].includes(user.role) && user.isOwner !== true) {
    return false;
  }
  if (!reviewConflicts(task, user)) return true;
  return isAdmin(user) && hasStudioOverrideReason(adminOverrideReason);
}

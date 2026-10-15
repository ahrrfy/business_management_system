import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { hasModuleAccess, type PermissionMap } from "@shared/permissions";
import type { Tx } from "../../db";
import {
  assertOperationAuthorityTx,
  canonicalOperationAllowed,
  hasServiceOperationAuthority,
  loadOperationUserTx,
  type ServiceOperationAuthority,
} from "./operationAuthority";

export interface StudioOperationActor {
  userId: number;
  role: string;
  isOwner?: boolean;
  operationAuthority?: ServiceOperationAuthority;
  managementAuthority?: ServiceOperationAuthority;
}

/** Account provisioning stays on its existing fixed authority gate. */
export const STUDIO_MANAGER_OPERATIONS = new Set([
  "productStudio.assignees",
  "productStudio.createCampaign",
  "productStudio.updateCampaignDetails",
  "productStudio.transitionCampaign",
  "productStudio.previewCampaignBacklog",
  "productStudio.createCampaignBacklog",
  "productStudio.drainCampaignBacklog",
  "productStudio.distributeCampaignTasks",
  "productStudio.updateCampaignAssignees",
  "productStudio.campaigns",
  "productStudio.campaignBoard",
  "productStudio.campaignAnalytics",
  "productStudio.productImages",
  "productStudio.managerImages",
  "productStudio.deleteImage",
  "productStudio.setImagePrimary",
  "productStudio.reorderImages",
  "productStudio.imageHealthCounts",
  "productStudio.discoverImageGaps",
  "productStudio.gapProductIds",
  "productStudio.topGapCategories",
  "productStudio.sendDueNotifications",
  "productStudio.assign",
  "productStudio.bulkAssign",
  "productStudio.reassign",
  "productStudio.bulkReassign",
  "productStudio.bulkSetPriority",
  "productStudio.updateSchedule",
  "productStudio.approve",
  "productStudio.reject",
  "productStudio.revert",
  "productStudio.cancel",
  "productStudio.cancelCampaignBacklog",
]);

function forbiddenStudioOperation(): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: "تعذّر تنفيذ عملية الاستوديو",
      why: "التفويض الحالي لا يطابق هذه العملية",
      doThis: "حدّث الصفحة واطلب من الإدارة تفويض العملية المطلوبة لحسابك",
    }),
  });
}

export function isStudioManager(actor: StudioOperationActor): boolean {
  const authority = actor.operationAuthority;
  const delegated =
    authority &&
    STUDIO_MANAGER_OPERATIONS.has(authority.path) &&
    hasServiceOperationAuthority(authority, actor.userId, authority.path);
  const management = actor.managementAuthority;
  const delegatedTaskRead =
    authority &&
    STUDIO_REVIEW_READ_OPERATIONS.has(authority.path) &&
    management &&
    STUDIO_TASK_MANAGEMENT_OPERATIONS.has(management.path) &&
    hasServiceOperationAuthority(authority, actor.userId, authority.path) &&
    hasServiceOperationAuthority(management, actor.userId, management.path);
  return (
    Boolean(delegated || delegatedTaskRead) ||
    (!authority && (actor.role === "admin" || actor.role === "manager")) ||
    actor.isOwner === true
  );
}

export const STUDIO_REVIEW_READ_OPERATIONS = new Set([
  "productStudio.tasks",
  "productStudio.candidatePreview",
  "productStudio.taskPreviousImages",
]);
export const STUDIO_TASK_MANAGEMENT_OPERATIONS = new Set([
  "productStudio.assign",
  "productStudio.bulkAssign",
  "productStudio.reassign",
  "productStudio.bulkReassign",
  "productStudio.bulkSetPriority",
  "productStudio.updateSchedule",
  "productStudio.approve",
  "productStudio.reject",
  "productStudio.revert",
  "productStudio.cancel",
  "productStudio.cancelCampaignBacklog",
]);

/** Complete RPC surface used by StudioPhotographerWorkspace. */
export const STUDIO_PHOTOGRAPHER_OPERATIONS = [
  "productStudio.tasks",
  "productStudio.myCampaigns",
  "productStudio.taskPreviousImages",
  "productStudio.nextPhotographerTask",
  "productStudio.claimByBarcode",
  "productStudio.submitCandidate",
  "productStudio.revert",
] as const;

/** A proof for approving cannot be reused for cancelling or provisioning accounts. */
export function assertStudioOperationBinding(
  actor: StudioOperationActor,
  expectedPath: string,
): void {
  const authority = actor.operationAuthority;
  if (!authority) return;
  const composedBacklog =
    authority.path === "productStudio.drainCampaignBacklog" &&
    (expectedPath === "productStudio.createCampaignBacklog" ||
      expectedPath === "productStudio.distributeCampaignTasks");
  if (
    !hasServiceOperationAuthority(authority, actor.userId, expectedPath) &&
    !(
      composedBacklog &&
      hasServiceOperationAuthority(authority, actor.userId, authority.path)
    )
  ) {
    throw forbiddenStudioOperation();
  }
}

/** Held role/user locks serialize revocation with the actual business transaction. */
export async function assertStudioOperationTx(
  tx: Tx,
  actor: StudioOperationActor,
  expectedPath: string,
): Promise<void> {
  assertStudioOperationBinding(actor, expectedPath);
  const authority = actor.operationAuthority;
  if (!authority) return;
  await assertOperationAuthorityTx(tx, actor, authority.path, false, authority);
  if (
    expectedPath === "productStudio.distributeCampaignTasks" &&
    authority.path !== expectedPath
  ) {
    await assertOperationAuthorityTx(tx, actor, expectedPath, false);
  }
}

/** Capturing an image and approving it are separate delegated operations. */
export async function canAutoApproveStudioTx(
  tx: Tx,
  actor: StudioOperationActor,
): Promise<boolean> {
  if (!actor.operationAuthority) return isStudioManager(actor);
  const user = await loadOperationUserTx(tx, actor.userId);
  // Delegated reviewers still cannot approve their own submissions. Legacy direct
  // manager capture stays unchanged; canonical automatic publication is administrative.
  return (
    canonicalOperationAllowed(user, "productStudio.approve") === true &&
    (user.role === "admin" || user.isOwner === true)
  );
}

export async function hasStudioManagementOperationsTx(
  tx: Tx,
  actor: StudioOperationActor,
): Promise<boolean> {
  if (!actor.operationAuthority) return isStudioManager(actor);
  const user = await loadOperationUserTx(tx, actor.userId);
  return Array.from(STUDIO_MANAGER_OPERATIONS).some(
    (path) => canonicalOperationAllowed(user, path) === true,
  );
}

/** Assignment requires an executable task lifecycle, rather than a broad module flag. */
export async function canStudioPhotographTx(
  tx: Tx,
  userId: number,
): Promise<boolean> {
  const user = await loadOperationUserTx(tx, userId);
  const capture = canonicalOperationAllowed(
    user,
    "productStudio.submitCandidate",
  );
  if (capture !== undefined) {
    return (
      capture &&
      canonicalOperationAllowed(user, "productStudio.tasks") === true &&
      canonicalOperationAllowed(user, "productStudio.claimByBarcode") === true
    );
  }
  return hasModuleAccess(
    user.role ?? "user",
    user.permissionsOverride as PermissionMap | null,
    "productStudio",
    "FULL",
  );
}

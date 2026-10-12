import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  getOperationPermission,
  hasOperationPolicy,
  operationDecision,
  operationRecordScope,
  type OperationRecordScope,
} from "@shared/operationPermissions";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import {
  hasServiceOperationAuthority,
  loadOperationUserTx,
  type ServiceOperationActor,
  type StoredOperationSnapshot,
} from "../authorization/operationAuthority";

export type DigitalIntentActor = Actor & ServiceOperationActor;
export interface DigitalIntentScope {
  readonly current: StoredOperationSnapshot;
  readonly userId: number;
  readonly path: string;
  readonly canonical: boolean;
  readonly scope: OperationRecordScope;
  readonly legacyElevated: boolean;
}
type IntentIdentity = { createdBy: number; branchId: number };

const RECOVER = "digitalCards.sales.recover";
export const DIGITAL_REVIEW_PARENT =
  "digitalCards.sales.approveReviewResolution";

function forbidden(
  message = "التفويض الحالي لا يسمح بهذه العملية على النيّة",
): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message });
}

/** Pure decision, using the actual authorizing user rather than the accounting actor. */
export function resolveDigitalIntentScope(
  current: StoredOperationSnapshot,
  actor: DigitalIntentActor,
  path: string,
  acceptedParents: readonly string[] = [],
  legacyAllowed = true,
): DigitalIntentScope {
  const parent = acceptedParents.find((candidate) =>
    hasServiceOperationAuthority(
      actor.operationAuthority,
      actor.userId,
      candidate,
    ),
  );
  const selectedPath = parent ?? path;
  if (
    actor.operationAuthority &&
    !hasServiceOperationAuthority(
      actor.operationAuthority,
      actor.userId,
      selectedPath,
    )
  ) {
    throw forbidden();
  }
  const canonical = hasOperationPolicy(current);
  if (
    (current.isOwner !== true &&
      actor.role != null &&
      actor.role !== current.role) ||
    (current.role !== "admin" &&
      current.branchId !== undefined &&
      Number(actor.branchId) !== Number(current.branchId))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({ what: "تغيّر دور الحساب أو فرعه", why: "إسناد الحساب الحالي يختلف عن الإسناد عند فتح الطلب", doThis: "حدّث الصفحة وراجع الدور والفرع الحاليين ثم أعد المحاولة" }),
    });
  }
  if (
    !(
      current.isOwner === true ||
      (canonical
        ? operationDecision(current, selectedPath).allowed
        : legacyAllowed)
    )
  ) {
    throw forbidden();
  }
  const legacyElevated =
    current.isOwner === true ||
    current.role === "admin" ||
    current.role === "manager";
  return {
    current,
    userId: actor.userId,
    path: selectedPath,
    canonical,
    // Existing review decisions have branch authority until all their handlers support record scopes.
    scope: canonical
      ? parent === DIGITAL_REVIEW_PARENT &&
        getOperationPermission(parent)?.supportsRecordScope !== true
        ? "BRANCH"
        : operationRecordScope(current, selectedPath)
      : legacyElevated
        ? "BRANCH"
        : "OWN",
    legacyElevated,
  };
}

/** Role/user policy rows stay locked for the same transaction as the intent read/write. */
export async function loadDigitalIntentScopeTx(
  tx: Tx,
  actor: DigitalIntentActor,
  path: string,
  acceptedParents: readonly string[] = [],
  legacyAllowed = true,
): Promise<DigitalIntentScope> {
  return resolveDigitalIntentScope(
    await loadOperationUserTx(tx, actor.userId),
    actor,
    path,
    acceptedParents,
    legacyAllowed,
  );
}

export function digitalIntentRecordAllowed(
  authority: DigitalIntentScope,
  intent: IntentIdentity,
): boolean {
  if (authority.current.isOwner === true) return true;
  // Match the central fixed cross-branch identity; OWN still narrows record ownership.
  const canCrossBranches = authority.current.role === "admin";
  if (
    !canCrossBranches &&
    (!Number.isFinite(Number(authority.current.branchId)) ||
      Number(authority.current.branchId) <= 0 ||
      Number(intent.branchId) !== Number(authority.current.branchId))
  )
    return false;
  return (
    authority.scope === "BRANCH" ||
    Number(intent.createdBy) === authority.userId
  );
}

export function assertDigitalIntentScope(
  authority: DigitalIntentScope,
  intent: IntentIdentity,
): void {
  if (!digitalIntentRecordAllowed(authority, intent))
    throw forbidden("هذه النيّة خارج نطاق تفويض حسابك أو فرعك");
}

export function digitalIntentCanUseOtherShift(
  authority: DigitalIntentScope,
): boolean {
  return (
    authority.current.isOwner === true ||
    (authority.canonical
      ? authority.scope === "BRANCH"
      : authority.legacyElevated)
  );
}

/** The selected execution operation authorizes retries; leases and SUCCESS remain immutable. */
export function digitalIntentCanRetry(authority: DigitalIntentScope): boolean {
  return authority.canonical || authority.legacyElevated;
}

/** Ordinary finalize/claim grants do not silently grant administrative recovery. */
export function digitalIntentCanRecover(
  authority: DigitalIntentScope,
  intent: IntentIdentity,
): boolean {
  if (!authority.canonical) return authority.legacyElevated;
  if (authority.path === RECOVER || authority.path === DIGITAL_REVIEW_PARENT) {
    return digitalIntentRecordAllowed(authority, intent);
  }
  if (!operationDecision(authority.current, RECOVER).allowed) return false;
  return digitalIntentRecordAllowed(
    {
      ...authority,
      path: RECOVER,
      scope: operationRecordScope(authority.current, RECOVER),
    },
    intent,
  );
}

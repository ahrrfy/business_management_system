import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  getOperationPermission,
  canViewOperationData,
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

/** Only a saved canonical policy can replace an obsolete role/module gate. */
export function canonicalOperationAllowed(user: OperationUser, path: string): boolean {
  return hasOperationPolicy(user) && getOperationPermission(path)?.delegable === true
    && operationDecision(user, path).allowed;
}

/** Reserved authorities keep their own guard; a new unclassified path fails closed. */
export function assertOperationAuthorized(user: OperationUser | null | undefined, path: string): void {
  if (!user || user.isOwner === true || !hasOperationPolicy(user)) return;
  const operation = getOperationPermission(path);
  if (operation && !operation.delegable && operation.reservedKind !== "UNSUPPORTED" && !operation.requiresLegacyReview) return;
  const decision = operationDecision(user, path);
  if (!decision.allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تنفيذ العملية",
        why: decision.reason,
        doThis: "اطلب من الإدارة تفويض هذه العملية لحسابك أو دورك ثم أعد المحاولة",
      }),
    });
  }
  if (operation?.requiresCostVisibility && (!canViewOperationData(user, "purchaseCost") || !canViewOperationData(user, "profitMargin"))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر عرض بيانات العملية",
        why: "هذه القراءة تتضمن تكلفة أو ربحًا لم تفوض الإدارة حسابك بعرضهما",
        doThis: "اطلب تفويض عرض التكلفة والربح مع هذه العملية من إدارة الصلاحيات",
      }),
    });
  }
}

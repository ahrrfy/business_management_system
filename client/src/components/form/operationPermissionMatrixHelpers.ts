import { PERMISSION_MODULES } from "@shared/permissions";
import {
  OPERATION_PERMISSIONS,
  type OperationPermission,
  type OperationPolicy,
} from "@shared/operationPermissions";

export const operations = OPERATION_PERMISSIONS.filter(
  (operation) => operation.delegable,
);
const stageLabels: Record<string, string> = {
  VIEW: "العرض والبحث",
  PREPARATION: "الإعداد والمسودة",
  REQUEST: "الطلب والإرسال",
  APPROVAL: "المراجعة والاعتماد",
  EXECUTION: "التنفيذ",
  COLLECTION: "التحصيل",
  SETTLEMENT: "التسوية",
  REVERSAL: "الإلغاء والعكس",
  CLOSURE: "الإقفال",
  ADMINISTRATION: "الإدارة",
  CORRECTION: "التصحيح والمرتجعات",
  CLOSING: "الإقفال",
  CANCELLATION: "الإلغاء والعكس",
  PAYMENT: "التحصيل والسداد",
};
export const stageLabel = (key: string) => stageLabels[key] ?? key;

/** Only business operations are editable; protected identity/owner endpoints stay outside the policy. */
export function editableOperationPolicy(
  policy: OperationPolicy,
): OperationPolicy {
  return {
    ...policy,
    grants: Object.fromEntries(
      operations.map((operation) => [
        operation.key,
        policy.grants[operation.key] === true,
      ]),
    ),
  };
}

/** Convert an old effective snapshot to differences without freezing inherited operations. */
export function individualOperationOverrides(
  effective: OperationPolicy,
  inherited: OperationPolicy,
): OperationPolicy {
  const grants: Record<string, boolean> = {};
  const recordScopes: Record<string, "OWN" | "BRANCH"> = {};
  for (const operation of operations) {
    if (
      (effective.grants[operation.key] === true) !==
      (inherited.grants[operation.key] === true)
    )
      grants[operation.key] = effective.grants[operation.key] === true;
    if (
      operation.supportsRecordScope &&
      effective.recordScopes?.[operation.key] !==
        inherited.recordScopes?.[operation.key] &&
      effective.recordScopes?.[operation.key]
    )
      recordScopes[operation.key] = effective.recordScopes[operation.key];
  }
  const costDiff =
    effective.dataVisibility?.purchaseCost !==
    inherited.dataVisibility?.purchaseCost;
  return {
    version: 1,
    grants,
    ...(Object.keys(recordScopes).length ? { recordScopes } : {}),
    ...(costDiff
      ? {
          dataVisibility: {
            purchaseCost: effective.dataVisibility?.purchaseCost === true,
            profitMargin: effective.dataVisibility?.purchaseCost === true,
          },
        }
      : {}),
  };
}

export type OperationSelection = "allow" | "deny" | "inherit";

export const requiresCost = (operation: OperationPermission) =>
  operation.requiresCostVisibility === true;

export const moduleLabel = (key: string) =>
  PERMISSION_MODULES.find((module) => module.key === key)?.label ??
  operations.find((operation) => operation.domain === key)?.resource ??
  key;

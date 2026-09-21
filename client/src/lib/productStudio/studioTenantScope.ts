export interface StudioTenantScope {
  /** `null` هو النطاق الصريح لنشر الشركة الواحدة، وليس شركةً افتراضيةً رقمها صفر. */
  companyId: number | null;
  userId: number;
}

export function isValidStudioTenantScope(
  value: unknown,
): value is StudioTenantScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<StudioTenantScope>;
  return (
    Number.isInteger(scope.userId) &&
    Number(scope.userId) > 0 &&
    (scope.companyId === null ||
      (Number.isInteger(scope.companyId) && Number(scope.companyId) > 0))
  );
}

export function sameStudioTenantScope(
  left: StudioTenantScope | null | undefined,
  right: StudioTenantScope | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.userId === right.userId &&
    left.companyId === right.companyId
  );
}

/** قيمة ثابتة للـHMAC فقط؛ لا تُستعمل كإذن ولا تُعرض للمستخدم. */
export function studioTenantScopeKey(scope: StudioTenantScope): string {
  return `${scope.companyId === null ? "single" : `company-${scope.companyId}`}:user-${scope.userId}`;
}

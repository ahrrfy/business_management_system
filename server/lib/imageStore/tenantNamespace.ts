import { isMultiTenantModeActive } from "../../db";
import { getCurrentCompanyId } from "../../tenancy/context";

/** نطاق R2 ثابت لكل شركة؛ غياب سياق شركة في وضع تعدد الشركات خطأ مغلق لا سقوط إلى نطاق مشترك. */
export function imageStoreTenantPrefix(): string {
  const companyId = getCurrentCompanyId();
  if (isMultiTenantModeActive() && companyId == null) {
    throw new Error("ImageStore: company context is required in multi-tenant mode");
  }
  return companyId == null ? "single" : `company-${companyId}`;
}

/** جذر Studio هو أيضاً نطاق الاحتفاظ/المرآة؛ يُشتق دائماً من نفس سياق المستأجر. */
export function studioObjectRoot(): string {
  return `${imageStoreTenantPrefix()}/studio/`;
}

export function studioObjectPrefix(kind: "original" | "candidate"): string {
  return `${studioObjectRoot()}${kind}`;
}

/** لا يسمح مسار HTTP إلا بمشتق المرشّح المنشور داخل نطاق الشركة الحالية. */
export function isCurrentTenantCandidateKey(key: string): boolean {
  return key.startsWith(`${studioObjectPrefix("candidate")}/`);
}

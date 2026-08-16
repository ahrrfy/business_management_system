/**
 * نقاط tRPC العامة التي تُغيّر حالة أو تُسهّل الاستنزاف لا تقبل أكثر من عملية واحدة في HTTP batch.
 * حد المعدّل في Express يحسب الطلبات؛ من دون هذا الحارس تصبح الدفعة وسيلة لمضاعفة المحاولات.
 */
const PUBLIC_SENSITIVE_PROCEDURES = [
  "auth.login",
  "auth.twoFactorVerify",
  "auth.resetPasswordWithToken",
  "count.auth",
  "kiosk.deviceLogin",
  "recruitment.submit",
  "platformAdmin.login",
  "storefront.createOrder",
  "storefront.trackBanner",
  "storefront.trackConversion",
  "storefront.trackOrder",
] as const;

/** true عندما يحوي مسار tRPC batch أكثر من عملية عامة حساسة واحدة. */
export function hasOverfilledPublicSensitiveBatch(path: string): boolean {
  if (!path.includes(",")) return false;
  const procedures = path.split("/").pop()?.split(",") ?? [];
  const sensitiveCount = procedures.filter((procedure) =>
    PUBLIC_SENSITIVE_PROCEDURES.some((sensitive) => procedure.includes(sensitive)),
  ).length;
  return sensitiveCount > 1;
}

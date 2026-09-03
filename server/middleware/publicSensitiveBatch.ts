/**
 * نقاط tRPC العامة التي تُغيّر حالة أو تُسهّل الاستنزاف لا تقبل أكثر من عملية واحدة في HTTP batch.
 * حد المعدّل في Express يحسب الطلبات؛ من دون هذا الحارس تصبح الدفعة وسيلة لمضاعفة المحاولات.
 */
const PUBLIC_SENSITIVE_PROCEDURES: ReadonlySet<string> = new Set([
  "auth.login",
  "auth.twoFactorVerify",
  "auth.resetPasswordWithToken",
  "count.auth",
  "kiosk.deviceLogin",
  "recruitment.submit",
  "platformAdmin.login",
  "storefront.createOrder",
  "storefront.quoteOrder",
  "storefront.quoteOrderPrivate",
  "storefront.trackBanner",
  "storefront.trackConversion",
  "storefront.trackOrder",
  "storefront.trackOrderPrivate",
  "storefront.trackOrderByToken",
]);

const CANONICAL_PROCEDURE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/**
 * يفحص المسار الخام قبل أن يفكّ Express/tRPC percent-encoding. أي ترميز أو slash إضافي أو
 * حبيبة فارغة يُرفض؛ وإلا نحصل على أسماء إجراءات كاملة يمكن مطابقتها دون substring.
 */
export function parseCanonicalTrpcProcedures(path: string): string[] | null {
  if (!path.startsWith("/") || path.includes("%") || path.slice(1).includes("/")) return null;
  const raw = path.slice(1);
  if (!raw) return null;
  const procedures = raw.split(",");
  if (!procedures.length || procedures.some((procedure) => !CANONICAL_PROCEDURE.test(procedure))) {
    return null;
  }
  return procedures;
}

/** true عندما يحوي مسار tRPC batch أكثر من عملية عامة حساسة واحدة. */
export function hasOverfilledPublicSensitiveBatch(path: string): boolean {
  const procedures = parseCanonicalTrpcProcedures(path);
  if (!procedures) return true;
  if (procedures.length === 1) return false;
  const sensitiveCount = procedures.filter((procedure) => PUBLIC_SENSITIVE_PROCEDURES.has(procedure)).length;
  return sensitiveCount > 1;
}

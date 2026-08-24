const PRODUCT_PATH = /^\/product\/\d+$/;
const ALLOWED_PATHS = new Set(["/", "/search", "/categories", "/cart", "/orders"]);

/**
 * يقبل روابط التطبيق الداخلية فقط. لا تسمح رسائل الحملات بفتح متصفح أو deep link خارجي.
 */
export function isAllowedStorefrontNotificationPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 180) return false;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) return false;
  return ALLOWED_PATHS.has(value) || PRODUCT_PATH.test(value);
}

export function storefrontPathFromNotificationData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const path = (data as Record<string, unknown>).path;
  return isAllowedStorefrontNotificationPath(path) ? path : null;
}

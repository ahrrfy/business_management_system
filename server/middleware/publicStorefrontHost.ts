import type { NextFunction, Request, Response } from "express";

const PUBLIC_HOSTS = new Set(["alarabiya.online", "www.alarabiya.online"]);

const PUBLIC_AUTH = new Set([
  "nativeDeviceChallenge", "me", "tenancyMode", "resetPasswordWithToken", "login", "twoFactorVerify",
  "changePassword", "revokeMySessions", "mySessions", "revokeSession", "twoFactorStatus",
  "twoFactorSetupStart", "twoFactorSetupConfirm", "twoFactorDisable", "twoFactorRegenerateCodes",
]);
const PUBLIC_PUSH = new Set(["publicKey", "myStatus", "subscribe", "unsubscribe"]);
const PUBLIC_RECRUITMENT = new Set(["submit", "openVacancies"]);

function extractHostname(host: string | undefined): string {
  return (host ?? "")
    .split(",", 1)[0]
    .trim()
    .split(":", 1)[0]
    .trim()
    .toLowerCase();
}

function readHeader(
  req: Partial<Pick<Request, "get" | "headers">>,
  name: string,
): string | undefined {
  if (typeof req.get === "function") {
    const value = req.get(name);
    if (typeof value === "string") return value;
  }
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

export function isPublicStorefrontHost(host: string | undefined): boolean {
  if (!host) return false;
  return host
    .split(",")
    .some((candidate) => PUBLIC_HOSTS.has(extractHostname(candidate)));
}

export const isPublicStorefrontHostname = isPublicStorefrontHost;

export function isPublicStorefrontRequest(
  req: Pick<Request, "hostname"> & Partial<Pick<Request, "get" | "headers">>,
): boolean {
  const rawHost = readHeader(req, "host");
  const forwardedHost = readHeader(req, "x-forwarded-host");
  const rawHostIsPublic = isPublicStorefrontHost(rawHost);
  const forwardedHostIsPublic = isPublicStorefrontHost(forwardedHost);
  const forwardedClassificationMismatch =
    Boolean(forwardedHost?.trim()) &&
    Boolean(rawHost?.trim()) &&
    rawHostIsPublic !== forwardedHostIsPublic;
  return (
    isPublicStorefrontHost(req.hostname) ||
    rawHostIsPublic ||
    forwardedHostIsPublic ||
    forwardedClassificationMismatch
  );
}

export function isPublicStorefrontProcedure(procedure: string): boolean {
  // أسماء tRPC لا تحتاج percent-encoding. رفضه قبل المهايئ يمنع تحويل `%2C`
  // لاحقاً إلى فاصلة batch بعد أن تكون حراس المضيف/المعدل قد رأوا نداءً واحداً.
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(procedure)) return false;
  const [namespace, operation, ...rest] = procedure.split(".");
  if (rest.length || !namespace || !operation) return false;
  if (namespace === "storefront" || namespace === "courier") return true;
  if (namespace === "auth") return PUBLIC_AUTH.has(operation);
  if (namespace === "push") return PUBLIC_PUSH.has(operation);
  return namespace === "recruitment" && PUBLIC_RECRUITMENT.has(operation);
}

export function isAllowedOnPublicStorefrontHost(method: string, path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  const isPublicImage = (method === "GET" || method === "HEAD") && path.startsWith("/api/img/");
  const trpcPath = path.match(/^\/api\/trpc\/([^/]+)$/)?.[1];
  const isPublicTrpc = !!trpcPath && trpcPath.split(",").every(isPublicStorefrontProcedure);
  return isPublicImage || isPublicTrpc;
}

/** يحمي نطاق الناس من كل API داخلي؛ الدفعة لا تمر إلا إن كانت كل إجراءاتها مسموحة صراحةً. */
export function publicStorefrontHostBoundary(req: Request, res: Response, next: NextFunction): void {
  if (!isPublicStorefrontRequest(req) || !/^\/api\//i.test(req.path)) return next();
  // ارفض case variants صراحةً أيضاً؛ هذا دفاع مستقل إذا تغيّر ترتيب تهيئة Express لاحقاً.
  if (!isAllowedOnPublicStorefrontHost(req.method, req.path)) {
    res.status(404).end();
    return;
  }
  return next();
}

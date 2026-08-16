import type { NextFunction, Request, Response } from "express";

const PUBLIC_HOSTS = new Set(["alarabiya.online", "www.alarabiya.online"]);

const PUBLIC_AUTH = new Set([
  "nativeDeviceChallenge", "me", "tenancyMode", "resetPasswordWithToken", "login", "twoFactorVerify",
  "changePassword", "revokeMySessions", "mySessions", "revokeSession", "twoFactorStatus",
  "twoFactorSetupStart", "twoFactorSetupConfirm", "twoFactorDisable", "twoFactorRegenerateCodes",
]);
const PUBLIC_PUSH = new Set(["publicKey", "myStatus", "subscribe", "unsubscribe"]);
const PUBLIC_RECRUITMENT = new Set(["submit", "openVacancies"]);

export function isPublicStorefrontHost(host: string | undefined): boolean {
  return PUBLIC_HOSTS.has((host ?? "").split(":", 1)[0].toLowerCase());
}

export function isPublicStorefrontProcedure(procedure: string): boolean {
  const [namespace, operation, ...rest] = procedure.split(".");
  if (rest.length || !namespace || !operation) return false;
  if (namespace === "storefront" || namespace === "courier") return true;
  if (namespace === "auth") return PUBLIC_AUTH.has(operation);
  if (namespace === "push") return PUBLIC_PUSH.has(operation);
  return namespace === "recruitment" && PUBLIC_RECRUITMENT.has(operation);
}

/** يحمي نطاق الناس من كل API داخلي؛ الدفعة لا تمر إلا إن كانت كل إجراءاتها مسموحة صراحةً. */
export function publicStorefrontHostBoundary(req: Request, res: Response, next: NextFunction): void {
  if (!isPublicStorefrontHost(req.hostname) || !req.path.startsWith("/api/")) return next();
  const isPublicImage = (req.method === "GET" || req.method === "HEAD") && req.path.startsWith("/api/img/");
  const trpcPath = req.path.match(/^\/api\/trpc\/([^/]+)$/)?.[1];
  const isPublicTrpc = !!trpcPath && trpcPath.split(",").every(isPublicStorefrontProcedure);
  if (isPublicImage || isPublicTrpc) return next();
  res.status(404).end();
}

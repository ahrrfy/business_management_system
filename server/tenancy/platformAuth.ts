import { PLATFORM_ADMIN_COOKIE_NAME } from "@shared/const";
import { parse as parseCookie } from "cookie";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { computeSessionFingerprint } from "../auth/session";
import { getControlDb } from "./controlDb";
import { platformAdmins, type PlatformAdmin } from "./controlSchema";

/**
 * جلسة مدير المنصّة — JWT + كوكي منفصلان تماماً عن `server/auth/session.ts` (جلسة
 * مستخدمي الشركات). نفس آلية jose/HS256 لكن بحمولة وكوكي مختلفين، ولا علاقة لها
 * بـAsyncLocalStorage/runWithCompany (مدير المنصّة لا يعمل داخل قاعدة أي شركة إطلاقاً
 * — فقط قاعدة التحكّم erp_control عبر `getControlDb`).
 */
const PLATFORM_SESSION_MS = 1000 * 60 * 60 * 8; // ٨ ساعات — جلسة عمل إدارية أقصر من جلسة المستخدم العادي

const revokedPlatformTokenHashes = new Map<string, number>();
const platformAdminRevokedBeforeMs = new Map<number, number>();
const platformAdminRevokedBeforeSec = new Map<number, number>();
const platformAdminSessionGen = new Map<number, number>();

function hashPlatformToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneRevokedPlatformTokens(nowMs = Date.now()): void {
  revokedPlatformTokenHashes.forEach((expiresAtMs, hash) => {
    if (expiresAtMs <= nowMs) {
      revokedPlatformTokenHashes.delete(hash);
    }
  });
}

function extractPlatformTokenFromRequest(
  req?: Request | { headers?: Record<string, unknown> } | null,
): string | null {
  if (!req?.headers) return null;
  const cookieHeader =
    typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const cookies = parseCookie(cookieHeader);
  const cookieToken = cookies[PLATFORM_ADMIN_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)) {
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (bearer) return bearer;
  }
  return null;
}

export function revokePlatformAdminSession(
  req?: Request | { headers?: Record<string, unknown> } | null,
  adminId?: number | null,
): void {
  const nowMs = Date.now();
  pruneRevokedPlatformTokens(nowMs);
  const rawToken = extractPlatformTokenFromRequest(req);
  if (rawToken) {
    revokedPlatformTokenHashes.set(
      hashPlatformToken(rawToken),
      nowMs + PLATFORM_SESSION_MS,
    );
  }
  if (typeof adminId === "number" && Number.isInteger(adminId) && adminId > 0) {
    platformAdminRevokedBeforeMs.set(adminId, nowMs);
    platformAdminRevokedBeforeSec.set(adminId, Math.floor(nowMs / 1000));
    platformAdminSessionGen.set(
      adminId,
      (platformAdminSessionGen.get(adminId) ?? 0) + 1,
    );
  }
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for sessions");
  return new TextEncoder().encode(secret);
}

export async function signPlatformSession(adminId: number, req?: Request | null): Promise<string> {
  const nowMs = Date.now();
  const issuedAtSeconds = Math.floor(nowMs / 1000);
  const expirationSeconds = issuedAtSeconds + Math.floor(PLATFORM_SESSION_MS / 1000);
  const gen = platformAdminSessionGen.get(adminId) ?? 0;
  const claims: Record<string, unknown> = {
    pid: adminId,
    kind: "platform_admin",
    iatMs: nowMs,
    gen,
  };
  // تدقيق ٣/٨: بصمة الجهاز (كجلسة المستخدم) — تمنع إعادة استعمال توكن مدير المنصّة المسروق من
  // جهاز آخر. الاستدعاء بلا req (اختبارات) يُصدر توكناً بلا fp ويُعامَل legacy (لا مقارنة).
  if (req) claims.fp = computeSessionFingerprint(req);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(issuedAtSeconds)
    .setNotBefore(issuedAtSeconds)
    .setExpirationTime(expirationSeconds)
    .sign(getSecret());
}

async function verifyPlatformSession(token: string | undefined | null, req?: Request | null): Promise<number | null> {
  if (!token) return null;
  pruneRevokedPlatformTokens();
  if (revokedPlatformTokenHashes.has(hashPlatformToken(token))) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"], clockTolerance: 60 });
    // `kind` يمنع تبادل توكنات جلسة مستخدم عادي عرَضاً هنا (حمولتان مختلفتا الشكل تماماً،
    // لكن فحص صريح أوضح من الاعتماد على غياب حقل uid وحده).
    if (payload.kind !== "platform_admin") return null;
    const pid = Number(payload.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const currentGen = platformAdminSessionGen.get(pid) ?? 0;
    if (typeof payload.gen === "number") {
      if (payload.gen < currentGen) return null;
    } else {
      const revokedBeforeMs = platformAdminRevokedBeforeMs.get(pid);
      const revokedBeforeSec = platformAdminRevokedBeforeSec.get(pid);
      if (typeof payload.iatMs === "number" && revokedBeforeMs != null && payload.iatMs <= revokedBeforeMs) {
        return null;
      }
      if (typeof payload.iat === "number" && revokedBeforeSec != null && payload.iat <= revokedBeforeSec) {
        return null;
      }
    }
    // تدقيق ٣/٨: إن مُرّر طلب، ألزم تطابق بصمة الجهاز. توكن legacy بلا fp عند تمرير req ⇒ يُرفض
    // (re-login إجباري مرّة واحدة بعد الترقية) — لا توكنات مدير منصّة قائمة في النشر الأحادي الحالي.
    if (req) {
      const fp = typeof payload.fp === "string" ? payload.fp : undefined;
      if (!fp || fp !== computeSessionFingerprint(req)) return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/** يحلّ مدير المنصّة الحالي من كوكي الطلب، أو null. */
export async function getPlatformAdminFromRequest(req: Request): Promise<PlatformAdmin | null> {
  const rawToken = extractPlatformTokenFromRequest(req);
  const pid = await verifyPlatformSession(rawToken, req);
  if (!pid) return null;

  const db = getControlDb();
  if (!db) return null;

  const rows = await db.select().from(platformAdmins).where(eq(platformAdmins.id, pid)).limit(1);
  const admin = rows[0];
  if (!admin || !admin.isActive) return null;
  return admin;
}

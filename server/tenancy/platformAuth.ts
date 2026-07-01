import { PLATFORM_ADMIN_COOKIE_NAME } from "@shared/const";
import { parse as parseCookie } from "cookie";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { getControlDb } from "./controlDb";
import { platformAdmins, type PlatformAdmin } from "./controlSchema";

/**
 * جلسة مدير المنصّة — JWT + كوكي منفصلان تماماً عن `server/auth/session.ts` (جلسة
 * مستخدمي الشركات). نفس آلية jose/HS256 لكن بحمولة وكوكي مختلفين، ولا علاقة لها
 * بـAsyncLocalStorage/runWithCompany (مدير المنصّة لا يعمل داخل قاعدة أي شركة إطلاقاً
 * — فقط قاعدة التحكّم erp_control عبر `getControlDb`).
 */
const PLATFORM_SESSION_MS = 1000 * 60 * 60 * 8; // ٨ ساعات — جلسة عمل إدارية أقصر من جلسة المستخدم العادي

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for sessions");
  return new TextEncoder().encode(secret);
}

export async function signPlatformSession(adminId: number): Promise<string> {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const expirationSeconds = issuedAtSeconds + Math.floor(PLATFORM_SESSION_MS / 1000);
  return new SignJWT({ pid: adminId, kind: "platform_admin" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(issuedAtSeconds)
    .setNotBefore(issuedAtSeconds)
    .setExpirationTime(expirationSeconds)
    .sign(getSecret());
}

async function verifyPlatformSession(token: string | undefined | null): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"], clockTolerance: 60 });
    // `kind` يمنع تبادل توكنات جلسة مستخدم عادي عرَضاً هنا (حمولتان مختلفتا الشكل تماماً،
    // لكن فحص صريح أوضح من الاعتماد على غياب حقل uid وحده).
    if (payload.kind !== "platform_admin") return null;
    const pid = Number(payload.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/** يحلّ مدير المنصّة الحالي من كوكي الطلب، أو null. */
export async function getPlatformAdminFromRequest(req: Request): Promise<PlatformAdmin | null> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  const pid = await verifyPlatformSession(cookies[PLATFORM_ADMIN_COOKIE_NAME]);
  if (!pid) return null;

  const db = getControlDb();
  if (!db) return null;

  const rows = await db.select().from(platformAdmins).where(eq(platformAdmins.id, pid)).limit(1);
  const admin = rows[0];
  if (!admin || !admin.isActive) return null;
  return admin;
}

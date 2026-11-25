/**
 * تذكرة تحدّي المصادقة الثنائية — JWT قصير العمر (٥ دقائق) يصدر بعد نجاح كلمة المرور
 * لمستخدمٍ مفعِّلٍ 2FA، **بدل** كوكي الجلسة. العميل يعيدها مع رمز TOTP/الاسترداد إلى
 * auth.twoFactorVerify الذي يُصدر الجلسة الحقيقية عند نجاح الرمز.
 */
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { computeSessionFingerprint } from "./session";

export const TWO_FACTOR_TICKET_TTL_MS = 5 * 60 * 1000;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for sessions");
  return new TextEncoder().encode(secret);
}

export type TwoFactorTicketPayload = {
  uid: number;
  remember: boolean;
  /** وقت إصدار التذكرة (ثوانٍ) — يُقارَن بـusers.sessionsValidFrom كي لا تُكمَل تذكرة صُكّت قبل إبطالٍ للجلسات. */
  iat: number;
};

type ReqLike =
  | Request
  | { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } }
  | null
  | undefined;

export async function signTwoFactorTicket(
  payload: Omit<TwoFactorTicketPayload, "iat">,
  req: ReqLike,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    purpose: "2fa",
    uid: payload.uid,
    remember: payload.remember,
    fp: computeSessionFingerprint(req),
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(nowSec)
    .setNotBefore(nowSec)
    .setExpirationTime(nowSec + Math.floor(TWO_FACTOR_TICKET_TTL_MS / 1000))
    .sign(getSecret());
}

/** يعيد الحمولة أو null عند أي فشل (انتهاء/غرض خاطئ/بصمة جهاز مغايرة/توقيع فاسد). */
export async function verifyTwoFactorTicket(
  ticket: string | undefined | null,
  req: ReqLike,
): Promise<TwoFactorTicketPayload | null> {
  if (!ticket) return null;
  try {
    const { payload } = await jwtVerify(ticket, getSecret(), {
      algorithms: ["HS256"],
      clockTolerance: 60,
    });
    if (payload.purpose !== "2fa") return null;
    if (payload.companyId != null) return null;
    if (
      typeof payload.companyCode === "string" &&
      payload.companyCode.trim() !== ""
    ) {
      return null;
    }
    const uid = Number(payload.uid);
    if (!Number.isInteger(uid) || uid <= 0) return null;
    const fp = typeof payload.fp === "string" ? payload.fp : "";
    if (!fp || fp !== computeSessionFingerprint(req)) return null;
    const iat = Number(payload.iat);
    if (!Number.isInteger(iat) || iat <= 0) return null;
    return {
      uid,
      remember: payload.remember === true,
      iat,
    };
  } catch {
    return null;
  }
}

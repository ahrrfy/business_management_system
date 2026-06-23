import { COOKIE_NAME, SESSION_DEFAULT_MS } from "@shared/const";
import { parse as parseCookie } from "cookie";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { users, type User } from "../../drizzle/schema";
import { getDb } from "../db";

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required for sessions");
  }
  return new TextEncoder().encode(secret);
}

/**
 * بصمة الجلسة (session fingerprint) — تربط التوكن بجهازٍ معيّن لإفشال
 * إعادة استعماله من جهازٍ آخر إذا سُرق. نُولّد هاش `sha256(userAgent + ipPrefix)`
 * ونضمّه في حمولة الـJWT (claim باسم `fp`). عند كل تحقّق نُعيد حسابه من الطلب
 * الحالي ونقارن: عدم التطابق ⇒ نُبطل الجلسة (re-login إجباري).
 *
 * **بادئة IP لا IP كاملاً**: نأخذ أوّل أوكتيتين فقط لـIPv4 (مثال 192.168.x.x → "192.168")
 * وأوّل ٣ مقاطع hex لـIPv6 ⇒ يتحمّل تنقّل المستخدم بين CGNAT/شبكات الجوال داخل نفس الـISP
 * بلا طرده، لكنه يكسر النقل عبر بلد/شبكة مختلفة (وهو السيناريو الذي نريد رفضه).
 *
 * **User-Agent يدخل كاملاً**: تغيير المتصفح/الجهاز = جلسة جديدة (سلوك مرغوب).
 */
function ipPrefix(ip: string | null | undefined): string {
  if (!ip) return "";
  // IPv6: قد يصلنا كـ"::ffff:1.2.3.4" (IPv4-mapped) — استخرج IPv4 منه.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (ip.includes(".")) {
    // IPv4 → أوّل أوكتيتين.
    const parts = ip.split(".");
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : ip;
  }
  if (ip.includes(":")) {
    // IPv6 → أوّل ٣ مقاطع (≈ /48).
    const parts = ip.split(":");
    return parts.slice(0, 3).join(":");
  }
  return ip;
}

function getRequestIp(req: Request | { ip?: string; socket?: { remoteAddress?: string } } | null | undefined): string {
  if (!req) return "";
  const anyReq = req as { ip?: string; socket?: { remoteAddress?: string } };
  return anyReq.ip ?? anyReq.socket?.remoteAddress ?? "";
}

function getRequestUserAgent(req: Request | { headers?: Record<string, unknown> } | null | undefined): string {
  if (!req) return "";
  const anyReq = req as { headers?: Record<string, unknown> };
  const ua = anyReq.headers?.["user-agent"];
  return typeof ua === "string" ? ua : "";
}

/** يحسب بصمة الجلسة من الطلب الحالي (sha256 مقطوع ١٦ خانة hex — كافٍ لتمييز جهاز). */
export function computeSessionFingerprint(req: Request | { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } } | null | undefined): string {
  const ua = getRequestUserAgent(req);
  const ip = ipPrefix(getRequestIp(req));
  // الدمج بفاصل `\x1f` (Unit Separator) ⇒ لا تصادم محتمل بين قِيَم تنتهي/تبدأ بقيم الأخرى.
  return createHash("sha256").update(`${ua}\x1f${ip}`).digest("hex").slice(0, 32);
}

/**
 * حمولة الجلسة = المعرّف + بصمة الجهاز. **الدور لا يُحفظ في الـJWT** ويُقرأ دائماً من
 * قاعدة البيانات (المصدر الموثوق) — فلا يستطيع توكنٌ مسروق/قديم تثبيت دور مرتفع.
 * `iat` (وقت الإصدار، بالثواني) يُستعمل لإبطال الجلسات عبر `users.sessionsValidFrom`.
 * `fp` (بصمة الجهاز) يُقارَن بالطلب الحالي عبر `getUserFromRequest` ⇒ توكن مسروق
 * من جهاز آخر يَفشل verifyToken (fp لا يتطابق) ⇒ re-login إجباري.
 */
export type SessionPayload = { uid: number; iat: number; fp?: string };

/**
 * Sign a session JWT for a local user.
 *
 * **`iatSec` (اختياري):** يثبّت وقت الإصدار (بالثواني) صراحةً بدل ساعة النظام. يُستعمل عند
 * **إعادة إصدار** كوكي صاحب الجلسة فور تغييرٍ يُبطل الجلسات (تغيير كلمة المرور بنفسه):
 * نُبطل بـ`sessionsValidFrom = now` ثم نُعيد إصدار التوكن بـ`iat = validFromSec + 1` كي يكون
 * **أكبر تماماً** من حدّ الإبطال ⇒ يجتاز فحص `iat <= validFromSec` (انظر getUserFromRequest)
 * فلا يُطرَد صاحبها، بينما يُرفض أي توكنٍ أجنبيٍّ صُكّ في نفس الثانية (iat <= validFromSec).
 * القيمة محدودة بثانيةٍ واحدةٍ في المستقبل ⇒ تبقى ضمن هامش clock-skew في verifySession.
 */
export async function signSession(
  uid: number,
  expiresInMs: number = SESSION_DEFAULT_MS,
  req?: Request | { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } } | null,
  iatSec?: number
): Promise<string> {
  const issuedAtSeconds =
    typeof iatSec === "number" && Number.isInteger(iatSec) && iatSec > 0
      ? iatSec
      : Math.floor(Date.now() / 1000);
  const expirationSeconds = Math.floor(Date.now() / 1000) + Math.floor(expiresInMs / 1000);
  const claims: Record<string, unknown> = { uid };
  // البصمة تُحسب فقط عند توفّر الطلب. الاستدعاءات بلا req (اختبارات وحدة) تُصدر
  // توكناً بلا fp — ويعامله verifySession كـlegacy (لا مقارنة) لكي لا تنكسر.
  if (req) {
    claims.fp = computeSessionFingerprint(req);
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(issuedAtSeconds)
    // nbf = iat: التوكن لا يُقبَل قبل لحظة إصداره (يقطع replay من مزامنة ساعة عكسية).
    .setNotBefore(issuedAtSeconds)
    .setExpirationTime(expirationSeconds)
    .sign(getSecret());
}

/**
 * Verify a session JWT. Returns null on any failure (missing/invalid/expired).
 *
 * إن مُرّر `req`: نقارن `fp` المخزّن في التوكن مع بصمة الطلب الحالي. عدم التطابق ⇒ null.
 * إن لم يُمرَّر `req` (استعمال داخلي أو اختبارات): نتجاهل المقارنة ونرجع الحمولة فقط.
 *
 * **سياسة الـlegacy**: التوكنات القديمة (قبل إضافة البصمة) لا تحمل `fp`. عند تمرير `req`
 * نُلزم وجود `fp` ⇒ تلك التوكنات تُرفض ويُعاد المستخدم لتسجيل الدخول (ترقية أمنية لمرّة واحدة).
 */
export async function verifySession(
  token: string | undefined | null,
  req?: Request | { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } } | null
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
      // هامش ٦٠ث لـnbf/exp: نمط إعادة الإصدار عند تغيير كلمة المرور يضع nbf=iat=validFromSec+1
      clockTolerance: 60,
    });
    const uid = Number(payload.uid);
    const iat = Number(payload.iat);
    if (!Number.isInteger(uid) || uid <= 0) return null;
    if (!Number.isInteger(iat) || iat <= 0) return null;
    // منع تَلاعب clock skew: توكن iat في المستقبل (بهامش +٦٠ث) ⇒ غير صالح.
    const nowSec = Math.floor(Date.now() / 1000);
    if (iat > nowSec + 60) return null;

    const fp = typeof payload.fp === "string" ? payload.fp : undefined;

    // إن وُجد طلب يحمل بصمةً قابلةً للحساب (UA أو IP): ألزم تطابق fp ⇒ يحبط إعادة
    // استعمال التوكن من جهاز آخر. الطلب الذي لا يحمل UA ولا IP (سياق اختبار/داخلي)
    // لا تُجرى عليه المقارنة لتجنّب أعراض جانبية.
    if (req) {
      const ua = getRequestUserAgent(req);
      const ip = ipPrefix(getRequestIp(req));
      if (ua || ip) {
        const current = computeSessionFingerprint(req);
        // legacy token بلا fp ⇒ ارفض (force re-login مرّة واحدة بعد الترقية الأمنية).
        if (!fp) return null;
        if (current !== fp) return null;
      }
    }

    return { uid, iat, fp };
  } catch {
    return null;
  }
}

/** Resolve the authenticated user from the request session cookie, or null. */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  // نمرّر req ⇒ verifySession يُلزم تطابق بصمة الجهاز مع التوكن.
  const session = await verifySession(cookies[COOKIE_NAME], req);
  if (!session) return null;

  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, session.uid))
    .limit(1);

  const user = rows[0];
  if (!user || !user.isActive) return null;

  // إبطال الجلسات (AUTH-02): أيّ توكن iat <= sessionsValidFrom (بالثواني) يُرفض —
  // بما فيه ما صُكّ في **نفس ثانية** الإبطال (يسدّ النافذة العمياء دون الثانية). صاحب
  // الجلسة في تغيير كلمة المرور لا يُطرَد لأنّ الراوتر يُعيد إصدار كوكيه بـiat = validFromSec+1.
  const validFromSec = user.sessionsValidFrom
    ? Math.floor(new Date(user.sessionsValidFrom).getTime() / 1000)
    : 0;
  if (session.iat <= validFromSec) return null;

  return user;
}

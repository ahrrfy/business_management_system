import { COOKIE_NAME, SESSION_DEFAULT_MS } from "@shared/const";
import { parse as parseCookie } from "cookie";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { userSessions, users, type User, type UserSession } from "../../drizzle/schema";
import { getDb } from "../db";
import { logger } from "../logger";

/** لا كتابة على كل طلب — نحدّث `lastSeenAt` فقط إن كانت أقدم من هذه المهلة. */
const LAST_SEEN_TOUCH_MS = 5 * 60 * 1000;

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
 *
 * `companyId` (اختياري): هوية الشركة في وضع تعدّد الشركات — يُستخرَج من التوكن مبكراً
 * (server/index.ts، قبل إنشاء سياق tRPC) لتحديد قاعدة الاتصال قبل أي استعلام. تبقى
 * اختيارية عمداً كي لا ينكسر أي نشر أحادي الشركة (لا CONTROL_DATABASE_URL مضبوطاً)
 * — تلك التوكنات تُصدَر وتُتحقَّق بلا هذا الحقل تماماً كسلوك المشروع الحالي.
 */
// `sid` (اختياري): معرّف سطر userSessions — يتيح إبطال جهاز واحد بعينه (راجع تعليق
// userSessions في drizzle/schema.ts). توكنات ما قبل هذه الميزة لا تحمله ⇒ تستمرّ
// بالعمل عبر sessionsValidFrom الجماعي فقط (بلا تحقّق فردي، بلا انحدار).
export type SessionPayload = { uid: number; iat: number; fp?: string; companyId?: number; sid?: number };

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
  iatSec?: number,
  companyId?: number,
  sid?: number
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
  // اختياري (وضع تعدّد الشركات فقط) — راجع تعليق SessionPayload.
  if (typeof companyId === "number" && Number.isInteger(companyId) && companyId > 0) {
    claims.companyId = companyId;
  }
  // اختياري — معرّف سطر userSessions (راجع تعليق SessionPayload). الاستدعاءات بلا sid
  // (اختبارات وحدة/مسارات لا تُنشئ سطر جلسة) تُصدر توكناً بلا تتبّع فردي، سلوك legacy.
  if (typeof sid === "number" && Number.isInteger(sid) && sid > 0) {
    claims.sid = sid;
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
    // اختياري — توكنات أُصدرت قبل تعدّد الشركات (أو في نشر أحادي الشركة) لا تحمله؛
    // getDb() (server/db.ts) يتعامل مع غيابه بسقوط لمسار DATABASE_URL في وضع غير متعدّد.
    const companyId =
      typeof payload.companyId === "number" && Number.isInteger(payload.companyId) && payload.companyId > 0
        ? payload.companyId
        : undefined;
    // اختياري — راجع تعليق SessionPayload.sid. توكنات قبل هذه الميزة تعود بلا sid.
    const sid =
      typeof payload.sid === "number" && Number.isInteger(payload.sid) && payload.sid > 0
        ? payload.sid
        : undefined;

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

    return { uid, iat, fp, companyId, sid };
  } catch {
    return null;
  }
}

/** ناتج تحليل جلسة الطلب: المستخدم (أو null) + معرّف سطر الجلسة الفردية (أو null إن كان
 *  التوكن legacy بلا sid، أو لا مستخدم). راجع تعليق userSessions في drizzle/schema.ts. */
export type SessionContext = { user: User | null; sessionId: number | null };

/** يحلّل جلسة الطلب كاملةً: المستخدم + معرّف الجلسة الفردية (إن وُجد). المصدر الموحّد
 *  الذي يبنى عليه getUserFromRequest (للمسارات التي لا تحتاج sessionId). */
export async function getSessionContext(req: Request): Promise<SessionContext> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  // نمرّر req ⇒ verifySession يُلزم تطابق بصمة الجهاز مع التوكن.
  const session = await verifySession(cookies[COOKIE_NAME], req);
  if (!session) return { user: null, sessionId: null };

  const db = getDb();
  if (!db) return { user: null, sessionId: null };

  // uid وsid (إن وُجد) كلاهما معروفان فور فكّ الـJWT أعلاه — لا تبعية بيانات فعلية بين
  // استعلامَي users وuserSessions ⇒ نُطلقهما معاً (مراجعة أداء ٣/٧: كانا متسلسلين فيضاعفان
  // جولة DB على كل طلبٍ مُصادَق، وهو المسار الأسخن في كامل النظام). توكن legacy بلا sid
  // لا يُطلق الاستعلام الثاني إطلاقاً (لا صفّ يخصّه أساساً).
  const hasSid = typeof session.sid === "number";
  const [rows, srows] = await Promise.all([
    db.select().from(users).where(eq(users.id, session.uid)).limit(1),
    hasSid
      ? db.select().from(userSessions).where(eq(userSessions.id, session.sid as number)).limit(1)
      : Promise.resolve([] as UserSession[]),
  ]);

  const user = rows[0];
  if (!user || !user.isActive) return { user: null, sessionId: null };

  // إبطال الجلسات (AUTH-02): أيّ توكن iat <= sessionsValidFrom (بالثواني) يُرفض —
  // بما فيه ما صُكّ في **نفس ثانية** الإبطال (يسدّ النافذة العمياء دون الثانية). صاحب
  // الجلسة في تغيير كلمة المرور لا يُطرَد لأنّ الراوتر يُعيد إصدار كوكيه بـiat = validFromSec+1.
  const validFromSec = user.sessionsValidFrom
    ? Math.floor(new Date(user.sessionsValidFrom).getTime() / 1000)
    : 0;
  if (session.iat <= validFromSec) return { user: null, sessionId: null };

  // إبطال فردي (AUTH-03): توكن يحمل sid ⇒ يجب أن يقابل سطراً حيّاً (غير مُبطَل/منتهٍ)
  // في userSessions. مكمِّل لا بديل لفحص sessionsValidFrom أعلاه — يتيح طرد جهازٍ واحدٍ
  // بعينه (revokeSession) بلا مسّ بقية جلسات المستخدم.
  let sessionId: number | null = null;
  if (hasSid) {
    const srow = srows[0];
    const expired = !srow || srow.revokedAt != null || srow.expiresAt.getTime() < Date.now();
    if (!srow || srow.userId !== user.id || expired) {
      return { user: null, sessionId: null };
    }
    sessionId = srow.id;
    // لمسة last-seen مُلطَّفة (best-effort، لا تُعطِّل الطلب إن فشلت) — لا كتابة على كل طلب.
    if (Date.now() - srow.lastSeenAt.getTime() > LAST_SEEN_TOUCH_MS) {
      db.update(userSessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(userSessions.id, srow.id))
        .catch((e: unknown) => logger.warn({ err: e, sessionId: srow.id }, "session.touch_last_seen_failed"));
    }
  }

  return { user, sessionId };
}

/** Resolve the authenticated user from the request session cookie, or null. */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  return (await getSessionContext(req)).user;
}

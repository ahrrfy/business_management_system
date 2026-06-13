/**
 * kioskSession — توكن جلسة **جهاز الكشك** (شاشة قارئ الأسعار الخارجية).
 *
 * منفصل تماماً عن جلسة المستخدم (auth/session.ts):
 *  - كوكي مستقلّ `KIOSK_COOKIE_NAME` (لا يمسّ كوكي جلسة النظام).
 *  - الحمولة تحمل `scope:"kiosk"` + معرّف الجهاز + الفرع — **بلا uid**؛ فلا يستطيع
 *    توكن جهاز أن يُصادِق `protectedProcedure` (التي تتطلّب ctx.user)، ولا العكس.
 *  - التوقيع بنفس JWT_SECRET لكن النطاق المنفصل + غياب uid يجعلان الخلط مستحيلاً.
 *
 * الرمز الخام للجهاز لا يُوقَّع هنا؛ هذا التوكن يُصدَر **بعد** التحقّق من رمز الجهاز
 * (kioskDeviceService.deviceLogin) ويُحفظ في كوكي الجهاز قصير-متوسط العمر.
 */
import { SignJWT, jwtVerify } from "jose";

/** كوكي جهاز الكشك — مستقلّ عن كوكي جلسة المستخدم. */
export const KIOSK_COOKIE_NAME = "app_kiosk_id";

/** عمر توكن الجهاز: ٣٠ يوماً. المُشغّل يُعيد الدخول بالرمز عند كل إقلاع ⇒ تجديد ذاتي. */
export const KIOSK_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for kiosk sessions");
  return new TextEncoder().encode(secret);
}

/**
 * حمولة توكن الجهاز — `kid` معرّف الجهاز، `bid` الفرع المربوط، `scope` ثابت،
 * و`ver` = بادئة الرمز الحالية (tokenPrefix). البادئة تتغيّر عند **تدوير الرمز**،
 * فيُرفض أي كوكي قديم وُقِّع ببادئة سابقة ⇒ التدوير يُبطل الجلسات الحيّة أيضاً (لا الرمز الخام فقط).
 * البادئة ليست سرّاً (تُعرض في لوحة الإدارة) فإدراجها في التوكن آمن.
 */
export type KioskPayload = { kid: number; bid: number; scope: "kiosk"; ver: string };

/** توقيع توكن جلسة لجهاز كشك مُتحقَّق منه (مرتبط ببادئة رمزه الحالية). */
export async function signKioskSession(
  deviceId: number,
  branchId: number,
  tokenPrefix: string,
  expiresInMs: number = KIOSK_TOKEN_TTL_MS
): Promise<string> {
  const exp = Math.floor((Date.now() + expiresInMs) / 1000);
  return new SignJWT({ kid: deviceId, bid: branchId, scope: "kiosk", ver: tokenPrefix })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(getSecret());
}

/** التحقّق من توكن جهاز. يُعيد null عند أي فشل (مفقود/غير صالح/منتهٍ/نطاق خاطئ). */
export async function verifyKioskSession(
  token: string | undefined | null
): Promise<{ deviceId: number; branchId: number; ver: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (payload.scope !== "kiosk") return null;
    const deviceId = Number(payload.kid);
    const branchId = Number(payload.bid);
    const ver = typeof payload.ver === "string" ? payload.ver : "";
    if (!Number.isInteger(deviceId) || deviceId <= 0) return null;
    if (!Number.isInteger(branchId) || branchId <= 0) return null;
    if (!ver) return null;
    return { deviceId, branchId, ver };
  } catch {
    return null;
  }
}

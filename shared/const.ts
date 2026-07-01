export const COOKIE_NAME = "app_session_id";
/** كوكي جلسة مدير المنصّة — منفصل تماماً عن جلسة مستخدمي الشركات (COOKIE_NAME أعلاه)،
 *  كي لا يتداخلا أبداً على نفس المتصفّح (مدير منصّة قد يتصفّح شاشة شركة في تبويب آخر). */
export const PLATFORM_ADMIN_COOKIE_NAME = "platform_admin_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/** مدّة الجلسة الافتراضية: ١٢ ساعة (يوم عمل) — لا سنة. */
export const SESSION_DEFAULT_MS = 1000 * 60 * 60 * 12;
/** «تذكّرني»: الحدّ الأقصى لعمر الجلسة = ٣٠ يوماً. */
export const SESSION_REMEMBER_MAX_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * سياسة كلمة المرور بمستوى NIST: ١٢ حرفاً على الأقل + حرف صغير + حرف كبير + رقم + رمز خاص.
 * رُفعت من ٨ إلى ١٢ في موجة ٥ (الفجوة ١٥) لأن ٨ أحرف بمزيج بسيط قابلة للتخمين بـbrute force
 * حديث في زمن مقبول، خصوصاً مع تسرّب hashes احتمالاً.
 */
export const PASSWORD_MIN_LEN = 12;
/**
 * نمط فحص قوّة كلمة المرور: حرف صغير + كبير + رقم + رمز خاص + طول ≥ ١٢.
 * [\s\S] بدل . لقبول السطر الجديد إن وُجد (لا حاجة لراية s متعدّدة الأسطر).
 */
export const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};:'",.<>?\/\\|])[\s\S]{12,}$/;
export const PASSWORD_POLICY_MSG =
  "كلمة المرور يجب ١٢ حرفاً على الأقل + حرف صغير + كبير + رقم + رمز خاص.";
export function isStrongPassword(pw: unknown): pw is string {
  return typeof pw === "string" && PASSWORD_REGEX.test(pw);
}

export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

/**
 * اسم المستخدم — معرّف دخول بديل للبريد الإلكتروني (المالك يطلب «اما بريد او اسم مستخدم»).
 * القاعدة: ٣–٣٢ حرفاً، يبدأ بحرف لاتيني صغير، ثم حروف/أرقام لاتينية أو نقطة/شرطة سفلية/شرطة.
 * بلا «@» عمداً ⇒ يتميّز بنيوياً عن البريد فلا يلتبسان عند الدخول (وجود @ ⇒ بريد، وإلا ⇒ اسم).
 * ASCII خالص بلا راية /u (هدف tsc منخفض — انظر ذاكرة whatsapp). الشرطة في آخر فئة المحارف = حرفية.
 */
export const USERNAME_MIN_LEN = 3;
export const USERNAME_MAX_LEN = 32;
export const USERNAME_REGEX = /^[a-z][a-z0-9._-]{2,31}$/;
export const USERNAME_POLICY_MSG =
  "اسم المستخدم يجب ٣–٣٢ خانة، يبدأ بحرف إنجليزي صغير، ويحتوي حروفاً/أرقاماً إنجليزية أو نقطة/شرطة فقط (بلا مسافات أو @).";
/** تطبيع اسم المستخدم للتخزين/المقارنة: قصّ + حالة صغيرة. (الفحص منفصل عبر isValidUsername.) */
export function normalizeUsername(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}
export function isValidUsername(s: unknown): s is string {
  return typeof s === "string" && USERNAME_REGEX.test(s.trim().toLowerCase());
}

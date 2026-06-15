export const COOKIE_NAME = "app_session_id";
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

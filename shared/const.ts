export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/** مدّة الجلسة الافتراضية: ١٢ ساعة (يوم عمل) — لا سنة. */
export const SESSION_DEFAULT_MS = 1000 * 60 * 60 * 12;
/** «تذكّرني»: الحدّ الأقصى لعمر الجلسة = ٣٠ يوماً. */
export const SESSION_REMEMBER_MAX_MS = 1000 * 60 * 60 * 24 * 30;

/** سياسة كلمة المرور: ٨ أحرف على الأقل، تحوي حرفاً ورقماً. */
export const PASSWORD_MIN_LEN = 8;
export const PASSWORD_POLICY_MSG = "كلمة المرور يجب أن تكون ٨ أحرف على الأقل وتحتوي حرفاً ورقماً.";
export function isStrongPassword(pw: unknown): pw is string {
  return (
    typeof pw === "string" &&
    pw.length >= PASSWORD_MIN_LEN &&
    /[A-Za-z]/.test(pw) &&
    /\d/.test(pw)
  );
}

export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";

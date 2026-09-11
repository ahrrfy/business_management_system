const INVALID_CREDENTIALS_MESSAGE = "تحقق من بيانات الدخول ثم حاول مرة أخرى.";
const TWO_FACTOR_MESSAGE = "تعذر التحقق من الرمز. تحقق منه وحاول مرة أخرى.";
const CONNECTION_MESSAGE = "تعذر إتمام الاتصال المحمي الآن. تحقق من الشبكة أو أعد المحاولة لاحقاً.";
const LOCAL_PROTECTION_MESSAGE = "فعّل قفل الشاشة أو البصمة في إعدادات الجهاز، ثم أعد المحاولة لحماية جلسة العمل.";
const GENERIC_MESSAGE = "تعذر إتمام الطلب الآن. لم يتم حفظ كلمة المرور في التطبيق.";

export function readableAuthError(error: unknown): string {
  const message = collectErrorSignals(error);

  if (
    /E_LOCAL_PROTECTION_REQUIRED/.test(message) ||
    /قفلاً آمناً|قفل الشاشة|بصمة|رمز الجهاز/.test(message)
  ) {
    return LOCAL_PROTECTION_MESSAGE;
  }

  if (
    /invalid login (identifier|password)/i.test(message) ||
    /البريد أو كلمة المرور غير صحيحة/.test(message)
  ) {
    return INVALID_CREDENTIALS_MESSAGE;
  }

  if (/two-factor/i.test(message) || /التحقق الثنائي|رمز (التحقق|الاسترداد)/.test(message)) {
    return TWO_FACTOR_MESSAGE;
  }

  if (
    /session|required|network|connection|unavailable/i.test(message) ||
    /الجلسة|جلسة محمية|الشبكة|الاتصال|غير متاح/.test(message)
  ) {
    return CONNECTION_MESSAGE;
  }

  return GENERIC_MESSAGE;
}

function collectErrorSignals(error: unknown, depth = 0): string {
  if (depth > 2 || error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return "";

  const value = error as Record<string, unknown>;
  const signals = ["code", "name", "message", "localizedMessage", "description"]
    .map((key) => value[key])
    .filter((part): part is string => typeof part === "string");

  if ("cause" in value) signals.push(collectErrorSignals(value.cause, depth + 1));
  return signals.filter(Boolean).join(" ");
}

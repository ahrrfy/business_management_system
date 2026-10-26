import { canonicalIraqiLocalPhone } from "@/lib/iraqi-phone";

export const ACCOUNT_DELETION_RETENTION_DAYS = 365 as const;

export const ACCOUNT_DELETION_DISCLOSURE = {
  title: "حذف الحساب والبيانات الشخصية",
  summary:
    "يؤدي تأكيد الحذف عبر رمز التحقق الهاتفي إلى إخفاء بياناتك الشخصية غير المحاسبية فوراً وإبطال جميع الجلسات الفعّالة، مع الاحتفاظ بالفواتير والأرصدة وسجلات التدقيق القانونية لمدة سنة واحدة (365 يوماً) فقط للامتثال المحاسبي.",
  preconditions:
    "يلزم قبل إتمام الحذف عدم وجود طلبات نشطة قيد التنفيذ أو أرصدة مالية غير مسوّاة على الحساب.",
  webFallbackNote:
    "إذا كانت شريحة الهاتف في جهاز آخر أو تعذّر التحقق الهاتفي داخل هذه النسخة، يمكنك تقديم طلب الحذف عبر صفحة الحذف الرسمية على الويب.",
} as const;

export function extractIraqiPhoneLocalInput(rawPhone: string | null | undefined): string {
  if (!rawPhone) return "";
  return canonicalIraqiLocalPhone(rawPhone);
}

export function isMobilePhoneOtpAvailable(platformOs?: string): boolean {
  return platformOs !== "web";
}

export function isFirebaseNativeUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("لا تحتوي مكتبة Firebase الأصلية") ||
    message.includes("NativeRNFB") ||
    message.includes("not registered") ||
    message.includes("معاينة الويب")
  );
}

export const DELETION_OTP_TOKEN_TTL_MS = 4 * 60 * 1000;

export interface CachedDeletionOtpVerification {
  firebaseIdToken: string;
  phone: string;
  verifiedAt: number;
}

export function normalizeOtpDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .trim();
}

export function formatAccountDeletionError(error: unknown): string {
  const errObj =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : null;
  const rawMessage =
    typeof errObj?.message === "string"
      ? errObj.message.trim()
      : typeof error === "string"
        ? error.trim()
        : "";
  const rawCode = typeof errObj?.code === "string" ? errObj.code.toLowerCase() : "";
  const combined = `${rawCode} ${rawMessage}`.toLowerCase();

  // Preserve clean Arabic messages from backend / local validation
  if (rawMessage && /[\u0600-\u06FF]/.test(rawMessage)) {
    return rawMessage;
  }

  if (combined.includes("invalid-verification-code") || combined.includes("invalid verification code")) {
    return "رمز التحقق غير صحيح. تأكد من الأرقام الستة وحاول مرة أخرى.";
  }
  if (combined.includes("session-expired") || combined.includes("code-expired")) {
    return "انتهت صلاحية رمز التحقق. اطلب رمز تحقق جديداً ثم حاول مرة أخرى.";
  }
  if (combined.includes("too-many-requests") || combined.includes("quota-exceeded")) {
    return "تم تجاوز عدد المحاولات المسموح مؤقتاً. انتظر قليلاً ثم أعد المحاولة.";
  }
  if (combined.includes("invalid-phone-number") || combined.includes("missing-phone-number")) {
    return "رقم الهاتف غير صالح. تأكد من إدخال رقم عراقي صحيح ثم أعد المحاولة.";
  }
  if (
    combined.includes("network-request-failed") ||
    combined.includes("network error") ||
    combined.includes("fetch failed") ||
    combined.includes("aborted")
  ) {
    return "تعذّر الاتصال بالخادم حالياً. تحقق من الإنترنت وحاول مرة أخرى.";
  }

  return "تعذّر إتمام العملية حالياً. تحقق من البيانات وحاول مرة أخرى.";
}

function shouldInvalidateCachedVerification(error: unknown): boolean {
  const errObj =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown; data?: { code?: unknown } })
      : null;
  const code =
    typeof errObj?.data?.code === "string"
      ? errObj.data.code
      : typeof errObj?.code === "string"
        ? errObj.code
        : "";
  const msg = typeof errObj?.message === "string" ? errObj.message : "";
  return (
    code === "UNAUTHORIZED" ||
    /انتهت صلاحية|غير صالح|تسجيل الدخول|unauthorized|token/i.test(msg)
  );
}

export type SendDeletionOtpOutcome =
  | { nextStep: "CODE"; normalizedPhone: string }
  | { nextStep: "WEB_FALLBACK"; message: string };

export async function sendAccountDeletionOtpStep(
  rawPhone: string,
  deps: {
    platformOs?: string;
    sendOtp: (phone: string) => Promise<string>;
  },
): Promise<SendDeletionOtpOutcome> {
  const trimmed = rawPhone.trim();
  if (!trimmed) {
    throw new Error("يرجى إدخال رقم الهاتف المرتبط بالحساب لإرسال رمز التحقق.");
  }
  if (!isMobilePhoneOtpAvailable(deps.platformOs)) {
    return {
      nextStep: "WEB_FALLBACK",
      message:
        "التحقق الهاتفي المباشر متاح في تطبيق Android وiOS الأصيل. يمكنك المتابعة فوراً عبر صفحة طلب حذف الحساب على الويب.",
    };
  }
  try {
    const normalizedPhone = await deps.sendOtp(trimmed);
    return { nextStep: "CODE", normalizedPhone };
  } catch (error) {
    if (isFirebaseNativeUnavailableError(error)) {
      return {
        nextStep: "WEB_FALLBACK",
        message:
          error instanceof Error
            ? error.message
            : "تعذّر تشغيل التحقق الهاتفي الأصيل على هذا الجهاز؛ يمكنك استخدام صفحة الحذف عبر الويب.",
      };
    }
    throw new Error(formatAccountDeletionError(error));
  }
}

export async function confirmAndDeleteStorefrontAccountStep(
  rawCode: string,
  deps: {
    confirmOtp: (code: string) => Promise<{ firebaseIdToken: string; phone: string }>;
    deleteAccount: (input: { firebaseIdToken: string }) => Promise<{ ok: true; deletedAt: string }>;
    clearSession: () => Promise<void>;
    cachedVerification?: CachedDeletionOtpVerification | null;
    now?: number;
    onVerified?: (verification: CachedDeletionOtpVerification) => void;
    onInvalidateVerification?: () => void;
  },
): Promise<{ ok: true; deletedAt: string }> {
  const now = deps.now ?? Date.now();
  const cached = deps.cachedVerification ?? null;
  const hasFreshToken =
    cached !== null &&
    Boolean(cached.firebaseIdToken) &&
    now - cached.verifiedAt >= 0 &&
    now - cached.verifiedAt < DELETION_OTP_TOKEN_TTL_MS;

  let firebaseIdToken: string;
  if (hasFreshToken && cached) {
    firebaseIdToken = cached.firebaseIdToken;
  } else {
    if (cached) {
      deps.onInvalidateVerification?.();
    }
    const cleanCode = normalizeOtpDigits(rawCode);
    if (!/^\d{6}$/.test(cleanCode)) {
      throw new Error("اكتب رمز التحقق المؤلف من 6 أرقام لإتمام حذف الحساب.");
    }
    try {
      const verified = await deps.confirmOtp(cleanCode);
      firebaseIdToken = verified.firebaseIdToken;
      deps.onVerified?.({
        firebaseIdToken: verified.firebaseIdToken,
        phone: verified.phone,
        verifiedAt: now,
      });
    } catch (error) {
      throw new Error(formatAccountDeletionError(error));
    }
  }

  try {
    const result = await deps.deleteAccount({
      firebaseIdToken,
    });
    deps.onInvalidateVerification?.();
    await deps.clearSession();
    return result;
  } catch (error) {
    if (shouldInvalidateCachedVerification(error)) {
      deps.onInvalidateVerification?.();
    }
    throw new Error(formatAccountDeletionError(error));
  }
}


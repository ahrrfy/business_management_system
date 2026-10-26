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
    throw error;
  }
}

export async function confirmAndDeleteStorefrontAccountStep(
  rawCode: string,
  deps: {
    confirmOtp: (code: string) => Promise<{ firebaseIdToken: string; phone: string }>;
    deleteAccount: (input: { firebaseIdToken: string }) => Promise<{ ok: true; deletedAt: string }>;
    clearSession: () => Promise<void>;
  },
): Promise<{ ok: true; deletedAt: string }> {
  const cleanCode = rawCode.trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new Error("اكتب رمز التحقق المؤلف من 6 أرقام لإتمام حذف الحساب.");
  }
  const verified = await deps.confirmOtp(cleanCode);
  const result = await deps.deleteAccount({
    firebaseIdToken: verified.firebaseIdToken,
  });
  await deps.clearSession();
  return result;
}

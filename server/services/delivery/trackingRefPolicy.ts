import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";

export type DeliveryPartyType = "INDIVIDUAL" | "COMPANY";

/**
 * رقم بوليصة شركة التوصيل هو مفتاح المطابقة مع كشفها الورقي، لذلك نطبّع الفراغات
 * مرةً واحدةً قبل إدخاله في بصمة التكرار أو قاعدة البيانات.
 */
export function normalizeExternalTrackingRef(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

/** شركات التوصيل تحتاج رقم البوليصة كي يمكن مطابقة الفاتورة لاحقاً بالماسح. */
export function requireExternalTrackingRef(
  partyType: DeliveryPartyType,
  value?: string | null,
): string | null {
  const normalized = normalizeExternalTrackingRef(value);
  if (partyType === "COMPANY" && normalized == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إسناد الشحنة إلى شركة التوصيل",
        why: "رقم تتبّع/بوليصة الشركة مطلوب لربط الفاتورة بكشف التحصيل لاحقاً",
        doThis: "امسح باركود بوليصة الشركة أو أدخل رقمها ثم أعد الإسناد",
      }),
    });
  }
  if (normalized != null && normalized.length > 100) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ رقم بوليصة شركة التوصيل",
        why: "رقم التتبّع أطول من الحد المسموح (100 محرف)",
        doThis: "أدخل الرقم المطبوع أسفل باركود البوليصة فقط، من دون وصفٍ إضافي",
      }),
    });
  }
  return normalized;
}

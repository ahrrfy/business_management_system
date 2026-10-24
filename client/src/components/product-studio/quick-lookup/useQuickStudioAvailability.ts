import { trpc } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";

export function useQuickStudioAvailability(offline: boolean) {
  const { allowed: canQuickSave } = useOperationPermission(
    "productStudio.quickSaveBarcodeProductImage",
  );
  const { allowed: canQuickAi } = useOperationPermission(
    "productStudio.quickAiTransform",
  );
  const aiConfig = trpc.imageStudio.aiConfig.useQuery(undefined, {
    enabled: !offline && canQuickAi,
    staleTime: 60_000,
  });
  const aiAvailable =
    !offline && canQuickAi && aiConfig.data?.aiAvailable === true;
  const proAvailable =
    !offline && canQuickAi && aiConfig.data?.proAvailable === true;
  const aiUnavailableMessage = offline
    ? "المعالجة بالذكاء الاصطناعي تتطلب اتصالا بالإنترنت."
    : !canQuickAi
      ? "لا تملك صلاحية تشغيل معالجة الذكاء الاصطناعي."
      : aiConfig.isLoading
        ? "يجري التحقق من جاهزية مزود الذكاء الاصطناعي..."
        : aiConfig.data?.cryptoReady === false
          ? "تشفير الإعدادات غير جاهز (مفتاح التشفير غير مضبوط في البيئة)."
          : aiConfig.data?.aiEnabled === false
            ? "مسار الذكاء الاصطناعي معطل في إعدادات الاستوديو."
            : aiConfig.data?.hasAiKey === false
              ? "مفتاح مزود الذكاء الاصطناعي غير مدخل في إعدادات الاستوديو."
              : "مسار الذكاء الاصطناعي غير متاح حاليا.";
  const proUnavailableMessage = offline
    ? "خدمة remove.bg تتطلب اتصالا بالإنترنت."
    : !canQuickAi
      ? "لا تملك صلاحية تشغيل خدمة العزل الاحترافي."
      : aiConfig.isLoading
        ? "يجري التحقق من جاهزية remove.bg..."
        : aiConfig.data?.cryptoReady === false
          ? "تشفير الإعدادات غير جاهز."
          : aiConfig.data?.proEnabled === false
            ? "خدمة remove.bg معطلة في إعدادات الاستوديو."
            : aiConfig.data?.hasProKey === false
              ? "مفتاح remove.bg غير مدخل في إعدادات الاستوديو."
              : "خدمة remove.bg غير متاحة حاليا.";
  return {
    canQuickSave,
    aiConfig,
    aiAvailable,
    proAvailable,
    aiUnavailableMessage,
    proUnavailableMessage,
  };
}

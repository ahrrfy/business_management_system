export type ZodFieldErrors = {
  fieldErrors?: Record<string, string[] | undefined>;
  formErrors?: string[];
};

export type MutationErrorLike = {
  message?: string;
  data?: {
    code?: string;
    zodError?: ZodFieldErrors | null;
  };
};

export type AiErrorPresentation = {
  title: string;
  message: string;
  action?: string;
  retryable: boolean;
};

// ترجمة مسار حقل Zod (مثل «saleUnits.0.conversionFactor») إلى اسمٍ عربيٍّ للمستخدم.
const FIELD_LABELS_AR: Record<string, string> = {
  finalProductName: "اسم المنتج النهائي",
  inputDescription: "الوصف الحرّ",
  category: "الفئة/التصنيف",
  productType: "النوع",
  brand: "الماركة/الناشر",
  modelName: "الموديل/الطبعة",
  saleUnits: "وحدات البيع",
  variants: "المتغيّرات",
  attributes: "الخصائص",
  verifiedClaims: "الادّعاءات المعتمَدة",
  audience: "الفئة المستهدفة",
  name: "الاسم",
  conversionFactor: "معامل التحويل",
  color: "اللون",
  size: "القياس",
};

function labelForPath(rawPath: string): string {
  const parts = rawPath.split(".").filter(Boolean);
  const labelled = parts.map((part) => {
    if (/^\d+$/.test(part)) return `#${Number(part) + 1}`;
    return FIELD_LABELS_AR[part] ?? part;
  });
  return labelled.join(" ← ") || rawPath;
}

function formatZodErrors(zodError: ZodFieldErrors | null | undefined): string | null {
  if (!zodError) return null;
  const parts: string[] = [];
  const fieldErrors = zodError.fieldErrors ?? {};
  for (const [key, msgs] of Object.entries(fieldErrors)) {
    if (!msgs || msgs.length === 0) continue;
    parts.push(`${labelForPath(key)}: ${msgs.join("، ")}`);
  }
  if (zodError.formErrors?.length) parts.push(...zodError.formErrors);
  const text = parts.join(" · ");
  return text || null;
}

// المصدر الافتراضيّ للـtRPC حين لا نمرّر رسالةً مخصّصة (نتجنّب عرضها للمستخدم).
const GENERIC_TRPC_FALLBACKS = new Set([
  "BAD_REQUEST",
  "PRECONDITION_FAILED",
  "TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "TOO_MANY_REQUESTS",
  "FORBIDDEN",
]);

function meaningfulServerMessage(message: string | undefined): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (GENERIC_TRPC_FALLBACKS.has(trimmed)) return null;
  // «رمز المتابعة: xxx» يُضاف من errorFormatter — يُعرَض كما هو.
  return trimmed;
}

export function describeAiError(error: unknown): AiErrorPresentation {
  const candidate = (error ?? {}) as MutationErrorLike;
  const code = candidate.data?.code ?? "";
  const zodDetail = formatZodErrors(candidate.data?.zodError);
  const serverMsg = meaningfulServerMessage(candidate.message);

  switch (code) {
    case "PRECONDITION_FAILED":
      if (candidate.message?.includes("سقف الاستخدام اليومي")) {
        return {
          title: "بلغ سقف الاستخدام اليومي",
          message:
            "توقف التوليد لحماية الميزانية. راجع المدير أو انتظر دورة الاستخدام التالية.",
          action: "لم يتم تغيير المنتج.",
          retryable: false,
        };
      }
      return {
        title: "مساعد الذكاء الاصطناعي غير مفعّل",
        message:
          serverMsg ??
          "تحقق من إعداد مزود الذكاء الاصطناعي ومفتاحه أو اطلب من المدير تفعيله.",
        action: "لم يتم تغيير المنتج.",
        retryable: false,
      };
    case "FORBIDDEN":
      return {
        title: "لا تملك صلاحية توليد المحتوى",
        message: "تحتاج إلى صلاحية إدارة المنتجات لاستخدام هذا المساعد.",
        retryable: false,
      };
    case "TOO_MANY_REQUESTS":
      return {
        title: "تم بلوغ الحد المؤقت للطلبات",
        message: serverMsg ?? "انتظر قليلاً ثم أعد المحاولة. لم يتم تغيير المنتج.",
        retryable: true,
      };
    case "TIMEOUT":
      return {
        title: "تأخر مزود الذكاء الاصطناعي",
        message:
          serverMsg ??
          "لم يصل الرد في الوقت المحدد. أعد المحاولة، وسيبقى المنتج دون تغيير.",
        retryable: true,
      };
    case "BAD_REQUEST": {
      // زودErr هو المسبّب الأشيع (حقلٌ في `facts` رُفض) — نُظهر الحقل بالضبط.
      // وإلّا فرسالةُ الخادم قد تكون تفصيل رفضٍ من Gemini (يحملها الراوتر خامةً).
      if (zodDetail) {
        return {
          title: "بيانات المنتج بحاجة لتصحيح قبل التوليد",
          message: zodDetail,
          action:
            "راجع الحقول أعلاه وتأكّد من صحّة القيم (خصوصاً معامل التحويل: نقطة عشرية لا فاصلة).",
          retryable: false,
        };
      }
      if (serverMsg) {
        return {
          title: "رفض مزود الذكاء الاصطناعي الطلب",
          message: serverMsg,
          action: "إن استمرّ الخطأ فأرسل الرسالة كاملةً لمسؤول النظام.",
          retryable: true,
        };
      }
      return {
        title: "تعذر قبول بيانات التوليد",
        message:
          "راجع الاسم النهائي والحقول الأساسية وتأكد من وجود قيم صالحة قبل إعادة المحاولة.",
        action:
          "إذا استمر الخطأ، أرسل رمز المشكلة لمسؤول النظام دون إرسال أي مفتاح أو كلمة مرور.",
        retryable: false,
      };
    }
    case "INTERNAL_SERVER_ERROR":
      return {
        title: "تعذر تجهيز مسودة المحتوى",
        message:
          serverMsg ??
          "حدث خطأ داخلي أثناء قراءة رد مزود الذكاء الاصطناعي. أعد المحاولة لاحقاً.",
        retryable: true,
      };
    default:
      return {
        title: "تعذر توليد محتوى المنتج",
        message:
          serverMsg ??
          "حدث خطأ غير متوقع. لم يتم تغيير المنتج؛ أعد المحاولة أو تواصل مع مسؤول النظام.",
        retryable: true,
      };
  }
}

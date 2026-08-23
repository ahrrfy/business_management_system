export type MutationErrorLike = {
  message?: string;
  data?: {
    code?: string;
  };
};

export type AiErrorPresentation = {
  title: string;
  message: string;
  action?: string;
  retryable: boolean;
};

export function describeAiError(error: unknown): AiErrorPresentation {
  const candidate = (error ?? {}) as MutationErrorLike;
  const code = candidate.data?.code ?? "";

  switch (code) {
    case "PRECONDITION_FAILED":
      return {
        title: "مساعد الذكاء الاصطناعي غير مفعّل",
        message:
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
        message: "انتظر قليلاً ثم أعد المحاولة. لم يتم تغيير المنتج.",
        retryable: true,
      };
    case "TIMEOUT":
      return {
        title: "تأخر مزود الذكاء الاصطناعي",
        message:
          "لم يصل الرد في الوقت المحدد. أعد المحاولة، وسيبقى المنتج دون تغيير.",
        retryable: true,
      };
    case "BAD_REQUEST":
      return {
        title: "تعذر قبول بيانات التوليد",
        message:
          "راجع الاسم النهائي والحقول الأساسية وتأكد من وجود قيم صالحة قبل إعادة المحاولة.",
        action:
          "إذا استمر الخطأ، أرسل رمز المشكلة لمسؤول النظام دون إرسال أي مفتاح أو كلمة مرور.",
        retryable: false,
      };
    case "INTERNAL_SERVER_ERROR":
      return {
        title: "تعذر تجهيز مسودة المحتوى",
        message:
          "حدث خطأ داخلي أثناء قراءة رد مزود الذكاء الاصطناعي. أعد المحاولة لاحقاً.",
        retryable: true,
      };
    default:
      return {
        title: "تعذر توليد محتوى المنتج",
        message:
          "حدث خطأ غير متوقع. لم يتم تغيير المنتج؛ أعد المحاولة أو تواصل مع مسؤول النظام.",
        retryable: true,
      };
  }
}

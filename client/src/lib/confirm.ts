// حوار تأكيد موحّد (بديل احترافي عن window.confirm) — singleton أمري مثل notify.
// الاستعمال:
//   import { confirm, confirmDelete } from "@/lib/confirm";
//   if (!(await confirm({ variant: "danger", title: "تعطيل العميل", description: "…", confirmText: "تعطيل" }))) return;
//   if (!(await confirmDelete({ description: "حذف نهائي؟", requireText: product.name }))) return;
// يُركَّب <ConfirmHost/> مرّة واحدة في main.tsx بجوار <Toaster/> (انظر ConfirmHost.tsx).
import type { ReactNode } from "react";

export type ConfirmVariant = "danger" | "warning" | "info";

export type ConfirmOptions = {
  /** العنوان — افتراضيٌّ حسب النوع. */
  title?: ReactNode;
  /** الوصف/التفاصيل — يُبرز اسماً أو رقماً لتفادي النقل الخاطئ. */
  description?: ReactNode;
  /** نص زر التأكيد — افتراضي «تأكيد» («حذف» مع confirmDelete). */
  confirmText?: string;
  /** نص زر الإلغاء — افتراضي «إلغاء». */
  cancelText?: string;
  /** نوع الخطورة — يحدّد الأيقونة ولون زر التأكيد. افتراضي «warning». */
  variant?: ConfirmVariant;
  /** حارس الحذف عالي الخطورة: يجب كتابة هذه القيمة حرفياً لتفعيل زر التأكيد. */
  requireText?: string;
  /** نصّ تسمية حقل التأكيد (افتراضياً: اكتب «{requireText}» للتأكيد). */
  requireTextLabel?: ReactNode;
};

export type ConfirmRequest = {
  id: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
};

type Listener = (req: ConfirmRequest) => void;

let listener: Listener | null = null;
let seq = 0;

/** اشتراك ConfirmHost بالطابور (داخلي — يستدعيه المُضيف عند التركيب). */
export function _subscribeConfirm(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** يعرض حوار تأكيد ويُرجع true عند التأكيد، false عند الإلغاء/الإغلاق/Esc. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!listener) {
      // لا مُضيف مُركَّب — افشل آمناً (لا نُنفّذ عملية حسّاسة دون تأكيد فعلي).
      if (typeof console !== "undefined") {
        console.warn("[confirm] ConfirmHost غير مُركَّب في الشجرة — رُفض التأكيد افتراضياً.");
      }
      resolve(false);
      return;
    }
    listener({ id: ++seq, options, resolve });
  });
}

/** اختصار للحذف: variant=danger ونصّ التأكيد الافتراضي «حذف». */
export function confirmDelete(
  options: Omit<ConfirmOptions, "variant"> = {},
): Promise<boolean> {
  return confirm({ confirmText: "حذف", ...options, variant: "danger" });
}

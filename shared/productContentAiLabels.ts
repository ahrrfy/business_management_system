import type { AiProductDraft } from "./productContentAi";

export type ProductContentField = keyof Pick<
  AiProductDraft,
  | "seoTitle"
  | "shortTitle"
  | "posLabel"
  | "invoiceLabel"
  | "marketingCopy"
  | "description"
>;
export const PRODUCT_CONTENT_FIELD_LABELS: Record<ProductContentField, string> =
  {
    seoTitle: "عنوان SEO",
    shortTitle: "العنوان المختصر",
    posLabel: "اسم الكاشير POS",
    invoiceLabel: "اسم الفاتورة",
    marketingCopy: "النص الترويجي",
    description: "الوصف الفني",
  };
export const PRODUCT_CONTENT_FIELD_HINTS: Record<ProductContentField, string> =
  {
    seoTitle: "عنوان المتجر ومحركات البحث، بلا سعر أو وعود غير مثبتة.",
    shortTitle: "نسخة قصيرة لبطاقة المنتج والهاتف.",
    posLabel: "اسم سريع القراءة داخل نقطة البيع.",
    invoiceLabel: "اسم ثابت ومقروء في المستند.",
    marketingCopy: "فائدة قصيرة مبنية على الحقائق المعتمدة.",
    description: "مواصفات واستخدامات المنتج دون اختراع معلومات.",
  };
// The editor must satisfy both the AI draft schema and the channel-content save schema.
export const PRODUCT_CONTENT_FIELD_LIMITS: Record<ProductContentField, number> =
  {
    seoTitle: 160,
    shortTitle: 100,
    posLabel: 120,
    invoiceLabel: 160,
    marketingCopy: 300,
    description: 2000,
  };
export const PRODUCT_CONTENT_DRAFT_STATUS_LABELS = {
  DRAFT: "مسودة",
  APPROVED: "معتمدة",
  REJECTED: "مرفوضة",
  APPLIED: "مطبقة",
} as const;

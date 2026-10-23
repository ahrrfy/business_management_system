import { formatQuantity } from "@/lib/money";

export interface ReturnComposerProps {
  invoiceId: number;
  /** وضع الفتح المبدئي: مرتجع كامل يملأ كافة البنود تلقائياً، أو جزئي */
  initialMode?: "FULL" | "PARTIAL";
  /**
   * اعتمادُ **طلب إرجاعٍ** من موظّف المحطة بدل مرتجعٍ مباشر (١٩/٨).
   * الفارق كلّه في الإجراء المُستدعى: `approveRequest` يفرض فصل المهام واللقطة التفاؤلية
   * ثمّ يُنفّذ **نفس** المسار الماليّ — فلا نسخةَ منطقٍ ثانية ولا شاشةَ اعتمادٍ موازية.
   */
  approvingRequestId?: number | null;
  /** باركود صنف مُمرّر من شريط المسح الخارجي للمعالجة المباشرة */
  scannedBarcode?: string | null;
  /** استدعاء عند معالجة الباركود الخارجي بنجاح */
  onBarcodeHandled?: () => void;
  /** يُستدعى بعد نجاح المرتجع (تحديث قوائم الصفحة المضيفة/التنقّل). */
  onDone?: (result: { fullyReturned: boolean; returnedTotal: string }) => void;
  /** رابط رجوعٍ اختياريّ تعرضه الصفحة المضيفة أسفل الإجراءات. */
  footer?: React.ReactNode;
}

export const QUICK_REASONS = [
  "تراجع العميل عن الشراء",
  "عيب مصنعي أو خلل",
  "استبدال بصنف آخر",
  "غير مطابق للمواصفات",
  "تلف أو كسر بالبضاعة",
];
export function returnQuantityLabel(
  base: number,
  factor: number,
  unitName: string,
  baseUnitName = "قطعة",
): string {
  if (base <= 0) return "0";
  if (factor <= 1) return `${formatQuantity(base)} ${unitName || baseUnitName}`;
  if (base % factor !== 0) return `${formatQuantity(base)} ${baseUnitName}`;
  return `${formatQuantity(base / factor)} ${unitName} (${formatQuantity(base)} ${baseUnitName})`;
}

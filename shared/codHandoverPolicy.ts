/**
 * codHandoverPolicy — سياسة إلزام الدفع الكامل عند التسليم (Slice O، ٣٠/٨/٢٦).
 *
 * الغرض: تجميعُ ثابتة «متى يجب دفع كامل المبلغ لحظة تسليم أمر الشغل؟» في مكانٍ واحد
 * قابل للاختبار البحت — تستهلكه `server/services/workOrder/deliver.ts` عند فحص المتبقّي.
 *
 * الحالة الحاسمة:
 *  - `paymentMode='COD' && hasDelivery=false` = **طلب استلامٍ COD** (طلبات الاتصال/واتساب/
 *    انستاغرام). لا مندوبَ يُحصِّل ⇒ العميل يستلم بيده. لو تركنا متبقّياً على الفاتورة
 *    ينفتح ديناً على عميلٍ جديد بلا حدّ ائتمانٍ ولا مسار تحصيل ⇒ خرقٌ لمبدأ «لا دينار
 *    صامت» (CLAUDE.md §٥).
 *
 * الحالات الأخرى مسموحة (السلوك التاريخيّ):
 *  - `COD && hasDelivery=true` ⇒ المندوب يقبض؛ متبقٍّ = تسليمٌ جزئيّ مشروع (يذهب للذمّة).
 *  - `PREPAID` ⇒ فحصُ الائتمان الاعتياديّ.
 *  - `CREDIT` ⇒ ذمّةٌ صريحة (فحصُ سقفٍ حادّ).
 */
export type CodPaymentMode = "PREPAID" | "COD" | "CREDIT";

export function requiresFullPaymentAtHandover(
  paymentMode: CodPaymentMode,
  hasDelivery: boolean,
): boolean {
  return paymentMode === "COD" && !hasDelivery;
}

export const COD_PICKUP_PAYMENT_ERROR_AR = (unpaidAmount: string): string =>
  `طلب COD للاستلام يتطلّب دفعاً كاملاً عند التسليم — المتبقّي ${unpaidAmount} د.ع. حصّل المبلغ قبل تسليم الأمر.`;

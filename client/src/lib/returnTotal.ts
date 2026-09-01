/**
 * إجمالي المرتجع الواجهيّ — **مطابقٌ حرفياً لفرع الإرجاع الجزئيّ في `returnService`**:
 *
 *   returnedRevenue = round2(Σ(itemTotal × qtyBase/itemBase) × (1 − discount/subtotal))
 *   returnedTax     = round2(returnedRevenue × taxAmount/(subtotal − discount))
 *   returnedTotal   = round2(returnedRevenue + returnedTax)
 *
 * لماذا وحدةٌ مستقلّة لا دالّةٌ داخل الشاشة: هذا الرقم يقود **سقف الاسترداد** الذي يراه الموظف،
 * فأيّ انحرافٍ عن صيغة الخادم يُنتج شاشةً تَعِد بمبلغٍ يرفضه الخادم. إخراجه هنا يجعله قابلاً
 * للاختبار وحده (بلا تركيب شاشة) ويمنع تكرار الصيغة في كل شاشة مرتجع.
 *
 * الإرجاع **المُكمِل** يطابق فرع الخادم الآخر حرفياً:
 *   returnedTotal = round2(invoice.total − invoice.returnedTotal)
 * فيلتقط أجرة الشحن وباقي تقريب IQD. هذا مهمّ لأن تسوية الزبون العابر لا تقبل فلساً ناقصاً.
 */
import { D, round2 } from "@/lib/money";

export interface ReturnTotalItem {
  invoiceItemId: number;
  /** الكمية المباعة بالوحدة الأساس — مقام النسبة. */
  baseQuantity: number;
  /** ما سبق إرجاعه؛ يلزم لاكتشاف أن الدفعة الحالية تُكمل الفاتورة. */
  returnedBaseQuantity?: number;
  /** إجمالي بند الفاتورة المصدر (نصّ decimal). */
  total: string;
}

export interface ReturnTotalInvoice {
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total?: string;
  returnedTotal?: string | null;
}

/**
 * @param items       بنود الفاتورة كما يعيدها `returns.getInvoice`.
 * @param qtyByItemId الكمية المُرجَعة بالوحدة الأساس لكل بند (الغائب/الصفر يُتجاهَل).
 * @returns نصٌّ بمنزلتين عشريّتين.
 */
export function computeReturnTotal(
  items: ReturnTotalItem[],
  qtyByItemId: Record<number, number>,
  inv: ReturnTotalInvoice,
): string {
  let gross = D(0);
  let hasSelectedQuantity = false;
  let completesInvoice = items.length > 0;
  for (const it of items) {
    const qty = qtyByItemId[it.invoiceItemId] ?? 0;
    const remaining = Math.max(0, it.baseQuantity - (it.returnedBaseQuantity ?? 0));
    if (qty > 0) hasSelectedQuantity = true;
    if (qty !== remaining) completesInvoice = false;
    // بندٌ بلا كمية أو بمقامٍ صفريّ يُتجاوَز بدل أن يُفسِد الإجمالي بقسمةٍ على صفر.
    if (!(qty > 0) || !D(it.baseQuantity).gt(0)) continue;
    gross = gross.plus(D(it.total).times(D(qty).div(it.baseQuantity)));
  }
  if (hasSelectedQuantity && completesInvoice && inv.total != null) {
    return round2(D(inv.total).minus(D(inv.returnedTotal ?? "0"))).toFixed(2);
  }
  const subtotal = D(inv.subtotal);
  const discountRatio = subtotal.gt(0) ? D(inv.discountAmount).div(subtotal) : D(0);
  const taxable = subtotal.minus(inv.discountAmount);
  const taxRate = taxable.gt(0) ? D(inv.taxAmount).div(taxable) : D(0);
  // التقريب مرّةً على الإيراد ومرّةً على الضريبة — نفس ترتيب الخادم (لا تقريبٌ لكل بند).
  const revenue = round2(gross.times(D(1).minus(discountRatio)));
  return round2(revenue.plus(round2(revenue.times(taxRate)))).toFixed(2);
}

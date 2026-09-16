/**
 * invoiceRemaining — «كم المتبقّي على هذه الفاتورة؟» + `isFullyPaid` مسندُها البُوَليّ.
 *
 * **مصدر الحقيقة الوحيد** لصيغةٍ مكرَّرة **حرفياً ٩ مرّات في الخادم** (D2، §٤):
 *   `money(inv.total).minus(money(inv.returnedTotal ?? "0")).minus(money(inv.paidAmount))`
 *
 * الأدلّة (`git grep`، ٣/٩/٢٦):
 *   - `delivery/courier.ts:1365`  · `delivery/dispatchInvoice.ts:228`  · `delivery/settle.ts:392`
 *   - `deliveryLegacyRepairService.ts:361/496/954`
 *   - `installment/plan.ts:150`   · `sale/controlRequests.ts:284`
 *   - `__tests__/returnRoundingLedger.test.ts:215`
 * ⇒ ٩ نُسخٍ بترتيبٍ متفاوت للطرحين: `paid−returnedTotal` مرّةً و`returnedTotal−paid` أخرى.
 * الجبر يعطي النتيجة نفسها، لكن الترتيب المختلف يُصعّب المراجعة العدائيّة (ذاكرة
 * [[feedback-verify-before-reuse]]) — لذا التوقيعُ واحد.
 *
 * ⚠️ **لماذا الطرحُ اثنان لا واحد:** `returnedTotal` يمثّل «قيمة البضاعة التي رجعت»؛ `paidAmount`
 * يمثّل «ما دُفع فعلياً». الفاتورة المرتجَعة كلياً بلا سدادٍ صافيها **صفر** لا سالب. لو حسبنا
 * `total − paidAmount` وحده ⇒ يظهر «متبقّي» على مستندٍ لا يستحقّ أحدٌ عليه شيئاً.
 *
 * **لا تقريبَ صامتاً:** الدالّة تُرجع `Decimal` بدقّةٍ كاملة — القرارُ حول التقريب (2dp أو
 * `roundCashIQD`) يقع عند الاستهلاك حسب المسار (عرضٌ عامّ ٢ · نقدٌ ٢٥٠).
 *
 * **الاستعمال المتوقَّع** (يوصَل لاحقاً):
 *   - `voucherService.attachToInvoice`: يرفض قبضاً > `invoiceRemaining(inv)`.
 *   - رأسُ صفحة الفاتورة: رقمٌ واحد لا حسبةٌ متكرّرة.
 *   - `sales.pay` بعد كلّ سداد: `if (isFullyPaid(inv)) markPaid()`.
 */

import Decimal from "decimal.js";

/** الشكل الأدنى للفاتورة الذي يكفي لحساب المتبقّي — يتوافق مع صفوف `invoices` و`purchaseOrders`. */
export type InvoiceRemainingInput = {
  total: string | number | null | undefined;
  paidAmount: string | number | null | undefined;
  returnedTotal?: string | number | null | undefined;
};

/** تحويلٌ آمنٌ إلى `Decimal` بلا رمي (يحاكي `money()` من `server/services/money.ts` بلا استيراده). */
function toDecimalSafe(v: string | number | null | undefined): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * ⭐ **الصيغةُ الحاكمة**: المتبقّي = `total − returnedTotal − paidAmount`.
 *
 * يعيد `Decimal` بدقّةٍ كاملة (بلا `toDecimalPlaces`). المستهلِك يقرّر التقريب:
 *   - عرضٌ عامّ: `.toDecimalPlaces(2)` أو `toDbMoney()`.
 *   - قبضٌ نقديّ: `roundCashIQD(...)` بحسب سياسة الدرج.
 *
 * ⚠️ قد يعود **سالباً** (سدادٌ زائد أو مرتجعٌ يبتلع سداداً سابقاً) — المستهلِك يقرّر: قصٌّ عند
 * الصفر بـ`positiveDiff` عرضاً للعميل، أو ترحيلُه ذمّةً دائنة، أو تنبيهٌ يفشل بصوت.
 *
 * @example
 *   invoiceRemaining({ total: "100", paidAmount: "40", returnedTotal: "0" })    // Decimal(60)
 *   invoiceRemaining({ total: "100", paidAmount: "100", returnedTotal: "0" })   // Decimal(0)
 *   invoiceRemaining({ total: "100", paidAmount: "60", returnedTotal: "40" })   // Decimal(0)
 *   invoiceRemaining({ total: "100", paidAmount: "120", returnedTotal: "0" })   // Decimal(-20) — سدادٌ زائد
 *   invoiceRemaining({ total: null, paidAmount: null })                         // Decimal(0)
 */
export function invoiceRemaining(inv: InvoiceRemainingInput | null | undefined): Decimal {
  if (!inv) return new Decimal(0);
  const total = toDecimalSafe(inv.total);
  const returned = toDecimalSafe(inv.returnedTotal);
  const paid = toDecimalSafe(inv.paidAmount);
  return total.minus(returned).minus(paid);
}

/**
 * ⭐ هل الفاتورةُ **مُسدَّدةٌ بالكامل** (المتبقّي ≤ 0)؟
 *
 * يقبل السدادَ الزائد (`invoiceRemaining < 0`) بوصفه «مُسدَّداً» — الفاتورةُ لا تُطالَب. ذمّةُ
 * الفائض تُعالَج على مستوى الطرف لا الفاتورة (يُرحَّل رصيداً دائناً).
 *
 * @example
 *   isFullyPaid({ total: "100", paidAmount: "100" })                           // true
 *   isFullyPaid({ total: "100", paidAmount: "60",  returnedTotal: "40" })      // true
 *   isFullyPaid({ total: "100", paidAmount: "120" })                           // true (سدادٌ زائد)
 *   isFullyPaid({ total: "100", paidAmount: "99.99" })                         // false
 */
export function isFullyPaid(inv: InvoiceRemainingInput | null | undefined): boolean {
  return invoiceRemaining(inv).lte(0);
}

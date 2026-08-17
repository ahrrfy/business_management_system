/**
 * اشتقاق «شروط الدفع» لمحرّر الفواتير من فاتورةٍ قائمة (نسخٌ أو تصحيح).
 *
 * **لماذا الاشتقاق أصلاً:** جدول `invoices` لا يملك عمودَ شروط دفع — الأثر المخزَّن الوحيد
 * للبيع الآجل هو `paidAmount = 0` (+ `dueDate` اختياريّ). فكلّ شاشةٍ تُعيد تحميل فاتورةٍ قائمة
 * في المحرّر تسقط على افتراضيّ `createInitialState` وهو `"CASH"`، و«نقديّ» مع حقل «المدفوع»
 * الفارغ تعني في `computePaidStr()` **«مسدَّدة بالكامل نقداً»** ⇒ إيصال قبضٍ لمالٍ لم يُقبض،
 * ودرجٌ يظهر عاجزاً بالمبلغ نفسه عند Z-report. لذا يُشتقّ الوضع من المال المدفوع، لا يُفترض.
 *
 * **قاعدة الاشتقاق — واتجاهها هو اتجاه الأمان الماليّ:** لا يُفترَض سدادٌ إلّا إن كان الأصل
 * مسدَّداً بالكامل فعلاً؛ وما دون ذلك ⇒ آجل. الذمّة مرئيّةٌ ومنسوبةٌ لطرفٍ وقابلةٌ للتحصيل
 * والتصحيح، أمّا النقد الوهميّ فعجزُ درجٍ لا يُستردّ ولا يُنسب لأحد.
 *
 * الحساب بـ`decimal.js` عبر `D` — لا `parseFloat` على الأموال.
 */
import { D } from "@/lib/money";
import type { PaymentTerm } from "./types";

export function derivePaymentTerms(source: {
  total?: string | null;
  paidAmount?: string | null;
  /** ما أُرجِع من الأصل — الصافي المستحقّ هو (الإجمالي − المرتجع)، مرآةً لـ`computeInvoiceStatus`. */
  returnedTotal?: string | null;
}): PaymentTerm {
  const net = D(source.total ?? "0").minus(D(source.returnedTotal ?? "0"));
  const paid = D(source.paidAmount ?? "0");
  // صافٍ غير موجب (فاتورة فارغة أو مُرتجَعة بالكامل): لا سدادَ يُفترَض على النسخة الجديدة.
  if (!net.gt(0)) return "CREDIT";
  return paid.gte(net) ? "CASH" : "CREDIT";
}

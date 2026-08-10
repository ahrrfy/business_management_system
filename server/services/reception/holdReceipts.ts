// ش٤ (V5+V6) — مُحدِّد «إيصال احتجازٍ سابق للفاتورة» الواحد المُصدَّر.
//
// إيصال الاحتجاز = مالٌ قُبض قبل وجود فاتورة (عربون أمر شغل، أو عربون/ردّ مسوّدة استقبال عبر
// orderPayments). قيده PAYMENT_IN/OUT يعيش بلا invoiceId مدى الحياة (append-only)، والمال يصل
// الفاتورة لاحقاً عبر invoices.paidAmount ⇒ أيّ قارئٍ يجمع «السندات المستقلّة» (قيود بلا فاتورة)
// فوق paidAmount يحتسب نفس الدينار مرّتين أو يطرحه من ذمّةٍ لم تُمسّ.
//
// قبل ش٤ كان الاستثناء مبعثراً بدلالة receipts.workOrderId وحدها (reconcileService) — عربون
// المسوّدة لا يحملها. هذا الملف يوحّد البصمة في تعبيرين SQL يستهلكهما القرّاء الثلاثة
// (reconcileService + arAging.customerPaymentLink + customerOpeningBalance عبره) بدل نسخٍ متفرّقة.
//
// ⚠️ لا يُستثنى القيد من الأرصدة المشتقّة قيوداً-فقط (branchBalanceJoin في getARAging): هناك القيد
// محمولُ الأثر عبر دورة الحياة كاملة (SALE − PAYMENT_INs = المتبقّي) واستثناؤه يكسر التطابق بعد
// التثبيت/التسليم — الازدواج ينشأ فقط عند خلط القيود المستقلّة مع paidAmount.
import { sql, type SQL } from "drizzle-orm";
import { orderPayments, receipts } from "../../../drizzle/schema";

/**
 * شرط SQL: «هذا الإيصال إيصالُ احتجازٍ سابقٌ للفاتورة» — يصدق على:
 *  - إيصال عربون أمر الشغل (receipts.workOrderId IS NOT NULL — النمط التاريخي القائم)، أو
 *  - إيصال قبض/ردّ عربون مسوّدة (مربوطٌ بصفّ orderPayments عبر uq_orderpay_receipt).
 * يُستعمل داخل WHERE على جدول receipts (مثل customerPaymentLink).
 */
export function isPreInvoiceHoldReceiptCond(): SQL {
  return sql`(${receipts.workOrderId} IS NOT NULL OR EXISTS (
    SELECT 1 FROM ${orderPayments} op WHERE op.receiptId = ${receipts.id}
  ))`;
}

/**
 * شرط SQL على **قيود الدفتر**: «قيد هذا الإيصال ليس قيدَ احتجاز» — للاستعمال في تجميعات
 * «السندات المستقلّة» (reconcileService.voucherSum ونظائرها). يُبقي القيود التي بلا إيصالٍ
 * أصلاً (سندات يدوية قديمة) ويستثني ما إيصالُه إيصالُ احتجاز بالبصمتين معاً.
 * يُمرَّر تعبير عمود receiptId من جدول القيود (accountingEntries.receiptId).
 */
export function entryNotHoldReceiptCond(receiptIdCol: SQL | unknown): SQL {
  return sql`(${receiptIdCol} IS NULL OR ${receiptIdCol} NOT IN (
    SELECT ${receipts.id} FROM ${receipts} WHERE ${receipts.workOrderId} IS NOT NULL
    UNION
    SELECT op.receiptId FROM ${orderPayments} op WHERE op.receiptId IS NOT NULL
  ))`;
}

import { fmtDate, fmtDateTime, fmtTime, type DateInput } from "@/lib/date";
import { D, round2 } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import type { ReceiptBrowserData } from "./print";

export interface InvoiceReceiptSource {
  invoiceNumber: string;
  invoiceDate: DateInput;
  customerName?: string | null;
  salespersonName?: string | null;
  /** G3 (١١/٨): رقم الوردية التي أُنشئت عليها الفاتورة — يُطبع في ترويسة إيصال إعادة الطباعة
   *  ليوثّق أصل المعاملة (invoices.shiftId). */
  shiftId?: number | null;
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  total: string | number;
  paidAmount?: string | number | null;
  returnedTotal?: string | number | null;
  paymentMethod?: string | null;
  correctionAudit?: {
    originalInvoiceNumber: string;
    requestedBy?: number | null;
    requestedByName?: string | null;
    requestedAt?: DateInput | null;
    reviewedBy?: number | null;
    reviewedByName?: string | null;
    reviewedAt?: DateInput | null;
  } | null;
  /** ٨/٨ — توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا الفاتورة — إفصاحٌ للزبون على
   *  الإيصال المُعاد طبعه (يُصوَّر ويُرسَل). عرضٌ فقط — لا يمسّ الإجمالي/الإيراد. */
  courierName?: string | null;
  courierFee?: string | number | null;
  courierFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  consignmentStatus?: string | null;
  items: {
    productName?: string | null;
    variantName?: string | null;
    unitName?: string | null;
    quantity: string | number;
    unitPrice: string | number;
    total: string | number;
    /** هدايا الفاتورة (0149): يُوسَم الاسم بـ«هدية» في الإيصال الحراريّ (السعر صفر أصلاً). */
    isGift?: boolean | null;
  }[];
}

/**
 * يعيد بناء إيصال الكاشير من لقطة الفاتورة المحفوظة؛ لا ينشئ بيعاً أو دفعة جديدة.
 * القيم المالية الحالية (المدفوع/المرتجع) تمنع أن تعرض النسخة المعاد طباعتها ذمة غير صحيحة.
 */
export function invoiceToReceipt(d: InvoiceReceiptSource): ReceiptBrowserData {
  const paid = D(d.paidAmount ?? 0);
  const credit = round2(D(d.total).minus(D(d.returnedTotal ?? 0)).minus(paid));

  return {
    receiptNumber: d.invoiceNumber,
    date: fmtDate(d.invoiceDate),
    time: fmtTime(d.invoiceDate),
    cashierName: d.salespersonName ?? null,
    customerName: d.customerName ?? null,
    shiftId: d.shiftId ?? null,
    items: d.items.map((item) => ({
      name: [
        item.productName ?? "منتج",
        item.variantName || null,
        item.unitName ? `(${item.unitName})` : null,
        item.isGift ? "هدية مجاناً" : null,
      ].filter(Boolean).join(" — "),
      quantity: D(item.quantity).toNumber(),
      price: item.unitPrice,
      total: item.total,
    })),
    subtotal: d.subtotal,
    discount: d.discountAmount ?? null,
    tax: d.taxAmount ?? null,
    total: d.total,
    paid: paid.toString(),
    credit: credit.gt(0) ? credit.toString() : null,
    paymentMethod: d.paymentMethod ? paymentMethodLabel(d.paymentMethod) : null,
    revision: d.correctionAudit ? {
      originalReceiptNumber: d.correctionAudit.originalInvoiceNumber,
      revisedAt: d.correctionAudit.requestedAt ? fmtDateTime(d.correctionAudit.requestedAt) : "غير موثّق",
      revisedByName: d.correctionAudit.requestedBy != null
        ? `المستخدم #${d.correctionAudit.requestedBy}${d.correctionAudit.requestedByName ? ` (الاسم الحالي: ${d.correctionAudit.requestedByName})` : ""}`
        : "حساب غير موثّق",
      approvedByName: d.correctionAudit.reviewedByName || d.correctionAudit.reviewedBy != null
        ? `المستخدم #${d.correctionAudit.reviewedBy ?? "غير موثّق"}${d.correctionAudit.reviewedByName ? ` (الاسم الحالي: ${d.correctionAudit.reviewedByName})` : ""}`
        : null,
      approvedAt: d.correctionAudit.reviewedAt ? fmtDateTime(d.correctionAudit.reviewedAt) : null,
    } : null,
    delivery: d.courierName && Number(d.courierFee ?? 0) > 0 && d.consignmentStatus !== "CANCELLED"
      ? { partyName: d.courierName, fee: d.courierFee ?? "0", feeCollection: d.courierFeeCollection ?? "COURIER" }
      : null,
  };
}

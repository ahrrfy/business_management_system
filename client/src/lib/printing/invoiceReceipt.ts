import { fmtDate, fmtTime, type DateInput } from "@/lib/date";
import { D, round2 } from "@/lib/money";
import type { ReceiptBrowserData } from "./print";

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  TELECOM: "رصيد زين",
};

export interface InvoiceReceiptSource {
  invoiceNumber: string;
  invoiceDate: DateInput;
  customerName?: string | null;
  salespersonName?: string | null;
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  total: string | number;
  paidAmount?: string | number | null;
  returnedTotal?: string | number | null;
  paymentMethod?: string | null;
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
    paymentMethod: d.paymentMethod ? (PAYMENT_METHOD_LABEL[d.paymentMethod] ?? d.paymentMethod) : null,
  };
}

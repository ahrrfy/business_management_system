import { D, fmt, fmtQty, round2 } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { printDoc, type PrintDoc } from "@/lib/printing/print";
import type { PrintWindowOptions } from "@/lib/printing/brand";
import type { PrintItemBlock } from "@/lib/printing/render";

export interface PrintSalesReturnData {
  /** Invoice relief without a customer account or any cash payout. */
  noCashNoAccount?: boolean;
  payoutAmount?: string;
  debtOffsetAmount?: string;
  returnNumber: string;
  originalInvoiceNumber?: string | null;
  customerName: string;
  customerPhone?: string | null;
  disposition: "RESTOCK" | "DAMAGED";
  method: "CASH" | "CARD" | "STORE_CREDIT" | "CREDIT_OFFSET";
  reference?: string | null;
  totalAmount: string;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: string;
    barcode?: string | null;
  }>;
}

export interface PrintPurchaseReturnData {
  returnNumber: string;
  supplierName: string;
  supplierPhone?: string | null;
  reference?: string | null;
  method: "CREDIT_OFFSET" | "CASH_IN" | "CARD_TRANSFER";
  totalAmount: string;
  items: Array<{
    name: string;
    quantity: number;
    unitCost: string;
    barcode?: string | null;
  }>;
}

/**
 * طباعة إيصال مرتجع مبيعات حراري فوري
 */
export async function printSalesReturnReceipt(data: PrintSalesReturnData, options?: PrintWindowOptions) {
  const methodLabel =
    data.noCashNoAccount ? "تخفيض المتبقي على الفاتورة — بلا استرداد مالي" : data.method === "CASH"
      ? "استرداد نقدي"
      : data.method === "CARD"
      ? "استرداد بالبطاقة"
      : data.method === "CREDIT_OFFSET"
      ? "معادلة ذمم (خصم من حساب العميل الآجل)"
      : "قسيمة رصيد متجر (Store Credit)";

  const dispositionLabel =
    data.disposition === "RESTOCK" ? "إعادة للمخزون (للرف)" : "إتلاف وتسجيل خسارة تلف";

  const meta = [
    `الزبون: ${data.customerName}`,
    ...(data.customerPhone ? [`الهاتف: ${data.customerPhone}`] : []),
    ...(data.originalInvoiceNumber ? [`الفاتورة الأصلية: #${data.originalInvoiceNumber}`] : []),
    `الحالة المخزنية: ${dispositionLabel}`,
    `التاريخ: ${fmtDateTime(new Date())}`,
  ];

  const itemBlocks: PrintItemBlock[] = data.items.map((i) => ({
    name: i.name,
    quantityPrice: `${fmtQty(i.quantity)} × ${fmt(i.unitPrice)} د.ع`,
    total: `${fmt(round2(D(i.quantity).times(D(i.unitPrice))).toFixed(2))} د.ع`,
  }));

  const totals = [
    { label: "قيمة المرتجع", value: `${fmt(data.totalAmount)} د.ع` },
    ...(data.payoutAmount != null ? [{ label: "المبلغ المدفوع للزبون", value: `${fmt(data.payoutAmount)} د.ع` }] : []),
    ...(data.debtOffsetAmount != null && D(data.debtOffsetAmount).gt(0) ? [{ label: "تخفيض المتبقي على الفاتورة", value: `${fmt(data.debtOffsetAmount)} د.ع` }] : []),
    { label: "طريقة الاسترداد", value: methodLabel },
    ...(data.reference ? [{ label: "رقم المرجع", value: data.reference }] : []),
  ];

  const doc: PrintDoc = {
    kind: "receipt",
    title: "مكتبة الرؤية العربية",
    subtitle: `إيصال مرتجع مبيعات: ${data.returnNumber}`,
    meta,
    itemBlocks,
    totals,
    barcodeSet: {
      qrPayload: data.returnNumber,
      barcode128: data.returnNumber,
      displayLabel: `سند مرتجع مبيعات: ${data.returnNumber}`,
    },
    footer: "شكراً لتعاملكم معنا — نظام إدارة أعمال الرؤية العربية",
  };

  return printDoc(doc, options);
}

/**
 * طباعة سند إرجاع مشتريات للمورد
 */
export async function printPurchaseReturnVoucher(data: PrintPurchaseReturnData, options?: PrintWindowOptions) {
  const methodLabel =
    data.method === "CREDIT_OFFSET"
      ? "معادلة ذمم (خصم من رصيد المورد)"
      : data.method === "CASH_IN"
      ? "مردود نقدي (قبض نقد من المورد)"
      : "حوالة / تحويل بنكي";

  const meta = [
    `المورد: ${data.supplierName}`,
    ...(data.supplierPhone ? [`هاتف المورد: ${data.supplierPhone}`] : []),
    ...(data.reference ? [`الرقم المرجعي / الفاتورة: ${data.reference}`] : []),
    `التاريخ: ${fmtDateTime(new Date())}`,
  ];

  const itemBlocks: PrintItemBlock[] = data.items.map((i) => ({
    name: i.name,
    quantityPrice: `${fmtQty(i.quantity)} × ${fmt(i.unitCost)} د.ع`,
    total: `${fmt(round2(D(i.quantity).times(D(i.unitCost))).toFixed(2))} د.ع`,
  }));

  const totals = [
    { label: "إجمالي قيمة المرتجع للمورد", value: `${fmt(data.totalAmount)} د.ع` },
    { label: "طريقة التسوية", value: methodLabel },
  ];

  const doc: PrintDoc = {
    kind: "receipt",
    title: "مكتبة الرؤية العربية",
    subtitle: `سند مرتجع مشتريات: ${data.returnNumber}`,
    meta,
    itemBlocks,
    totals,
    barcodeSet: {
      qrPayload: data.returnNumber,
      barcode128: data.returnNumber,
      displayLabel: `مرتجع مشتريات للمورد: ${data.returnNumber}`,
    },
    footer: "سند رسمي صادر من قسم المشتريات والمخازن — الرؤية العربية",
  };

  return printDoc(doc, options);
}

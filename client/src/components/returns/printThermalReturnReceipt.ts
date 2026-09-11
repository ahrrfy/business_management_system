import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { printDoc, type PrintDoc } from "@/lib/printing/print";
import type { PrintItemBlock } from "@/lib/printing/render";

export interface PrintSalesReturnData {
  returnNumber: string;
  originalInvoiceNumber?: string | null;
  customerName: string;
  customerPhone?: string | null;
  disposition: "RESTOCK" | "DAMAGED";
  method: "CASH" | "CARD" | "STORE_CREDIT";
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
export async function printSalesReturnReceipt(data: PrintSalesReturnData) {
  const methodLabel =
    data.method === "CASH"
      ? "استرداد نقدي"
      : data.method === "CARD"
      ? "استرداد بالبطاقة"
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
    quantityPrice: `${i.quantity} × ${fmt(i.unitPrice)} د.ع`,
    total: `${fmt(String(Number(i.quantity) * Number(i.unitPrice)))} د.ع`,
  }));

  const totals = [
    { label: "إجمالي المرتجع المسترد", value: `${fmt(data.totalAmount)} د.ع` },
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
      qrPayload: `https://alarabiya.online/return/${encodeURIComponent(data.returnNumber)}`,
      barcode128: data.returnNumber,
      displayLabel: `سند مرتجع مبيعات: ${data.returnNumber}`,
    },
    footer: "شكراً لتعاملكم معنا — نظام إدارة أعمال الرؤية العربية",
  };

  return printDoc(doc);
}

/**
 * طباعة سند إرجاع مشتريات للمورد
 */
export async function printPurchaseReturnVoucher(data: PrintPurchaseReturnData) {
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
    quantityPrice: `${i.quantity} × ${fmt(i.unitCost)} د.ع`,
    total: `${fmt(String(Number(i.quantity) * Number(i.unitCost)))} د.ع`,
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
      qrPayload: `https://alarabiya.online/preturn/${encodeURIComponent(data.returnNumber)}`,
      barcode128: data.returnNumber,
      displayLabel: `مرتجع مشتريات للمورد: ${data.returnNumber}`,
    },
    footer: "سند رسمي صادر من قسم المشتريات والمخازن — الرؤية العربية",
  };

  return printDoc(doc);
}

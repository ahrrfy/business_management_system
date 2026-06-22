/**
 * BarcodeService — Domain Service (DDD pattern)
 * المسؤولية: توليد وتوقيع payload الباركود/QR لكل نوع مستند.
 *
 * المبادئ:
 *  • لا وصول مباشر للـ DB — تأخذ بيانات جاهزة، تُعيد BarcodeSet موقَّعة.
 *  • HMAC-SHA256 (crypto مدمجة في Node — صفر تكلفة) يمنع تزوير أي QR.
 *  • الخادم وحده يملك BARCODE_SECRET → الواجهة تعرض فقط، لا تُنشئ signatures.
 *  • صيغة payload: TYPE|number|date|amount|branchId|hmac12
 *    مستوحاة من ZATCA (Saudi e-invoice) TLV وEU e-invoicing compact format.
 */

import { createHmac } from "crypto";
import Decimal from "decimal.js";
import { money, round2 } from "./money";
import type {
  BarcodeSet,
  InvoicePayloadFields,
  WorkOrderPayloadFields,
  PurchaseOrderPayloadFields,
  CustomerPayloadFields,
  VerifyResult,
  DocType,
} from "../../shared/barcodeTypes";

// -------------------------------------------------------------------
// HMAC core — يستخدم crypto المدمجة في Node (لا تبعيات خارجية)
// -------------------------------------------------------------------

function getSecret(): string {
  const s = process.env.BARCODE_SECRET;
  if (!s) throw new Error("BARCODE_SECRET غير مُعيَّن في .env");
  return s;
}

/** يوقّع قائمة حقول بـ HMAC-SHA256 ويُعيد أول 12 حرفاً hex */
function sign(fields: string[]): string {
  const message = fields.join("|");
  return createHmac("sha256", getSecret())
    .update(message)
    .digest("hex")
    .slice(0, 12);
}

/** يُفكّك payload ويتحقق من التوقيع */
export function verifyPayload(qrPayload: string): VerifyResult {
  try {
    const parts = qrPayload.split("|");
    if (parts.length < 6) return { valid: false };

    const [docType, number, date, amount, branchIdStr, receivedSig] = parts;
    const dataFields = [docType, number, date, amount, branchIdStr];
    const expectedSig = sign(dataFields);

    if (receivedSig !== expectedSig) return { valid: false };

    return {
      valid: true,
      docType: docType as DocType,
      number,
      date,
      amount,
      branchId: parseInt(branchIdStr, 10),
    };
  } catch {
    return { valid: false };
  }
}

// -------------------------------------------------------------------
// Factory Methods — إنشاء BarcodeSet لكل نوع مستند
// -------------------------------------------------------------------

/** تنسيق التاريخ بصيغة YYYY-MM-DD من أي مدخل */
function toIsoDate(d: string | Date): string {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** تنسيق التاريخ للعرض dd/mm/yyyy */
function toDisplayDate(isoDate: string): string {
  const [y, m, day] = isoDate.split("-");
  return `${day}/${m}/${y}`;
}

/** تنسيق المبلغ للعرض (يُضيف فواصل الآلاف).
 *  §٥: ممنوع parseFloat على الأموال ⇒ نعبر عبر Decimal لحفظ الدقّة قبل التقريب للعرض. */
function formatAmount(amount: string): string {
  try {
    const d = money(amount);
    // نقرّب إلى ٢ خانة عشرية ثم نعرض بصيغة محلية. الدينار العراقي عملياً صحيح،
    // لكن الكسور (لو وُجدت) لا يجب أن تُلغى بـ parseFloat الذي يفقد الدقّة.
    return round2(d).toNumber().toLocaleString("ar-IQ-u-nu-latn") + " د.ع";
  } catch {
    return amount; // قيمة غير صالحة ⇒ نعرض كما هي بلا كسر
  }
}

// ---

export function invoiceBarcodeSet(inv: InvoicePayloadFields): BarcodeSet {
  const isoDate = toIsoDate(inv.invoiceDate);
  // المبلغ يُخزَّن كعدد صحيح (دينار) للإيجاز في QR.
  // §٥: نقرّب بـ Decimal HALF_UP (لا parseFloat الذي يفقد الدقّة قبل التقريب).
  const amountInt = money(inv.total).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  const dataFields = ["INV", inv.invoiceNumber, isoDate, String(amountInt), String(inv.branchId)];
  const sig = sign(dataFields);

  return {
    barcode128: inv.invoiceNumber,
    qrPayload: [...dataFields, sig].join("|"),
    displayLabel: [
      `فاتورة: ${inv.invoiceNumber}`,
      `${toDisplayDate(isoDate)} — ${formatAmount(inv.total)}`,
    ].join("\n"),
  };
}

export function workOrderBarcodeSet(wo: WorkOrderPayloadFields): BarcodeSet {
  const isoDate = toIsoDate(wo.createdAt);
  const dataFields = ["WO", wo.orderNumber, isoDate, "0", String(wo.branchId)];
  const sig = sign(dataFields);

  return {
    barcode128: wo.orderNumber,
    qrPayload: [...dataFields, sig].join("|"),
    displayLabel: `طلب خدمة: ${wo.orderNumber}\n${toDisplayDate(isoDate)}`,
  };
}

export function purchaseOrderBarcodeSet(po: PurchaseOrderPayloadFields): BarcodeSet {
  const isoDate = toIsoDate(po.createdAt);
  const dataFields = ["PO", po.poNumber, isoDate, "0", String(po.branchId)];
  const sig = sign(dataFields);

  return {
    barcode128: po.poNumber,
    qrPayload: [...dataFields, sig].join("|"),
    displayLabel: `طلب شراء: ${po.poNumber}\n${toDisplayDate(isoDate)}`,
  };
}

export function customerBarcodeSet(customer: CustomerPayloadFields): BarcodeSet {
  // العميل: لا مبلغ ولا تاريخ — نستخدم "0" كقيم محايدة
  const dataFields = ["CUST", String(customer.id), "0", "0", "0"];
  const sig = sign(dataFields);

  const paddedId = String(customer.id).padStart(5, "0");

  return {
    barcode128: `CUST-${paddedId}`,
    qrPayload: [...dataFields, sig].join("|"),
    displayLabel: `${customer.name}\nCUST-${paddedId}`,
  };
}

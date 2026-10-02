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
import { docBarcode } from "@shared/documentNumber";
import { money, round2 } from "./money";
import { getDb } from "../db";
import { eq, or } from "drizzle-orm";
import {
  onlineOrders,
  invoices,
  workOrders,
  purchaseOrders,
  customers,
  suppliers,
} from "../../drizzle/schema";
import type {
  BarcodeSet,
  InvoicePayloadFields,
  WorkOrderPayloadFields,
  PurchaseOrderPayloadFields,
  CustomerPayloadFields,
  OnlineOrderPayloadFields,
  VerifyResult,
  DocType,
} from "../../shared/barcodeTypes";

// -------------------------------------------------------------------
// HMAC core — يستخدم crypto المدمجة في Node (لا تبعيات خارجية)
// -------------------------------------------------------------------

function getSecret(): string {
  const s =
    process.env.BARCODE_SECRET ||
    (process.env.NODE_ENV !== "production" ? "default_dev_barcode_secret_32_bytes_ok" : undefined);
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

/**
 * رابط ملصق طلب المتجر: التوقيع يجعل رقم الطلب المتسلسل غير قابل للتخمين أو التزوير.
 * الرمز يوضع في QR فقط، ولا يحمل بيانات العميل نفسها.
 */
export function onlineOrderLabelToken(orderNumber: string): string {
  return sign(["STORE_LABEL", orderNumber.trim()]);
}

export function verifyOnlineOrderLabelToken(orderNumber: string, token: string): boolean {
  if (!orderNumber.trim() || !/^[a-f0-9]{12}$/i.test(token.trim())) return false;
  return onlineOrderLabelToken(orderNumber) === token.trim().toLowerCase();
}

/**
 * يستخرج رمز التحقق من أي مدخل:
 * 1. معرّف مباشر: ORD-100009، INV-10023، 100009
 * 2. رابط كامل: https://srv1548487.hstgr.cloud/verify?ref=ORD-100009
 * 3. رابط بمسار: /verify/ORD-100009
 * 4. وسيط استعلام: ?payload=...، ?p=...، ?ref=...، ?id=...، ?number=...
 */
export function extractVerificationCode(input: string): string {
  if (!input) return "";
  let raw = input.trim();
  if (raw.length > 1000) return "";

  if (raw.includes("://") || raw.startsWith("/") || raw.includes("?") || raw.includes("&")) {
    try {
      const u = new URL(raw, "http://localhost");
      const param =
        u.searchParams.get("ref") ||
        u.searchParams.get("payload") ||
        u.searchParams.get("p") ||
        u.searchParams.get("id") ||
        u.searchParams.get("number");

      if (param && param.trim()) {
        return param.trim();
      }

      const pathname = u.pathname;
      const verifyMatch = pathname.match(/\/verify\/([^/?#]+)/i);
      if (verifyMatch && verifyMatch[1]) {
        return decodeURIComponent(verifyMatch[1]).trim();
      }
    } catch {
      // متابعة للتحليل البديل بـ regex
    }
  }

  const queryMatch = raw.match(/[?&](?:ref|payload|p|id|number)=([^&#]+)/i);
  if (queryMatch && queryMatch[1]) {
    try {
      return decodeURIComponent(queryMatch[1]).trim();
    } catch {
      return queryMatch[1].trim();
    }
  }

  const pathMatch = raw.match(/\/verify\/([^/?#]+)/i);
  if (pathMatch && pathMatch[1]) {
    try {
      return decodeURIComponent(pathMatch[1]).trim();
    } catch {
      return pathMatch[1].trim();
    }
  }

  return raw;
}

type AppDatabase = NonNullable<ReturnType<typeof getDb>>;

async function lookupOnlineOrderByCode(db: AppDatabase, cleanCode: string): Promise<VerifyResult | null> {
  const isNumeric = /^\d+$/.test(cleanCode);
  const numVal = isNumeric ? Number(cleanCode) : null;

  const conditions = [
    eq(onlineOrders.orderNumber, cleanCode),
    eq(onlineOrders.orderNumber, `ORD-${cleanCode}`),
  ];
  if (numVal !== null) {
    conditions.push(eq(onlineOrders.id, numVal));
  }

  const rows = await db
    .select({
      orderNumber: onlineOrders.orderNumber,
      orderDate: onlineOrders.orderDate,
      total: onlineOrders.total,
      branchId: onlineOrders.branchId,
      status: onlineOrders.status,
      customerName: customers.name,
    })
    .from(onlineOrders)
    .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
    .where(or(...conditions))
    .limit(1);

  if (rows && rows.length > 0) {
    const row = rows[0];
    return {
      valid: true,
      docType: "ORD",
      number: row.orderNumber,
      date: toIsoDate(row.orderDate),
      amount: String(row.total),
      branchId: row.branchId !== null && row.branchId !== undefined ? Number(row.branchId) : undefined,
      status: row.status ?? undefined,
      customerName: row.customerName || undefined,
    };
  }
  return null;
}

async function lookupInvoiceByCode(db: AppDatabase, cleanCode: string): Promise<VerifyResult | null> {
  const isNumeric = /^\d+$/.test(cleanCode);
  const numVal = isNumeric ? Number(cleanCode) : null;

  const conditions = [
    eq(invoices.invoiceNumber, cleanCode),
    eq(invoices.invoiceNumber, `INV-${cleanCode}`),
  ];
  if (cleanCode.startsWith("INV-")) {
    conditions.push(eq(invoices.invoiceNumber, cleanCode.slice(4)));
  }
  if (numVal !== null) {
    conditions.push(eq(invoices.id, numVal));
  }

  const rows = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      total: invoices.total,
      branchId: invoices.branchId,
      status: invoices.status,
      customerName: customers.name,
    })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(or(...conditions))
    .limit(1);

  if (rows && rows.length > 0) {
    const row = rows[0];
    return {
      valid: true,
      docType: "INV",
      number: row.invoiceNumber,
      date: toIsoDate(row.invoiceDate),
      amount: String(row.total),
      branchId: row.branchId !== null && row.branchId !== undefined ? Number(row.branchId) : undefined,
      status: row.status ?? undefined,
      customerName: row.customerName || undefined,
    };
  }
  return null;
}

async function lookupWorkOrderByCode(db: AppDatabase, cleanCode: string): Promise<VerifyResult | null> {
  const isNumeric = /^\d+$/.test(cleanCode);
  const numVal = isNumeric ? Number(cleanCode) : null;

  const conditions = [
    eq(workOrders.orderNumber, cleanCode),
    eq(workOrders.orderNumber, `WO-${cleanCode}`),
  ];
  if (cleanCode.startsWith("WO-")) {
    conditions.push(eq(workOrders.orderNumber, cleanCode.slice(3)));
  }
  if (numVal !== null) {
    conditions.push(eq(workOrders.id, numVal));
  }

  const rows = await db
    .select({
      orderNumber: workOrders.orderNumber,
      createdAt: workOrders.createdAt,
      salePrice: workOrders.salePrice,
      branchId: workOrders.branchId,
      status: workOrders.status,
      contactName: workOrders.contactName,
      customerName: customers.name,
    })
    .from(workOrders)
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .where(or(...conditions))
    .limit(1);

  if (rows && rows.length > 0) {
    const row = rows[0];
    return {
      valid: true,
      docType: "WO",
      number: row.orderNumber,
      date: toIsoDate(row.createdAt),
      amount: String(row.salePrice ?? "0"),
      branchId: row.branchId !== null && row.branchId !== undefined ? Number(row.branchId) : undefined,
      status: row.status ?? undefined,
      customerName: row.customerName || row.contactName || undefined,
    };
  }
  return null;
}

async function lookupPurchaseOrderByCode(db: AppDatabase, cleanCode: string): Promise<VerifyResult | null> {
  const isNumeric = /^\d+$/.test(cleanCode);
  const numVal = isNumeric ? Number(cleanCode) : null;

  const conditions = [
    eq(purchaseOrders.poNumber, cleanCode),
    eq(purchaseOrders.poNumber, `PO-${cleanCode}`),
  ];
  if (cleanCode.startsWith("PO-")) {
    conditions.push(eq(purchaseOrders.poNumber, cleanCode.slice(3)));
  }
  if (numVal !== null) {
    conditions.push(eq(purchaseOrders.id, numVal));
  }

  const rows = await db
    .select({
      poNumber: purchaseOrders.poNumber,
      orderDate: purchaseOrders.orderDate,
      total: purchaseOrders.total,
      branchId: purchaseOrders.branchId,
      status: purchaseOrders.status,
      supplierName: suppliers.name,
    })
    .from(purchaseOrders)
    .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
    .where(or(...conditions))
    .limit(1);

  if (rows && rows.length > 0) {
    const row = rows[0];
    return {
      valid: true,
      docType: "PO",
      number: row.poNumber,
      date: toIsoDate(row.orderDate),
      amount: String(row.total),
      branchId: row.branchId !== null && row.branchId !== undefined ? Number(row.branchId) : undefined,
      status: row.status ?? undefined,
      customerName: row.supplierName || undefined,
    };
  }
  return null;
}

/**
 * المحرك المزدوج للتحقق (Dual Verification Engine):
 * 1. المسار السريع: التحقق بالـ HMAC التشفيري (بدون استعلام DB — فوري وصالح دون اتصال).
 * 2. المسار الرديف: البحث في قاعدة البيانات لمطابقة أرقام المستندات (ORD-*, INV-*, WO-*, PO-*، ومعرّفات النظام).
 */
export async function verifyPayload(qrPayload: string): Promise<VerifyResult> {
  try {
    if (!qrPayload || qrPayload.length > 1000) return { valid: false };

    const cleanCode = extractVerificationCode(qrPayload);
    if (!cleanCode || cleanCode.length > 1000) return { valid: false };

    // 1. المسار التشفيري: فحص صيغة الـ HMAC الموقَّعة (6 أجزاء مفصولة بـ |)
    const parts = cleanCode.split("|");
    if (parts.length >= 6) {
      const [docType, number, date, amount, branchIdStr, receivedSig] = parts;
      const dataFields = [docType, number, date, amount, branchIdStr];
      const expectedSig = sign(dataFields);

      if (receivedSig === expectedSig) {
        return {
          valid: true,
          docType: docType as DocType,
          number,
          date,
          amount,
          branchId: parseInt(branchIdStr, 10),
        };
      }
    }

    // 2. المسار الرديف: استعلام قاعدة البيانات عند غياب التوقيع التشفيري أو عدم اكتمال الحقول
    const db = getDb();
    if (!db) {
      // توافق كامل مع اختبارات الوحدة بدون اتصال DB
      return { valid: false };
    }

    try {
      // أ) طلبات المتجر الإلكتروني (مثل ORD-100009)
      if (/^ORD-/i.test(cleanCode)) {
        const res = await lookupOnlineOrderByCode(db, cleanCode);
        if (res) return res;
      }

      // ب) فواتير المبيعات (مثل INV-10023 أو INV-1-20260806-00068)
      if (/^INV-/i.test(cleanCode)) {
        const res = await lookupInvoiceByCode(db, cleanCode);
        if (res) return res;
      }

      // ج) أوامر الشغل وطلبات الخدمة (مثل WO-10001 أو WO-10023)
      if (/^WO-/i.test(cleanCode)) {
        const res = await lookupWorkOrderByCode(db, cleanCode);
        if (res) return res;
      }

      // د) أوامر الشراء (مثل PO-2026-001 أو PO-10001)
      if (/^PO-/i.test(cleanCode)) {
        const res = await lookupPurchaseOrderByCode(db, cleanCode);
        if (res) return res;
      }

      // هـ) معرّفات عددية أو نصوص بلا بادئة معروفة: فحص حسب الأولوية
      const onlineRes = await lookupOnlineOrderByCode(db, cleanCode);
      if (onlineRes) return onlineRes;

      const invRes = await lookupInvoiceByCode(db, cleanCode);
      if (invRes) return invRes;

      const woRes = await lookupWorkOrderByCode(db, cleanCode);
      if (woRes) return woRes;

      const poRes = await lookupPurchaseOrderByCode(db, cleanCode);
      if (poRes) return poRes;
    } catch {
      // أي خطأ استعلام في DB يُعيد valid: false بأمان
      return { valid: false };
    }

    return { valid: false };
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
    // ١٨/٨ — رقم العرض قصيرٌ (10023) لكن **رمز الآلة يبقى بادئياً**: الماسح يعرف نوع
    // المستند من بادئته فيوجّه المسح صحيحاً؛ رقمٌ عارٍ من الأرقام كان سيُقرأ باركود منتج.
    barcode128: docBarcode("INV", inv.invoiceNumber),
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
    barcode128: docBarcode("WO", wo.orderNumber),
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

export function onlineOrderBarcodeSet(order: OnlineOrderPayloadFields): BarcodeSet {
  const isoDate = toIsoDate(order.orderDate || new Date());
  const amountInt = order.total
    ? money(order.total).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
    : 0;
  const branchId = order.branchId != null ? order.branchId : 0;
  const dataFields = ["ORD", order.orderNumber, isoDate, String(amountInt), String(branchId)];
  const sig = sign(dataFields);

  return {
    barcode128: order.orderNumber,
    qrPayload: [...dataFields, sig].join("|"),
    displayLabel: [
      `طلب متجر: ${order.orderNumber}`,
      `${toDisplayDate(isoDate)} — ${formatAmount(order.total || "0")}`,
    ].join("\n"),
  };
}


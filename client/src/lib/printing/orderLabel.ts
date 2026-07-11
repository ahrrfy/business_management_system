/**
 * ملصق طلب التوصيل (متجر الجوال) — يُطبع من شاشة تثبيت الطلبات على طابعة الملصقات/الإيصالات.
 *
 * يعيد استخدام `printDoc` بالكامل (جسر الخادم ← WebUSB ← نافذة المتصفّح — لا تُسقَط الطباعة أبداً)،
 * ويحمل **باركود Code128 + QR لرقم الطلب** (يُمسح بالماسح ⇒ ربط الطرد بالطلب بلا إدخال يدوي —
 * منع الخطأ Poka-Yoke). البيانات كلها من الطلب نفسه ⇒ صفر إعادة كتابة.
 */
import { governorateById } from "@shared/governorates";
import { CO, fmtC } from "./brand";
import { printDoc } from "./print";

export interface OrderLabelItem {
  productName: string;
  unitName: string;
  quantity: string;
}

export interface OrderLabelData {
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  addressText: string | null;
  subtotal: string;
  deliveryFee: string;
  total: string;
  createdAt?: Date | string | null;
  items: OrderLabelItem[];
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  try {
    const dt = typeof d === "string" ? new Date(d) : d;
    return dt.toLocaleDateString("en-GB");
  } catch {
    return "";
  }
}

/** يطبع ملصق طلب التوصيل. يعيد `{ via }` (server/thermal/browser) لعرض الحالة للمستخدم. */
export function printOrderLabelDoc(o: OrderLabelData): Promise<{ via: "server" | "thermal" | "browser" }> {
  const govName = o.governorate ? governorateById(o.governorate)?.name ?? o.governorate : "";
  const meta = [
    `طلب: ${o.orderNumber}`,
    fmtDate(o.createdAt),
    o.customerName ? `الزبون: ${o.customerName}` : "",
    o.customerPhone ? `الهاتف: ${o.customerPhone}` : "",
    govName ? `المحافظة: ${govName}` : "",
    o.addressText ? `العنوان: ${o.addressText}` : "",
  ].filter(Boolean);
  const rows = o.items.map((it) => [
    `${it.productName}${it.unitName ? ` (${it.unitName})` : ""}`,
    it.quantity,
  ]);
  return printDoc({
    kind: "receipt",
    title: CO.short,
    subtitle: "ملصق طلب توصيل",
    meta,
    columns: rows.length ? ["الصنف", "الكمية"] : undefined,
    rows: rows.length ? rows : undefined,
    totals: [
      { label: "قيمة الأصناف", value: fmtC(o.subtotal) },
      { label: "أجرة التوصيل", value: fmtC(o.deliveryFee) },
      { label: "يُدفع نقداً عند الاستلام", value: fmtC(o.total) },
    ],
    footer: CO.footerLine,
    barcodeSet: { barcode128: o.orderNumber, qrPayload: o.orderNumber, displayLabel: o.orderNumber },
  });
}

// تذكرة حجزٍ حراريّة (٨٠مم) — تُطبع في نافذة تفاصيل الحجز أو من صفّ الجدول. تكامل الطباعة
// الوظيفيّ للحجوزات كان مفقوداً على `main` قبل هذا الملفّ: `ReservationsHub.tsx` بلا أيّ استيراد
// طباعة، ولا مكوّن `reservationToTicket` مقابل `invoiceToReceipt`.
//
// النموذج يعتمد `PrintDoc` (kind:"receipt") لا `ReceiptBrowserData` عمداً: تذكرة الحجز **ليست
// مستنداً محاسبيّاً** (لا مبيعات ولا قيود)، فتذييل «شكراً لتسوقكم — سياسة الاستبدال» في قالب
// `printReceipt` سيكون مضلِّلاً. `printDoc` يمنحنا عنواناً/سطوراً/جدولاً/تذييلاً حرّاً بنفس تدرّج
// الطابعات (جسر ← WebUSB ← نافذة). النمط مطابقٌ لـ`printDeliverySlip` في `deliveryDocs.ts`.
import { D, fmt } from "@/lib/money";
import { fmtDate, fmtTime, type DateInput } from "@/lib/date";
import { printDoc } from "@/lib/printing/print";
import type { PrintDoc } from "@/lib/printing/render";

/** الحقول التي تقرأها الدالة فعلياً — يحقّقها `reservations.get` بنيوياً بلا تحويل. */
export interface ReservationTicketSource {
  reservationNumber: string;
  createdAt?: DateInput | null;
  expiresAt?: DateInput | null;
  status?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  branchId?: number | null;
  total?: string | number | null;
  /** بعض البنود بلا سعرٍ مرجعيّ ⇒ الإجمالي جزئيّ (يُعلن تحته «الإجمالي المسعَّر — قد يتغيّر»). */
  hasUnpriced?: boolean;
  lines: {
    productName: string;
    variantName?: string | null;
    color?: string | null;
    size?: string | null;
    unitName: string;
    quantity: number;
    quotedUnitPrice?: string | number | null;
    lineTotal?: string | number | null;
  }[];
}

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "نشط",
  PARTIALLY_FULFILLED: "نُفِّذ جزئياً",
  FULFILLED: "نُفِّذ",
  EXPIRED: "منتهٍ",
  CANCELLED: "ملغيّ",
  RELEASED: "مُحرَّر",
};

/**
 * يطبع تذكرة حجزٍ حراريّة. `printDoc` يتدرّج تلقائياً: جسر الخادم ← WebUSB ← نافذة المتصفح.
 * لا رمي إن فشلت الطابعة — `printDoc` يبتلع الخطأ (تدهور سلس)، وشاشة الحجوزات تُبقي الحوار.
 */
export function reservationToTicketDoc(res: ReservationTicketSource): PrintDoc {
  const itemBlocks = res.lines.map((l) => {
    const attrs = [l.color, l.size, l.variantName].filter(Boolean).join(" · ");
    const price = l.quotedUnitPrice != null ? fmt(l.quotedUnitPrice) : "غير مُسعَّر";
    return {
      name: l.productName + (attrs ? ` — ${attrs}` : ""),
      quantityPrice: `${l.quantity} × ${price}${l.unitName ? ` / ${l.unitName}` : ""}`,
      total: l.lineTotal != null ? fmt(l.lineTotal) : "—",
    };
  });

  const meta: string[] = [];
  const who = res.contactName?.trim() || (res.contactPhone ? `هاتف: ${res.contactPhone}` : "عميل");
  meta.push(`الزبون: ${who}`);
  if (res.contactPhone && res.contactName?.trim()) meta.push(`الهاتف: ${res.contactPhone}`);
  if (res.createdAt) meta.push(`أُنشئ: ${fmtDate(res.createdAt)} ${fmtTime(res.createdAt)}`);
  if (res.expiresAt) meta.push(`ينتهي: ${fmtDate(res.expiresAt)} ${fmtTime(res.expiresAt)}`);
  if (res.status) meta.push(`الحالة: ${STATUS_LABEL[res.status] ?? res.status}`);
  if (res.notes?.trim()) meta.push(`ملاحظات: ${res.notes.trim()}`);

  const totals: { label: string; value: string }[] = [];
  if (D(res.total).gt(0)) {
    totals.push({
      label: res.hasUnpriced ? "الإجمالي المسعَّر (جزئيّ)" : "الإجمالي المرجعيّ",
      value: `${fmt(res.total)} د.ع`,
    });
  }

  return {
    kind: "receipt",
    title: "تذكرة حجز",
    subtitle: res.reservationNumber,
    meta,
    columns: ["المنتج", "الإجمالي"],
    itemBlocks,
    totals,
    footer:
      "احتفظ بهذه التذكرة للاستلام. الأسعار مرجعيّة قد تتغيّر عند التنفيذ." +
      (res.expiresAt ? " الحجز صالح حتى تاريخ الانتهاء أعلاه." : ""),
    // QR + Code128 بالرقم — يمسحه الكاشير في محطّة الاستقبال لاستدعاء الحجز مباشرةً.
    barcodeSet: {
      barcode128: res.reservationNumber,
      qrPayload: res.reservationNumber,
      displayLabel: res.reservationNumber,
    },
  };
}

export function printReservationTicket(res: ReservationTicketSource): void {
  void printDoc(reservationToTicketDoc(res));
}

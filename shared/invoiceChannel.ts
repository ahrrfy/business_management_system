/**
 * **قناة الفاتورة** — أيّ محطّةٍ أصدرتها (١٩/٨). اشتقاقٌ لا عمود.
 *
 * بلاغ المالك: «لا تمييز بصريّ لقناة الفاتورة». والسبب أنّ `invoices.sourceType` **لا يميّز**:
 * كاشير التجزئة وكاشير الاستقبال وكاشير الطباعة يختمون ثلاثتُهم `POS`. المميّز الوحيد قائمٌ
 * في القاعدة: `shifts.shiftType` عبر `invoices.shiftId` — والـ`leftJoin(shifts)` **موجودٌ
 * أصلاً** في كل مستهلكي قائمة الفواتير (وضعه عزلُ النطاق)، فالقناة مجّانيةٌ بلا عمودٍ جديد
 * ولا هجرة ولا كاتبٍ ثانٍ ينجرف.
 *
 * والحالة الحدّية محسوبة: تسليمُ أمر شغلٍ بلا وردية استقبالٍ مفتوحة يترك `shiftId=NULL`
 * (فخّ معروف) ⇒ `sourceType='WORKORDER'` وحده يكفي لتصنيفها استقبالاً.
 */
export const INVOICE_CHANNELS = ["RETAIL", "RECEPTION", "PRINT", "STORE", "OTHER"] as const;
export type InvoiceChannel = (typeof INVOICE_CHANNELS)[number];

const LABELS: Record<InvoiceChannel, string> = {
  RETAIL: "كاشير التجزئة",
  RECEPTION: "الاستقبال",
  PRINT: "المطبعة",
  STORE: "المتجر الإلكتروني",
  OTHER: "أخرى",
};

/** اسم أيقونة `lucide-react` — الواجهة تستوردها (لا إيموجي، حارس `check:emoji`). */
const ICONS: Record<InvoiceChannel, string> = {
  RETAIL: "ShoppingCart",
  RECEPTION: "ClipboardList",
  PRINT: "Printer",
  STORE: "Globe",
  OTHER: "FileText",
};

/**
 * توكن اللون (متغيّر CSS من نظام التصميم — لا لون خام، حارس `check:colors`).
 * القناة **هويّة** لا حالة، فتُلوَّن بتوكنز محايدة الدلالة.
 */
const TONES: Record<InvoiceChannel, string> = {
  RETAIL: "chan-retail",
  RECEPTION: "chan-reception",
  PRINT: "chan-print",
  STORE: "chan-store",
  OTHER: "chan-other",
};

export interface InvoiceChannelSource {
  sourceType: string | null | undefined;
  /** `shifts.shiftType` عبر `invoices.shiftId` — NULL حين لا وردية. */
  shiftType?: string | null | undefined;
}

export function deriveInvoiceChannel(row: InvoiceChannelSource): InvoiceChannel {
  const src = row.sourceType ?? "";
  // أمر الشغل استقبالٌ دائماً — ولو خرجت فاتورته بلا وردية (shiftId=NULL).
  if (src === "WORKORDER" || src === "ORDER") return "RECEPTION";
  if (src === "ONLINE") return "STORE";
  switch (row.shiftType ?? "") {
    case "RECEPTION":
      return "RECEPTION";
    case "PRINT_SERVICES":
      return "PRINT";
    case "RETAIL":
      return "RETAIL";
    default:
      // `POS` بلا وردية معروفة: تجزئةٌ بحكم الغلبة (وردية التجزئة هي الافتراضية).
      return src === "POS" ? "RETAIL" : "OTHER";
  }
}

export function invoiceChannelLabel(c: InvoiceChannel): string {
  return LABELS[c] ?? LABELS.OTHER;
}
export function invoiceChannelIcon(c: InvoiceChannel): string {
  return ICONS[c] ?? ICONS.OTHER;
}
export function invoiceChannelTone(c: InvoiceChannel): string {
  return TONES[c] ?? TONES.OTHER;
}

/** خيارات فلتر القناة — ترتيبٌ واحد في كل شاشة. */
export function invoiceChannelOptions(): { value: InvoiceChannel; label: string }[] {
  return INVOICE_CHANNELS.map((v) => ({ value: v, label: LABELS[v] }));
}

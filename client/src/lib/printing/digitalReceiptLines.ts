/**
 * أسطر الكرت الرقميّ على الإيصال (ش١٠) — **مصدر حقيقة واحد** للمسارين:
 * الراسم الحراريّ (`receiptRaster.ts`) وقالب المتصفّح (`printTemplates.ts`).
 *
 * سببُ التوحيد (معيار خروج ش١٠): «نفس البيانات في المسارين». كتابةُ التنسيق مرّتين
 * تُنتج انحرافاً صامتاً — إيصالٌ حراريّ يعرض شيئاً ونسخةُ المتصفّح تعرض غيره.
 *
 * سياسة الخصوصية (§١٢.٢): **لا تُطبع** حصة المزوّد ولا الربح ولا رصيد المحفظة —
 * النوع نفسه لا يحمل هذه الحقول، فلا يمكن تسريبها سهواً. وأرقام الهواتف تُقنَّع وسطها
 * افتراضياً في نسخة الزبون.
 */

/** لقطة الكرت الرقميّ كما تصل من الخادم — بلا أي حقلٍ ماليّ داخليّ. */
export interface DigitalReceiptDetail {
  lineName: string;
  referenceLabel?: string | null;
  providerReference?: string | null;
  studentName?: string | null;
  studentPhone?: string | null;
  guardianPhone?: string | null;
  studentAddress?: string | null;
}

export interface DigitalLinesOptions {
  /** إخفاء وسط أرقام الهواتف عند طلب نسخة خصوصية صراحةً. */
  maskPhones?: boolean;
}

/**
 * يُقنّع وسط الرقم ويُبقي بدايته ونهايته: `+9647701234567` → `+96477•••4567`.
 * أرقامٌ قصيرة جداً تُقنَّع كلياً بدل كشفها.
 */
export function maskPhone(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const keepHead = 5;
  const keepTail = 4;
  if (s.length <= keepHead + keepTail) return "•".repeat(s.length);
  return `${s.slice(0, keepHead)}${"•".repeat(Math.max(3, s.length - keepHead - keepTail))}${s.slice(-keepTail)}`;
}

/**
 * يبني أسطر العرض لكرتٍ واحد بالترتيب المنصوص عليه في §١٢.٢.
 * يعيد أزواج (تسمية، قيمة) كي يرسمها كل مسارٍ بأسلوبه دون إعادة اشتقاق المحتوى.
 */
export function digitalDetailLines(
  d: DigitalReceiptDetail,
  opts: DigitalLinesOptions = {},
): { label: string; value: string }[] {
  const mask = opts.maskPhones === true;
  const out: { label: string; value: string }[] = [];
  const phone = (v: string | null | undefined) => (mask ? maskPhone(v) : (v ?? "").trim());

  if (d.studentName?.trim()) out.push({ label: "الطالب", value: d.studentName.trim() });
  if (d.studentPhone?.trim()) out.push({ label: "هاتف الطالب", value: phone(d.studentPhone) });
  if (d.guardianPhone?.trim()) out.push({ label: "هاتف ولي الأمر", value: phone(d.guardianPhone) });
  if (d.studentAddress?.trim()) out.push({ label: "العنوان", value: d.studentAddress.trim() });
  if (d.providerReference?.trim()) out.push({ label: d.referenceLabel?.trim() || "رقم العملية أو ID الكرت", value: d.providerReference.trim() });
  return out;
}

/** كل التفاصيل مرتّبةً بأسطرها — يستهلكها المساران كما هي. */
export function buildDigitalBlocks(
  details: DigitalReceiptDetail[] | null | undefined,
  opts: DigitalLinesOptions = {},
): { lineName: string; rows: { label: string; value: string }[] }[] {
  if (!details?.length) return [];
  return details
    .map((d) => ({ lineName: d.lineName, rows: digitalDetailLines(d, opts) }))
    .filter((b) => b.rows.length > 0);
}

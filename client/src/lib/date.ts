// تنسيق تواريخ موحّد **للعرض فقط** (ar-IQ + أرقام لاتينية) — يلغي تكرار دوال fmtDate/fmtDateTime
// المحلية المنتشرة في الصفحات (PeriodLock/YearEnd/Settings/CreditApprovals/KioskDevices/Production/
// WIPReport/CashOrphan…) ويصحّح تضارب en-GB/ar-IQ وعرض YYYY-MM-DD الخام.
// الاستعمال: import { fmtDate, fmtDateTime, fmtTime, fmtDateRange } from "@/lib/date";
// ⛔ للعرض فقط — لا تستعمله في حمولات الـAPI (التواريخ تُرسَل ISO/YYYY-MM-DD كما هي).

export type DateInput = string | number | Date | null | undefined;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** يحوّل أي مدخل إلى Date صالح، أو null. تواريخ YYYY-MM-DD البحتة تُفسَّر **محلياً**
 *  (تجنّب انزياح يوم بسبب UTC مع توقيت العراق +3). */
export function toDate(v: DateInput): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** تاريخ فقط: «21/06/2026». فارغ/غير صالح ⇒ «—». */
export function fmtDate(v: DateInput): string {
  const d = toDate(v);
  if (!d) return "—";
  // نبني النص رقمياً بدلاً من Intl: تنسيق ar-IQ يضيف محارف اتجاه مخفية
  // وعلامة «م»، فتتفكك التواريخ داخل خلايا LTR وتظهر مقتطعة/مقلوبة.
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** تاريخ ووقت ثابت الاتجاه بنظام 24 ساعة: «21/06/2026، 14:30». فارغ/غير صالح ⇒ «—». */
export function fmtDateTime(v: DateInput): string {
  const d = toDate(v);
  if (!d) return "—";
  return `${fmtDate(d)}، ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** وقت فقط بنظام 24 ساعة: «14:30». فارغ/غير صالح ⇒ «—». */
export function fmtTime(v: DateInput): string {
  const d = toDate(v);
  if (!d) return "—";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** مدى تاريخين: «21/06/2026 — 30/06/2026». كلاهما فارغ ⇒ «—». */
export function fmtDateRange(from: DateInput, to: DateInput): string {
  const a = fmtDate(from);
  const b = fmtDate(to);
  if (a === "—" && b === "—") return "—";
  return `${a} — ${b}`;
}

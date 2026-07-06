/**
 * variants.ts — منطق نقيّ لشاشة «إضافة منتج بمتغيّرات».
 *
 * كل دالة هنا خالصة (بلا DOM/شبكة) وقابلة للاختبار: أدوات EAN-13، اشتقاق SKU،
 * حالة الباركود اللحظية، وحساب الهامش (عرضيّ فقط — ليس قيمة مالية تُخزَّن).
 * المكوّنات البصرية تستوردها؛ هكذا يبقى المنطق مفصولاً عن العرض ومضموناً باختبار.
 */

/* ============================ EAN-13 ============================ */

/** خانة التحقّق القياسية لـEAN-13 (وزن ١ للمواضع الفردية، ٣ للزوجية). */
export function ean13CheckDigit(d12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** هل السلسلة باركود EAN-13 صحيح (١٣ رقماً + خانة تحقّق سليمة)؟ */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code || "")) return false;
  return +code[12] === ean13CheckDigit(code.slice(0, 12));
}

/** يولّد EAN-13 صالحاً ببادئة معطاة (افتراضي 621 — مجال داخليّ). */
export function genEan13(prefix = "621"): string {
  let body = (prefix || "").replace(/\D/g, "");
  while (body.length < 12) body += Math.floor(Math.random() * 10);
  body = body.slice(0, 12);
  return body + ean13CheckDigit(body);
}

/**
 * يُرجِع الباركود التالي تصاعدياً (للترقيم التسلسلي) مع إعادة حساب خانة التحقّق.
 * جسم EAN-13 من ١٢ رقماً (أقصاه ~1e12) أصغر بكثير من `Number.MAX_SAFE_INTEGER` (~9e15)
 * فالحساب بـNumber آمن ويُغني عن BigInt (غير المتاح على هدف TS الحالي).
 */
export function incEan13(code: string): string {
  const base = /^\d{13}$/.test(code || "") ? code.slice(0, 12) : "621000000000";
  const next = String(Number(base) + 1).padStart(12, "0").slice(-12);
  return next + ean13CheckDigit(next);
}

/* ============================ اشتقاق SKU ============================ */

/** `<baseSku>-<colorCode>-<size>` (مثال: PG-G2 + أزرق + 0.7 ⇒ PG-G2-BLU-0.7). */
export function deriveSku(baseSku: string, color?: string, size?: string): string {
  const cc =
    COLOR_CODE[(color ?? "").trim()] ||
    (color ?? "").trim().slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const sz = (size ?? "").trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
  return [baseSku || "PR", cc, sz].filter(Boolean).join("-");
}

/* ============================ حالة الباركود اللحظية ============================ */

export type BarcodeState = "empty" | "valid" | "invalid" | "dupInForm" | "takenInDb";

/**
 * يصنّف خلية باركود: فارغ ⇐ محجوز في القاعدة ⇐ مكرّر داخل النموذج ⇐ خانة تحقّق خاطئة ⇐ صالح.
 * الترتيب مقصود: «محجوز/مكرّر» أهمّ من «خانة تحقّق» لأنهما يمنعان الحفظ فعلاً.
 */
export function barcodeState(
  code: string,
  opts: { countInForm: number; takenInDb: boolean }
): BarcodeState {
  if (!code) return "empty";
  if (opts.takenInDb) return "takenInDb";
  if (opts.countInForm > 1) return "dupInForm";
  if (!isValidEan13(code)) return "invalid";
  return "valid";
}

/* ============================ الهامش (عرضيّ فقط) ============================ */

/**
 * هامش الربح كنسبة مئوية — **للعرض فقط** (شارة بصرية، لا يُخزَّن ولا يدخل الدفتر)،
 * فالتحويل العدديّ هنا لا يخضع لقاعدة الأموال (decimal.js) المخصَّصة للقيم المُخزَّنة.
 * يعيد null إن لم يكن سعر البيع موجباً.
 */
export function marginPercent(
  cost: number | string,
  sell: number | string
): { pct: number; loss: boolean } | null {
  const c = toNum(cost);
  const s = toNum(sell);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(c) || c < 0) return null;
  return { pct: Math.round(((s - c) / s) * 100), loss: s < c };
}

function toNum(v: number | string): number {
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[^\d.-]/g, "");
  return cleaned ? Number(cleaned) : NaN;
}

/* ============================ أدوات عرض عربية ============================ */

const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

/** يحوّل الأرقام اللاتينية في السلسلة إلى عربية (للعرض). */
export function toArabicDigits(n: string | number): string {
  return String(n).replace(/[0-9]/g, (d) => AR_DIGITS[+d]);
}

/** يُبقي الأرقام فقط (لحقول الكمية/المخزون). */
export function onlyDigits(s: string): string {
  return String(s).replace(/[^\d]/g, "");
}

/** إجمالي رصيد المتغيّر عبر كل الفروع (بالوحدة الأساس). */
export function variantStockTotal(stockByBranch: Record<number, string>): number {
  return Object.values(stockByBranch || {}).reduce((sum, q) => sum + (parseInt(q, 10) || 0), 0);
}

/* ============================ استيراد/لصق (ذهاب-وإياب مع التصدير) ============================ */

/** صفّ مُحلَّل من لصق Excel — بنفس ترتيب أعمدة التصدير (لون، قياس، SKU، باركود/وحدة…، مخزون). */
export interface ParsedVariantRow {
  color: string;
  size: string;
  sku: string;
  /** باركود لكل وحدة، بطول عدد الوحدات في القالب. */
  barcodes: string[];
  stock: string;
}

/**
 * يحلّل نصّاً ملصوقاً (صفوف بأسطر، أعمدة مفصولة بـTab أو فاصلة) إلى صفوف متغيّرات.
 * الترتيب = ترتيب التصدير: اللون، القياس، SKU، ثم باركود لكل وحدة، ثم المخزون.
 * يتجاهل الأسطر الفارغة وما لا لون له (دالة نقية قابلة للاختبار).
 */
export function parseVariantPaste(text: string, unitCount: number): ParsedVariantRow[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const c = line.split(/\t|,/).map((x) => x.trim());
      return {
        color: c[0] || "",
        size: c[1] || "",
        sku: c[2] || "",
        barcodes: Array.from({ length: unitCount }, (_, i) => c[3 + i] || ""),
        stock: c[3 + unitCount] || "0",
      };
    })
    .filter((r) => r.color);
}

/** قيمة موجبة صحيحة من نصّ حقل (مخزون/حدود): يطرح غير الأرقام ويقصّ للصحيح غير السالب. */
export function clampInt(s: string): number {
  return Math.max(0, Math.trunc(Number(onlyDigits(s) || "0")));
}

/* ============================ خرائط الألوان ============================ */

export const COLOR_HEX: Record<string, string> = {
  "أزرق": "#2563eb", "أسود": "#1f2937", "أحمر": "#dc2626", "أخضر": "#16a34a",
  "أصفر": "#eab308", "أبيض": "#f8fafc", "برتقالي": "#ea580c", "بنفسجي": "#7c3aed",
  "وردي": "#ec4899", "رمادي": "#6b7280", "بني": "#92400e", "ذهبي": "#d4af37",
  "فضي": "#cbd5e1", "سماوي": "#06b6d4", "كحلي": "#1e3a8a", "نبيتي": "#7f1d1d",
};

export const COLOR_CODE: Record<string, string> = {
  "أزرق": "BLU", "أسود": "BLK", "أحمر": "RED", "أخضر": "GRN", "أصفر": "YEL",
  "أبيض": "WHT", "برتقالي": "ORG", "بنفسجي": "PUR", "وردي": "PNK", "رمادي": "GRY",
  "بني": "BRN", "ذهبي": "GLD", "فضي": "SLV", "سماوي": "CYN", "كحلي": "NVY", "نبيتي": "MRN",
};

/** ألوان شائعة تُعرض كاقتراحات سريعة في مُدخل الألوان. */
export const COLOR_PRESETS = ["أزرق", "أسود", "أحمر", "أخضر", "أصفر", "أبيض", "رمادي", "كحلي"];

/* ============================ نماذج الحالة (الواجهة) ============================ */

/** وحدة في القالب المشترك (قطعة/درزن/كرتون) — القيم مشتركة عبر كل المتغيّرات. */
export interface ClientUnit {
  id: number;
  name: string;
  factor: string;
  isBase: boolean;
  retail: string;
  wholesale: string;
  /** سعر الحكومي (GOVERNMENT) — اختياري؛ يجب إعادة إرساله عند التعديل وإلّا حُذف (upsert يمسح ثم يُدرِج). */
  government?: string;
}

/** متغيّر واحد = منتج مخزنيّ مستقل (لون/قياس) بباركود لكل وحدة ورصيد لكل فرع. */
export interface ClientVariant {
  id: string;
  color: string;
  size: string;
  sku: string;
  /** باركود مستقل لكل وحدة (مفتاحه `ClientUnit.id`). */
  unitBarcodes: Record<number, string>;
  /** رصيد افتتاحي لكل فرع (مفتاحه `branchId`). */
  stockByBranch: Record<number, string>;
  minStock: string;
  reorderPoint: string;
  /** استثناء سعر خاص لهذا اللون (تكلفة/بيع) بدل التسعير المشترك. */
  priceOverride: boolean;
  costPrice: string;
  retail: string;
  isActive: boolean;
  image: string | null;
}

/**
 * variants.ts — منطق نقيّ لشاشة «إضافة منتج بمتغيّرات».
 *
 * كل دالة هنا خالصة (بلا DOM/شبكة) وقابلة للاختبار: أدوات EAN-13، اشتقاق SKU،
 * حالة الباركود اللحظية، وحساب الهامش (عرضيّ فقط — ليس قيمة مالية تُخزَّن).
 * المكوّنات البصرية تستوردها؛ هكذا يبقى المنطق مفصولاً عن العرض ومضموناً باختبار.
 */

import { colorSkuCode, skuToken } from "@shared/colorBank";
import { detectSymbology, type SymbologyResult, type SymbologyKind } from "@shared/barcodeSymbology";

export { detectSymbology, type SymbologyResult, type SymbologyKind };

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

/**
 * يولّد EAN-13 صالحاً ببادئة معطاة.
 * الافتراضي "200" = النطاق المعياريّ GS1 (20-29) المخصَّص للاستخدام الداخلي داخل المؤسّسة —
 * صفر تصادم مع أيّ مصنِّع مسجَّل في العالم (قرار المالك ٣٠/٧: استبدلنا 621 لأنها فعلياً نطاق GS1-Egypt).
 */
export function genEan13(prefix = "200"): string {
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
  // بادئة الاحتياط "200000000000" في النطاق المعياريّ GS1 الداخلي (20-29).
  const base = /^\d{13}$/.test(code || "") ? code.slice(0, 12) : "200000000000";
  const next = String(Number(base) + 1).padStart(12, "0").slice(-12);
  return next + ean13CheckDigit(next);
}

/* ============================ اشتقاق SKU ============================ */

/**
 * `<baseSku>-<colorCode>-<size>` (مثال: PG-G2 + أزرق + 0.7 ⇒ PG-G2-BLU-0.7).
 * كود اللون: الخريطة القصيرة المنسّقة (BLU/RED/GLD…) أولاً، وإلّا `colorSkuCode` من بنك الألوان —
 * وهو **لا يعود فارغاً أبداً** (يشتقّ من مرادف إنكليزيّ أو رمزٍ ثابت)، فيمنع تصادم SKU بين ألوان
 * عربية خارج الخريطة (كان كلّها يسقط لكودٍ فارغ ⇒ «SKU مكرّر بين المتغيّرات» يمنع الحفظ).
 */
export function deriveSku(baseSku: string, color?: string, size?: string): string {
  const c = (color ?? "").trim();
  const cc = COLOR_CODE[c] || colorSkuCode(c);
  const sz = sizeSkuCode(size);
  return [baseSku || "PR", cc, sz].filter(Boolean).join("-");
}

/**
 * رمز القياس للـSKU: الحروف اللاتينية والأرقام والنقطة كما هي (M/XL/0.7)، وإن كان القياس غير لاتينيّ
 * (صغير/كبير أو أرقام عربية ٣٨/٤٠) يعطي رمزاً ثابتاً غير فارغ («S» + رمز) — وإلّا لَسقط لفراغٍ فيتصادم
 * قياسان عربيّان للون واحد على نفس الـSKU («PR-RED») فيُمنع الحفظ (نفس صنف علّة كود اللون).
 */
function sizeSkuCode(size?: string): string {
  const raw = (size ?? "").trim();
  if (!raw) return "";
  const latin = raw.toUpperCase().replace(/[^A-Z0-9.]/g, "");
  return latin || "S" + skuToken(raw);
}

/* ============================ حالة الباركود اللحظية ============================ */

export type BarcodeState = "empty" | "valid" | "invalid" | "dupInForm" | "takenInDb";

/**
 * يصنّف خلية باركود: فارغ ⇐ محجوز في القاعدة ⇐ مكرّر داخل النموذج ⇐ خانة تحقّق خاطئة ⇐ صالح.
 * الترتيب مقصود: «محجوز/مكرّر» أهمّ من «خانة تحقّق» لأنهما يمنعان الحفظ فعلاً.
 *
 * ⚠️ توافق للخلف: هذه الدالة تفحص EAN-13 حصراً. الشاشات الجديدة تستعمل `barcodeInfo` أدناه
 * التي تكشف كل الترميزات (Code128/UPC-A/EAN-8/ITF-14/ISBN/GS1-128…) وترسل رسالة صادقة.
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

/* ============================ معلومات الباركود مع نوع الترميز ============================ */

/**
 * نتيجة شاملة لخانة الباركود: تُدمج حالة التفرّد (محجوز/مكرّر) مع نوع الترميز المكتشف.
 *
 * لماذا فُصلت عن `barcodeState`:
 *   `barcodeState` القديمة تفترض EAN-13 حصراً ⇒ رسالة «invalid» مضلّلة لأنواع أخرى صحيحة
 *   (Code128 داخلي، UPC-A ١٢ رقماً، EAN-8، ITF-14…). هذه الدالة تكشف النوع الفعلي
 *   وتعطي رسالة صادقة + بادج للعرض. الشاشات الحديثة تستعملها بدلاً من `barcodeState`.
 */
export interface BarcodeInfo {
  /** حالة التفرّد (تسبق نوع الترميز في الأهمّية — المكرّر يمنع الحفظ). */
  state: BarcodeState;
  /** نتيجة كشف نوع الترميز — تعطي الـkind واللابل والصلاحية والسبب. */
  symbology: SymbologyResult;
  /** رسالة صادقة للعرض: تصف الحالة بدقّة بلا تخويف كاذب. */
  message: string;
  /** درجة الخطورة للعرض: `blocker` يمنع الحفظ، `warn` يعرض تحذيراً، `info` معلومة، `ok` صالح. */
  severity: "ok" | "info" | "warn" | "blocker";
}

/**
 * تحليل شامل لخانة باركود: يجمع حالة التفرّد مع كشف نوع الترميز، ويعطي رسالة صادقة.
 *
 * قواعد الشدّة:
 *   `blocker` (يمنع الحفظ): محجوز في DB، أو مكرّر داخل النموذج.
 *   `warn`  (تحذير غير مانع): كشف نوع معياريّ لكن خانة التحقّق فاسدة (يُقبل بقرار المالك).
 *   `info`  (تنبيه معلوماتي): نوع صحيح غير EAN-13 (Code128 / UPC-A / ISBN / داخلي…).
 *   `ok`    (صالح تماماً): EAN-13 معياريّ صحيح.
 */
export function barcodeInfo(
  code: string,
  opts: { countInForm: number; takenInDb: boolean }
): BarcodeInfo {
  const symbology = detectSymbology(code);
  const state = barcodeState(code, opts);

  // (١) حالات التفرّد تسبق كلّ شيء — بلا اعتبار للترميز.
  if (state === "empty") {
    return { state, symbology, message: "", severity: "info" };
  }
  if (state === "takenInDb") {
    return { state, symbology, message: "باركود مُستخدَم في منتج آخر — غيّره قبل الحفظ.", severity: "blocker" };
  }
  if (state === "dupInForm") {
    return { state, symbology, message: "باركود مكرّر داخل النموذج.", severity: "blocker" };
  }

  // (٢) صادق التشخيص بحسب النوع المكتشف.
  switch (symbology.kind) {
    case "EAN-13":
      return symbology.valid
        ? { state: "valid", symbology, message: "باركود EAN-13 صالح.", severity: "ok" }
        : {
            state,
            symbology,
            message: "خانة تحقّق EAN-13 لا تطابق — يُقبل مع ذلك (ترميز غير قياسيّ).",
            severity: "warn",
          };
    case "EAN-13-INTERNAL":
      return { state: "valid", symbology, message: "باركود داخليّ صالح (نطاق EAN-13 المخصَّص للاستخدام الداخلي).", severity: "ok" };
    case "ISBN-13":
      return { state: "valid", symbology, message: "رقم ISBN صالح — منتج نشر (كتاب).", severity: "ok" };
    case "UPC-A":
      return symbology.valid
        ? { state: "valid", symbology, message: "باركود UPC-A صالح (١٢ رقماً — قياسيّ في الأسواق الأمريكية).", severity: "info" }
        : { state, symbology, message: "UPC-A: خانة التحقّق لا تطابق — يُقبل مع ذلك.", severity: "warn" };
    case "EAN-8":
      return symbology.valid
        ? { state: "valid", symbology, message: "باركود EAN-8 صالح (٨ أرقام — للمنتجات الصغيرة).", severity: "info" }
        : { state, symbology, message: "EAN-8: خانة التحقّق لا تطابق — يُقبل مع ذلك.", severity: "warn" };
    case "ITF-14":
      return symbology.valid
        ? { state: "valid", symbology, message: "باركود ITF-14 صالح (كرتون شحن).", severity: "info" }
        : { state, symbology, message: "ITF-14: خانة التحقّق لا تطابق — يُقبل مع ذلك.", severity: "warn" };
    case "INTERNAL":
      return { state: "valid", symbology, message: "رمز داخليّ (بادئة ALR) — صالح.", severity: "info" };
    case "GS1-128":
      return { state: "valid", symbology, message: "GS1-128 — سيُطبع بترميزه القياسيّ.", severity: "info" };
    case "Code39":
      return { state: "valid", symbology, message: "Code39 — سيُطبع بترميزه.", severity: "info" };
    case "Code128":
      return { state: "valid", symbology, message: "Code128 — سيُطبع بترميز يتّسع لكلّ ASCII.", severity: "info" };
    case "unknown":
      return { state: "invalid", symbology, message: "نصّ يحتوي محارف غير قابلة للطباعة — لا يُطبع.", severity: "warn" };
    default:
      return { state, symbology, message: "", severity: "info" };
  }
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

// اللون الحقيقي لاسم اللون يأتي من بنك الألوان المشترك (≈١٥٢ لوناً + تطبيع + معدِّلات درجة فاتح/غامق).
// مصدر حقيقة واحد للعميل والخادم؛ ColorDot يستعمل resolveColorHex للتمييز التلقائي، وderiveSku يستعمل
// colorSkuCode (مستورَد أعلى الملف) لاشتقاق رمز لاتينيّ غير فارغ لأيّ اسم لون (يمنع تصادم SKU).
export { resolveColorHex, normalizeColorName, normalizeHex, colorSkuCode } from "@shared/colorBank";

export const COLOR_CODE: Record<string, string> = {
  "أزرق": "BLU", "أسود": "BLK", "أحمر": "RED", "أخضر": "GRN", "أصفر": "YEL",
  "أبيض": "WHT", "برتقالي": "ORG", "بنفسجي": "PUR", "وردي": "PNK", "رمادي": "GRY",
  "بني": "BRN", "ذهبي": "GLD", "فضي": "SLV", "سماوي": "CYN", "كحلي": "NVY", "نبيتي": "MRN",
};

/** ألوان شائعة تُعرض كاقتراحات سريعة في مُدخل الألوان. */
export const COLOR_PRESETS = ["أزرق", "أحمر", "أخضر", "أصفر", "أسود", "أبيض", "رمادي", "كحلي", "بني", "برتقالي", "بنفسجي", "وردي"];

/**
 * يزامن رقائق مصفوفة الألوان عند إعادة تسمية لون متغيّر **بالصفّ** (تحرير مباشر): يُضيف الاسم الجديد
 * (إن كان غير فارغ وغائباً) ويحذف القديم **فقط إن لم يعُد أيّ متغيّر يستعمله** — فلا يمسّ ألوان المصفوفة
 * التي لم تُولَّد بعد، ويُبقي «ولّد المتغيّرات» متّسقاً بعد التحرير المباشر (يمنع فقدان اللون المُعاد تسميته
 * عند إعادة التوليد). `variantColors` = ألوان المتغيّرات الحالية **بعد** تطبيق إعادة التسمية.
 */
export function syncColorChipsOnRename(
  chips: string[],
  oldColor: string,
  newColor: string,
  variantColors: string[]
): string[] {
  const nc = newColor.trim();
  let out = nc && !chips.includes(nc) ? [...chips, nc] : chips;
  if (oldColor && !variantColors.includes(oldColor)) out = out.filter((c) => c !== oldColor);
  return out;
}

/* ============================ نماذج الحالة (الواجهة) ============================ */

/** وحدة في القالب المشترك (قطعة/درزن/كرتون) — القيم مشتركة عبر كل المتغيّرات. */
export interface ClientUnit {
  id: number;
  name: string;
  factor: string;
  isBase: boolean;
  sellInStore: boolean;
  retail: string;
  wholesale: string;
  /** سعر الحكومي (GOVERNMENT) — اختياري؛ يجب إعادة إرساله عند التعديل وإلّا حُذف (upsert يمسح ثم يُدرِج). */
  government?: string;
}

/** متغيّر واحد = منتج مخزنيّ مستقل (لون/قياس) بباركود لكل وحدة ورصيد لكل فرع. */
export interface ClientVariant {
  id: string;
  /** نوع المتغيّر (م٣): "VARIANT" تنويعة لون/قياس، "ALTERNATIVE" بديلٌ مستقلّ يلزمه اسمٌ وباركود. */
  variantKind?: "VARIANT" | "ALTERNATIVE";
  /** اسم البديل (للبدائل) — يظهر في العرض الموحّد. */
  variantName?: string | null;
  color: string;
  /**
   * لون العرض الحقيقي «#RRGGBB» — اختيار صريح من منتقي اللون. إن غاب (null/undefined)
   * يُستنتَج تلقائياً من اسم اللون عبر بنك الألوان (`@shared/colorBank`). مصدر التمييز الحقيقي.
   */
  colorHex?: string | null;
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
  /**
   * باركودات بديلة محلّية لكل وحدة (مفتاحه `ClientUnit.id`) — نفس السلعة/التكلفة/السعر/المخزون
   * بعدّة باركودات. تُجمَع في الواجهة وتُدرَج ذرّياً مع المنتج عبر `createProduct` (وضع local،
   * لا تعبر الشبكة قبل الحفظ). اختياريّ: شاشات لا تُفعّل البدائل (كالتعديل) تتركه فارغاً.
   */
  unitBarcodeAliases?: Record<number, Array<{ barcode: string; note?: string | null }>>;
}

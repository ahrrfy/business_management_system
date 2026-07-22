// محرّك تسعير الطباعة الرقمية (Digital) — ثوابت وأنواع مشتركة (العميل + الخادم).
//
// ⚠️ المطبعة **ديجيتال لا أوفست** (قرار المالك ٢٢/٧): لا ألواح/زنكات، لا «فرخ»، لا تشغيل
// بالألف. الوحدة الأساسية = **الوجه المطبوع (impression)**، و**سعر الوجه يشمل الورق** —
// سعرٌ واحدٌ لكل (مقاس ISO × نمط ملوّن/أبيض-أسود) يغطّي الورق + الطباعة معاً. الطباعة
// العريضة (فلكس) بالمتر المربّع. الأرقام كلّها **إعداداتٌ يضبطها المالك** (لا ثابتة هنا).
//
// هذا الملف مصدر الحقيقة الوحيد لقائمة المقاسات والإينمز وأنواع مدخل/مخرج الحاسبة، كي لا
// تنجرف الواجهة عن الخادم. الحساب نفسه (بـdecimal.js) في server/services/printPricing.

/** رموز مقاسات ISO 216 — السلسلتان A و B كاملتين (A0–A10، B0–B10). تُبذَر كلها؛ المالك
 *  يُسعّر ما يستعمله ويترك الباقي بلا سعر (لا يظهر في الحاسبة). ⚠️ هذه القائمة تُطابق حرفياً
 *  قيم إينم `paperSize` في drizzle/schema.ts (٢٢ رمزاً ثابتاً — معيار لا يتغيّر). */
export const PAPER_SIZE_CODES = [
  "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10",
  "B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10",
] as const;

export type PaperSizeCode = (typeof PAPER_SIZE_CODES)[number];

/** أبعاد كل مقاس بالمليمتر (عرض × ارتفاع) — للعرض فقط (بطاقة «A4 = ٢١٠×٢٩٧مم»). لا يدخل في
 *  حساب تكلفة الطباعة الصغيرة (تُحسب بالوجه لا بالمساحة). */
export interface PaperSizeInfo {
  code: PaperSizeCode;
  series: "A" | "B";
  widthMm: number;
  heightMm: number;
  /** تسمية العرض «A4 · ٢١٠×٢٩٧مم». */
  label: string;
}

const DIMS: Record<PaperSizeCode, [number, number]> = {
  A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297],
  A5: [148, 210], A6: [105, 148], A7: [74, 105], A8: [52, 74], A9: [37, 52], A10: [26, 37],
  B0: [1000, 1414], B1: [707, 1000], B2: [500, 707], B3: [353, 500], B4: [250, 353],
  B5: [176, 250], B6: [125, 176], B7: [88, 125], B8: [62, 88], B9: [44, 62], B10: [31, 44],
};

export const PAPER_SIZES: readonly PaperSizeInfo[] = PAPER_SIZE_CODES.map((code) => {
  const [widthMm, heightMm] = DIMS[code];
  return { code, series: code[0] as "A" | "B", widthMm, heightMm, label: `${code} · ${widthMm}×${heightMm}مم` };
});

/** نمط الطباعة — يحدّد سعر الوجه (ملوّن أغلى من الأبيض-أسود عادةً). */
export const COLOR_MODES = ["COLOR", "BW"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export const COLOR_MODE_AR: Record<ColorMode, string> = {
  COLOR: "ملوّن",
  BW: "أبيض وأسود",
};

/** وحدة رسم الورق المميّز الاختياري: لكل وجه مطبوع، أو لكل ورقة فيزيائية (وجهان = ورقة). */
export const PAPER_UPCHARGE_UNITS = ["PER_FACE", "PER_SHEET"] as const;
export type PaperUpchargeUnit = (typeof PAPER_UPCHARGE_UNITS)[number];
export const PAPER_UPCHARGE_UNIT_AR: Record<PaperUpchargeUnit, string> = {
  PER_FACE: "لكل وجه",
  PER_SHEET: "لكل ورقة",
};

/** وحدة خيار التشطيب: لكل نسخة (× عدد النسخ/الكمية)، أو لكل شغلة (مرّة واحدة للطلب كلّه). */
export const FINISHING_UNITS = ["PER_COPY", "PER_JOB"] as const;
export type FinishingUnit = (typeof FINISHING_UNITS)[number];
export const FINISHING_UNIT_AR: Record<FinishingUnit, string> = {
  PER_COPY: "لكل نسخة",
  PER_JOB: "لكل شغلة",
};

/** وضع التسعير العامّ (إعداد المدير):
 *  - MARGIN: السعر المقترح = الكلفة × (١ + هامش٪) — الأسعار المضبوطة تكاليف، يُضاف الهامش.
 *  - DIRECT: الأسعار المضبوطة **هي** سعر البيع (بيعٌ مباشر) — السعر المقترح = الكلفة، بلا هامش. */
export const PRICING_MODES = ["MARGIN", "DIRECT"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export const PRICING_MODE_AR: Record<PricingMode, string> = {
  MARGIN: "هامش ربح على الكلفة",
  DIRECT: "سعر بيع مباشر (الأسعار نهائية)",
};

/** فئة الطلب في الحاسبة: صغير المقاس (بالوجه) أو عريض/فلكس (بالمتر المربّع). */
export type PrintCategory = "SMALL" | "WIDE";

// ─── مدخلات الحاسبة ─────────────────────────────────────────────────────────

/** مدخل الطباعة صغيرة المقاس (بالوجه). */
export interface SmallFormatEstimateInput {
  category: "SMALL";
  paperSize: PaperSizeCode;
  colorMode: ColorMode;
  /** الأوجه لكل ورقة: ١ (وجه واحد) أو ٢ (وجهان). */
  sides: 1 | 2;
  /** عدد النسخ (صحيح ≥ ١). */
  copies: number;
  /** الصفحات (الأوراق) لكل نسخة (صحيح ≥ ١). */
  pagesPerCopy: number;
  /** ورق مميّز اختياري (id من printPaperUpcharges) — زيادةٌ فوق سعر الوجه القياسيّ. */
  paperUpchargeId?: number | null;
  /** خيارات التشطيب المختارة (ids من printFinishingOptions). */
  finishingIds?: number[];
}

/** مدخل الطباعة العريضة (فلكس — بالمتر المربّع). */
export interface WideFormatEstimateInput {
  category: "WIDE";
  /** نوع الوسيط (id من printWideMedia). */
  mediaId: number;
  /** العرض بالمتر (سلسلة عشرية ≤ ٣ منازل). */
  width: string;
  /** الارتفاع بالمتر (سلسلة عشرية ≤ ٣ منازل). */
  height: string;
  /** الكمية (عدد القطع، صحيح ≥ ١). */
  quantity: number;
  finishingIds?: number[];
}

/** حقول مشتركة تُضاف لأي مدخل: رسم التجهيز الاختياريّ + تجاوز الهامش الحيّ. */
export interface EstimateCommonInput {
  /** هل يُضاف رسم التجهيز/التصميم من الإعدادات (افتراضياً true). */
  applySetupFee?: boolean;
  /** تجاوز نسبة الهامش حيّاً (وضع MARGIN فقط) — null/غياب = هامش الإعدادات الافتراضيّ. */
  marginPercentOverride?: string | null;
}

export type PrintEstimateInput = (SmallFormatEstimateInput | WideFormatEstimateInput) & EstimateCommonInput;

// ─── مخرجات الحاسبة ─────────────────────────────────────────────────────────

/** سطر في تفصيل الكلفة (مبلغ نصّاً — decimal مُسلسَل). */
export interface CostLine {
  key: string;
  label: string;
  /** المبلغ نصّاً (٢ منزلة). */
  amount: string;
  /** تفصيل الحساب (مثل «٢٠٠ وجه × ٥٠»). */
  detail?: string;
}

export interface PrintEstimateResult {
  category: PrintCategory;
  /** صغير: عدد الأوجه المطبوعة = النسخ × الصفحات × الأوجه. */
  faces?: number;
  /** صغير: عدد الأوراق الفيزيائية = النسخ × الصفحات. */
  sheets?: number;
  /** عريض: المساحة بالمتر المربّع (نصّاً، ٣ منازل). */
  areaSqm?: string;
  /** الوحدات لحساب سعر الوحدة: النسخ (صغير) أو الكمية (عريض). */
  units: number;
  /** تفصيل الكلفة سطراً سطراً. */
  lines: CostLine[];
  /** إجمالي الكلفة (مجموع الأسطر). */
  totalCost: string;
  /** وضع التسعير المطبّق. */
  pricingMode: PricingMode;
  /** نسبة الهامش المطبّقة فعلياً (٪ نصّاً) — صفر في وضع DIRECT. */
  marginPercent: string;
  /** السعر المقترح النهائي. */
  suggestedPrice: string;
  /** سعر الوحدة الواحدة = المقترح ÷ الوحدات. */
  unitPrice: string;
}

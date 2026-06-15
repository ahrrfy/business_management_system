// إعداد مقاس ملصق الباركود — **مشترك عبر كل شاشات الطباعة** (صفحة الملصقات + قائمة المنتجات
// + نافذة المتغيّرات)، محفوظ محلياً. مصدر حقيقة واحد للمقاس ⇒ نختاره مرّة في صفحة الملصقات
// ويُطبَّق في كل مكان.
//
// الطابعة HPRT LPQ58: عرض الوسائط الأقصى 58مم، وعرض الطباعة الفعّال ~48مم
// (384 نقطة @ 203dpi — قياسيّ لطابعات 58مم). لذا نقيّد عرض النقطية بـ384 ولو كان الملصق أعرض.

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}

/** عرض الوسائط الأقصى للطابعة (مم). */
export const MAX_LABEL_WIDTH_MM = 58;
/** كثافة الطباعة: 203dpi ≈ 8 نقاط/مم. */
export const PRINT_DPMM = 8;
/** عرض الطباعة الفعّال لطابعة 58مم بالنقاط (قياسيّ). */
export const MAX_PRINT_WIDTH_DOTS = 384;

/** مقاسات جاهزة تقع ضمن حدود الطابعة (≤58مم). */
export const LABEL_PRESETS: { id: string; label: string; size: LabelSize }[] = [
  { id: "50x30", label: "50 × 30 مم", size: { widthMm: 50, heightMm: 30 } },
  { id: "40x30", label: "40 × 30 مم", size: { widthMm: 40, heightMm: 30 } },
  { id: "40x25", label: "40 × 25 مم", size: { widthMm: 40, heightMm: 25 } },
  { id: "58x40", label: "58 × 40 مم", size: { widthMm: 58, heightMm: 40 } },
  { id: "58x30", label: "58 × 30 مم", size: { widthMm: 58, heightMm: 30 } },
];

export const DEFAULT_LABEL_SIZE: LabelSize = { widthMm: 50, heightMm: 30 };
const LS_KEY = "labelSize";

/** يحصُر المقاس ضمن حدود معقولة (وضمن عرض الطابعة). */
export function clampLabelSize(s: LabelSize): LabelSize {
  const widthMm = Math.min(Math.max(Math.round(s.widthMm), 20), MAX_LABEL_WIDTH_MM);
  const heightMm = Math.min(Math.max(Math.round(s.heightMm), 15), 120);
  return { widthMm, heightMm };
}

/** المقاس المحفوظ (أو الافتراضي). يُستعمل افتراضياً في كل مسارات الطباعة. */
export function getLabelSize(): LabelSize {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.widthMm === "number" && typeof p?.heightMm === "number") return clampLabelSize(p);
    }
  } catch {
    /* localStorage غير متاح ⇒ الافتراضي */
  }
  return DEFAULT_LABEL_SIZE;
}

/** يحفظ المقاس (بعد الحصر) ويعيد القيمة المحفوظة فعلاً. */
export function setLabelSize(s: LabelSize): LabelSize {
  const c = clampLabelSize(s);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch {
    /* تجاهل */
  }
  return c;
}

/** هل المقاس يطابق أحد المقاسات الجاهزة؟ (يعيد معرّفه أو "custom"). */
export function presetIdFor(s: LabelSize): string {
  const hit = LABEL_PRESETS.find((p) => p.size.widthMm === s.widthMm && p.size.heightMm === s.heightMm);
  return hit ? hit.id : "custom";
}

/** عرض الطباعة بالنقاط (نقطية حرارية): مقيّد بعرض الطابعة الفعّال ومقرَّب لمضاعف 8. */
export function labelWidthDots(widthMm: number): number {
  const raw = Math.min(widthMm, MAX_LABEL_WIDTH_MM) * PRINT_DPMM;
  const capped = Math.min(raw, MAX_PRINT_WIDTH_DOTS);
  return Math.max(8, Math.floor(capped / 8) * 8);
}

/** ارتفاع الملصق بالنقاط (يحدّد خطوة تقدّم الورق بين الملصقات في وضع النقطية). */
export function labelHeightDots(heightMm: number): number {
  return Math.max(8, Math.round(heightMm * PRINT_DPMM));
}

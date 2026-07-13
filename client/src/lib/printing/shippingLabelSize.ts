/**
 * قياس «ملصق الشحن» (مم) — مصدر حقيقة واحد لكل شاشات الطباعة (طلبات المتجر/التوصيل/أوامر الشغل).
 * منفصل عن `labelSize.ts` (ملصقات الباركود 58مم) لأن الطابعة والمقاسات والاستعمال مختلفة كلياً.
 *
 * الافتراضي ٨٠×١٢٠مم (قرار المالك ١٣/٧)، مع قوالب شائعة وقياس مخصّص «عرض×ارتفاع»
 * يُحفَظ في localStorage فيسري على كل الشاشات معاً.
 */
export interface ShippingLabelSize {
  widthMm: number;
  heightMm: number;
}

export const DEFAULT_SHIPPING_LABEL_SIZE: ShippingLabelSize = { widthMm: 80, heightMm: 120 };

/** حدود عاقلة لطابعات ملصقات الشحن (تمنع قيماً تُفسد @page). */
export const SHIPPING_LABEL_MM_MIN = 40;
export const SHIPPING_LABEL_MM_MAX = 250;

export const SHIPPING_LABEL_PRESETS: { key: string; label: string; size: ShippingLabelSize }[] = [
  { key: "80x120", label: "٨٠×١٢٠ مم (افتراضي)", size: { widthMm: 80, heightMm: 120 } },
  { key: "100x150", label: "١٠٠×١٥٠ مم (4×6 إنش)", size: { widthMm: 100, heightMm: 150 } },
  { key: "100x100", label: "١٠٠×١٠٠ مم", size: { widthMm: 100, heightMm: 100 } },
  { key: "80x100", label: "٨٠×١٠٠ مم", size: { widthMm: 80, heightMm: 100 } },
];

const STORAGE_KEY = "shipping-label-size";

export function shippingLabelSizeKey(s: ShippingLabelSize): string {
  return `${s.widthMm}x${s.heightMm}`;
}

/** يفسّر «80x120» أو «٨٠×١٢٠» أو «80*120» (فاصل ×/x/X/*) — null إن لم يصلُح أو خرج عن الحدود.
 *  الملصق **طوليّ**: يُرفَض ارتفاعٌ أقلّ من العرض (قياس أفقي مثل 250x40 يمرّ بالحدود لكن
 *  اللوحة المرجعية 100مم تُحجَّم من العرض فيتبقّى ارتفاعٌ داخليّ أقصر من المحتوى الثابت
 *  فيُقتصّ التذييل — مراجعة Codex على PR #185). المربّع (100x100) مُثبَتٌ اتّساعه. */
export function parseShippingLabelSize(raw: string): ShippingLabelSize | null {
  const normalized = raw
    .trim()
    // أرقام عربية-هندية ⇒ لاتينية
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\s+/g, "");
  const m = /^(\d{2,3})[x×X*](\d{2,3})$/.exec(normalized);
  if (!m) return null;
  const widthMm = Number(m[1]);
  const heightMm = Number(m[2]);
  if (
    widthMm < SHIPPING_LABEL_MM_MIN || widthMm > SHIPPING_LABEL_MM_MAX ||
    heightMm < SHIPPING_LABEL_MM_MIN || heightMm > SHIPPING_LABEL_MM_MAX ||
    heightMm < widthMm
  ) {
    return null;
  }
  return { widthMm, heightMm };
}

/** القياس المحفوظ (أو الافتراضي ٨٠×١٢٠). آمنة خارج المتصفح (اختبارات/SSR). */
export function getSavedShippingLabelSize(): ShippingLabelSize {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_SHIPPING_LABEL_SIZE;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHIPPING_LABEL_SIZE;
    return parseShippingLabelSize(raw) ?? DEFAULT_SHIPPING_LABEL_SIZE;
  } catch {
    return DEFAULT_SHIPPING_LABEL_SIZE;
  }
}

export function saveShippingLabelSize(s: ShippingLabelSize): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, shippingLabelSizeKey(s));
  } catch {
    /* وضع خاص/مساحة ممتلئة — يبقى الافتراضي */
  }
}

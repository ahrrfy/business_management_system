// بناء عنصر الملصق من صفّ الكتالوج — **مصدر الحقيقة الوحيد** لما يظهر على الملصق.
//
// سبب وجود هذا الملف (١٦/٧): كان بناء الملصق مكرَّراً في موضعين تفرّقا فعلياً —
// `BarcodeLabels.tsx` يبني الاسم `المنتج — الوحدة` (بلا لون/قياس ⇒ ملصقات الألوان تخرج
// متطابقةً نصّياً)، بينما `variantModals.tsx` يبنيه صحيحاً `المنتج اللون القياس — الوحدة`.
// أيّ تصحيح في موضعٍ كان ينجرف عن الآخر. الآن: دالّة واحدة، والطرفان يستدعيانها.
import type { LabelRenderItem } from "./labelRaster";

/** فئات السعر كما يعرفها الكتالوج. */
export type LabelTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

/**
 * شارة الفئة المطبوعة على الملصق. المفرد = السعر الافتراضي للرفّ ⇒ **بلا شارة** (ضجيج على
 * ملصق 50×25مم)؛ الجملة/الحكومي يجب أن تُوسَما وإلّا لم يُفرَّق ملصق الرفّ عن ملصق العقد.
 */
export const TIER_LABEL: Record<LabelTier, string> = {
  RETAIL: "",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};

/** الاسم العربي الكامل للفئة (للواجهة لا للملصق). */
export const TIER_NAME: Record<LabelTier, string> = {
  RETAIL: "مفرد",
  WHOLESALE: "جملة",
  GOVERNMENT: "حكومي",
};

/** حقول صفّ الكتالوج التي يحتاجها الملصق (مجموعة فرعية من `PosRow` ⇒ يقبل الصفّ كما هو). */
export interface LabelSource {
  productName: string;
  color?: string | null;
  size?: string | null;
  unitName?: string | null;
}

/**
 * اسم الملصق = «المنتج اللون القياس — الوحدة».
 *
 * اللون/القياس يُدمَجان في **سطر الاسم** لا في سطرٍ مستقلّ: على 50×25مم (المقاس الافتراضي
 * والأكثر استعمالاً) يقتطع سطرٌ مستقلّ ~2.8مم من ارتفاع الباركود فيهبط إلى أرضية 6مم =
 * حدّ المسح الأدنى. سطر الاسم أصلاً متكيّف (`nameFontPt` يصغّر الخطّ مع الطول، حتى سطرين)
 * ⇒ الدمج يُظهر التمييز بلا أن يدفع الباركود ثمنه.
 *
 * الوحدة تبقى دائماً: السعر المطبوع هو **سعر الوحدة**، فملصق «درزن» بلا كلمة «درزن» يقرأه
 * الزبون سعراً للقطعة.
 */
/** مكوّنات الاسم المنظَّمة — تُغذّي الاسم المدموج (`labelName`) والتخطيط الاحترافي المنظّم معاً. */
export interface LabelParts {
  /** اسم المنتج الأساس (كما هو). */
  baseName: string;
  /** الوسوم (اللون/القياس) بعد حارس التكرار — ما لا يحتويه الاسم أصلاً. */
  tags: string[];
  /** اسم الوحدة (قطعة/درزن…) أو null. */
  unitName: string | null;
}

/**
 * يفكّك المصدر إلى مكوّناته المنظَّمة مع **حارس التكرار**: كثيرٌ من المنتجات يحمل اسمها اللون
 * أصلاً («قلم جاف أزرق» ولونه «أزرق») — نُلحق الوسم فقط إن لم يكن في الاسم ككلماتٍ مستقلّة
 * (لا كجزءٍ من كلمةٍ أطول، فلا يبتلع «أحمر» في «أحمرار»). مصدرٌ واحد للاسم المدموج والمنظَّم.
 */
export function labelParts(src: LabelSource): LabelParts {
  const nameTokens = tokenize(src.productName);
  const tags: string[] = [];
  for (const raw of [src.color, src.size]) {
    const tag = raw?.trim();
    if (!tag) continue;
    if (hasPhrase(nameTokens, tag)) continue;
    tags.push(tag);
  }
  return { baseName: src.productName.trim(), tags, unitName: src.unitName?.trim() || null };
}

/** اسم الملصق المدموج = «المنتج اللون القياس — الوحدة» (يُستعمل حين لا يتّسع المقاس لسطر خصائص منظّم). */
export function labelName(src: LabelSource): string {
  const { baseName, tags, unitName } = labelParts(src);
  const base = [baseName, ...tags].filter(Boolean).join(" ");
  return unitName ? `${base} — ${unitName}` : base;
}

/** نصّ سطر الخصائص المنظّم = «اللون · القياس · الوحدة» (بلا الاسم؛ يُعرَض تحت الاسم البارز). */
export function attrsLineText(parts: { tags: string[]; unitName?: string | null }): string {
  return [...parts.tags, parts.unitName].filter(Boolean).join(" · ");
}

/** يقطّع نصّاً إلى كلمات على الفراغات والفواصل الشائعة (عربية ولاتينية). */
function tokenize(s: string): string[] {
  return s.trim().split(/[\s·.,،\-—_/\\|()[\]]+/).filter(Boolean);
}

/** هل تظهر عبارة `phrase` ككلماتٍ متتالية مستقلّة داخل `tokens`؟ */
function hasPhrase(tokens: string[], phrase: string): boolean {
  const p = tokenize(phrase);
  if (!p.length) return false;
  for (let i = 0; i + p.length <= tokens.length; i++) {
    if (p.every((t, j) => tokens[i + j] === t)) return true;
  }
  return false;
}

/** صفّ الكتالوج بحقول التسعير التي تخصّ الملصق (مجموعة فرعية من `PosRow`). */
export interface LabelPriceSource {
  price: string | null;
  promotionEffectivePrice?: string | null;
}

/**
 * السعر المطبوع + السعر المشطوب.
 *
 * **قاعدة الصحّة (§٥، «نقطة العرض = نقطة الفرض»):** `posList` يعيد `price` = السعر الأصلي
 * و`promotionEffectivePrice` = السعر بعد خصم العرض الساري. طباعة `price` وحده تجعل ملصق
 * الرفّ **يكذب** أثناء أي عرض: الرفّ يقول ١٠٠٠ والكاشير يحصّل ٨٠٠. لذا المطبوع = السعر
 * الفعّال، والأصلي يُطبع مشطوباً بجانبه (فيرى الزبون قيمة الخصم).
 */
export function labelPrice(src: LabelPriceSource): { price: string | null; basePrice: string | null } {
  const promo = src.promotionEffectivePrice;
  if (promo != null && promo !== "" && promo !== src.price) {
    return { price: promo, basePrice: src.price };
  }
  return { price: src.price, basePrice: null };
}

/**
 * يلفّ نصّاً على حتى سطرين ضمن عرضٍ أقصى، ويقصّ الثاني بـ«…» إن فاض — منطقٌ نقيّ يُحقَن فيه
 * قياس العرض (`measure`) كي يُختبَر بلا Canvas، ويستعمله الراستر الحراريّ بقياس `ctx.measureText`.
 * يطابق سلوك `-webkit-line-clamp:2` في التصميم المتّجه ⇒ اسمٌ واحد على كل النواقل (§٥).
 */
export function wrapTwoLines(text: string, maxW: number, measure: (s: string) => number): string[] {
  const clean = text.trim();
  if (!clean || measure(clean) <= maxW) return clean ? [clean] : [];
  const words = clean.split(/\s+/);
  let first = "";
  let i = 0;
  for (; i < words.length; i++) {
    const cand = first ? `${first} ${words[i]}` : words[i];
    if (measure(cand) > maxW) break;
    first = cand;
  }
  if (!first) {
    // الكلمة الأولى وحدها أعرض من السطر ⇒ اقصصها حرفياً على سطرين.
    let head = clean;
    while (head.length > 2 && measure(head) > maxW) head = head.slice(0, -1);
    return [head, ellipsize(clean.slice(head.length), maxW, measure)];
  }
  const rest = words.slice(i).join(" ");
  return rest ? [first, ellipsize(rest, maxW, measure)] : [first];
}

/** يقصّ نصّاً بـ«…» ليلائم عرضاً أقصى (السطر الثاني حين يفيض). */
export function ellipsize(text: string, maxW: number, measure: (s: string) => number): string {
  let s = text.trim();
  if (measure(s) <= maxW) return s;
  while (s.length > 1 && measure(s + "…") > maxW) s = s.slice(0, -1);
  return s + "…";
}

/** يبني عنصر ملصقٍ كاملاً من صفّ كتالوج + فئة السعر + الباركود المختار. */
export function toLabelItem(
  src: LabelSource & LabelPriceSource & { sku?: string; colorHex?: string | null },
  barcode: string,
  tier: LabelTier,
): LabelRenderItem {
  const { price, basePrice } = labelPrice(src);
  const parts = labelParts(src);
  return {
    name: labelName(src),
    sku: src.sku,
    price,
    basePrice,
    // الشارة تعني «هذا سعر جملة/حكومي». بلا سعرٍ لهذه الفئة لا تسعيرَ نوسمه ⇒ لا شارة
    // (وإلّا خرج ملصقٌ يقول «حكومي» بلا رقم — تشويشٌ لا تمييز).
    tierLabel: price != null && price !== "" ? TIER_LABEL[tier] : "",
    barcode,
    // مكوّنات منظّمة للتخطيط الاحترافي (اسمٌ بارز + سطر «اللون · القياس · الوحدة» + رمز لون)
    // حين يتّسع المقاس؛ يتراجع الحلّال للاسم المدموج على الملصقات الضيّقة (بلا فقد معلومة).
    attrs: { baseName: parts.baseName, tags: parts.tags, colorHex: src.colorHex?.trim() || null, unitName: parts.unitName },
  };
}

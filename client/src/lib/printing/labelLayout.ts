// حلّال ملاءمة ملصق الباركود — **مصدر الحقيقة الوحيد للتخطيط الرأسي** على كل النواقل
// (المعاينة الحيّة + طباعة المتصفّح المتّجهة `labelDesign.ts` + النقطية الحرارية `labelRaster.ts`).
//
// **قاعدة المالك القاطعة (٢١/٧): لا تختفي أيّ معلومة أساسية.** المجموعة الإلزامية = **الاسم الكامل
// + الباركود + اللون + الوحدة + السعر** — لا يُسقَط أيٌّ منها أبداً. اللون/الوحدة يظهران على سطر
// خصائص منظّم حين يتّسع المقاس، وإلّا **مدموجَين في الاسم** (بلا فقد). الوحيدان القابلان للإخفاء
// على المقاسات الصغيرة جداً هما ما **لم** يطلبه المالك: **رقم الباركود المقروء** تحت القضبان
// (القضبان نفسها تُمسَح ⇒ الرقم مكرَّر) و**الرمز (SKU)**. لتحقيق ذلك يُصغّر الحلّال الخطوط نحو
// أرضية صلبة ويجعل **ارتفاع الباركود ديناميكياً** (٦مم→٥مم قابلة للمسح) حتى يتّسع كلّ الإلزاميّ.
//
// سبب وجوده (٢١/٧): كان التخطيط يعتمد على `overflow:hidden` ليَقُصّ الفائض **صامتاً** فيختفي الاسم
// أو السعر بلا إنذار (والمسار الحراري يتراكم — خرق §٥). الآن قرارٌ حتميّ واحدٌ للمسارين.
//
// وحدة نقيّة بلا Canvas/DOM ⇒ قابلة للاختبار مباشرةً (نمط `wrapTwoLines`/`labelPrice`).
import { type LabelSize } from "./labelSize";

/** نقطة طباعية = 0.3528مم — تحويل pt→mm الفيزيائيّ (مطابق للمطبوع على كلّ النواقل). */
export const PT_MM = 0.3528;

/** أدنى حجم خطٍّ مطلق (نقطة) نُصغّر إليه لإبقاء كلّ الإلزاميّ ظاهراً على المقاس الصغير جداً. */
export const HARD_FLOOR_PT = 6;
/** أرضية «مريحة» للخطوط (نقطة) — نفضّلها ونهبط تحتها فقط عند الضرورة القصوى. */
export const SOFT_FLOOR_PT = 8;
/** ارتفاع قضبان Code128 **المريح** المستهدف (مم). */
export const BAR_COMFORT_MM = 6;
/** أدنى ارتفاع قضبان مسموح (مم) يبقى قابلاً للمسح على 203dpi حادّ (الارتفاع لا يحمل معلومة). */
export const BAR_FLOOR_MM = 5;
/** الهامش الرأسيّ لكلّ جهة (مم). */
export const PAD_Y_MM = 0.8;
/** الفراغ بين الكتل الرأسية (مم). */
export const GAP_MM = 0.4;
/** الحجم الأساس لخطّ السعر (نقطة) قبل القياس بالعرض — كبيرٌ عمداً ليلاحظه كبار السنّ. */
const PRICE_PT = 15;

/** الأجزاء **القابلة للإخفاء** (ليست إلزامية) — بترتيب الإخفاء. الإلزاميّ (اسم/باركود/سعر/لون/وحدة) ليس هنا. */
export type LabelPart = "digits" | "sku" | "tier";

/** معامل تصغير حسب عرض الملصق (مرجعه 50مم) — الأضيق يأخذ خطوطاً أصغر تناسبياً. */
export function widthScale(widthMm: number): number {
  return Math.min(1, Math.max(0.6, widthMm / 50));
}

/**
 * حجم خطّ اسم المنتج (نقطة) متكيّفاً مع طوله وعرض الملصق: القصير كبيرٌ بارز، والطويل يصغُر
 * تدريجياً (ويلتفّ حتى سطرين) ليبقى مقروءاً — بحدٍّ أدنى مريح؛ يُقيَّد لاحقاً بسقفٍ عند الضيق.
 */
export function nameFontPt(name: string, widthMm: number): number {
  const n = name.trim().length;
  const base = n <= 18 ? 12 : n <= 28 ? 10 : n <= 40 ? 8.5 : 7.5;
  return Math.max(SOFT_FLOOR_PT, Math.round(base * widthScale(widthMm) * 10) / 10);
}

/** حجم خطٍّ ثانويّ (خصائص/أرقام/رمز/سعر) مقيّساً بعرض الملصق وبحدٍّ أدنى مريح. */
export function scaledPt(pt: number, widthMm: number, floor = 7): number {
  return Math.max(floor, Math.round(pt * widthScale(widthMm) * 10) / 10);
}

/** يقيّد حجم خطٍّ بسقفٍ (عند الضغط) وبالأرضية الصلبة — `cap=Infinity` ⇒ الحجم المريح كما هو. */
function capFont(preferredPt: number, capPt: number): number {
  return Math.max(HARD_FLOOR_PT, Math.min(preferredPt, capPt));
}

/**
 * تقدير عدد أسطر الاسم (١ أو ٢) بطوله مقابل سعة السطر — منحازٌ احترازياً للسطرين لمنع التداخل.
 * حتميّ (بلا Canvas) كي يتطابق حجزُ المسار المتّجه والحراري على العدد نفسه (§٥).
 */
export function estNameLines(name: string, widthMm: number, fsPt: number): 1 | 2 {
  const usableW = Math.max(10, widthMm - 3); // ناقص هامشي 1.5مم
  const capChars = usableW / (fsPt * PT_MM * 0.5); // ~0.5مم عرض الحرف لكلّ نقطة (تقدير عربي محافظ)
  return name.trim().length > capChars * 0.9 ? 2 : 1;
}

/** ما يحمله الصفّ فعلاً (توفّرُ كلّ جزء) — يُشتقّ من `LabelRenderItem`. */
export interface LabelContent {
  /** الاسم المدموج «المنتج اللون القياس — الوحدة». */
  name?: string | null;
  /** اسم المنتج الأساس (بلا لون/قياس/وحدة) — للتخطيط المنظّم. */
  baseName?: string | null;
  /** هل ثمّة خصائص (لون/قياس أو لونٌ معرَّف) تستحقّ سطراً منظّماً؟ */
  hasAttrs: boolean;
  hasBarcode: boolean;
  hasPrice: boolean;
  hasBasePrice: boolean;
  hasSku: boolean;
  hasTier: boolean;
}

/** خيارا المستخدم (اسم/سعر) — الافتراضي إظهارهما (`!== false`). */
export interface LabelShow {
  name?: boolean;
  price?: boolean;
}

/** التخطيط المحسوب للكتل + بيانات العرض. */
export interface LabelLayout {
  /** الهامش الرأسيّ لكلّ جهة (مم). */
  padYMm: number;
  /** الفراغ بين الكتل (مم). */
  gapMm: number;
  /** الاسم — `structured=true` ⇒ يُرسَم الاسم الأساس (بارزاً) + سطر الخصائص؛ وإلّا الاسم المدموج. */
  name: { show: boolean; fsPt: number; lines: 1 | 2; heightMm: number; structured: boolean };
  /** سطر الخصائص المنظّم «اللون · القياس · الوحدة» + رمز لون — يظهر فقط في التخطيط المنظّم. */
  attrs: { show: boolean; fsPt: number; heightMm: number };
  barcode: { show: boolean; heightMm: number; scannable: boolean; compact: boolean };
  digits: { show: boolean; fsPt: number; heightMm: number };
  bottom: {
    show: boolean;
    showPrice: boolean;
    showSku: boolean;
    showTier: boolean;
    /** خطّ السعر (نقطة) — الأكبر في الصفّ السفليّ. */
    priceFsPt: number;
    /** خطّ ثانويّ للرمز/الشارة/السعر المشطوب (نقطة). */
    secFsPt: number;
    heightMm: number;
  };
  // ── تقرير الملاءمة (تستهلكه الواجهة لإشعار المستخدم) ──
  /** الأجزاء **غير الإلزامية** التي أُخفيت لضيق المقاس (رقم الباركود/الرمز/الشارة). */
  dropped: LabelPart[];
  /** هل صُغِّرت الخطوط/تقلّص الباركود/دُمج الاسم دون المريح لتُلائم؟ */
  compressed: boolean;
  /** هل الخطّ عند الأرضية الصلبة (٦نقطة) — مقروءٌ لكن صغير ⇒ يُنصَح بمقاسٍ أكبر للوضوح؟ */
  tiny: boolean;
  /** أصغر ارتفاع (مم) يُظهر كلّ شيء **بحجمٍ مريح** — لتلميح «كبِّر الارتفاع إلى ≥ س». */
  minHeightMmForAll: number;
  /**
   * حتى بالأرضية الصلبة وأصغر باركود لم يتّسع كلّ الإلزاميّ (مقاسٌ ضئيلٌ جداً أو اسمٌ أطول من
   * سطرين على هذا العرض ⇒ قد يُقتطع طرف الاسم). نادرٌ — الحلّ: مقاسٌ أكبر أو أعرض.
   */
  overflow: boolean;
}

/**
 * يحسب تخطيط الملصق الحتميّ لمقاسٍ ومحتوىً وخيارات عرض. مصدرٌ واحد يستهلكه المسار المتّجه
 * (`labelDesign`) والنقطيّ (`labelRaster`) والواجهة (`BarcodeLabels`) ⇒ تطابقٌ تامّ.
 */
export function solveLabelLayout(size: LabelSize, content: LabelContent, show: LabelShow = {}): LabelLayout {
  const w = size.widthMm;
  const H = size.heightMm;
  const usableH = H - 2 * PAD_Y_MM;
  const mergedName = (content.name ?? "").trim();
  const baseName = (content.baseName ?? mergedName).trim();
  const barcode = content.hasBarcode;

  const wantName = show.name !== false && !!mergedName;
  const wantPrice = show.price !== false && content.hasPrice;
  const wantSku = content.hasSku;
  const wantTier = content.hasTier;
  const canStructure = content.hasAttrs && !!baseName && wantName;

  const pricePrefPt = scaledPt(PRICE_PT, w);
  const secPrefPt = scaledPt(8, w);

  /** حالة تخطيط مُرشَّحة: منظّم؟ + سقف الخطّ + إخفاء الثانويّات + أرضية الباركود. */
  interface State {
    structured: boolean;
    cap: number;
    hideDigits: boolean;
    hideSku: boolean;
    hideTier: boolean;
    barFloor: number;
  }

  /** يحسب ميزانية رأسية لحالةٍ مُرشَّحة (الاسم دائماً بأسطره الطبيعية — لا يُقصّ). */
  function budget(s: State) {
    const useStructured = s.structured && canStructure;
    const nameStr = useStructured ? baseName : mergedName;
    const nameFs = wantName ? capFont(nameFontPt(nameStr, w), s.cap) : 0;
    const priceFs = wantPrice ? capFont(pricePrefPt, s.cap) : 0;
    const secFs = capFont(secPrefPt, s.cap); // ثانويّ (خصائص/رقم/رمز/شارة/مشطوب)
    const showDigits = barcode && !s.hideDigits;
    const showSku = wantSku && !s.hideSku;
    const showTier = wantTier && !s.hideTier;
    const skuTierFs = showSku || showTier ? secFs : 0;
    const bottomFs = Math.max(priceFs, skuTierFs);
    const nameLines = wantName ? estNameLines(nameStr, w, nameFs) : 0;

    const nameMm = wantName ? nameLines * nameFs * PT_MM * 1.18 : 0;
    const attrsMm = useStructured ? secFs * PT_MM * 1.15 : 0;
    const digitsMm = showDigits ? secFs * PT_MM * 1.1 : 0;
    const bottomMm = bottomFs > 0 ? bottomFs * PT_MM * 1.12 : 0;
    const blocks = [wantName, useStructured, barcode, showDigits, bottomFs > 0].filter(Boolean).length;
    const gaps = Math.max(0, blocks - 1) * GAP_MM;
    const nonBar = nameMm + attrsMm + digitsMm + bottomMm + gaps;
    const barMax = Math.round(H * 0.6 * 10) / 10;
    const barMm = barcode ? Math.min(barMax, Math.max(0, Math.round((usableH - nonBar) * 10) / 10)) : 0;
    return {
      useStructured, nameFs, priceFs, secFs, bottomFs, nameLines, nameMm, attrsMm, digitsMm, bottomMm, barMm,
      showDigits, showSku, showTier,
    };
  }

  // قائمة الحالات من **الأفضل إلى الأضعف**: منظّم قبل مدموج، خطّ مريح قبل الصغير، إظهار الثانويّات
  // قبل إخفائها، باركود مريح قبل المتقلّص. أوّل حالةٍ يتّسع فيها الباركود ≥ أرضيتها = المختارة.
  const CAPS = [Infinity, SOFT_FLOOR_PT, 7, 6.5, HARD_FLOOR_PT];
  const HIDES: Array<Pick<State, "hideDigits" | "hideSku" | "hideTier">> = [
    { hideDigits: false, hideSku: false, hideTier: false },
    { hideDigits: true, hideSku: false, hideTier: false },
    { hideDigits: true, hideSku: true, hideTier: false },
    { hideDigits: true, hideSku: true, hideTier: true },
  ];
  const states: State[] = [];
  for (const structured of canStructure ? [true, false] : [false]) {
    for (const cap of CAPS) {
      for (const hide of HIDES) {
        for (const barFloor of [BAR_COMFORT_MM, BAR_FLOOR_MM]) {
          states.push({ structured, cap, ...hide, barFloor });
        }
      }
    }
  }

  let chosen = states[0];
  let b = budget(chosen);
  let fitFound = false;
  for (const s of states) {
    const cand = budget(s);
    if (!barcode || cand.barMm >= s.barFloor) {
      chosen = s;
      b = cand;
      fitFound = true;
      break;
    }
  }
  if (!fitFound) {
    // حتى الأضعف لم يتّسع (مقاسٌ ضئيلٌ جداً) — نستعمله بأقصى باركودٍ ممكن (الإلزاميّ يبقى، قد يُقتطع طرف اسم).
    chosen = states[states.length - 1];
    b = budget(chosen);
  }

  // أصغر ارتفاع يُظهر كلّ شيء بحجمٍ مريح (خطّ مريح، منظّم إن أمكن، بلا إخفاء، باركود مريح).
  const comfort = budget({ structured: canStructure, cap: Infinity, hideDigits: false, hideSku: false, hideTier: false, barFloor: BAR_COMFORT_MM });
  const comfortNonBar =
    comfort.nameMm + comfort.attrsMm + comfort.digitsMm + comfort.bottomMm +
    Math.max(0, [wantName, comfort.useStructured, barcode, comfort.showDigits, comfort.bottomFs > 0].filter(Boolean).length - 1) * GAP_MM;
  const minHeightMmForAll = Math.ceil(comfortNonBar + (barcode ? BAR_COMFORT_MM : 0) + 2 * PAD_Y_MM);

  const dropped: LabelPart[] = [];
  if (barcode && !b.showDigits) dropped.push("digits");
  if (wantSku && !b.showSku) dropped.push("sku");
  if (wantTier && !b.showTier) dropped.push("tier");

  const compressed = chosen.cap < Infinity || (canStructure && !b.useStructured) || b.barMm < BAR_COMFORT_MM;

  return {
    padYMm: PAD_Y_MM,
    gapMm: GAP_MM,
    name: {
      show: wantName,
      fsPt: b.nameFs,
      lines: (b.nameLines || 1) as 1 | 2,
      heightMm: b.nameMm,
      structured: b.useStructured,
    },
    attrs: { show: b.useStructured, fsPt: b.secFs, heightMm: b.attrsMm },
    barcode: {
      show: barcode,
      heightMm: b.barMm,
      scannable: b.barMm >= BAR_FLOOR_MM,
      compact: b.barMm > 0 && b.barMm < BAR_COMFORT_MM,
    },
    digits: { show: b.showDigits, fsPt: b.secFs, heightMm: b.digitsMm },
    bottom: {
      show: wantPrice || b.showSku || b.showTier,
      showPrice: wantPrice,
      showSku: b.showSku,
      showTier: b.showTier,
      priceFsPt: b.priceFs || b.bottomFs,
      secFsPt: b.secFs,
      heightMm: b.bottomMm,
    },
    dropped,
    compressed,
    tiny: chosen.cap <= HARD_FLOOR_PT,
    minHeightMmForAll,
    overflow: barcode ? b.barMm < BAR_FLOOR_MM : false,
  };
}

/** يشتقّ `LabelContent` من عنصر ملصقٍ مُركَّب — نقطة واحدة تلتقط توفّر كلّ جزء. */
export function labelContentOf(item: {
  name?: string;
  sku?: string;
  price?: string | number | null;
  basePrice?: string | number | null;
  tierLabel?: string;
  barcode: string;
  attrs?: { baseName: string; tags: string[]; colorHex?: string | null; unitName?: string | null };
}): LabelContent {
  const has = (v: unknown) => v != null && v !== "";
  const a = item.attrs;
  return {
    name: item.name ?? "",
    baseName: a?.baseName,
    hasAttrs: !!a && (a.tags.length > 0 || !!a.colorHex),
    hasBarcode: !!item.barcode,
    hasPrice: has(item.price),
    hasBasePrice: has(item.basePrice),
    hasSku: !!item.sku,
    hasTier: !!item.tierLabel,
  };
}

/** وصفٌ عربيّ مختصر لجزءٍ غير إلزاميٍّ مُخفى — للإشعار في الواجهة. */
export const PART_LABEL_AR: Record<LabelPart, string> = {
  digits: "رقم الباركود المقروء",
  sku: "الرمز",
  tier: "شارة الفئة",
};

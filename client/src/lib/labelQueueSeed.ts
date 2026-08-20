/**
 * labelQueueSeed — جسرٌ صغير بين «تغيّر سعر» و«اطبع ملصق الرفّ».
 *
 * **لماذا:** أخطر أثرٍ جانبيّ لموجة تسعيرٍ ناجحة هو أنّ ملصقات الرفّ صارت **تكذب** فوراً: الرفّ
 * يقول ‎1,450 والكاشير يحصّل ‎1,500. لم يكن هناك أيّ رابطٍ بين الشاشتين، فيُترك الأمر لذاكرة
 * المدير — وهي أوّل ما يسقط في يومٍ مزدحم.
 *
 * **كيف:** الشاشة الباعثة تكتب **معرّفات وحدات + فئة السعر المتغيّرة**، وشاشة الملصقات تلتقطها
 * عند التركيب فتجلب صفوفها **حيّةً من الخادم** بمسار التسعير نفسه (فئة ← تعاقديّ ← بكج ← عروض)
 * ثم تبنيها بدالّتها `addRows`. ⇒ لا مسار بناءٍ ثانٍ لعنصر الطابور، ولا سعرٌ منسوخ يشيخ في
 * التخزين المحليّ (وهو بالضبط ما نحاول إصلاحه).
 *
 * **الفئة جزءٌ من البذرة لا تفصيلٌ ثانويّ:** موجةٌ على «الجملة» تُبذَر بفئتها، وإلّا جلبت شاشة
 * الملصقات أسعار «المفرد» (فئتها الافتراضية) فطبعت ملصقاتٍ **لا علاقة لها بالسعر الذي تغيّر**.
 *
 * **الدفعات:** الموجة قد تمسّ آلاف الوحدات بينما الطباعة عملٌ على دفعات. البذرة تحتفظ بالبقية
 * وتُسلّمها دفعةً دفعة (`takeLabelQueueSeed` يُعيد كتابة المتبقّي) — بدل اقتطاعٍ صامت يترك رفوفاً
 * بملصقاتٍ كاذبة بلا أن يعلم أحد.
 */

const SEED_KEY = "barcodeLabels.seed.v2";

/** حجم الدفعة الواحدة التي تُسلَّم لشاشة الملصقات في كل زيارة. */
export const LABEL_SEED_BATCH = 300;

/** سقفٌ مطلق يحمي التخزين المحليّ من موجةٍ ضخمة (أبعد من أيّ جلسة طباعةٍ واقعية). */
export const MAX_LABEL_SEED_TOTAL = 5000;

export type LabelSeedTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

export interface LabelQueueSeed {
  productUnitIds: number[];
  /** فئة السعر التي تغيّرت — تضبط فئة شاشة الملصقات كي يطابق المطبوع ما تغيّر. */
  tier?: LabelSeedTier;
  /** سببٌ يُعرَض للمستخدم في شاشة الملصقات («أسعارها تغيّرت بموجة …»). */
  note?: string;
  /** كم بقي بعد هذه الدفعة — تعرضه الشاشة صراحةً بدل الاقتطاع الصامت. */
  remaining?: number;
}

function readSeed(): LabelQueueSeed | null {
  try {
    const raw = localStorage.getItem(SEED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LabelQueueSeed;
    const ids = Array.isArray(parsed?.productUnitIds)
      ? parsed.productUnitIds
          .map(Number)
          .filter((n) => Number.isSafeInteger(n) && n > 0)
      : [];
    if (!ids.length) return null;
    return {
      productUnitIds: ids,
      tier:
        parsed.tier === "WHOLESALE" ||
        parsed.tier === "GOVERNMENT" ||
        parsed.tier === "RETAIL"
          ? parsed.tier
          : undefined,
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * يبذر قائمة طباعة الملصقات ثم ينتقل المستدعي إلى تبويب الملصقات.
 * يُرجع العدد الكلّيّ المبذور (قد يُسلَّم على دفعات) — أو صفراً إن تعذّر التخزين.
 */
export function seedLabelQueue(
  productUnitIds: number[],
  opts: { tier?: LabelSeedTier; note?: string } = {},
): number {
  const ids = Array.from(
    new Set(
      productUnitIds
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ).slice(0, MAX_LABEL_SEED_TOTAL);
  if (!ids.length) return 0;
  try {
    localStorage.setItem(
      SEED_KEY,
      JSON.stringify({
        productUnitIds: ids,
        tier: opts.tier,
        note: opts.note,
      } satisfies LabelQueueSeed),
    );
  } catch {
    /* تخزين محلّي ممتلئ/محجوب — الانتقال يتمّ بلا بذرة، والمستخدم يبحث يدوياً */
    return 0;
  }
  return ids.length;
}

/**
 * يأخذ **دفعةً واحدة** ويُبقي الباقي للزيارة التالية (فإن لم يبقَ شيء مُحيت البذرة).
 * `remaining` في النتيجة = ما تبقّى بعد هذه الدفعة، كي تقوله الشاشة صراحةً.
 */
export function takeLabelQueueSeed(): LabelQueueSeed | null {
  const seed = readSeed();
  if (!seed) return null;
  const batch = seed.productUnitIds.slice(0, LABEL_SEED_BATCH);
  const rest = seed.productUnitIds.slice(LABEL_SEED_BATCH);
  try {
    if (rest.length) {
      localStorage.setItem(
        SEED_KEY,
        JSON.stringify({
          ...seed,
          productUnitIds: rest,
        } satisfies LabelQueueSeed),
      );
    } else {
      localStorage.removeItem(SEED_KEY);
    }
  } catch {
    /* لا يمنع تسليم الدفعة الحالية */
  }
  return { ...seed, productUnitIds: batch, remaining: rest.length };
}

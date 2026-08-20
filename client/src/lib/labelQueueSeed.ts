/**
 * labelQueueSeed — جسرٌ صغير بين «تغيّر سعر» و«اطبع ملصق الرفّ».
 *
 * **لماذا:** أخطر أثرٍ جانبيّ لموجة تسعيرٍ ناجحة هو أنّ ملصقات الرفّ صارت **تكذب** فوراً: الرفّ
 * يقول ‎1,450 والكاشير يحصّل ‎1,500. لم يكن هناك أيّ رابطٍ بين الشاشتين، فيُترك الأمر لذاكرة
 * المدير — وهي أوّل ما يسقط في يومٍ مزدحم.
 *
 * **كيف:** الشاشة الباعثة تكتب **معرّفات وحدات فقط** (لا أسعار ولا أسماء)، وشاشة الملصقات تلتقطها
 * عند التركيب فتجلب صفوفها **حيّةً من الخادم** بمسار التسعير نفسه (فئة ← تعاقديّ ← بكج ← عروض)
 * ثم تبنيها بدالّتها `addRows`. ⇒ لا مسار بناءٍ ثانٍ لعنصر الطابور، ولا سعرٌ منسوخ يشيخ في
 * التخزين المحليّ (وهو بالضبط ما نحاول إصلاحه).
 *
 * البذرة تُقرَأ **مرّةً واحدة** وتُمحى فوراً (`takeLabelQueueSeed`)، فإعادةُ تحميل الصفحة لا تُعيد
 * حقن نفس المنتجات مرّةً بعد أخرى.
 */

const SEED_KEY = "barcodeLabels.seed.v1";

/** سقفٌ يحمي التخزين المحليّ وجلبةَ الخادم من موجةٍ ضخمة (الملصقات تُطبع على دفعات أصلاً). */
export const MAX_LABEL_SEED = 300;

export interface LabelQueueSeed {
  productUnitIds: number[];
  /** سببٌ يُعرَض للمستخدم في شاشة الملصقات («أسعارها تغيّرت بموجة …»). */
  note?: string;
}

/** يبذر قائمة طباعة الملصقات ثم ينتقل المستدعي إلى تبويب الملصقات. يُرجع العدد المبذور فعلاً. */
export function seedLabelQueue(
  productUnitIds: number[],
  note?: string,
): number {
  const ids = Array.from(
    new Set(
      productUnitIds
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ).slice(0, MAX_LABEL_SEED);
  if (!ids.length) return 0;
  try {
    localStorage.setItem(
      SEED_KEY,
      JSON.stringify({ productUnitIds: ids, note } satisfies LabelQueueSeed),
    );
  } catch {
    /* تخزين محلّي ممتلئ/محجوب — الانتقال يتمّ بلا بذرة، والمستخدم يبحث يدوياً */
    return 0;
  }
  return ids.length;
}

/** يقرأ البذرة **ويمحوها** — قراءةٌ واحدة لا تتكرّر مع كل إعادة تحميل. */
export function takeLabelQueueSeed(): LabelQueueSeed | null {
  try {
    const raw = localStorage.getItem(SEED_KEY);
    if (!raw) return null;
    localStorage.removeItem(SEED_KEY);
    const parsed = JSON.parse(raw) as LabelQueueSeed;
    const ids = Array.isArray(parsed?.productUnitIds)
      ? parsed.productUnitIds
          .map(Number)
          .filter((n) => Number.isSafeInteger(n) && n > 0)
      : [];
    if (!ids.length) return null;
    return {
      productUnitIds: ids.slice(0, MAX_LABEL_SEED),
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  } catch {
    return null;
  }
}

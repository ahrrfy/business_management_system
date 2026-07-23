import { type ImageItem } from "@/components/form/ImageUploader";

/**
 * productImages — تحويلٌ ثنائيّ الاتجاه بين صور المنتج القادمة من الخادم وحالة رافع الصور (ImageItem[])،
 * بمطابقةٍ بالمعرّف كي يبقى الحفظ اقتصاديّاً وآمناً:
 *   • القراءة (hydrate): كلّ صورة خادم ⇒ عنصر رافع؛ `dataUrl=url` (data URL يُعرَض مباشرةً في الرافع)،
 *     و`id` موسومٌ ببادئة القاعدة ليُطابَق لاحقاً عند الحفظ. وجود `url` = علامةُ «قائمة غير متغيّرة».
 *   • الكتابة (build payload): الصورة غير المتغيّرة تُرسَل **بمعرّفها فقط** (بلا بايتات ⇒ لا تكرار للشبكة)،
 *     والجديدة/المستبدَلة تُرسَل ببايتاتها (`dataUrl`). الترتيب = ترتيب المصفوفة.
 *
 * الاستوديو (ImageStudioUploader.accept) يمسح `url` ويستبدل `dataUrl` عند المعالجة ⇒ تُرسَل بايتاتها الجديدة
 * وتُحدَّث في المكان (يصون `productImages.id`). يشترك فيه محرّرا المنتج (المتغيّرات + السلعة البسيطة).
 */

/** بادئة معرّف صورةٍ قائمةٍ في القاعدة داخل حالة الرافع — تمييزها عن الصور المرفوعة حديثاً (img_…). */
export const DB_IMG_PREFIX = "dbimg:";

/** صورة منتج كما يعيدها الخادم (getForVariantEdit.images). */
export interface ServerProductImage {
  id: number;
  url: string;
  isPrimary: boolean;
  sortOrder: number;
}

/** عنصر حمولة صورة منتج للتعديل — يطابق editImageSchema الخادميّ (id مملوك ⇒ يُبقى؛ url ⇒ بايتات جديدة). */
export interface ProductImagePayloadItem {
  id?: number;
  url?: string;
  isPrimary: boolean;
  sortOrder: number;
}

/** يحوّل صور الخادم إلى عناصر الرافع (dataUrl=url، وid موسومٌ بمعرّف القاعدة). */
export function hydrateProductImages(images: ServerProductImage[] | undefined): ImageItem[] {
  return (images ?? []).map((im) => ({
    id: `${DB_IMG_PREFIX}${im.id}`,
    dataUrl: im.url,
    url: im.url,
    isPrimary: !!im.isPrimary,
  }));
}

/**
 * يبني حمولة الصور بمطابقة المعرّف. القائمة غير المتغيّرة (لها معرّف قاعدة و`url` باقٍ) تُرسَل بمعرّفها بلا
 * بايتات؛ الجديدة أو المستبدَلة (استوديو مسح `url`) تُرسَل ببايتاتها (`dataUrl`). المعرّف المُشوَّه يُعامَل جديداً.
 */
export function buildProductImagesPayload(items: ImageItem[]): ProductImagePayloadItem[] {
  return items.map((it, idx) => {
    const raw = it.id.startsWith(DB_IMG_PREFIX) ? Number(it.id.slice(DB_IMG_PREFIX.length)) : NaN;
    const dbId = Number.isInteger(raw) && raw > 0 ? raw : undefined;
    // url باقٍ ⇒ لم تُستبدَل بايتاتها (الاستوديو يمسح url عند الاستبدال، والرفع الجديد بلا url) ⇒ نرسل المعرّف فقط.
    const unchanged = dbId != null && !!it.url;
    return {
      id: dbId,
      url: unchanged ? undefined : it.dataUrl,
      isPrimary: it.isPrimary,
      sortOrder: idx,
    };
  });
}

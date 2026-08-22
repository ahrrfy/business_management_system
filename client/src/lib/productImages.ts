import { type ImageItem } from "@/components/form/ImageUploader";

/**
 * productImages — تحويلٌ ثنائيّ الاتجاه بين صور المنتج القادمة من الخادم وحالة رافع الصور (ImageItem[])،
 * بمطابقةٍ بالمعرّف كي يبقى الحفظ اقتصاديّاً وآمناً:
 *   • القراءة (hydrate): كلّ صورة خادم ⇒ عنصر رافع؛ `dataUrl=url` (data URL يُعرَض مباشرةً في الرافع)،
 *     و`id` موسومٌ ببادئة القاعدة ليُطابَق لاحقاً عند الحفظ. وجود `url` = علامةُ «قائمة غير متغيّرة».
 *   • الكتابة (build payload): صور القاعدة غير المتغيّرة فقط تُرسَل **بمعرّفها وmetadata بلا بايتات**.
 *     أي عنصر جديد/مستبدَل يُستبعَد fail-closed؛ النشر الجديد حصراً عبر Product Studio/R2.
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

/** عنصر حمولة صورة منتج للتعديل — id مملوك وmetadata فقط؛ لا بايتات خارج Product Studio. */
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
 * يبني حمولة metadata بمطابقة المعرّف. لا تدخل الحمولة إلا صورة قاعدة ذات URL أصلي باقٍ؛
 * الجديدة والمستبدَلة والمعرّفات المشوّهة تُستبعَد، فلا يستطيع نموذج الكتالوج تسريب data URL.
 */
export function buildProductImagesPayload(items: ImageItem[]): ProductImagePayloadItem[] {
  return items.flatMap((it) => {
    const raw = it.id.startsWith(DB_IMG_PREFIX) ? Number(it.id.slice(DB_IMG_PREFIX.length)) : NaN;
    const dbId = Number.isInteger(raw) && raw > 0 ? raw : undefined;
    if (dbId == null || !it.url) return [];
    return [{
      id: dbId,
      url: undefined,
      isPrimary: it.isPrimary,
      sortOrder: 0,
    }];
  }).map((item, sortOrder) => ({ ...item, sortOrder }));
}

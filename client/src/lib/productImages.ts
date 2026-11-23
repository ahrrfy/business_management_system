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
  displayUrl?: string;
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

/** يحوّل صور الخادم إلى عناصر الرافع (مع استخدام displayUrl الآمن للعرض مع بقاء url للمطابقة). */
export function hydrateProductImages(images: ServerProductImage[] | undefined): ImageItem[] {
  return (images ?? []).map((im) => ({
    id: `${DB_IMG_PREFIX}${im.id}`,
    dataUrl: im.displayUrl ?? im.url,
    url: im.url,
    ...(im.displayUrl !== undefined ? { displayUrl: im.displayUrl } : {}),
    isPrimary: !!im.isPrimary,
  }));
}

export interface StudioImageSrcInput {
  id: number;
  thumbDataUrl?: string | null;
  displayUrl?: string | null;
  contentHash?: string | null;
  url?: string | null;
}

/**
 * يبني رابط عرضٍ آمنٍ لصور الاستوديو للموظّفين (لا يطلق 404 عند showInStore = 0
 * ولا يُصدر رابط `/api/img/inventory-product/:id` عارياً بلا بصمة `?v=<16-hex>`).
 */
export function resolveStudioImageSrc(
  img: StudioImageSrcInput,
  preferFullRes = false,
): string {
  const thumb = img.thumbDataUrl?.trim() || null;
  const hash16 =
    img.contentHash && /^[0-9a-f]{64}$/i.test(img.contentHash.trim())
      ? img.contentHash.trim().toLowerCase().slice(0, 16)
      : null;

  let inventoryUrl: string | null = null;
  if (img.displayUrl && /^\/api\/img\/inventory-product\/\d+\?v=[0-9a-f]{16}$/i.test(img.displayUrl.trim())) {
    inventoryUrl = img.displayUrl.trim();
  } else if (hash16) {
    inventoryUrl = `/api/img/inventory-product/${img.id}?v=${hash16}`;
  } else if (img.url) {
    const rawUrl = img.url.trim();
    const publicMatch = /^\/api\/img\/(?:company\/[^/]+\/)?product\/(\d+)(?:\?([^#]*))?$/i.exec(rawUrl);
    if (publicMatch) {
      const v = new URLSearchParams(publicMatch[2] ?? "").get("v");
      if (v && /^[0-9a-f]{16}$/i.test(v)) {
        inventoryUrl = `/api/img/inventory-product/${publicMatch[1]}?v=${v.toLowerCase()}`;
      }
    } else if (/^\/api\/img\/inventory-product\/\d+\?v=[0-9a-f]{16}$/i.test(rawUrl) || /^data:/i.test(rawUrl)) {
      inventoryUrl = rawUrl;
    }
  }

  const safeFallbackUrl =
    img.url &&
    !/^\/api\/img\/(?:company\/[^/]+\/)?product\//i.test(img.url.trim()) &&
    !/^\/api\/img\/inventory-product\/\d+$/i.test(img.url.trim())
      ? img.url.trim()
      : null;

  if (preferFullRes) {
    return inventoryUrl || thumb || safeFallbackUrl || "";
  }
  return thumb || inventoryUrl || safeFallbackUrl || "";
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

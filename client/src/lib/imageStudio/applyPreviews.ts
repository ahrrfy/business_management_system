import { type ImageItem } from "@/components/form/ImageUploader";

/**
 * applyPreviews — تطبيق نواتج الاستوديو على الصور **بمطابقة المعرّف حصراً**.
 *
 * جوهر الصحّة الذي كان مفقوداً في تجربة «تعديل عدّة صور»: كلّ ناتجٍ يُطبَّق على صورته بعينها (بالـid)،
 * والصور غير المُستهدَفة **تبقى دون أيّ مساس** — لا خلطٌ ولا تكرارٌ لصورةٍ معدَّلة على أخرى. تُمسَح `url`
 * للصورة المعدَّلة فقط (بايتاتها الجديدة في `dataUrl` ⇒ يُعاد حفظها؛ راجع lib/productImages).
 */
export interface StudioPreviewLike {
  id: string;
  /** الناتج المعالَج (data URL). */
  after: string;
}

export function applyStudioPreviews(value: ImageItem[], previews: StudioPreviewLike[]): ImageItem[] {
  const byId = new Map(previews.map((p) => [p.id, p.after]));
  return value.map((it) => (byId.has(it.id) ? { ...it, dataUrl: byId.get(it.id) as string, url: undefined } : it));
}

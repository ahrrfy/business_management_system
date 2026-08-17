/**
 * ImageStore — واجهة تخزين كائنات معنونة-بالمحتوى لصور المنتجات (شريحة ٠، استوديو الصور).
 *
 * الأصل + المعالَجة كاملة الدقة يُخزَّنان خارج MySQL (مخزن كائنات، R2 إنتاجياً) بمفتاحٍ = هاش
 * البايتات ⇒ الكائن ثابتٌ ببنائه، PUT متعادِل، و«الكائن أولاً ثم الصفّ» يمنع المرجع المعلَّق حتماً.
 * راجع docs/product-image-studio-design-2026-07-21.md §١+§٢.
 *
 * سائق fs (fsStore) للتطوير/الجلسة حصراً؛ R2 هو السائق الخاص للإنتاج.
 * ⛔ لا تخزين كامل الدقة على قرص الـVPS المشترك (خطّ سراج/أودو الأحمر).
 */
import type { Readable } from "node:stream";

/** الحد الواحد نفسه لعقد submit والمشتق المنشور؛ إبقاؤه مشتركاً يمنع رفض صورة اعتمدها الاستوديو. */
export const MAX_PUBLISHED_PRODUCT_IMAGE_BYTES = 900_000;

export interface PutResult {
  /** المفتاح المعنون-بالمحتوى المُودَع. */
  key: string;
  /** حجم البايتات. */
  bytes: number;
  /** true إن كان الكائن موجوداً سلفاً (PUT متعادِل، لا كتابة فوقية). */
  existed: boolean;
}

export interface ObjectHead {
  exists: boolean;
  bytes?: number;
}

export interface ImageStoreReadOptions {
  signal?: AbortSignal;
}

export interface ImageStore {
  /** يودِع البايتات عند المفتاح؛ متعادِل (كائن موجود ⇒ لا كتابة، existed=true). */
  put(key: string, body: Buffer, contentType: string): Promise<PutResult>;
  /** يفحص وجود الكائن دون تنزيله (للتسوية/الكنس المعدود-مرجعياً). */
  head(key: string): Promise<ObjectHead>;
  /** يبثّ بايتات الكائن، أو null إن غاب (⇒ سقوطٌ للمصغّرة في طبقة الخدمة). */
  getStream(key: string): Promise<Readable | null>;
  /** يقرأ الكائن كاملاً ضمن سقف صريح؛ مطلوب لمسار عام يتحقق قبل إرسال أي headers. */
  getBuffer(key: string, expectedBytes: number, options?: ImageStoreReadOptions): Promise<Buffer | null>;
  /** يحذف الكائن (يُستعمَل من الكنس المعدود-مرجعياً فقط؛ لا حذف آنيّ عند cascade). */
  delete(key: string): Promise<void>;
  /** رابط موقَّع قصير العمر (اختياريّ — سائق R2؛ fs لا يدعمه). */
  signedUrl?(key: string, expiresSec?: number): Promise<string>;
}

/**
 * برميل + مصنع ImageStore. fs للتطوير/الجلسة فقط؛ R2 خاصّ وإلزامي في الإنتاج.
 * راجع docs/product-image-studio-design-2026-07-21.md §١.
 */
import path from "node:path";
import { FsImageStore } from "./fsStore";
import { R2ImageStore, readR2ImageStoreConfig } from "./r2Store";
import type { ImageStore } from "./types";

export type { ImageStore, ObjectHead, PutResult } from "./types";
export { contentHash, extForMime, objectKeyFor, shortHash } from "./contentAddress";
export { FsImageStore } from "./fsStore";
export { R2ImageStore, readR2ImageStoreConfig } from "./r2Store";

let cached: ImageStore | null = null;

/**
 * يعيد ImageStore المُهيّأ (مفرد). `IMAGE_STORE_DRIVER`: `fs` (تطوير فقط) أو `r2`.
 * لا يوجد سقوط تلقائي من R2 إلى القرص: الإنتاج بلا R2 يتوقّف عند الإقلاع بدلاً من تخزين صور
 * كاملة الدقة على الـVPS المشترك أو فقد الحماية الخاصة للـbucket.
 */
export function getImageStore(): ImageStore {
  if (cached) return cached;
  const driver = (process.env.IMAGE_STORE_DRIVER ?? "fs").toLowerCase();
  if (driver === "r2") {
    cached = new R2ImageStore(readR2ImageStoreConfig());
    return cached;
  }
  if (driver !== "fs") {
    throw new Error("ImageStore: IMAGE_STORE_DRIVER يجب أن يكون fs أو r2.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("ImageStore: سائق fs محظور في الإنتاج؛ اضبط IMAGE_STORE_DRIVER=r2 واعتماد R2 الخاص.");
  }
  const root = process.env.IMAGE_STORE_DIR ?? path.join(process.cwd(), ".image-store");
  cached = new FsImageStore(root);
  return cached;
}

/** لإعادة التهيئة في الاختبارات (يُبطل المفرد المُخبَّأ). */
export function __resetImageStoreForTest(): void {
  cached = null;
}

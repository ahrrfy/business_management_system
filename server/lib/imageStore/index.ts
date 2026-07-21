/**
 * برميل + مصنع ImageStore. الافتراضي سائق fs (تطوير/جلسة)؛ سائق R2 يُضاف في شريحة لاحقة.
 * راجع docs/product-image-studio-design-2026-07-21.md §١.
 */
import path from "node:path";
import { FsImageStore } from "./fsStore";
import type { ImageStore } from "./types";

export type { ImageStore, ObjectHead, PutResult } from "./types";
export { contentHash, extForMime, objectKeyFor, shortHash } from "./contentAddress";
export { FsImageStore } from "./fsStore";

let cached: ImageStore | null = null;

/**
 * يعيد ImageStore المُهيّأ (مفرد). `IMAGE_STORE_DRIVER`: `fs` (افتراضي) أو `r2` (شريحة لاحقة).
 * جذر fs من `IMAGE_STORE_DIR` أو `<cwd>/.image-store` (تطوير فقط — لا قرص VPS مشترك).
 */
export function getImageStore(): ImageStore {
  if (cached) return cached;
  const driver = (process.env.IMAGE_STORE_DRIVER ?? "fs").toLowerCase();
  if (driver === "r2") {
    throw new Error("ImageStore: سائق R2 غير مُنفَّذ بعد (شريحة لاحقة) — اضبط IMAGE_STORE_DRIVER=fs للتطوير.");
  }
  const root = process.env.IMAGE_STORE_DIR ?? path.join(process.cwd(), ".image-store");
  cached = new FsImageStore(root);
  return cached;
}

/** لإعادة التهيئة في الاختبارات (يُبطل المفرد المُخبَّأ). */
export function __resetImageStoreForTest(): void {
  cached = null;
}

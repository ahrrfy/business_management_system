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
export { imageStoreTenantPrefix, isCurrentTenantCandidateKey, studioObjectPrefix } from "./tenantNamespace";

let cached: ImageStore | null = null;
let cachedDriver: "fs" | "r2" | null = null;

function normalizedImageStoreDriver(env: NodeJS.ProcessEnv): string | undefined {
  return env.IMAGE_STORE_DRIVER?.trim().toLowerCase() || undefined;
}

/**
 * يفحص تفعيل السائق عند الإقلاع بلا اتصال شبكي. غياب المتغيّر يعني أن مرحلة الصور
 * القديمة في MySQL ما زالت فعّالة؛ أمّا ضبطه صراحةً فيحوّل أي اعتماد ناقص إلى فشل مبكر.
 */
export function assertImageStoreStartupConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const configuredDriver = normalizedImageStoreDriver(env);
  if (!configuredDriver) return;
  if (configuredDriver === "r2") {
    readR2ImageStoreConfig(env);
    return;
  }
  if (configuredDriver !== "fs") {
    throw new Error("ImageStore: IMAGE_STORE_DRIVER يجب أن يكون fs أو r2.");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("ImageStore: سائق fs محظور في الإنتاج؛ اضبط IMAGE_STORE_DRIVER=r2 واعتماد R2 الخاص.");
  }
}

/**
 * بوابة كل عملية على مخزن الكائنات. غياب السائق في الإنتاج يعني مرحلة legacy read-only، لا إذناً
 * ضمنياً بالقرص المحلي. تبقى بوابة الإقلاع أعلاه متسامحة كي يعمل المتجر بالصور القديمة من MySQL.
 */
export function assertImageStoreOperationalConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  assertImageStoreStartupConfiguration(env);
  if (env.NODE_ENV === "production" && !normalizedImageStoreDriver(env)) {
    throw new Error("ImageStore: عمليات الصور متوقفة حتى تهيئة IMAGE_STORE_DRIVER=r2 واعتماد R2 الخاص.");
  }
}

export function isImageStoreOperational(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    assertImageStoreOperationalConfiguration(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * يعيد ImageStore المُهيّأ (مفرد). `IMAGE_STORE_DRIVER`: `fs` (تطوير فقط) أو `r2`.
 * لا يوجد سقوط تلقائي من R2 إلى القرص: الإنتاج بلا R2 يبقى online للصور القديمة، لكن كل عملية
 * object-store تفشل مغلقة بدلاً من تخزين صور كاملة الدقة على الـVPS أو فقد خصوصية الـbucket.
 */
export function getImageStore(): ImageStore {
  assertImageStoreOperationalConfiguration();
  const driver = normalizedImageStoreDriver(process.env) ?? "fs";
  if (cached && cachedDriver === driver) return cached;
  if (driver === "r2") {
    cached = new R2ImageStore(readR2ImageStoreConfig());
    cachedDriver = "r2";
    return cached;
  }
  const root = process.env.IMAGE_STORE_DIR ?? path.join(process.cwd(), ".image-store");
  cached = new FsImageStore(root);
  cachedDriver = "fs";
  return cached;
}

/** لإعادة التهيئة في الاختبارات (يُبطل المفرد المُخبَّأ). */
export function __resetImageStoreForTest(): void {
  cached = null;
  cachedDriver = null;
}

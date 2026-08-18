import { TRPCError } from "@trpc/server";

export const CATALOG_MEDIA_STUDIO_ONLY_MESSAGE =
  "إضافة أو استبدال صور المنتج تتم حصراً عبر استوديو صور المنتجات ومسار المراجعة";

/** يمنع أيّ كاتب كتالوج قديم من نشر بايتات MANUAL+APPROVED خارج Product Studio/R2. */
export function rejectLegacyCatalogMediaWrite(): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: CATALOG_MEDIA_STUDIO_ONLY_MESSAGE });
}

export function assertCreateHasNoLegacyMedia(input: {
  variants: Array<{ image?: string | null }>;
  images?: Array<{ url: string | null | undefined }>;
}): void {
  const hasVariantBytes = input.variants.some((variant) => Boolean((variant.image ?? "").trim()));
  const hasProductBytes = (input.images ?? []).some((image) => Boolean((image.url ?? "").trim()));
  if (hasVariantBytes || hasProductBytes) rejectLegacyCatalogMediaWrite();
}

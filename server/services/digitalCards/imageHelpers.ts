/**
 * مساعدات صور المزوّدين والبطاقات الرقمية:
 * - تطبيع السلاسل الفارغة إلى `null` قبل الفحص والتخزين (منع كسر الوراثة بـ `""`).
 * - التحقّق من صحة data URL وحجمه وأبعاده عبر `assertValidImageDataUrl`.
 * - توليد روابط `/api/img/digital-*` الخفيفة بالبصمة (`?v=<sha256:16>`) دون شحن base64 في JSON.
 */
import { createHash } from "node:crypto";
import { assertValidImageDataUrl } from "../../lib/imageValidation";

const MAX_DIGITAL_IMAGE_BYTES = 2_000_000;

export interface OfferingImageFields {
  ownImageUrl: string | null;
  effectiveImageUrl: string | null;
  hasCustomImage: boolean;
  inheritsProviderLogo: boolean;
}

export function digitalImageHash(
  dataUrl: string,
  variant?: "custom" | "inherited",
): string {
  const payload = variant ? `${dataUrl}:${variant}` : dataUrl;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * - `undefined`: يترك القيمة الحالية دون تغيير عند التعديل.
 * - `null` أو نصّ فارغ: يُطبَّع إلى `null` لمسح الصورة وإعادة الوراثة.
 * - data URL غير فارغ: يُفحَص بصرامة (MIME + base64 + الحجم + البصمة السحرية + الأبعاد).
 */
export function normalizeAndValidateImageDataUrl(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  assertValidImageDataUrl(trimmed, MAX_DIGITAL_IMAGE_BYTES, true);
  return trimmed;
}

export function digitalProviderLogoUrl(
  providerId: number,
  rawLogoUrl: string | null | undefined,
): string | null {
  const trimmed = rawLogoUrl?.trim() || null;
  if (!trimmed) return null;
  return `/api/img/digital-provider/${providerId}?v=${digitalImageHash(trimmed)}`;
}

export function digitalOfferingImageUrl(
  offeringId: number,
  dataUrl: string,
  variant: "custom" | "inherited",
): string {
  return `/api/img/digital-offering/${offeringId}?v=${digitalImageHash(dataUrl, variant)}`;
}

export function resolveDigitalOfferingImages(
  offeringId: number,
  rawOwnImageUrl: string | null | undefined,
  rawProviderLogoUrl: string | null | undefined,
): OfferingImageFields {
  const ownTrimmed = rawOwnImageUrl?.trim() || null;
  const providerTrimmed = rawProviderLogoUrl?.trim() || null;
  const hasCustomImage = ownTrimmed !== null;
  const inheritsProviderLogo = !hasCustomImage && providerTrimmed !== null;
  const ownImageUrl = ownTrimmed
    ? digitalOfferingImageUrl(offeringId, ownTrimmed, "custom")
    : null;
  const effectiveImageUrl = ownTrimmed
    ? ownImageUrl
    : providerTrimmed
      ? digitalOfferingImageUrl(offeringId, providerTrimmed, "inherited")
      : null;

  return {
    ownImageUrl,
    effectiveImageUrl,
    hasCustomImage,
    inheritsProviderLogo,
  };
}

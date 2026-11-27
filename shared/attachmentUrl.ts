import { TRPCError } from "@trpc/server";

const SAFE_IMAGE_DATA_URL_RE =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;
const SAFE_RELATIVE_ATTACHMENT_RE = /^\/(?:api\/|uploads\/)[^\s"'<>\\]*$/;

/**
 * يتحقق من مأمونية رابط المرفق لمنع حقن javascript:/vbscript:/data:text/html/SVG
 * في شاشات اعتماد السندات والمصاريف والفواتير والأصول.
 */
export function sanitizeAttachmentHref(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/[\u0000-\u001F\u007F]/.test(normalized)) return null;

  if (SAFE_IMAGE_DATA_URL_RE.test(normalized)) {
    return normalized;
  }

  if (
    SAFE_RELATIVE_ATTACHMENT_RE.test(normalized) &&
    !normalized.includes("..")
  ) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "https:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function isSafeAttachmentUrl(
  value: string | null | undefined,
): boolean {
  if (value == null || value.trim() === "") return true;
  return sanitizeAttachmentHref(value) !== null;
}

export function assertSafeAttachmentUrl(
  value: string | null | undefined,
  fieldLabel = "المرفق",
): void {
  if (value == null || value.trim() === "") return;
  if (sanitizeAttachmentHref(value) === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `رابط ${fieldLabel} غير آمن أو بصيغة غير مدعومة — يُقبل فقط رابط https:// أو مسار /api/ داخلي أو صورة بصيغة PNG/JPEG/WEBP/GIF.`,
    });
  }
}

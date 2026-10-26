import { z } from "zod";

export const QUOTE_CUSTOMIZATION_TRAILER_MARKER = "\n---SRQ_CUSTOM_ASSETS_V1---\n";
const BARE_MARKER = "---SRQ_CUSTOM_ASSETS_V1---";

export const MAX_QUOTE_CUSTOMIZATION_ATTACHMENTS = 30;
export const MAX_QUOTE_ATTACHMENT_SUMMARY_CHARS = 300;
/** السعة القصوى لعمود MySQL TEXT (`storefront_quote_requests.customerNote`) بالبايت (UTF-8). */
export const MAX_QUOTE_CUSTOMER_NOTE_UTF8_BYTES = 65_535;

export const quoteCustomizationAssetsInputSchema = z
  .array(
    z
      .object({
        productUnitId: z.number().int().positive(),
        quantity: z.number().int().positive().max(10_000),
        summary: z.string().trim().max(MAX_QUOTE_ATTACHMENT_SUMMARY_CHARS).nullish(),
        logoAssetKey: z.string().trim().min(1).max(255).nullish(),
        previewAssetKey: z.string().trim().min(1).max(255).nullish(),
      })
      .refine(
        (v) => Boolean(v.logoAssetKey || v.previewAssetKey),
        "يجب أن يتضمّن مرفق التخصيص شعاراً أو معاينة تصميم واحدة على الأقل",
      ),
  )
  .max(MAX_QUOTE_CUSTOMIZATION_ATTACHMENTS)
  .optional();

export interface StoredQuoteCustomizationAttachment {
  productUnitId: number;
  productName: string;
  variantLabel: string | null;
  unitName: string;
  quantity: number;
  summary: string | null;
  logoAssetKey: string | null;
  previewAssetKey: string | null;
}

/**
 * يزيل أي ذيل مرفقات مزوّر أو موروث من ملاحظة العميل الخام قبل التحقق والحفظ،
 * بحيث لا تُحفظ إلا مراجع الملفات التي تحقّق الخادم من ملكيتها ونوعها داخل المعاملة.
 */
export function stripQuoteCustomizationTrailer(rawNote: string): string {
  const idx = rawNote.indexOf(BARE_MARKER);
  const head = idx >= 0 ? rawNote.slice(0, idx) : rawNote;
  return head.trim();
}

export function encodeQuoteCustomerNoteWithAssets(
  cleanNote: string,
  attachments: ReadonlyArray<StoredQuoteCustomizationAttachment>,
): string {
  const sanitizedNote = stripQuoteCustomizationTrailer(cleanNote);
  if (attachments.length === 0) {
    return sanitizedNote;
  }
  return `${sanitizedNote}${QUOTE_CUSTOMIZATION_TRAILER_MARKER}${JSON.stringify(attachments)}`;
}

export function isQuoteCustomerNoteWithinColumnCapacity(
  encodedNote: string,
): boolean {
  return Buffer.byteLength(encodedNote, "utf8") <= MAX_QUOTE_CUSTOMER_NOTE_UTF8_BYTES;
}

function normalizeParsedAttachment(
  raw: unknown,
): StoredQuoteCustomizationAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const productUnitId = Number(r.productUnitId);
  const quantity = Math.floor(Number(r.quantity));
  const productName = typeof r.productName === "string" ? r.productName.trim() : "";
  const unitName = typeof r.unitName === "string" ? r.unitName.trim() : "";
  if (
    !Number.isSafeInteger(productUnitId) ||
    productUnitId <= 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    !productName ||
    !unitName
  ) {
    return null;
  }
  const variantLabel =
    typeof r.variantLabel === "string" && r.variantLabel.trim()
      ? r.variantLabel.trim()
      : null;
  const summary =
    typeof r.summary === "string" && r.summary.trim()
      ? r.summary.trim()
      : null;
  const logoAssetKey =
    typeof r.logoAssetKey === "string" &&
    r.logoAssetKey.trim().length > 0 &&
    r.logoAssetKey.trim().length <= 255
      ? r.logoAssetKey.trim()
      : null;
  const previewAssetKey =
    typeof r.previewAssetKey === "string" &&
    r.previewAssetKey.trim().length > 0 &&
    r.previewAssetKey.trim().length <= 255
      ? r.previewAssetKey.trim()
      : null;
  if (!logoAssetKey && !previewAssetKey) {
    return null;
  }
  return {
    productUnitId,
    productName,
    variantLabel,
    unitName,
    quantity,
    summary,
    logoAssetKey,
    previewAssetKey,
  };
}

export function splitQuoteCustomerNoteAndAssets(
  storedNote: string | null | undefined,
): {
  customerNote: string;
  attachments: StoredQuoteCustomizationAttachment[];
} {
  const raw = storedNote ?? "";
  const markerIdx = raw.indexOf(QUOTE_CUSTOMIZATION_TRAILER_MARKER);
  if (markerIdx >= 0) {
    const customerNote = raw.slice(0, markerIdx).trim();
    const jsonPart = raw.slice(markerIdx + QUOTE_CUSTOMIZATION_TRAILER_MARKER.length).trim();
    try {
      const parsed = JSON.parse(jsonPart);
      if (Array.isArray(parsed)) {
        return {
          customerNote,
          attachments: parsed
            .map(normalizeParsedAttachment)
            .filter((v): v is StoredQuoteCustomizationAttachment => v !== null),
        };
      }
    } catch {
      /* ignore malformed trailer and still keep customerNote clean */
    }
    return { customerNote, attachments: [] };
  }

  const bareIdx = raw.indexOf(BARE_MARKER);
  if (bareIdx >= 0) {
    const customerNote = raw.slice(0, bareIdx).trim();
    const jsonPart = raw.slice(bareIdx + BARE_MARKER.length).trim();
    try {
      const parsed = JSON.parse(jsonPart);
      if (Array.isArray(parsed)) {
        return {
          customerNote,
          attachments: parsed
            .map(normalizeParsedAttachment)
            .filter((v): v is StoredQuoteCustomizationAttachment => v !== null),
        };
      }
    } catch {
      /* ignore malformed trailer */
    }
    return { customerNote, attachments: [] };
  }

  return { customerNote: raw.trim(), attachments: [] };
}

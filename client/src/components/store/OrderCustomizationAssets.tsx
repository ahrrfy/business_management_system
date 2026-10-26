import React from "react";
import { Download, ExternalLink, Image as ImageIcon } from "lucide-react";

const ORDER_NOTE_SEPARATOR = "\nملاحظة:";
const LEADING_ORDER_NOTE_PREFIX = "ملاحظة:";

export function splitShippingAddressAndNotes(
  rawAddress: string | null | undefined,
): { shippingAddress: string; notes: string } {
  const raw = rawAddress?.trim() ?? "";
  if (!raw) {
    return { shippingAddress: "", notes: "" };
  }
  const sepIdx = raw.indexOf(ORDER_NOTE_SEPARATOR);
  if (sepIdx >= 0) {
    return {
      shippingAddress: raw.slice(0, sepIdx).trim(),
      notes: raw.slice(sepIdx + ORDER_NOTE_SEPARATOR.length).trim(),
    };
  }
  if (raw.startsWith(LEADING_ORDER_NOTE_PREFIX)) {
    return {
      shippingAddress: "",
      notes: raw.slice(LEADING_ORDER_NOTE_PREFIX.length).trim(),
    };
  }
  return { shippingAddress: raw, notes: "" };
}

export function resolveOrderShippingAddressAndNotes(detail: {
  addressText?: string | null;
  customerNotes?: string | null;
}): { shippingAddress: string; notes: string } {
  const split = splitShippingAddressAndNotes(detail.addressText);
  const directNotes = detail.customerNotes?.trim() ? detail.customerNotes.trim() : null;
  return {
    shippingAddress: split.shippingAddress,
    notes: directNotes ?? split.notes,
  };
}

function sanitizeCustomizationAssetUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export interface OrderCustomizationAssetsProps {
  previewAssetUrl?: string | null;
  logoAssetUrl?: string | null;
  productName?: string;
  compact?: boolean;
}

export function OrderCustomizationAssets({
  previewAssetUrl,
  logoAssetUrl,
  productName,
  compact = false,
}: OrderCustomizationAssetsProps) {
  const safePreviewUrl = sanitizeCustomizationAssetUrl(previewAssetUrl);
  const safeLogoUrl = sanitizeCustomizationAssetUrl(logoAssetUrl);

  if (!safePreviewUrl && !safeLogoUrl) {
    return null;
  }

  return (
    <div
      className={`mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 ${
        compact ? "px-2 py-1" : "p-2"
      } text-[11px]`}
    >
      {safePreviewUrl ? (
        <a
          href={safePreviewUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 overflow-hidden rounded border border-border bg-background transition hover:opacity-90"
          title="فتح معاينة التخصيص بالحجم الكامل"
        >
          <img
            src={safePreviewUrl}
            alt={productName ? `معاينة تخصيص ${productName}` : "معاينة التخصيص"}
            className={compact ? "size-9 object-contain" : "size-12 object-contain"}
            loading="lazy"
          />
        </a>
      ) : (
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground">
          <ImageIcon className="size-4" aria-hidden />
        </span>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {safePreviewUrl && (
          <a
            href={safePreviewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 font-semibold text-foreground transition hover:bg-accent"
          >
            <ExternalLink className="size-3 text-primary" aria-hidden />
            <span>معاينة التخصيص</span>
          </a>
        )}
        {safeLogoUrl && (
          <a
            href={safeLogoUrl}
            target="_blank"
            rel="noreferrer"
            download
            className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-1 font-semibold text-primary transition hover:bg-primary/15"
          >
            <Download className="size-3" aria-hidden />
            <span>ملف الشعار الأصلي</span>
          </a>
        )}
      </div>
    </div>
  );
}

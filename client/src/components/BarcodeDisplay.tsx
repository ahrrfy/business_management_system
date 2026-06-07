/**
 * BarcodeDisplay — Facade Component
 *
 * يعرض مجموعة الباركود (Code128 + QR + نص) في واجهة موحّدة قابلة لإعادة الاستخدام.
 * يُستخدم في: InvoiceDetail، WorkOrderDetail، CustomerDetail، QuotationDetail.
 *
 * التصميم الداخلي:
 *  - Code128: sync (code128Svg من barcode.ts الموجود)
 *  - QR: async (qrCodeSvg من qr.ts) — يُدار بـ useEffect + useState
 *  - تدهور سلس: يُظهر skeleton أثناء التحميل، لا يُوقف الصفحة عند الخطأ
 */

import { useState, useEffect } from "react";
import { code128Svg } from "@/lib/printing/barcode";
import { qrCodeSvg } from "@/lib/printing/qr";
import type { BarcodeSet } from "@shared/barcodeTypes";

interface Props {
  barcodeSet: BarcodeSet;
  /** sm=140px · md=180px · lg=220px (افتراضي: md) */
  size?: "sm" | "md" | "lg";
  showCode128?: boolean;
  showQR?: boolean;
  showLabel?: boolean;
  className?: string;
}

const QR_SIZE: Record<NonNullable<Props["size"]>, number> = {
  sm: 140,
  md: 180,
  lg: 220,
};

export function BarcodeDisplay({
  barcodeSet,
  size = "md",
  showCode128 = true,
  showQR = true,
  showLabel = true,
  className = "",
}: Props) {
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);

  const qrPx = QR_SIZE[size];

  useEffect(() => {
    let cancelled = false;
    setQrSvg(null);
    setQrError(false);
    qrCodeSvg(barcodeSet.qrPayload, { size: qrPx, margin: 1 })
      .then((svg) => { if (!cancelled) setQrSvg(svg); })
      .catch(() => { if (!cancelled) setQrError(true); });
    return () => { cancelled = true; };
  }, [barcodeSet.qrPayload, qrPx]);

  // Code128 — sync
  let bc128Svg: string | null = null;
  try {
    bc128Svg = code128Svg(barcodeSet.barcode128, {
      moduleWidth: size === "sm" ? 1 : 2,
      height: size === "sm" ? 40 : 52,
      showText: true,
    }).svg;
  } catch {
    bc128Svg = null;
  }

  const labelLines = barcodeSet.displayLabel.split("\n");

  return (
    <div
      className={`flex flex-col items-center gap-2 p-3 rounded-lg border bg-white print:border-0 ${className}`}
      dir="ltr"
    >
      {/* QR Code */}
      {showQR && (
        <div
          className="flex items-center justify-center bg-white rounded"
          style={{ width: qrPx, height: qrPx }}
        >
          {qrSvg ? (
            <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
          ) : qrError ? (
            <span className="text-xs text-muted-foreground">QR غير متاح</span>
          ) : (
            <div
              className="animate-pulse bg-muted rounded"
              style={{ width: qrPx - 8, height: qrPx - 8 }}
            />
          )}
        </div>
      )}

      {/* نص العرض */}
      {showLabel && (
        <div className="text-center" dir="rtl">
          {labelLines.map((line, i) => (
            <p key={i} className="text-xs text-muted-foreground leading-snug">
              {line}
            </p>
          ))}
        </div>
      )}

      {/* Code128 */}
      {showCode128 && bc128Svg && (
        <div
          className="max-w-full overflow-hidden"
          dangerouslySetInnerHTML={{ __html: bc128Svg }}
        />
      )}
    </div>
  );
}

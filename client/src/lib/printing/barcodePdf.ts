/**
 * client/src/lib/printing/barcodePdf.ts — وظائف مساعدة لتوليد وتنزيل باركودات وملصقات المنتجات المتجهية (300+ DPI).
 */

import { buildBarcodePdfFilename, buildBatchBarcodePdfFilename } from "@shared/barcodeEncoding";
import { saveFileAs } from "@/lib/export";
import { notify } from "@/lib/notify";

export type { BarcodePdfPreset } from "@/components/product/BarcodePdfButton";
export { buildBarcodePdfFilename, buildBatchBarcodePdfFilename };

export interface SingleBarcodePdfOptions {
  barcode: string;
  productName?: string | null;
  unitName?: string | null;
  retailPrice?: string | number | null;
  brand?: string | null;
  modelName?: string | null;
  sku?: string | null;
  preset?: "50x30" | "50x25" | "60x40" | "artwork" | "a4";
  widthMm?: number;
  heightMm?: number;
}

export interface BatchBarcodePdfOptions {
  items: Array<{
    barcode: string;
    productName?: string | null;
    unitName?: string | null;
    retailPrice?: string | number | null;
    brand?: string | null;
    modelName?: string | null;
    sku?: string | null;
    count: number;
  }>;
  layout?: "individual_pages" | "a4_grid";
  widthMm?: number;
  heightMm?: number;
}

/**
 * تنزيل باركود PDF فردي عبر نافذة حفظ الملفات القياسية للنظام.
 */
export function downloadSingleBarcodePdf(
  mutateAsync: (input: SingleBarcodePdfOptions) => Promise<{ base64: string; filename: string }>,
  opts: SingleBarcodePdfOptions,
  onStateChange?: (loading: boolean) => void
): void {
  const code = (opts.barcode || "").trim();
  if (!code) {
    notify.err("يرجى إدخال أو تحديد باركود أولاً لتحميله");
    return;
  }

  const suggestedFilename = buildBarcodePdfFilename({
    productName: opts.productName,
    unitName: opts.unitName,
    barcode: code,
  });

  onStateChange?.(true);

  saveFileAs(
    async () => {
      try {
        const res = await mutateAsync(opts);
        const binary = atob(res.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        notify.ok(`تم تجهيز باركود PDF عالي الدقة: ${res.filename}`);
        return {
          blob: new Blob([bytes], { type: "application/pdf" }),
          filename: res.filename || suggestedFilename,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "فشل توليد باركود PDF";
        notify.err(message);
        return null;
      } finally {
        onStateChange?.(false);
      }
    },
    {
      filename: suggestedFilename,
      description: "وثيقة باركود PDF عالي الدقة (300+ DPI)",
      mime: "application/pdf",
    }
  );
}

/**
 * تنزيل دفعة ملصقات PDF (Batch) عبر نافذة حفظ الملفات القياسية للنظام.
 */
export function downloadBatchBarcodePdf(
  mutateAsync: (input: BatchBarcodePdfOptions) => Promise<{ base64: string; filename: string; totalLabels: number }>,
  opts: BatchBarcodePdfOptions,
  onStateChange?: (loading: boolean) => void
): void {
  const valid = (opts.items || []).filter((item) => (item.barcode || "").trim().length > 0 && item.count > 0);
  if (!valid.length) {
    notify.err("لا توجد ملصقات صالحة في القائمة للتحميل");
    return;
  }

  const totalCount = valid.reduce((sum, item) => sum + item.count, 0);
  const suggestedFilename = buildBatchBarcodePdfFilename({
    totalCount,
    itemCount: valid.length,
  });

  onStateChange?.(true);

  saveFileAs(
    async () => {
      try {
        const res = await mutateAsync({
          ...opts,
          items: valid,
        });

        const binary = atob(res.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        notify.ok(`تم تجهيز ملف PDF لـ ${res.totalLabels} ملصق: ${res.filename}`);
        return {
          blob: new Blob([bytes], { type: "application/pdf" }),
          filename: res.filename || suggestedFilename,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "فشل توليد ملف PDF للملصقات";
        notify.err(message);
        return null;
      } finally {
        onStateChange?.(false);
      }
    },
    {
      filename: suggestedFilename,
      description: "دفعة ملصقات باركود PDF عالية الدقة (300+ DPI)",
      mime: "application/pdf",
    }
  );
}

import { saveFileAs } from "@/lib/export";

export interface DownloadOfficialPdfOpts {
  kind: "INVOICE" | "QUOTATION";
  documentId: number;
  documentNumber?: string;
  fetcher: (params: { kind: "INVOICE" | "QUOTATION"; documentId: number }) => Promise<{
    filename: string;
    bytesBase64: string;
  }>;
}

/**
 * حفظ ملف PDF لقاعدة بيانات المستندات الرسمية (فاتورة مبيعات أو عرض سعر).
 * يفتح حوار «حفظ باسم» الأصلي في نظام التشغيل (Chrome/Edge على Windows)
 * لاختيار مكان الحفظ المفضل فوراً، مع تراجع تلقائي للتنزيل المباشر.
 */
export function downloadOfficialPdf(opts: DownloadOfficialPdfOpts): void {
  const defaultFilename = opts.documentNumber
    ? `${opts.documentNumber}.pdf`
    : `${opts.kind === "INVOICE" ? "فاتورة" : "عرض_سعر"}-${opts.documentId}.pdf`;

  saveFileAs(
    async () => {
      const res = await opts.fetcher({
        kind: opts.kind,
        documentId: opts.documentId,
      });
      const binary = window.atob(res.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return {
        blob: new Blob([bytes], { type: "application/pdf" }),
        filename: res.filename || defaultFilename,
      };
    },
    {
      filename: defaultFilename,
      description: "مستند PDF",
      mime: "application/pdf",
    },
  );
}

/**
 * يحفظ ملف PDF من نص Base64 عبر حوار «حفظ باسم» في المتصفح.
 */
export function saveBase64Pdf(base64: string, filename: string): void {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "application/pdf" });
  saveFileAs(blob, {
    filename,
    description: "مستند PDF",
    mime: "application/pdf",
  });
}

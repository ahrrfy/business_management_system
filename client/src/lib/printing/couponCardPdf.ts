/**
 * client/src/lib/printing/couponCardPdf.ts
 *
 * مساعد تنزيل واستعراض ملفات PDF لبطاقات الكوبونات المفردة قياس 54×84 مم.
 */

/**
 * تنزيل ملف PDF مباشرة في المتصفح من بيانات Base64.
 */
export function downloadPdfFromBase64(base64: string, filename: string): void {
  if (typeof window === "undefined") return;

  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/**
 * فتح ملف PDF في نافذة/تبويب جديد للمعاينة أو الطباعة المباشرة.
 */
export function openPdfBlobInNewTab(base64: string, title?: string): boolean {
  if (typeof window === "undefined") return false;

  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (!win) return false;
  if (title) win.document.title = title;
  return true;
}

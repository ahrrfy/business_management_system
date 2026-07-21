/**
 * غلاف عزل الخلفية عبر @imgly/background-removal (مسار CUT).
 * - يعمل النموذج في **عامل داخليّ** (`proxyToWorker`) خارج الخيط الرئيسيّ.
 * - **الأصول مستضافة ذاتياً** (`publicPath` محلّي `/imgly-assets/`) — CSP يحجب CDN staticimgly.
 * - المدخل **Blob** لا data URL (CSP `connect-src 'self'` يحجب `fetch(data:)`).
 * - النموذج `isnet_fp16` (توازن حجم/جودة).
 * راجع docs/product-image-studio-design-2026-07-21.md §٥.
 */
import { removeBackground } from "@imgly/background-removal";
import { loadImageEl } from "./compositor";

/** جذر الأصول المستضافة ذاتياً (يُنسَخ إليه isnet + onnxruntime وقت الإعداد/البناء). */
export const IMGLY_ASSETS_PATH = "/imgly-assets/";

function studioImglyConfig() {
  return {
    publicPath: (typeof window !== "undefined" ? window.location.origin : "") + IMGLY_ASSETS_PATH,
    model: "isnet_fp16" as const,
    proxyToWorker: true,
    output: { format: "image/png" as const },
  };
}

/** يحوّل data URL إلى Blob عبر canvas (لا `fetch(data:)` — محجوب بـCSP). */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const img = await loadImageEl(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("dataUrlToBlob: تعذّر إنشاء سياق canvas");
  ctx.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob أعاد فارغاً"))), "image/png");
  });
}

/** يعزل الخلفية ⇒ data URL لقصاصة PNG بخلفية شفّافة. يرمي إن تعذّر تحميل النموذج/العزل. */
export async function removeBackgroundToDataUrl(
  sourceDataUrl: string,
  onProgress?: (key: string, current: number, total: number) => void,
): Promise<string> {
  const blob = await dataUrlToBlob(sourceDataUrl);
  const cut = await removeBackground(blob, { ...studioImglyConfig(), progress: onProgress });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(cut);
  });
}

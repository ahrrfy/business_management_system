import { imageDataToRaster, type Raster } from "./escpos";
import { code128Svg } from "./barcode";
import { qrCodeSvg, qrCodeDataUrl } from "./qr";
import type { BarcodeSet } from "@shared/barcodeTypes";

/** مستند طباعة عام: فاتورة، Z-report، أو بيان رصيد افتتاحي. */
export interface PrintDoc {
  kind: "receipt" | "zreport" | "opening";
  title: string;
  subtitle?: string;
  meta: string[];
  columns?: string[];
  rows?: string[][];
  totals?: { label: string; value: string }[];
  footer?: string;
  /** مجموعة باركود/QR اختيارية — تُضمَّن في نهاية الإيصال */
  barcodeSet?: BarcodeSet;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** تحويل SVG string إلى data URL للرسم على Canvas */
function svgToDataUrl(svg: string): string {
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  } catch {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

/** رسم صورة من src (data URL) على Canvas — async لانتظار تحميل الصورة */
function drawImage(
  ctx: CanvasRenderingContext2D,
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, x, y, w, h); resolve(); };
    img.onerror = () => resolve(); // تدهور سلس — لا يُوقف الطباعة
    img.src = src;
  });
}

// -------------------------------------------------------------------
// HTML path (طباعة المتصفح)
// -------------------------------------------------------------------

/**
 * قالب HTML بعرض 80مم — يُستخدم كبديل عبر حوار طباعة المتصفّح.
 * async: تحتاج لتوليد QR SVG قبل بناء HTML.
 */
export async function docToHtml(doc: PrintDoc): Promise<string> {
  const meta = doc.meta.map((m) => `<p class="muted">${esc(m)}</p>`).join("");
  let table = "";
  if (doc.columns && doc.rows) {
    const head = `<tr>${doc.columns.map((c, i) => `<th style="text-align:${i === 0 ? "right" : "left"}">${esc(c)}</th>`).join("")}</tr>`;
    const body = doc.rows
      .map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i === 0 ? "right" : "left"}">${esc(c)}</td>`).join("")}</tr>`)
      .join("");
    table = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }
  const totals = (doc.totals ?? [])
    .map((t) => `<div class="tot"><span>${esc(t.label)}</span><span>${esc(t.value)}</span></div>`)
    .join("");

  // قسم الباركود — QR + Code128 + نص العرض
  let barcodeSection = "";
  if (doc.barcodeSet) {
    const [qrSvg, bc128Result] = await Promise.all([
      qrCodeSvg(doc.barcodeSet.qrPayload, { size: 140, margin: 1 }),
      Promise.resolve(code128Svg(doc.barcodeSet.barcode128, { moduleWidth: 2, height: 48, showText: true })),
    ]);
    const labelHtml = doc.barcodeSet.displayLabel
      .split("\n")
      .map((l) => `<span>${esc(l)}</span>`)
      .join("<br>");
    barcodeSection = `<div class="bc-wrap">
      <div class="bc-qr">${qrSvg}</div>
      <p class="bc-lbl">${labelHtml}</p>
      <div class="bc-128">${bc128Result.svg}</div>
    </div>`;
  }

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>@page{size:80mm auto;margin:3mm}body{font-family:"Cairo",monospace;width:74mm;font-size:14px;color:#000;line-height:1.6}
h2{text-align:center;margin:3px 0;font-size:18px;font-weight:900}.muted{text-align:center;margin:0;color:#222;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:8px}th{border-bottom:2px solid #000;font-size:13px;padding:3px 0}td{padding:3px 0;font-size:13px}
.tot{display:flex;justify-content:space-between;border-top:1px dashed #000;padding-top:4px;font-weight:bold;font-size:14px}
.tot:last-child{font-size:16px;font-weight:900;border-top:2px solid #000;padding-top:5px;margin-top:3px}
.foot{text-align:center;margin-top:10px;font-size:13px}
.bc-wrap{text-align:center;margin-top:10px;border-top:1px dashed #000;padding-top:8px}
.bc-wrap svg{display:block;margin:0 auto}
.bc-qr svg{width:140px;height:140px}
.bc-lbl{font-size:10px;margin:4px 0;color:#333;line-height:1.4}
.bc-128{margin-top:6px}
.bc-128 svg{max-width:100%;height:auto}
</style></head>
<body onload="window.print();setTimeout(()=>window.close(),300)">
<h2>${esc(doc.title)}</h2>${doc.subtitle ? `<p class="muted">${esc(doc.subtitle)}</p>` : ""}${meta}${table}${totals}
${doc.footer ? `<p class="foot">${esc(doc.footer)}</p>` : ""}${barcodeSection}</body></html>`;
}

// -------------------------------------------------------------------
// Thermal path (طباعة حرارية ESC/POS)
// -------------------------------------------------------------------

const BARCODE_SECTION_H = 150 + 16 + 76 + 20; // QR(150) + gap(16) + Code128(76) + label(20)

/**
 * رسم المستند على Canvas وتحويله إلى نقطية ESC/POS.
 * async: تحتاج لتحميل صور QR وCode128 على Canvas.
 */
export async function docToRaster(doc: PrintDoc, widthPx = 576): Promise<Raster | null> {
  if (typeof document === "undefined") return null;
  const line = 36;
  const pad = 14;
  const rowsCount =
    1 +
    (doc.subtitle ? 1 : 0) +
    doc.meta.length +
    (doc.columns ? 1 : 0) +
    (doc.rows?.length ?? 0) +
    (doc.totals?.length ?? 0) +
    (doc.footer ? 2 : 0);
  const height =
    pad * 2 + (rowsCount + 1) * line + (doc.barcodeSet ? BARCODE_SECTION_H : 0);

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, height);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  const right = widthPx - pad;
  const left = pad;
  let y = pad + line;

  ctx.textAlign = "center";
  ctx.font = "900 38px Cairo, sans-serif";
  ctx.fillText(doc.title, widthPx / 2, y);
  y += line;
  ctx.font = "700 28px Cairo, sans-serif";
  if (doc.subtitle) { ctx.fillText(doc.subtitle, widthPx / 2, y); y += line; }
  for (const m of doc.meta) { ctx.fillText(m, widthPx / 2, y); y += line; }

  if (doc.columns && doc.rows) {
    const last = doc.columns.length - 1;
    ctx.font = "800 30px Cairo, sans-serif";
    ctx.textAlign = "right"; ctx.fillText(doc.columns[0], right, y);
    ctx.textAlign = "left"; ctx.fillText(doc.columns[last], left, y);
    y += line;
    ctx.font = "700 28px Cairo, sans-serif";
    for (const r of doc.rows) {
      ctx.textAlign = "right"; ctx.fillText(r[0], right, y);
      ctx.textAlign = "left"; ctx.fillText(r[r.length - 1], left, y);
      y += line;
    }
  }

  const totals = doc.totals ?? [];
  for (let i = 0; i < totals.length; i++) {
    const t = totals[i];
    const isLast = i === totals.length - 1;
    ctx.font = isLast
      ? "900 44px Cairo, sans-serif"
      : "800 30px Cairo, sans-serif";
    ctx.textAlign = "right"; ctx.fillText(t.label, right, y);
    ctx.textAlign = "left"; ctx.fillText(t.value, left, y);
    y += isLast ? line * 1.3 : line;
  }
  if (doc.footer) {
    ctx.font = "600 26px Cairo, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(doc.footer, widthPx / 2, y + line);
    y += line * 2;
  }

  // قسم الباركود — يُرسم آخراً على Canvas
  if (doc.barcodeSet) {
    y += 10; // gap قبل الباركود
    const QR_SIZE = 150;

    // QR — يُحمَّل كـ PNG data URL ويُرسم على Canvas
    try {
      const qrUrl = await qrCodeDataUrl(doc.barcodeSet.qrPayload, { size: QR_SIZE });
      await drawImage(ctx, qrUrl, (widthPx - QR_SIZE) / 2, y, QR_SIZE, QR_SIZE);
    } catch { /* تدهور سلس */ }
    y += QR_SIZE + 6;

    // نص العرض أسفل QR
    ctx.font = "16px Cairo, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#444";
    const labelLines = doc.barcodeSet.displayLabel.split("\n");
    for (const ln of labelLines) { ctx.fillText(ln, widthPx / 2, y); y += 18; }
    ctx.fillStyle = "#000";

    // Code128 — يُحوَّل SVG إلى data URL ويُرسم على Canvas
    try {
      const bc128 = code128Svg(doc.barcodeSet.barcode128, { moduleWidth: 2, height: 60, showText: false });
      const bc128Url = svgToDataUrl(bc128.svg);
      const bc128X = (widthPx - bc128.widthPx) / 2;
      await drawImage(ctx, bc128Url, bc128X, y, bc128.widthPx, bc128.heightPx);
    } catch { /* تدهور سلس */ }
  }

  const img = ctx.getImageData(0, 0, widthPx, height);
  return imageDataToRaster({ width: widthPx, height, data: img.data });
}

export function printHtml(html: string): void {
  if (typeof window === "undefined") return;
  const w = window.open("", "_blank", "width=380,height=640");
  if (w) {
    w.document.write(html);
    w.document.close();
  }
}

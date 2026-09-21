import { imageDataToRaster, type Raster } from "./escpos";
import { code128Svg } from "./barcode";
import { qrCodeSvg, qrCodeDataUrl } from "./qr";
import type { BarcodeSet } from "@shared/barcodeTypes";
import { CAIRO_FONT, CO, logoUrl } from "./brand";

/** بندٌ مركّب لإيصال 80مم: الاسم مستقل عن سطر الكمية/السعر والإجمالي. */
export interface PrintItemBlock {
  name: string;
  quantityPrice: string;
  total: string;
}

/** مستند طباعة عام: فاتورة، Z-report، أو بيان رصيد افتتاحي. */
export interface PrintDoc {
  kind: "receipt" | "zreport" | "opening";
  title: string;
  subtitle?: string;
  meta: string[];
  columns?: string[];
  rows?: string[][];
  /** بديلٌ منظّم لجدول الصفوف حين يحتاج البند أكثر من سطر بصريّ واحد. */
  itemBlocks?: PrintItemBlock[];
  totals?: { label: string; value: string }[];
  footer?: string;
  /** مجموعة باركود/QR اختيارية — تُضمَّن في نهاية الإيصال */
  barcodeSet?: BarcodeSet;
  /** تضمين ترويسة الهوية المؤسسية الكاملة للمكتبة العربية (شعار + اسم الشركة + الفروع) */
  includeBrandHeader?: boolean;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));

const htmlLines = (s: unknown): string =>
  esc(s).replace(/\r\n?|\n/g, "<br>");

export function resolveQrUrl(payload: string): string {
  if (!payload) return "";
  if (payload.startsWith("http://") || payload.startsWith("https://")) return payload;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (origin) {
    return `${origin}/verify?payload=${encodeURIComponent(payload)}`;
  }
  return payload;
}

export interface TextMeasureLike {
  measureText(text: string): { width: number };
}

/** يلفّ النص بقياس الراسم، ويحترم الفواصل الصريحة ويقسّم الكلمات الطويلة. */
export function wrapMeasuredText(
  measure: TextMeasureLike,
  value: unknown,
  maxWidth: number,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const lines: string[] = [];

  const pushWord = (word: string, current: string): string => {
    let rest = word;
    let line = current;
    while (rest) {
      const candidate = line ? `${line} ${rest}` : rest;
      if (measure.measureText(candidate).width <= maxWidth) return candidate;
      if (line) {
        lines.push(line);
        line = "";
        continue;
      }
      let cut = 1;
      while (cut < rest.length && measure.measureText(rest.slice(0, cut + 1)).width <= maxWidth) cut += 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return line;
  };

  for (const paragraph of text.split(/\r\n?|\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (lines.length) lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) current = pushWord(word, current);
    if (current) lines.push(current);
  }

  if (lines.length <= maxLines) return lines;
  const result = lines.slice(0, Math.max(1, maxLines));
  const lastIndex = result.length - 1;
  let last = result[lastIndex].replace(/…$/, "");
  while (last && measure.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  result[lastIndex] = `${last}…`;
  return result;
}

/** يحافظ على نسبة الباركود ويمنعه من تجاوز عرض المحتوى الآمن. */
export function fitWithinWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !(maxWidth > 0) || width <= maxWidth) return { width, height };
  const scale = maxWidth / width;
  return { width: maxWidth, height: height * scale };
}

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
  const brandHeaderHtml = doc.includeBrandHeader
    ? `<header style="text-align:center;padding:2px 0 6px;border-bottom:2px solid #000;margin-bottom:6px">
        <img src="${logoUrl()}" style="width:44px;height:44px;object-fit:contain;margin-bottom:2px;filter:grayscale(100%) contrast(1000%)" alt="" onerror="this.style.display='none'">
        <div style="font-size:17px;font-weight:900;line-height:1.15;color:#000">${esc(CO.short)}</div>
        <div style="font-size:12px;font-weight:800;color:#000;margin-top:1px">${esc(CO.subtitle)}</div>
        <div style="font-size:9.5px;font-weight:800;color:#000;margin-top:2px;line-height:1.3">${esc(CO.name)}<br>${esc(CO.address)}</div>
      </header>`
    : "";

  const titleBlock = `<div style="border-top:2px solid #000;border-bottom:2px solid #000;padding:4px 0;text-align:center;margin:4px 0 6px">
    <h2 style="margin:0;font-size:16px;font-weight:900;letter-spacing:0.5px">${esc(doc.title)}</h2>
    ${doc.subtitle ? `<div style="font-size:11px;font-weight:800;margin-top:2px;color:#000">${htmlLines(doc.subtitle)}</div>` : ""}
  </div>`;

  const meta = doc.meta.length
    ? `<table class="receipt-grid" style="margin:4px 0">
        <tbody>
          ${doc.meta
            .map((m) => {
              const colonIdx = m.indexOf(":");
              if (colonIdx !== -1) {
                const label = m.slice(0, colonIdx).trim();
                const val = m.slice(colonIdx + 1).trim();
                const isPhone = label.includes("هاتف") || /^[0-9+\s-]+$/.test(val);
                return `<tr>
                  <td style="width:36%;font-weight:900;padding:2px 3px;border:1px solid #000">${esc(label)}</td>
                  <td style="font-weight:900;padding:2px 3px;border:1px solid #000;text-align:${isPhone ? "left" : "right"};direction:${isPhone ? "ltr" : "rtl"};unicode-bidi:isolate">${htmlLines(val)}</td>
                </tr>`;
              }
              return `<tr><td colspan="2" style="font-weight:900;padding:2px 3px;border:1px solid #000">${htmlLines(m)}</td></tr>`;
            })
            .join("")}
        </tbody>
      </table>`
    : "";

  let table = "";
  if (doc.itemBlocks?.length) {
    const firstHeading = doc.columns?.[0] ?? "البند والوصف";
    const totalHeading = doc.columns?.at(-1) ?? "الإجمالي";
    table = `<table class="receipt-grid">
      <thead>
        <tr>
          <th style="text-align:right;width:70%">${esc(firstHeading)}</th>
          <th style="text-align:left;width:30%">${esc(totalHeading)}</th>
        </tr>
      </thead>
      <tbody>
        ${doc.itemBlocks.map((item) => `<tr>
          <td style="border:1px solid #000;padding:3px 2px">
            <div style="font-weight:900;font-size:12px;line-height:1.25">${esc(item.name)}</div>
            <div style="font-weight:800;font-size:10.5px;margin-top:1px">${esc(item.quantityPrice)}</div>
          </td>
          <td style="border:1px solid #000;padding:3px 2px;text-align:left;direction:ltr;font-weight:900;font-variant-numeric:tabular-nums;white-space:nowrap;vertical-align:middle;font-size:12px">
            ${esc(item.total)}
          </td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  } else if (doc.columns && doc.rows) {
    const isThreeCol = doc.columns.length === 3;
    const colStyles = isThreeCol
      ? [
          'style="text-align:right;width:52%;padding:3px 2px;border:1px solid #000"',
          'style="text-align:center;width:18%;white-space:nowrap;padding:3px 2px;font-variant-numeric:tabular-nums;border:1px solid #000"',
          'style="text-align:left;width:30%;white-space:nowrap;direction:ltr;padding:3px 2px;font-variant-numeric:tabular-nums;border:1px solid #000"',
        ]
      : doc.columns.length === 2
        ? [
            'style="text-align:right;width:65%;padding:3px 2px;border:1px solid #000"',
            'style="text-align:left;width:35%;white-space:nowrap;direction:ltr;padding:3px 2px;font-variant-numeric:tabular-nums;border:1px solid #000"',
          ]
        : doc.columns.map((_, i) => (i === 0 ? 'style="text-align:right;border:1px solid #000"' : 'style="text-align:left;border:1px solid #000"'));

    const head = `<tr>${doc.columns.map((c, i) => `<th ${colStyles[i] || 'style="text-align:left;border:1px solid #000"'}>${esc(c)}</th>`).join("")}</tr>`;
    const body = doc.rows
      .map((r) => `<tr>${r.map((c, i) => `<td ${colStyles[i] || 'style="text-align:left;border:1px solid #000"'}>${esc(c)}</td>`).join("")}</tr>`)
      .join("");
    table = `<table class="receipt-grid"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  const totals = doc.totals?.length
    ? `<table class="receipt-grid" style="margin:4px 0">
        <tbody>
          ${doc.totals.map((t, idx, arr) => {
            const isLast = idx === arr.length - 1;
            const isTafqit = t.label.includes("كتابة") || t.label.includes("فقط") || t.label.includes("تفقيط");
            if (isTafqit) {
              return `<tr>
                <td colspan="2" style="text-align:center;font-weight:900;font-size:10.5px;padding:3px;border:1px solid #000">${esc(t.value)}</td>
              </tr>`;
            }
            return `<tr style="${isLast ? "background:#000;color:#fff;font-weight:900" : ""}">
              <td style="width:55%;padding:3px;font-weight:900;border:1px solid #000">${esc(t.label)}</td>
              <td style="width:45%;text-align:left;direction:ltr;font-variant-numeric:tabular-nums;font-weight:900;padding:3px;white-space:nowrap;border:1px solid #000;font-size:${isLast ? "13.5px" : "11.5px"}">${esc(t.value)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`
    : "";

  // قسم الباركود — QR + Code128 + نص العرض
  let barcodeSection = "";
  if (doc.barcodeSet) {
    const [qrSvg, bc128Result] = await Promise.all([
      qrCodeSvg(resolveQrUrl(doc.barcodeSet.qrPayload), { size: 100, margin: 1 }),
      Promise.resolve(code128Svg(doc.barcodeSet.barcode128, { moduleWidth: 1.5, height: 38, showText: true })),
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
${CAIRO_FONT}
<style>
@page{size:80mm auto;margin:2mm}
*,*::before,*::after{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Cairo',sans-serif;width:72mm;max-width:72mm;margin:0 auto;font-size:11.5px;color:#000;line-height:1.4;direction:rtl;word-break:normal;overflow-wrap:normal;background:#fff}
table.receipt-grid{width:100%;border-collapse:collapse;border:1.5px solid #000;margin:3px 0;table-layout:fixed}
table.receipt-grid th{border:1px solid #000;font-size:11.5px;font-weight:900;padding:3px 2px;background:#000;color:#fff}
table.receipt-grid td{padding:3px 2px;font-size:11px;font-weight:800;vertical-align:top;border:1px solid #000}
.foot{text-align:center;margin-top:6px;font-size:10.5px;font-weight:800;line-height:1.4;color:#000}
.bc-wrap{text-align:center;margin-top:6px;border-top:1.5px solid #000;padding-top:5px}
.bc-wrap svg{display:block;margin:0 auto}
.bc-qr svg{width:95px;height:95px}
.bc-lbl{font-size:9.5px;font-weight:800;margin:2px 0;color:#000;line-height:1.3}
.bc-128{margin-top:3px}
.bc-128 svg{max-width:100%;max-height:40px}
</style></head>
<body onload="window.print();setTimeout(()=>window.close(),300)">
${brandHeaderHtml}
${titleBlock}
${meta}
${table}
${totals}
${doc.footer ? `<p class="foot">${htmlLines(doc.footer)}</p>` : ""}
${barcodeSection}
</body></html>`;
}

// -------------------------------------------------------------------
// Thermal path (طباعة حرارية ESC/POS)
// -------------------------------------------------------------------

const RASTER_PAD = 14;
const TITLE_FONT = "900 38px Cairo, sans-serif";
const TITLE_LINE = 44;
const META_FONT = "700 28px Cairo, sans-serif";
const META_LINE = 36;
const HEADER_FONT = "800 30px Cairo, sans-serif";
const HEADER_LINE = 38;
const ROW_FONT = "700 28px Cairo, sans-serif";
const ROW_LINE = 36;
const ITEM_NAME_FONT = "800 30px Cairo, sans-serif";
const ITEM_NAME_LINE = 38;
const ITEM_DETAIL_FONT = "700 25px Cairo, sans-serif";
const ITEM_DETAIL_LINE = 32;
const FOOTER_FONT = "600 26px Cairo, sans-serif";
const FOOTER_LINE = 34;

/**
 * رسم المستند على Canvas وتحويله إلى نقطية ESC/POS.
 * async: تحتاج لتحميل صور QR وCode128 على Canvas.
 */
export async function docToRaster(doc: PrintDoc, widthPx = 576): Promise<Raster | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  let ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const contentWidth = widthPx - RASTER_PAD * 2;

  const measured = (font: string, text: unknown, maxWidth = contentWidth, maxLines?: number) => {
    ctx!.font = font;
    return wrapMeasuredText(ctx!, text, maxWidth, maxLines);
  };
  const titleLines = measured(TITLE_FONT, doc.title, contentWidth, 2);
  const subtitleLines = doc.subtitle ? measured(META_FONT, doc.subtitle, contentWidth, 3) : [];
  const metaLines = doc.meta.map((line) => measured(META_FONT, line, contentWidth));
  const headerFirst = doc.columns?.[0] ?? "";
  const headerLast = doc.columns?.at(-1) ?? "";
  const hasRows = !!doc.rows?.length;
  const hasItems = !!doc.itemBlocks?.length;
  const headingHeight = doc.columns && (hasRows || hasItems) ? HEADER_LINE : 0;
  const firstColumnWidth = contentWidth * 0.68;
  const lastColumnWidth = contentWidth - firstColumnWidth - 12;
  const rowLayouts = !hasItems ? (doc.rows ?? []).map((row) => ({
    first: measured(ROW_FONT, row[0] ?? "", firstColumnWidth),
    last: measured(ROW_FONT, row.at(-1) ?? "", lastColumnWidth),
  })) : [];
  const itemLayouts = (doc.itemBlocks ?? []).map((item) => ({
    name: measured(ITEM_NAME_FONT, item.name, contentWidth, 2),
    quantityPrice: measured(ITEM_DETAIL_FONT, item.quantityPrice, firstColumnWidth, 2),
    total: measured(ITEM_DETAIL_FONT, item.total, lastColumnWidth, 2),
  }));
  const totalLayouts = (doc.totals ?? []).map((total, index, all) => {
    const font = index === all.length - 1 ? "900 44px Cairo, sans-serif" : HEADER_FONT;
    const lineHeight = index === all.length - 1 ? 48 : HEADER_LINE;
    return {
      font,
      lineHeight,
      label: measured(font, total.label, firstColumnWidth, 2),
      value: measured(font, total.value, lastColumnWidth, 2),
    };
  });
  const footerLines = doc.footer ? measured(FOOTER_FONT, doc.footer, contentWidth) : [];
  const barcodeLabelLines = doc.barcodeSet
    ? measured("16px Cairo, sans-serif", doc.barcodeSet.displayLabel, contentWidth)
    : [];
  let rawBarcode: ReturnType<typeof code128Svg> | null = null;
  if (doc.barcodeSet) {
    try {
      rawBarcode = code128Svg(doc.barcodeSet.barcode128, { moduleWidth: 2, height: 60, showText: false });
    } catch {
      // باركود غير صالح لا يُسقط بقية التذكرة؛ QR والنص يظلان قابلين للطباعة.
    }
  }
  const fittedBarcode = rawBarcode
    ? fitWithinWidth(rawBarcode.widthPx, rawBarcode.heightPx, contentWidth)
    : null;

  const rowsHeight = rowLayouts.reduce(
    (sum, row) => sum + Math.max(row.first.length, row.last.length, 1) * ROW_LINE + 6,
    0,
  );
  const itemsHeight = itemLayouts.reduce(
    (sum, item) => sum + item.name.length * ITEM_NAME_LINE
      + Math.max(item.quantityPrice.length, item.total.length, 1) * ITEM_DETAIL_LINE + 12,
    0,
  );
  const totalsHeight = totalLayouts.reduce(
    (sum, total) => sum + Math.max(total.label.length, total.value.length, 1) * total.lineHeight + 4,
    0,
  );
  const barcodeHeight = doc.barcodeSet
    ? 10 + 144 + 6 + barcodeLabelLines.length * 18 + 6 + (fittedBarcode?.height ?? 0)
    : 0;
  const height = Math.ceil(
    RASTER_PAD * 2 + titleLines.length * TITLE_LINE + subtitleLines.length * META_LINE
      + metaLines.reduce((sum, lines) => sum + lines.length * META_LINE, 0)
      + headingHeight + rowsHeight + itemsHeight + totalsHeight
      + (footerLines.length ? 10 + footerLines.length * FOOTER_LINE : 0)
      + barcodeHeight + 12,
  );

  canvas.height = height;
  ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, height);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  const right = widthPx - RASTER_PAD;
  const left = RASTER_PAD;
  let y = RASTER_PAD;
  const drawLines = (
    lines: string[], font: string, lineHeight: number, x: number, align: CanvasTextAlign, color = "#000",
  ) => {
    ctx!.font = font;
    ctx!.textAlign = align;
    ctx!.fillStyle = color;
    for (const line of lines) {
      y += lineHeight;
      ctx!.fillText(line, x, y);
    }
  };
  const drawColumns = (first: string[], last: string[], font: string, lineHeight: number) => {
    ctx!.font = font;
    ctx!.fillStyle = "#000";
    const count = Math.max(first.length, last.length, 1);
    for (let index = 0; index < count; index += 1) {
      y += lineHeight;
      if (first[index]) { ctx!.textAlign = "right"; ctx!.fillText(first[index], right, y); }
      if (last[index]) { ctx!.textAlign = "left"; ctx!.fillText(last[index], left, y); }
    }
  };
  const dashedRule = () => {
    ctx!.save();
    ctx!.strokeStyle = "#000";
    ctx!.lineWidth = 1;
    ctx!.setLineDash([6, 5]);
    ctx!.beginPath();
    ctx!.moveTo(left, y + 5);
    ctx!.lineTo(right, y + 5);
    ctx!.stroke();
    ctx!.restore();
    y += 6;
  };

  drawLines(titleLines, TITLE_FONT, TITLE_LINE, widthPx / 2, "center");
  drawLines(subtitleLines, META_FONT, META_LINE, widthPx / 2, "center");
  for (const lines of metaLines) drawLines(lines, META_FONT, META_LINE, widthPx / 2, "center");

  if (headingHeight) {
    drawColumns([headerFirst], [headerLast], HEADER_FONT, HEADER_LINE);
    ctx.fillRect(left, y + 4, contentWidth, 2);
    y += 6;
  }
  for (const row of rowLayouts) {
    drawColumns(row.first, row.last, ROW_FONT, ROW_LINE);
    y += 6;
  }
  for (const item of itemLayouts) {
    drawLines(item.name, ITEM_NAME_FONT, ITEM_NAME_LINE, right, "right");
    drawColumns(item.quantityPrice, item.total, ITEM_DETAIL_FONT, ITEM_DETAIL_LINE);
    dashedRule();
  }
  for (const total of totalLayouts) {
    drawColumns(total.label, total.value, total.font, total.lineHeight);
    y += 4;
  }
  if (footerLines.length) {
    y += 10;
    drawLines(footerLines, FOOTER_FONT, FOOTER_LINE, widthPx / 2, "center");
  }

  // قسم الباركود — يُرسم آخراً على Canvas
  if (doc.barcodeSet) {
    y += 10; // gap قبل الباركود
    const QR_SIZE = 144;

    // QR — يُحمَّل كـ PNG data URL ويُرسم على Canvas
    try {
      const qrUrl = await qrCodeDataUrl(resolveQrUrl(doc.barcodeSet.qrPayload), { size: QR_SIZE });
      await drawImage(ctx, qrUrl, (widthPx - QR_SIZE) / 2, y, QR_SIZE, QR_SIZE);
    } catch { /* تدهور سلس */ }
    y += QR_SIZE + 6;

    // نص العرض أسفل QR
    for (const line of barcodeLabelLines) {
      ctx.font = "16px Cairo, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#444";
      y += 18;
      ctx.fillText(line, widthPx / 2, y);
    }
    ctx.fillStyle = "#000";
    y += 6;

    // Code128 — يُحوَّل SVG إلى data URL ويُرسم على Canvas
    try {
      if (!rawBarcode || !fittedBarcode) throw new Error("تعذّر بناء الباركود");
      const bc128Url = svgToDataUrl(rawBarcode.svg);
      const bc128X = (widthPx - fittedBarcode.width) / 2;
      await drawImage(ctx, bc128Url, bc128X, y, fittedBarcode.width, fittedBarcode.height);
    } catch { /* تدهور سلس */ }
  }

  const img = ctx.getImageData(0, 0, widthPx, height);
  return imageDataToRaster({ width: widthPx, height, data: img.data });
}

export function printHtml(html: string): boolean {
  if (typeof window === "undefined") return false;
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}

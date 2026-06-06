import { imageDataToRaster, type Raster } from "./escpos";

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
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

/** قالب HTML بعرض 80مم — يُستخدم كبديل عبر حوار طباعة المتصفّح. */
export function docToHtml(doc: PrintDoc): string {
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
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>@page{size:80mm auto;margin:3mm}body{font-family:"Cairo",monospace;width:74mm;font-size:12px;color:#000}
h2{text-align:center;margin:2px 0;font-size:15px}.muted{text-align:center;margin:0;color:#222}
table{width:100%;border-collapse:collapse;margin-top:6px}th{border-bottom:1px dashed #000}th,td{padding:2px 0}
.tot{display:flex;justify-content:space-between;border-top:1px dashed #000;padding-top:2px;font-weight:bold}
.foot{text-align:center;margin-top:8px}</style></head>
<body onload="window.print();setTimeout(()=>window.close(),300)">
<h2>${esc(doc.title)}</h2>${doc.subtitle ? `<p class="muted">${esc(doc.subtitle)}</p>` : ""}${meta}${table}${totals}
${doc.footer ? `<p class="foot">${esc(doc.footer)}</p>` : ""}</body></html>`;
}

/** رسم المستند على Canvas وتحويله إلى نقطية ESC/POS (للطباعة الحرارية، يدعم العربية). */
export function docToRaster(doc: PrintDoc, widthPx = 576): Raster | null {
  if (typeof document === "undefined") return null;
  const line = 28;
  const pad = 14;
  const rowsCount =
    1 + (doc.subtitle ? 1 : 0) + doc.meta.length + (doc.columns ? 1 : 0) + (doc.rows?.length ?? 0) + (doc.totals?.length ?? 0) + (doc.footer ? 2 : 0);
  const height = pad * 2 + (rowsCount + 1) * line;

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, height);
  ctx.fillStyle = "#000";
  (ctx as any).direction = "rtl";
  const right = widthPx - pad;
  const left = pad;
  let y = pad + line;

  ctx.textAlign = "center";
  ctx.font = "bold 26px Cairo, sans-serif";
  ctx.fillText(doc.title, widthPx / 2, y);
  y += line;
  ctx.font = "20px Cairo, sans-serif";
  if (doc.subtitle) { ctx.fillText(doc.subtitle, widthPx / 2, y); y += line; }
  for (const m of doc.meta) { ctx.fillText(m, widthPx / 2, y); y += line; }

  if (doc.columns && doc.rows) {
    const last = doc.columns.length - 1;
    ctx.textAlign = "right"; ctx.fillText(doc.columns[0], right, y);
    ctx.textAlign = "left"; ctx.fillText(doc.columns[last], left, y);
    y += line;
    for (const r of doc.rows) {
      ctx.textAlign = "right"; ctx.fillText(r[0], right, y);
      ctx.textAlign = "left"; ctx.fillText(r[r.length - 1], left, y);
      y += line;
    }
  }
  for (const t of doc.totals ?? []) {
    ctx.font = "bold 20px Cairo, sans-serif";
    ctx.textAlign = "right"; ctx.fillText(t.label, right, y);
    ctx.textAlign = "left"; ctx.fillText(t.value, left, y);
    ctx.font = "20px Cairo, sans-serif";
    y += line;
  }
  if (doc.footer) { ctx.textAlign = "center"; ctx.fillText(doc.footer, widthPx / 2, y + line); }

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

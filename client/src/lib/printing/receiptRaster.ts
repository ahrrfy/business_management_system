// الراسم الحراري المُعلَّم لإيصال نقطة البيع — يرسم تصميم الإيصال المعتمد نفسه
// (شعار + مكتبة العربية + Code128 + جدول الأصناف + الإجماليات + التواصل + سياسة الاستبدال)
// على Canvas ثم يحوّله نقطية ESC/POS. التصميم مطابق لقالب printBrowserReceipt (بديل المتصفح)
// كي لا يتفاوت شكل الإيصال بتفاوت الناقل (جسر خادم / WebUSB / نافذة متصفح).
//
// قيد مهم: عتبة النقطية في imageDataToRaster هي lum<128 ⇒ الرماديات الفاتحة تختفي.
// لذلك كل العناصر هنا تُرسم بأسود صافٍ (#000) عمداً وإن كانت رمادية في قالب HTML.
import { imageDataToRaster, type Raster } from "./escpos";
import { code128Svg } from "./barcode";
import { CO, RECEIPT_PHONES, fmt, logoUrl } from "./brand";
import type { ReceiptBrowserData } from "./printTemplates";

const W = 576; // 80مم @ 203dpi — عرض الطباعة الفعلي للطابعات الحرارية
const PAD = 12;

// أعمدة جدول الأصناف (RTL كقالب HTML): الصنف يميناً ← عدد ← السعر ← المبلغ أقصى اليسار
const COL_AMOUNT_X = PAD; //  «المبلغ» — محاذاة يسار
const COL_PRICE_X = PAD + 138; //  «السعر» — محاذاة يسار
const COL_QTY_CENTER = PAD + 280; //  «عدد» — توسيط
const COL_NAME_R = W - PAD; //  «الصنف» — محاذاة يمين
const COL_NAME_W = COL_NAME_R - (COL_QTY_CENTER + 42);

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // تدهور سلس — الإيصال يُطبع بلا الصورة
    img.src = src;
  });
}

function svgToDataUrl(svg: string): string {
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  } catch {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

/**
 * تحميل أوجه Cairo المطلوبة قبل الرسم — وجه العربية مقيّد بـunicode-range فلا يُحمَّل
 * إلا بنصّ عربي في نداء load (وإلا رُسم أول إيصال بخط النظام).
 */
async function ensureFonts(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const sample = "مكتبة العربية للطباعة 0123 IQD";
    await Promise.all(
      ["400 21px Cairo", "600 19px Cairo", "700 21px Cairo", "800 25px Cairo", "900 29px Cairo", "900 38px Cairo"].map(
        (f) => fonts.load(f, sample).catch(() => undefined),
      ),
    );
  } catch {
    /* تدهور سلس — يُرسم بالخط المتاح */
  }
}

/** لفّ نص على أسطر بعرض أقصى (مع «…» عند تجاوز maxLines) — مُصدَّرة للاختبار */
export function wrapLines(
  ctx: { measureText(s: string): { width: number } },
  s: string,
  maxW: number,
  maxLines = 2,
): string[] {
  const words = String(s).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  let lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (!cur || ctx.measureText(cand).width <= maxW) cur = cand;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  const overflowed = lines.length > maxLines;
  lines = lines.slice(0, maxLines);
  let last = lines[lines.length - 1] + (overflowed ? "…" : "");
  while (last.length > 2 && ctx.measureText(last).width > maxW) last = last.slice(0, -2) + "…";
  lines[lines.length - 1] = last;
  return lines;
}

function solidLine(ctx: CanvasRenderingContext2D, y: number, lw = 2): void {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(PAD, y, W - PAD * 2, lw);
  ctx.restore();
}

function dashedLine(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  ctx.restore();
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * رسم الإيصال المُعلَّم على Canvas. يعيد اللوحة + الارتفاع المستعمل فعلياً (يُقصّ عنده)،
 * أو null خارج المتصفح (بلا DOM).
 */
export async function receiptToCanvas(
  d: ReceiptBrowserData,
): Promise<{ canvas: HTMLCanvasElement; height: number } | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();

  // تقدير سخي للارتفاع ثم قصّ للمستعمل فعلياً بعد الرسم
  const estH = 1400 + d.items.length * 96;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = estH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, estH);
  ctx.fillStyle = "#000";
  (ctx as unknown as { direction: string }).direction = "rtl";
  ctx.textBaseline = "alphabetic";

  let y = PAD;

  // ───── ١) الرأس: شعار + اسم المتجر ─────
  const logo = await loadImage(logoUrl());
  if (logo) {
    ctx.drawImage(logo, (W - 160) / 2, y, 160, 160);
    y += 160;
  }
  ctx.textAlign = "center";
  ctx.font = "900 38px Cairo, sans-serif";
  y += 44;
  ctx.fillText("مكتبة العربية", W / 2, y);
  ctx.font = "800 25px Cairo, sans-serif";
  y += 34;
  ctx.fillText("للطباعة والقرطاسية", W / 2, y);
  ctx.font = "400 16px Cairo, sans-serif";
  y += 24;
  ctx.fillText(CO.name, W / 2, y);

  y += 14;
  solidLine(ctx, y, 4);
  y += 4;

  // ───── ٢) باركود رقم الفاتورة (Code128) ─────
  try {
    const bc = code128Svg(d.receiptNumber, { moduleWidth: 2, height: 70, showText: false });
    const img = await loadImage(svgToDataUrl(bc.svg));
    if (img) {
      y += 14;
      const bw = Math.min(bc.widthPx, W - PAD * 2);
      ctx.drawImage(img, (W - bw) / 2, y, bw, bc.heightPx);
      y += bc.heightPx + 24;
      ctx.font = "600 17px Cairo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(d.receiptNumber, W / 2, y);
    }
  } catch {
    /* رقم غير قابل للترميز ⇒ إيصال بلا باركود */
  }

  // ───── ٣) صفوف المعلومات ─────
  y += 32;
  const metaRow = (right: string, left: string) => {
    ctx.font = "400 21px Cairo, sans-serif";
    if (right) {
      ctx.textAlign = "right";
      ctx.fillText(right, W - PAD, y);
    }
    if (left) {
      ctx.textAlign = "left";
      ctx.fillText(left, PAD, y);
    }
    y += 28;
  };
  metaRow(`رقم: ${d.receiptNumber}`, d.date);
  if (d.cashierName || d.time) metaRow(d.cashierName ? `الكاشير: ${d.cashierName}` : "", d.time ? `الوقت: ${d.time}` : "");
  if (d.customerName) metaRow(`العميل: ${d.customerName}`, "");

  y += 2;
  dashedLine(ctx, y);
  y += 32;

  // ───── ٤) جدول الأصناف ─────
  ctx.font = "700 21px Cairo, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("الصنف", COL_NAME_R, y);
  ctx.textAlign = "center";
  ctx.fillText("عدد", COL_QTY_CENTER, y);
  ctx.textAlign = "left";
  ctx.fillText("السعر", COL_PRICE_X, y);
  ctx.fillText("المبلغ", COL_AMOUNT_X, y);
  y += 10;
  solidLine(ctx, y, 2);
  y += 30;

  for (const it of d.items) {
    ctx.font = "400 21px Cairo, sans-serif";
    const lines = wrapLines(ctx, it.name, COL_NAME_W);
    ctx.textAlign = "right";
    ctx.fillText(lines[0], COL_NAME_R, y);
    ctx.textAlign = "center";
    ctx.fillText(String(it.quantity), COL_QTY_CENTER, y);
    ctx.textAlign = "left";
    ctx.fillText(fmt(it.price), COL_PRICE_X, y);
    ctx.font = "600 21px Cairo, sans-serif";
    ctx.fillText(fmt(it.total), COL_AMOUNT_X, y);
    y += 28;
    if (lines[1]) {
      ctx.font = "400 21px Cairo, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(lines[1], COL_NAME_R, y);
      y += 28;
    }
  }

  y += 2;
  dashedLine(ctx, y);
  y += 34;

  // ───── ٥) الإجماليات ─────
  const totRow = (label: string, value: string, bold = false) => {
    ctx.font = `${bold ? "800" : "400"} 22px Cairo, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(label, W - PAD, y);
    ctx.textAlign = "left";
    ctx.fillText(value, PAD, y);
    y += 30;
  };
  totRow("المجموع:", fmt(d.subtotal));
  if (Number(d.tax ?? 0) > 0) totRow("الضريبة:", fmt(d.tax));

  y += 2;
  solidLine(ctx, y, 2);
  y += 42;
  ctx.font = "900 29px Cairo, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("الإجمالي:", W - PAD, y);
  ctx.textAlign = "left";
  ctx.fillText(`${fmt(d.total)} د.ع`, PAD, y);
  y += 14;
  solidLine(ctx, y, 2);
  y += 34;

  if (d.paid != null) totRow("المدفوع:", fmt(d.paid));
  if (d.change != null) totRow("الباقي:", fmt(d.change));
  if (Number(d.credit ?? 0) > 0) totRow("آجل/ذمة:", fmt(d.credit), true);

  y += 2;
  dashedLine(ctx, y);
  y += 38;

  // ───── ٦) الشكر ─────
  ctx.textAlign = "center";
  ctx.font = "900 25px Cairo, sans-serif";
  ctx.fillText("شكراً لتسوقكم معنا", W / 2, y);
  y += 28;
  ctx.font = "400 19px Cairo, sans-serif";
  ctx.fillText("نتمنى لكم تجربة ممتعة", W / 2, y);
  y += 18;
  dashedLine(ctx, y);
  y += 34;

  // ───── ٧) أرقام التواصل ─────
  ctx.font = "700 20px Cairo, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("القسم", W - PAD, y);
  ctx.textAlign = "left";
  ctx.fillText("رقم التواصل", PAD, y);
  y += 9;
  solidLine(ctx, y, 2);
  y += 30;
  for (const p of RECEIPT_PHONES) {
    ctx.font = "600 19px Cairo, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(p.l, W - PAD, y);
    ctx.font = "700 20px Cairo, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(p.n, PAD, y);
    y += 9;
    dashedLine(ctx, y);
    y += 28;
  }

  // ───── ٨) العنوان ─────
  y += 4;
  ctx.font = "600 19px Cairo, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(CO.address, W / 2, y);
  y += 18;
  dashedLine(ctx, y);
  y += 26;

  // ───── ٩) سياسة الاستبدال ─────
  const boxH = 88;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#000";
  roundRectPath(ctx, PAD + 1, y, W - PAD * 2 - 2, boxH, 6);
  ctx.stroke();
  ctx.restore();
  ctx.font = "700 19px Cairo, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("نعتذر عن قبول الاسترجاع — والاستبدال متاح", W / 2, y + 35);
  ctx.fillText("خلال 48 ساعة بشرط سلامة المنتج بـ100%", W / 2, y + 67);
  y += boxH + PAD;

  return { canvas, height: Math.min(Math.ceil(y) + 4, estH) };
}

/** الإيصال المُعلَّم نقطيةً ESC/POS (مقصوصاً للارتفاع المستعمل). null خارج المتصفح. */
export async function receiptToRaster(d: ReceiptBrowserData): Promise<Raster | null> {
  const drawn = await receiptToCanvas(d);
  if (!drawn) return null;
  const ctx = drawn.canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, W, drawn.height);
  return imageDataToRaster({ width: W, height: drawn.height, data: img.data });
}

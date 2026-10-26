import { imageDataToRaster, type Raster } from "./escpos";
import { fmt } from "./brand";
import { fmtQty } from "@shared/quantityFormat";
import type { ReceiptBrowserData } from "./printTemplates";
import { buildDigitalBlocks } from "./digitalReceiptLines";
import {
  RECEIPT_WIDTH as W,
  RECEIPT_PAD as PAD,
  receiptRule,
  receiptTextLines,
} from "./receiptLayout";
import { receiptAssets, type ReceiptAssets } from "./receiptLayoutAssets";
import { drawReceiptHeader } from "./receiptLayoutHeader";
import { drawReceiptFooter } from "./receiptLayoutFooter";
import { drawReceiptTotals } from "./receiptLayoutTotals";
const RECEIPT_THRESHOLD = 160;
const COL_AMOUNT_X = PAD;
const COL_PRICE_X = PAD + 138;
const COL_QTY_CENTER = PAD + 280;
const COL_NAME_R = W - PAD;
const COL_NAME_W = COL_NAME_R - (COL_QTY_CENTER + 42);
async function ensureFonts(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const sample = "مكتبة العربية للطباعة 0123 IQD";
    await Promise.all(
      [
        "400 21px Cairo",
        "600 19px Cairo",
        "700 21px Cairo",
        "800 25px Cairo",
        "900 29px Cairo",
        "900 38px Cairo",
      ].map((f) => fonts.load(f, sample).catch(() => undefined)),
    );
  } catch {
    /* تدهور سلس — يُرسم بالخط المتاح */
  }
}
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
  while (last.length > 2 && ctx.measureText(last).width > maxW)
    last = last.slice(0, -2) + "…";
  lines[lines.length - 1] = last;
  return lines;
}
function drawReceipt(
  ctx: CanvasRenderingContext2D,
  d: ReceiptBrowserData,
  assets: ReceiptAssets,
): number {
  ctx.fillStyle = "#000";
  ctx.direction = "rtl";
  ctx.textBaseline = "alphabetic";
  let y = drawReceiptHeader(ctx, d, assets);

  if (d.copyLabel) {
    receiptRule(ctx, y);
    y += 30;
    ctx.font = "900 22px Cairo, sans-serif";
    ctx.textAlign = "center";
    const copyLines = receiptTextLines(ctx, d.copyLabel, W - PAD * 2 - 24);
    copyLines.forEach((line, index) =>
      ctx.fillText(line, W / 2, y + index * 27),
    );
    y += Math.max(copyLines.length, 1) * 27;
    receiptRule(ctx, y);
    y += 28;
  }

  ctx.font = "900 22px Cairo, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("المنتج", COL_NAME_R, y);
  ctx.textAlign = "center";
  ctx.fillText("عدد", COL_QTY_CENTER, y);
  ctx.textAlign = "left";
  ctx.fillText("السعر", COL_PRICE_X, y);
  ctx.fillText("المبلغ", COL_AMOUNT_X, y);
  y += 8;
  receiptRule(ctx, y);
  y += 26;
  for (const item of d.items) {
    ctx.font = "800 22px Cairo, sans-serif";
    const lines = receiptTextLines(ctx, item.name, COL_NAME_W);
    ctx.textAlign = "right";
    lines.forEach((line, index) =>
      ctx.fillText(line, COL_NAME_R, y + index * 28),
    );
    ctx.font = "900 22px Cairo, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fmtQty(item.quantity), COL_QTY_CENTER, y);
    ctx.font = "800 22px Cairo, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(fmt(item.price), COL_PRICE_X, y);
    ctx.font = "900 23px Cairo, sans-serif";
    ctx.fillText(fmt(item.total), COL_AMOUNT_X, y);
    y += Math.max(lines.length, 1) * 28;
  }
  // ───── ٤-ب) تفاصيل الكروت الرقمية (ش١٠) ─────
  // نفس الأسطر التي يبنيها قالب المتصفّح (`digitalReceiptLines`) — مصدرٌ واحد فلا ينحرف المساران.
  // لا حصة مزوّد ولا ربح ولا رصيد محفظة: النوع نفسه لا يحملها (§١٢.٢).
  const digitalBlocks = buildDigitalBlocks(d.digitalDetails, {
    maskPhones: d.maskPhones,
  });
  if (digitalBlocks.length) {
    y += 2;
    receiptRule(ctx, y, true);
    y += 30;
    for (const block of digitalBlocks) {
      ctx.font = "900 21px Cairo, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(block.lineName, W - PAD, y);
      y += 26;
      for (const row of block.rows) {
        ctx.font = "800 19px Cairo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(`${row.label}:`, W - PAD, y);
        ctx.font = "900 19px Cairo, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(row.value, PAD, y);
        y += 25;
      }
      y += 4;
    }
  }

  y += 2;
  receiptRule(ctx, y, true);
  y += 26;

  y = drawReceiptTotals(ctx, d, assets, y);
  return drawReceiptFooter(ctx, d, assets, y);
}
/** Measure at the loaded font widths before allocating; long names/receipts never rely on a guessed height. */
export async function receiptToCanvas(
  d: ReceiptBrowserData,
): Promise<{ canvas: HTMLCanvasElement; height: number } | null> {
  if (typeof document === "undefined") return null;
  await ensureFonts();
  const assets = await receiptAssets(d);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const height = Math.ceil(drawReceipt(ctx, d, assets)) + 4;
  canvas.height = height + 4;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, canvas.height);
  drawReceipt(ctx, d, assets);
  return { canvas, height };
}
export async function receiptToRaster(
  d: ReceiptBrowserData,
): Promise<Raster | null> {
  const drawn = await receiptToCanvas(d);
  if (!drawn) return null;
  const ctx = drawn.canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.getImageData(0, 0, W, drawn.height);
  return imageDataToRaster(
    { width: W, height: drawn.height, data: image.data },
    RECEIPT_THRESHOLD,
  );
}

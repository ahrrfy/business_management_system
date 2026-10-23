import { wrapMeasuredText, type TextMeasureLike } from "./render";

export const RECEIPT_WIDTH = 576;
export const RECEIPT_PAD = 12;
export const RECEIPT_DPI = 203;
export const receiptDotsToMm = (dots: number) => (dots * 25.4) / RECEIPT_DPI;
export const receiptTextLines = (
  ctx: TextMeasureLike,
  text: string,
  width = RECEIPT_WIDTH - RECEIPT_PAD * 2,
) => wrapMeasuredText(ctx, text, width);

export function receiptRule(
  ctx: CanvasRenderingContext2D,
  y: number,
  dashed = false,
) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(RECEIPT_PAD, y);
  ctx.lineTo(RECEIPT_WIDTH - RECEIPT_PAD, y);
  ctx.stroke();
  ctx.restore();
}

/** Wrap both columns rather than shrinking financial text or drawing over its neighbour. */
export function receiptPair(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  value: string,
  strong = false,
) {
  const width = (RECEIPT_WIDTH - RECEIPT_PAD * 2 - 16) / 2;
  ctx.font = `${strong ? "900" : "800"} 22px Cairo, sans-serif`;
  const labels = receiptTextLines(ctx, label, width);
  ctx.font = "900 22px Cairo, sans-serif";
  const values = receiptTextLines(ctx, value, width);
  ctx.textAlign = "right";
  labels.forEach((line, index) =>
    ctx.fillText(line, RECEIPT_WIDTH - RECEIPT_PAD, y + index * 26),
  );
  ctx.textAlign = "left";
  values.forEach((line, index) =>
    ctx.fillText(line, RECEIPT_PAD, y + index * 26),
  );
  return y + Math.max(labels.length, values.length, 1) * 26;
}

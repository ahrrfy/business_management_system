import { CO } from "./brand";
import type { ReceiptBrowserData } from "./printTemplates";
import type { ReceiptAssets } from "./receiptLayoutAssets";
import {
  RECEIPT_PAD as PAD,
  RECEIPT_WIDTH as W,
  receiptRule,
  receiptTextLines,
} from "./receiptLayout";

export function drawReceiptHeader(
  ctx: CanvasRenderingContext2D,
  data: ReceiptBrowserData,
  assets: ReceiptAssets,
): number {
  let y = PAD;
  const logoSize = 64;
  if (assets.logo)
    ctx.drawImage(assets.logo, W - PAD - logoSize, y, logoSize, logoSize);
  const textWidth = W - PAD * 2 - (assets.logo ? logoSize + 12 : 0);
  const center = PAD + textWidth / 2;
  const names = [
    {
      text: CO.short || CO.sub,
      font: "900 24px Cairo, sans-serif",
      lineHeight: 28,
    },
    { text: CO.subtitle, font: "800 18px Cairo, sans-serif", lineHeight: 22 },
    { text: CO.name, font: "700 15px Cairo, sans-serif", lineHeight: 19 },
  ];
  let nameY = y;
  ctx.textAlign = "center";
  for (const row of names) {
    if (!row.text) continue;
    ctx.font = row.font;
    for (const line of receiptTextLines(ctx, row.text, textWidth)) {
      nameY += row.lineHeight;
      ctx.fillText(line, center, nameY);
    }
  }
  y = Math.max(nameY, y + (assets.logo ? logoSize : 0)) + 8;
  receiptRule(ctx, y);
  y += 8;
  if (assets.barcode) {
    const width = Math.min(assets.barcode.width, W - PAD * 2);
    ctx.drawImage(
      assets.barcode.image,
      Math.round((W - width) / 2),
      y,
      width,
      assets.barcode.height,
    );
    y += assets.barcode.height + 22;
  } else y += 20;
  const meta = (right: string, left = "", strong = false) => {
    ctx.font = `${strong ? "900" : "700"} 20px Cairo, sans-serif`;
    const leftWidth = left ? ctx.measureText(left).width + 16 : 0;
    const lines = receiptTextLines(ctx, right, W - PAD * 2 - leftWidth);
    ctx.textAlign = "right";
    lines.forEach((line, index) => ctx.fillText(line, W - PAD, y + index * 24));
    if (left) {
      ctx.textAlign = "left";
      ctx.fillText(left, PAD, y);
    }
    y += Math.max(lines.length, 1) * 24;
  };
  meta(`رقم: ${data.receiptNumber}`, data.date);
  if (data.cashierName || data.time)
    meta(
      data.cashierName ? `الكاشير: ${data.cashierName}` : "",
      data.time ?? "",
    );
  if (data.shiftId != null) meta(`الوردية: #${data.shiftId}`);
  if (data.customerName) meta(`العميل: ${data.customerName}`, "", true);
  if (data.revision) {
    receiptRule(ctx, y);
    y += 24;
    ctx.textAlign = "right";
    ctx.font = "800 17px Cairo, sans-serif";
    const revision = data.revision;
    for (const text of [
      `فاتورة معدلة — بديلة عن ${revision.originalReceiptNumber}`,
      `طلبها: ${revision.revisedByName} — ${revision.revisedAt}`,
      revision.approvedByName
        ? `اعتمدها: ${revision.approvedByName}${revision.approvedAt ? ` — ${revision.approvedAt}` : ""}`
        : "",
    ])
      for (const line of receiptTextLines(ctx, text)) {
        ctx.fillText(line, W - PAD, y);
        y += 22;
      }
  }
  receiptRule(ctx, y);
  return y + 26;
}

import { CO, RECEIPT_PHONES } from "./brand";
import type { ReceiptBrowserData } from "./printTemplates";
import type { ReceiptAssets } from "./receiptLayoutAssets";
import {
  RECEIPT_PAD as PAD,
  RECEIPT_WIDTH as W,
  receiptRule,
  receiptTextLines,
} from "./receiptLayout";
import { receiptStorefrontModel } from "./receiptStorefront";

/** One QR/caption, every contact, and only real coupon terms; no duplicate promotional block. */
export function drawReceiptFooter(
  ctx: CanvasRenderingContext2D,
  data: ReceiptBrowserData,
  assets: ReceiptAssets,
  top: number,
): number {
  let y = top + 6;
  receiptRule(ctx, y);
  y += 24;
  const centered = (text: string, font: string, lineHeight: number) => {
    ctx.font = font;
    ctx.textAlign = "center";
    for (const line of receiptTextLines(ctx, text)) {
      ctx.fillText(line, W / 2, y);
      y += lineHeight;
    }
  };
  centered("شكراً لتسوقكم معنا", "800 20px Cairo, sans-serif", 24);
  const store = receiptStorefrontModel();
  if (assets.storefront) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      assets.storefront,
      Math.round((W - store.sizeDots) / 2),
      y,
      store.sizeDots,
      store.sizeDots,
    );
    ctx.restore();
    y += store.sizeDots + 18;
  }
  centered(
    "امسح الرمز للتسوق عبر متجرنا الإلكتروني",
    "800 18px Cairo, sans-serif",
    22,
  );
  centered(store.displayUrl, "800 19px Cairo, sans-serif", 24);

  const width = (W - PAD * 2 - 16) / 2;
  for (let index = 0; index < RECEIPT_PHONES.length; index += 2) {
    const contacts = RECEIPT_PHONES.slice(index, index + 2);
    const rows = contacts.map((contact) => {
      ctx.font = "700 16px Cairo, sans-serif";
      return { contact, label: receiptTextLines(ctx, contact.l, width) };
    });
    const labelHeight =
      Math.max(...rows.map((row) => row.label.length), 1) * 19;
    rows.forEach(({ contact, label }, column) => {
      const center = column === 0 ? W - PAD - width / 2 : PAD + width / 2;
      ctx.textAlign = "center";
      ctx.font = "700 16px Cairo, sans-serif";
      label.forEach((line, lineIndex) =>
        ctx.fillText(line, center, y + lineIndex * 19),
      );
      ctx.font = "900 20px Cairo, sans-serif";
      ctx.fillText(contact.n, center, y + labelHeight);
    });
    y += labelHeight + 26;
  }
  centered(CO.address, "700 17px Cairo, sans-serif", 22);
  receiptRule(ctx, y - 8, true);
  y += 12;
  centered(
    "نعتذر عن قبول الاسترجاع — والاستبدال متاح",
    "800 17px Cairo, sans-serif",
    22,
  );
  centered(
    "خلال 48 ساعة بشرط سلامة المنتج بـ100%",
    "800 17px Cairo, sans-serif",
    22,
  );

  if (data.bounceBackCoupon) {
    const coupon = data.bounceBackCoupon;
    receiptRule(ctx, y, true);
    y += 24;
    centered(coupon.headline, "900 20px Cairo, sans-serif", 24);
    centered(`خصم ${coupon.discountText}`, "900 22px Cairo, sans-serif", 26);
    centered(coupon.code, "900 22px Cairo, sans-serif", 26);
    if (coupon.minSpendText)
      centered(coupon.minSpendText, "800 18px Cairo, sans-serif", 22);
    centered(coupon.validToText, "800 18px Cairo, sans-serif", 22);
    centered(
      "احتفظ بهذه القسيمة وقدّمها للكاشير في زيارتك القادمة",
      "700 17px Cairo, sans-serif",
      22,
    );
  }
  return y + PAD;
}

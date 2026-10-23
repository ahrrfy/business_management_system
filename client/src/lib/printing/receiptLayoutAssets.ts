import { code128Svg } from "./barcode";
import { logoUrl } from "./brand";
import { CARD_BRAND_LOGO_URL, isCardPaymentMethod } from "./cardBrandLogos";
import { receiptStorefrontPng } from "./receiptStorefront";
import type { ReceiptBrowserData } from "./printTemplates";

export interface ReceiptAssets {
  logo: HTMLImageElement | null;
  barcode: { image: HTMLImageElement; width: number; height: number } | null;
  storefront: HTMLImageElement | null;
  card: HTMLImageElement | null;
}
async function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
async function barcodeImage(number: string): Promise<ReceiptAssets["barcode"]> {
  try {
    const barcode = code128Svg(number, {
      moduleWidth: 2,
      height: 56,
      showText: false,
    });
    const image = await loadImage(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(barcode.svg)}`,
    );
    return image
      ? { image, width: barcode.widthPx, height: barcode.heightPx }
      : null;
  } catch {
    return null;
  }
}
export async function receiptAssets(
  data: ReceiptBrowserData,
): Promise<ReceiptAssets> {
  const needsCard =
    isCardPaymentMethod(data.paymentMethod) ||
    data.paymentLegs?.some((leg) => isCardPaymentMethod(leg.method));
  const [logo, barcode, storefront, card] = await Promise.all([
    loadImage(logoUrl()),
    barcodeImage(data.receiptNumber),
    receiptStorefrontPng()
      .then(loadImage)
      .catch(() => null),
    needsCard ? loadImage(CARD_BRAND_LOGO_URL) : null,
  ]);
  return { logo, barcode, storefront, card };
}

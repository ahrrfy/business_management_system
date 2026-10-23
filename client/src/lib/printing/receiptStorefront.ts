import { STOREFRONT_URL } from "./brand";
import { qrCodeDataUrl, qrCodeSvgSync, qrPixelLayout } from "./qr";
import { receiptDotsToMm } from "./receiptLayout";

export function receiptStorefrontModel() {
  const qr = qrPixelLayout(STOREFRONT_URL, 256, 4);
  return {
    url: STOREFRONT_URL,
    displayUrl: STOREFRONT_URL.replace(/^https?:\/\//, ""),
    ...qr,
    sizeMm: receiptDotsToMm(qr.sizeDots),
  };
}
export function receiptStorefrontSvg() {
  const model = receiptStorefrontModel();
  return qrCodeSvgSync(model.url, {
    size: model.sizeDots,
    margin: model.quietModules,
  });
}
export function receiptStorefrontPng() {
  const model = receiptStorefrontModel();
  return qrCodeDataUrl(model.url, {
    size: model.sizeDots,
    margin: model.quietModules,
  });
}

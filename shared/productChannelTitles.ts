export type ProductChannel =
  | "store"
  | "seo"
  | "card"
  | "pos"
  | "invoice"
  | "internal";

export type ProductTitleSource = {
  name: string;
  internalName?: string | null;
  storeTitle?: string | null;
  seoTitle?: string | null;
  shortTitle?: string | null;
  posLabel?: string | null;
  invoiceLabel?: string | null;
};

function firstNonEmpty(
  fallback: string,
  ...values: Array<string | null | undefined>
): string {
  return (
    values
      .find((value) => typeof value === "string" && value.trim().length > 0)
      ?.trim() || fallback
  );
}

/**
 * نقطة القرار الوحيدة لأسماء العرض. لا تغيّر البيانات ولا تكتب في قاعدة البيانات.
 * عند عدم تطبيق الهجرة أو عدم تعبئة الحقول الجديدة، يبقى السلوك القديم فعالاً عبر fallback إلى name.
 */
export function titleForChannel(
  product: ProductTitleSource,
  channel: ProductChannel,
): string {
  const fallback = product.name.trim();
  switch (channel) {
    case "store":
      return firstNonEmpty(fallback, product.storeTitle);
    case "seo":
      return firstNonEmpty(fallback, product.seoTitle, product.storeTitle);
    case "card":
      return firstNonEmpty(fallback, product.shortTitle, product.storeTitle);
    case "pos":
      return firstNonEmpty(fallback, product.posLabel, product.shortTitle);
    case "invoice":
      return firstNonEmpty(fallback, product.invoiceLabel, product.shortTitle);
    case "internal":
      return firstNonEmpty(fallback, product.internalName);
  }
}

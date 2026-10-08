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

export type ProductChannelLabelsUpdateInput = {
  name?: string | null;
  posLabel?: string | null;
  invoiceLabel?: string | null;
  storeTitle?: string | null;
  shortTitle?: string | null;
};

export type ExistingProductChannelLabels = {
  name: string;
  posLabel?: string | null;
  invoiceLabel?: string | null;
  storeTitle?: string | null;
  shortTitle?: string | null;
};

export type ChannelLabelsPatch = {
  posLabel?: string | null;
  invoiceLabel?: string | null;
  storeTitle?: string | null;
  shortTitle?: string | null;
};

export type ResolvedProductChannelLabels = {
  name: string;
  isNameUpdated: boolean;
  posLabel: string | null;
  invoiceLabel: string | null;
  storeTitle: string | null;
  shortTitle: string | null;
  patch: ChannelLabelsPatch;
};

/**
 * يحدّد عناوين القنوات عند تعديل المنتج:
 * - إذا أُرسلت قيمة صريحة لأي عنوان، تُعتمد قيمتها (بعد التقليم، أو null إذا كانت فارغة).
 * - إذا تغير اسم المنتج (name) ولم تُرسل عناوين القنوات (كانت undefined)، تُزامن تلقائياً مع الاسم الجديد:
 *   - posLabel: مقتطع إلى 120 محرفاً (حد جدول products).
 *   - shortTitle: مقتطع إلى 160 محرفاً (حد جدول products).
 *   - invoiceLabel: مقتطع إلى 255 محرفاً (حد جدول products).
 *   - storeTitle: مقتطع إلى 255 محرفاً (حد جدول products).
 * - إذا لم يتغير اسم المنتج وكانت المدخلات undefined، تُترك القيم كما هي حفظاً للتخصيص القائم.
 * - يُنتج كائن patch يحتوي الحقول التي تتطلب التحديث فقط في قاعدة البيانات.
 */
export function resolveChannelLabelsOnUpdate(
  input: ProductChannelLabelsUpdateInput,
  existing: ExistingProductChannelLabels,
): ResolvedProductChannelLabels {
  const newName = (input.name ?? "").trim() || (existing.name ?? "").trim();
  const isNameUpdated = newName !== (existing.name ?? "").trim();

  const posLabel =
    input.posLabel !== undefined
      ? input.posLabel?.trim() || null
      : isNameUpdated
        ? newName.slice(0, 120)
        : undefined;

  const invoiceLabel =
    input.invoiceLabel !== undefined
      ? input.invoiceLabel?.trim() || null
      : isNameUpdated
        ? newName.slice(0, 255)
        : undefined;

  const storeTitle =
    input.storeTitle !== undefined
      ? input.storeTitle?.trim() || null
      : isNameUpdated
        ? newName.slice(0, 255)
        : undefined;

  const shortTitle =
    input.shortTitle !== undefined
      ? input.shortTitle?.trim() || null
      : isNameUpdated
        ? newName.slice(0, 160)
        : undefined;

  return {
    name: newName,
    isNameUpdated,
    posLabel: posLabel !== undefined ? posLabel : (existing.posLabel ?? null),
    invoiceLabel: invoiceLabel !== undefined ? invoiceLabel : (existing.invoiceLabel ?? null),
    storeTitle: storeTitle !== undefined ? storeTitle : (existing.storeTitle ?? null),
    shortTitle: shortTitle !== undefined ? shortTitle : (existing.shortTitle ?? null),
    patch: {
      ...(posLabel !== undefined ? { posLabel } : {}),
      ...(invoiceLabel !== undefined ? { invoiceLabel } : {}),
      ...(storeTitle !== undefined ? { storeTitle } : {}),
      ...(shortTitle !== undefined ? { shortTitle } : {}),
    },
  };
}


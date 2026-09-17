export type ExactProductResolution = "FOUND" | "NOT_FOUND" | "BLOCKED" | "STALE";

export interface PricingRequestToken {
  generation: number;
  context: string;
}

export interface PricingRequestGuard {
  begin(context: string): PricingRequestToken;
  isCurrent(token: PricingRequestToken, currentContext: string): boolean;
}

/** حارس صغير يمنع استجابة بحث/باركود قديمة من الكتابة بعد تبدّل العميل أو الفئة أو الفرع. */
export function createLatestPricingRequestGuard(): PricingRequestGuard {
  let generation = 0;
  return {
    begin(context: string): PricingRequestToken {
      return { generation: ++generation, context };
    },
    isCurrent(token: PricingRequestToken, currentContext: string): boolean {
      return token.generation === generation && token.context === currentContext;
    },
  };
}

/**
 * يسجّل نية اختيار العميل/الفئة قبل قرار «لا تغيير».
 *
 * هذا الترتيب مقصود: إذا كان طلب B معلّقاً بينما القيمة المثبّتة ما تزال A، ثم عاد المستخدم
 * إلى A، فالعودة نفسها جيلٌ أحدث يجب أن يبطل B حتى لو لم تحتج dispatch جديداً.
 */
export function beginPricingSelectionIntent<T>(
  guard: PricingRequestGuard,
  context: string,
  currentValue: T,
  nextValue: T,
): { token: PricingRequestToken; changed: boolean } {
  const token = guard.begin(context);
  return { token, changed: !Object.is(currentValue, nextValue) };
}

export interface PricingContextRequestGuard {
  /** يعلن تبدّل سياق التسعير ويبطل كل الطلبات الملتقطة في السياق السابق. */
  sync(context: string): void;
  /** يلتقط الجيل الحالي بلا إبطال الطلبات المتوازية في السياق نفسه. */
  capture(): PricingRequestToken;
  isCurrent(token: PricingRequestToken, currentContext: string): boolean;
}

export function buildProductPricingContext(input: {
  invoiceType: string;
  branchId: number;
  tier: string;
  customerId?: number | null;
  purchaseCurrency?: string;
  purchaseAgreedRate?: string;
}): string {
  const base = `${input.invoiceType}:${input.branchId}:${input.tier}:${input.customerId ?? "none"}`;
  const isPurchase = input.invoiceType === "PURCHASE" || input.invoiceType === "PURCHASE_RETURN";
  if (!isPurchase) return base;

  const currency = (input.purchaseCurrency ?? "IQD").trim().toUpperCase();
  const agreedRate = (input.purchaseAgreedRate ?? "").trim() || "none";
  return `${base}:purchase:${currency}:${agreedRate}`;
}

/**
 * حارس لمسوح الباركود المتوازية: الجيل يتغيّر مع سياق التسعير لا مع كل مسح.
 * لذلك يُسمح لعدة مسوح في العميل/الفئة/الفرع نفسها أن تضيف نتائجها، وتُرفض كلها فور تبدّل السياق.
 */
export function createPricingContextRequestGuard(initialContext: string): PricingContextRequestGuard {
  let generation = 0;
  let context = initialContext;
  return {
    sync(nextContext: string): void {
      if (nextContext === context) return;
      context = nextContext;
      generation += 1;
    },
    capture(): PricingRequestToken {
      return { generation, context };
    },
    isCurrent(token: PricingRequestToken, currentContext: string): boolean {
      return token.generation === generation && token.context === context && context === currentContext;
    },
  };
}

export async function resolveExactBeforeFuzzy<T>(
  resolveExact: () => Promise<ExactProductResolution>,
  readFuzzy: () => T,
): Promise<{ status: ExactProductResolution; fuzzy?: T }> {
  const status = await resolveExact();
  return status === "NOT_FOUND" ? { status, fuzzy: readFuzzy() } : { status };
}

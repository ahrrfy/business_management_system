export type ExactProductResolution = "FOUND" | "NOT_FOUND" | "BLOCKED" | "STALE";

export interface PricingRequestToken {
  generation: number;
  context: string;
}

/** حارس صغير يمنع استجابة بحث/باركود قديمة من الكتابة بعد تبدّل العميل أو الفئة أو الفرع. */
export function createLatestPricingRequestGuard() {
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

export async function resolveExactBeforeFuzzy<T>(
  resolveExact: () => Promise<ExactProductResolution>,
  readFuzzy: () => T,
): Promise<{ status: ExactProductResolution; fuzzy?: T }> {
  const status = await resolveExact();
  return status === "NOT_FOUND" ? { status, fuzzy: readFuzzy() } : { status };
}

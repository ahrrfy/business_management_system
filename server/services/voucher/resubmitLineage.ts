export type ExpensePaymentResubmitFamily = "asset" | "expense";

export type ExpensePaymentResubmitKey = {
  family: ExpensePaymentResubmitFamily;
  rootReceiptId: number;
  attempt: number;
};

const KEY_PATTERN =
  /^system-(asset|expense)-resubmit-([1-9][0-9]*)-A([1-9][0-9]*)$/;
const DESCRIPTION_SUFFIX_PATTERN =
  /(?:^| — )المحاولة A([1-9][0-9]*) بعد السند #([1-9][0-9]*): ([^\r\n]{5,})(?:\r?\n\[رُفض [\s\S]*\])?$/;

export function parseExpensePaymentResubmitKey(
  clientRequestId: string,
): ExpensePaymentResubmitKey | null {
  const match = KEY_PATTERN.exec(clientRequestId);
  if (!match) return null;
  const rootReceiptId = Number(match[2]);
  const attempt = Number(match[3]);
  if (!Number.isSafeInteger(rootReceiptId) || !Number.isSafeInteger(attempt)) {
    return null;
  }
  return {
    family: match[1] as ExpensePaymentResubmitFamily,
    rootReceiptId,
    attempt,
  };
}

export function expensePaymentResubmitKey(
  input: ExpensePaymentResubmitKey,
): string {
  return `system-${input.family}-resubmit-${input.rootReceiptId}-A${input.attempt}`;
}

export function expensePaymentResubmitDescriptionSuffix(input: {
  attempt: number;
  priorReceiptId: number;
  reissueReason: string;
}): string {
  return `المحاولة A${input.attempt} بعد السند #${input.priorReceiptId}: ${input.reissueReason.trim()}`;
}

export function parseExpensePaymentResubmitDescription(
  description: string | null | undefined,
): { attempt: number; priorReceiptId: number; reissueReason: string } | null {
  const match = DESCRIPTION_SUFFIX_PATTERN.exec(description?.trim() ?? "");
  if (!match) return null;
  const attempt = Number(match[1]);
  const priorReceiptId = Number(match[2]);
  const reissueReason = match[3].trim();
  if (
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(priorReceiptId) ||
    reissueReason.length < 5
  ) {
    return null;
  }
  return { attempt, priorReceiptId, reissueReason };
}

export interface EmptyCompanyStatementDraft<TPartyId, TAmount extends number | string> {
  partyId: TPartyId;
  statementNumber: "";
  statementDate: "";
  statementDeductions: TAmount;
  statementNotes: "";
  countedCash: TAmount;
  selections: Record<number, never>;
  amounts: Record<number, string>;
  queueIds: number[];
  countedBreakdown: Record<number, number>;
}

/**
 * يبني مسودةً فارغة فقط عند الانتقال الفعلي بين جهتين.
 * إبقاء نتيجة الانتقال لنفس الجهة `null` مهم لمسح أكثر من بوليصة للشركة نفسها دون فقد الطابور.
 */
export function companyStatementPartyTransition<
  TPartyId extends number | string | null,
  TAmount extends number | string,
>(
  currentPartyId: TPartyId,
  nextPartyId: TPartyId,
  emptyAmount: TAmount,
): EmptyCompanyStatementDraft<TPartyId, TAmount> | null {
  if (currentPartyId === nextPartyId) return null;

  return {
    partyId: nextPartyId,
    statementNumber: "",
    statementDate: "",
    statementDeductions: emptyAmount,
    statementNotes: "",
    countedCash: emptyAmount,
    selections: {},
    amounts: {},
    queueIds: [],
    countedBreakdown: {},
  };
}

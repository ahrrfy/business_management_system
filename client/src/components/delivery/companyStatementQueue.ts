import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { D, round2 } from "@/lib/money";

export interface CompanyStatementQueueCandidate {
  id: number;
  consignmentNumber: string;
  externalTrackingRef?: string | null;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
  customerName?: string | null;
  recipientName?: string | null;
  customerPhone?: string | null;
  recipientPhone?: string | null;
  address?: string | null;
  deliveryAddress?: string | null;
  codAmount: string | number;
  collectedAmount: string | number;
  counterSettledAmount?: string | number | null;
  shortfallAssigned?: string | number | null;
}

export function statementQueueRemaining(candidate: CompanyStatementQueueCandidate) {
  const remaining = round2(
    D(candidate.codAmount)
      .minus(D(candidate.collectedAmount))
      .minus(D(candidate.counterSettledAmount))
      .minus(D(candidate.shortfallAssigned)),
  );
  return remaining.isNegative() ? D(0) : remaining;
}

export type StatementBarcodeResolution =
  | { kind: "EMPTY" }
  | { kind: "NOT_FOUND"; trackingRef: string }
  | { kind: "AMBIGUOUS"; trackingRef: string; matches: number }
  | { kind: "DUPLICATE"; trackingRef: string; candidate: CompanyStatementQueueCandidate }
  | { kind: "ADDED"; trackingRef: string; candidate: CompanyStatementQueueCandidate };

/** يطابق الباركود مع رقم بوليصة الشركة حصراً، ويحفظ الصفر البادئ كما في الكشف المطبوع. */
export function resolveCompanyStatementBarcode(
  candidates: readonly CompanyStatementQueueCandidate[],
  raw: string,
  queuedIds: ReadonlySet<number>,
): StatementBarcodeResolution {
  const trackingRef = normalizeBarcodeScannerInput(raw);
  if (!trackingRef) return { kind: "EMPTY" };
  const matches = candidates.filter(
    (candidate) => normalizeBarcodeScannerInput(candidate.externalTrackingRef ?? "") === trackingRef,
  );
  if (matches.length === 0) return { kind: "NOT_FOUND", trackingRef };
  if (matches.length > 1) return { kind: "AMBIGUOUS", trackingRef, matches: matches.length };
  const candidate = matches[0];
  return queuedIds.has(candidate.id)
    ? { kind: "DUPLICATE", trackingRef, candidate }
    : { kind: "ADDED", trackingRef, candidate };
}

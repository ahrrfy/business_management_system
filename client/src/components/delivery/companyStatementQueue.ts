import type { DeliverySourceReference } from "@shared/deliverySource";
import {
  normalizeBarcodeScannerInput,
  trackingRefsEquivalent,
} from "@/lib/barcodeScannerInput";
import { D, round2 } from "@/lib/money";

export interface CompanyStatementQueueCandidate extends DeliverySourceReference {
  id: number;
  consignmentNumber: string;
  externalTrackingRef?: string | null;
  shipmentLeaderConsignmentId?: number | null;
  shipmentInvoiceCount?: number;
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
  remainingDue?: string | number | null;
  codDue?: string | number | null;
  status?: string | null;
  consignmentStatus?: string | null;
  returnDeclaredAt?: Date | string | null;
}

export function shipmentStatementCandidates<T extends CompanyStatementQueueCandidate>(candidates: readonly T[], consignmentId: number): T[] {
  const selected = candidates.find((candidate) => candidate.id === consignmentId);
  if (!selected) return [];
  return selected.shipmentLeaderConsignmentId == null ? [selected]
    : candidates.filter((candidate) => candidate.shipmentLeaderConsignmentId === selected.shipmentLeaderConsignmentId);
}

export function statementQueueRemaining(candidate: CompanyStatementQueueCandidate) {
  if (candidate.sourceType === "AFTERCARE_EXECUTION") return D(0);
  const status = candidate.consignmentStatus ?? candidate.status;
  if (candidate.returnDeclaredAt != null || (status != null && !["DISPATCHED", "PARTIAL"].includes(status))) return D(0);
  const serverDue = candidate.remainingDue ?? candidate.codDue;
  if (serverDue != null) return round2(D(serverDue)).clamp(0, Infinity);
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

/**
 * يطابق الباركود مع رقم بوليصة الشركة حصراً، مع التسامح التام مع الأصفار البادئة (0, 00, 000):
 * 1. المطابقة التامة المباشرة (أولوية قصوى)
 * 2. المطابقة القانونية المتسامحة مع الأصفار البادئة عند اختلاف التنسيق بين الكشف المطبوع والمدخل
 * 3. حارس عدم اللبس: عند وجود أكثر من إرسالية تطابق النواة يرفض الحسم كـ AMBIGUOUS لمنع التخمين
 */
export function resolveCompanyStatementBarcode(
  candidates: readonly CompanyStatementQueueCandidate[],
  raw: string,
  queuedIds: ReadonlySet<number>,
): StatementBarcodeResolution {
  const trackingRef = normalizeBarcodeScannerInput(raw);
  if (!trackingRef) return { kind: "EMPTY" };

  // 1. المطابقة التامة المباشرة أولاً
  const exactMatches = candidates.filter(
    (candidate) => normalizeBarcodeScannerInput(candidate.externalTrackingRef ?? "") === trackingRef,
  );
  if (exactMatches.length === 1) {
    const candidate = exactMatches[0];
    return queuedIds.has(candidate.id)
      ? { kind: "DUPLICATE", trackingRef, candidate }
      : { kind: "ADDED", trackingRef, candidate };
  }
  if (exactMatches.length > 1) {
    return { kind: "AMBIGUOUS", trackingRef, matches: exactMatches.length };
  }

  // 2. المطابقة المتسامحة مع الأصفار البادئة (0, 00, 000)
  const canonicalMatches = candidates.filter((candidate) =>
    trackingRefsEquivalent(candidate.externalTrackingRef, trackingRef),
  );
  if (canonicalMatches.length === 0) return { kind: "NOT_FOUND", trackingRef };
  if (canonicalMatches.length > 1) return { kind: "AMBIGUOUS", trackingRef, matches: canonicalMatches.length };

  const candidate = canonicalMatches[0];
  return queuedIds.has(candidate.id)
    ? { kind: "DUPLICATE", trackingRef, candidate }
    : { kind: "ADDED", trackingRef, candidate };
}


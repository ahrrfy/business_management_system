import type { DeliverySourceReference } from "@shared/deliverySource";
import { docBarcode } from "@shared/documentNumber";
import {
  normalizeBarcodeScannerInput,
  normalizeKnownSystemBarcode,
  trackingRefsEquivalent,
} from "@/lib/barcodeScannerInput";
import { D, fmt, round2 } from "@/lib/money";
import { digitsArabicToLatin } from "@shared/numberNormalize";
import { isShortfallReason, SHORTFALL_REASON_LABEL_AR, type ShortfallReason } from "@shared/shortfallReason";
import Decimal from "decimal.js";

export interface CompanyStatementQueueCandidate extends DeliverySourceReference {
  id: number;
  consignmentNumber: string;
  shipmentNumber?: string | null;
  externalTrackingRef?: string | null;
  shipmentTrackingRef?: string | null;
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
  cashInCourierCustody?: string | number | null;
  orderTotal?: string | number | null;
  invoicePaidAmount?: string | number | null;
  parcelStatus?: string | null;
  feeWithholdingCash?: string | number | null;
  feeCollection?: string | null;
  status?: string | null;
  consignmentStatus?: string | null;
  returnDeclaredAt?: Date | string | null;
}

export type StatementResponsibility = "CUSTOMER" | "DELIVERY_PARTY" | "COURIER_CUSTODY";
export type StatementDecision = {
  shortfallResponsibility?: StatementResponsibility;
  shortfallReason?: ShortfallReason;
  zeroDeliveryConfirmed?: boolean;
};

/** Keep the claim seen at selection time independent of the editable statement amount. */
export function statementClaimSnapshot(candidate: CompanyStatementQueueCandidate): string {
  return JSON.stringify({
    id: candidate.id,
    invoiceId: candidate.invoiceId ?? null,
    invoiceNumber: candidate.invoiceNumber ?? null,
    due: statementQueueRemaining(candidate).toFixed(2),
    custody: candidate.cashInCourierCustody == null ? null : round2(D(candidate.cashInCourierCustody)).toFixed(2),
    orderTotal: candidate.orderTotal == null ? null : round2(D(candidate.orderTotal)).toFixed(2),
    invoicePaid: candidate.invoicePaidAmount == null ? null : round2(D(candidate.invoicePaidAmount)).toFixed(2),
    parcelStatus: candidate.parcelStatus ?? null,
    status: candidate.consignmentStatus ?? candidate.status ?? null,
    leader: candidate.shipmentLeaderConsignmentId ?? null,
    fee: candidate.feeWithholdingCash == null ? null : round2(D(candidate.feeWithholdingCash)).toFixed(2),
  });
}

export function parseStatementAmount(value: string | undefined) {
  const normalized = digitsArabicToLatin(value ?? "").trim().replace(/٫/g, ".");
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(normalized)) return null;
  const amount = D(normalized);
  return amount.isFinite() && amount.lte("9999999999999.99") ? round2(amount) : null;
}

export function statementAmountsMatchClaims(
  candidates: readonly CompanyStatementQueueCandidate[],
  amounts: Readonly<Record<number, string>>,
  snapshots: Readonly<Record<number, string>>,
): boolean {
  return candidates.every((candidate) => {
    const amount = parseStatementAmount(amounts[candidate.id]);
    return amount != null && amount.lte(statementQueueRemaining(candidate)) &&
      snapshots[candidate.id] === statementClaimSnapshot(candidate);
  });
}

/** Split only what existing collection evidence actually proves. */
export function statementDifference(candidate: CompanyStatementQueueCandidate, value: string | undefined) {
  const amount = parseStatementAmount(value);
  if (amount == null || candidate.cashInCourierCustody == null) return null;
  const due = statementQueueRemaining(candidate);
  const proven = round2(D(candidate.cashInCourierCustody));
  if (!proven.isFinite() || proven.lt(0) || proven.gt(due) || amount.gt(due)) return null;
  const custody = round2(Decimal.max(0, proven.minus(amount)));
  const unproven = round2(Decimal.max(0, due.minus(Decimal.max(proven, amount))));
  return { due, amount, proven, custody, unproven };
}

export function statementDecisionValid(candidate: CompanyStatementQueueCandidate, amount: string | undefined, decision: StatementDecision | undefined): boolean {
  const parsed = parseStatementAmount(amount);
  if (!parsed) return false;
  const due = statementQueueRemaining(candidate);
  if (parsed.isZero() && (due.gt(0) || candidate.parcelStatus !== "DELIVERED") && !decision?.zeroDeliveryConfirmed) return false;
  if (candidate.cashInCourierCustody == null) return false;
  const proven = D(candidate.cashInCourierCustody);
  if (!proven.isFinite() || proven.lt(0) || proven.gt(due)) return false;
  if (parsed.eq(due)) return true;
  const difference = statementDifference(candidate, amount);
  if (!difference) return false;
  if (difference.unproven.isZero()) return decision?.shortfallResponsibility === "COURIER_CUSTODY";
  if (decision?.shortfallResponsibility === "CUSTOMER") return true;
  return decision?.shortfallResponsibility === "DELIVERY_PARTY" && isShortfallReason(decision.shortfallReason);
}

export function statementLineSummary(candidate: CompanyStatementQueueCandidate, amount: string, decision?: StatementDecision): string {
  const difference = statementDifference(candidate, amount);
  const labels: Record<StatementResponsibility, string> = {
    CUSTOMER: "العميل", DELIVERY_PARTY: "جهة التوصيل", COURIER_CUSTODY: "عهدة جهة التوصيل",
  };
  const parts = [`${candidate.invoiceNumber ?? candidate.consignmentNumber}: ${fmt(amount)} د.ع`];
  if (difference?.custody.gt(0)) parts.push(`عهدة مثبتة متبقية ${fmt(difference.custody.toFixed(2))}`);
  if (difference?.unproven.gt(0)) parts.push(`فرق غير مثبت ${fmt(difference.unproven.toFixed(2))}`);
  if (decision?.shortfallResponsibility && parseStatementAmount(amount)?.lt(statementQueueRemaining(candidate))) {
    parts.push(`مسؤولية الفرق: ${labels[decision.shortfallResponsibility]}`);
    if (decision.shortfallResponsibility === "DELIVERY_PARTY" && decision.shortfallReason) parts.push(`السبب: ${SHORTFALL_REASON_LABEL_AR[decision.shortfallReason]}`);
  }
  return parts.join(" · ");
}

/** Fees stay with their physical shipment even when the fee owner's cash line is zero. */
export function statementShipmentFees(
  candidates: readonly CompanyStatementQueueCandidate[],
  amounts: Readonly<Record<number, string>>,
) {
  const groups = new Map<number, { cash: Decimal; fee: Decimal; uncertain: boolean; insufficient: boolean }>();
  for (const row of candidates) {
    const key = row.shipmentLeaderConsignmentId ?? row.id;
    const group = groups.get(key) ?? { cash: D(0), fee: D(0), uncertain: false, insufficient: false };
    const cash = parseStatementAmount(amounts[row.id]) ?? D(0);
    const fee = parseStatementAmount(String(row.feeWithholdingCash ?? "0"));
    if (!fee) group.uncertain = true;
    else {
      group.fee = group.fee.plus(fee);
      // An already-zero claim may carry its own quote and a projection of the same
      // fee onto a sibling. Without source-level attribution, ask for the document's
      // explicit deduction rather than guess whether those quotes are distinct.
      if (statementQueueRemaining(row).isZero() && fee.gt(0)) group.uncertain = true;
    }
    group.cash = group.cash.plus(cash);
    groups.set(key, group);
  }
  let total = D(0), insufficient = false, needsExplicit = false;
  for (const group of Array.from(groups.values())) {
    if (group.cash.isZero()) continue; // zero-only statement does not remit fees
    if (group.uncertain) needsExplicit = true;
    else {
      total = total.plus(group.fee);
      if (group.fee.gt(group.cash)) insufficient = true;
    }
    if (group.insufficient) insufficient = true;
  }
  return { total: round2(total), insufficient, needsExplicit };
}

export function statementDraftLines(
  candidates: readonly CompanyStatementQueueCandidate[],
  amounts: Readonly<Record<number, string>>,
  snapshots: Readonly<Record<number, string>>,
  decisions: Readonly<Record<number, StatementDecision>>,
) {
  if (!statementAmountsMatchClaims(candidates, amounts, snapshots)) return null;
  if (candidates.some((candidate) => candidate.cashInCourierCustody == null)) return null;
  if (candidates.some((candidate) => !statementDecisionValid(candidate, amounts[candidate.id], decisions[candidate.id]))) return null;
  return candidates.map((candidate) => {
    const amount = parseStatementAmount(amounts[candidate.id])!;
    const claim = JSON.parse(snapshots[candidate.id]) as { due: string; custody: string };
    const decision = decisions[candidate.id];
    const partial = amount.lt(statementQueueRemaining(candidate));
    return {
      consignmentId: candidate.id,
      collectedAmount: amount.toFixed(2),
      expectedDue: claim.due,
      expectedProven: claim.custody,
      ...(amount.isZero() && decision?.zeroDeliveryConfirmed ? { zeroDeliveryConfirmed: true } : {}),
      ...(partial ? { shortfallResponsibility: decision?.shortfallResponsibility } : {}),
      ...(partial && decision?.shortfallResponsibility === "DELIVERY_PARTY" ? { shortfallReason: decision.shortfallReason } : {}),
    };
  });
}

export function shipmentStatementCandidates<T extends CompanyStatementQueueCandidate>(candidates: readonly T[], consignmentId: number): T[] {
  const selected = candidates.find((candidate) => candidate.id === consignmentId);
  if (!selected) return [];
  const leaderId = selected.shipmentLeaderConsignmentId ?? selected.id;
  return candidates.filter((candidate) =>
    (candidate.shipmentLeaderConsignmentId ?? candidate.id) === leaderId,
  );
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
 * 3. حارس عدم اللبس: تعدّد فواتير الشحنة نفسها ليس تعدّد بوليصات؛ تعدّد الشحنات يرفض الحسم.
 */
export function resolveCompanyStatementBarcode(
  candidates: readonly CompanyStatementQueueCandidate[],
  raw: string,
  queuedIds: ReadonlySet<number>,
): StatementBarcodeResolution {
  const trackingRef = normalizeBarcodeScannerInput(raw);
  if (!trackingRef) return { kind: "EMPTY" };

  const references = (candidate: CompanyStatementQueueCandidate) =>
    [candidate.externalTrackingRef, candidate.shipmentTrackingRef].filter(
      (reference): reference is string => !!reference,
    );
  const documentReferences = (candidate: CompanyStatementQueueCandidate) =>
    [
      candidate.consignmentNumber,
      candidate.consignmentNumber ? docBarcode("CN", candidate.consignmentNumber) : null,
      candidate.shipmentNumber,
      candidate.shipmentNumber ? docBarcode("SHP", candidate.shipmentNumber) : null,
      candidate.invoiceNumber,
      candidate.invoiceNumber ? docBarcode("INV", candidate.invoiceNumber) : null,
      candidate.orderNumber,
      candidate.orderNumber
        ? docBarcode(
            candidate.sourceType === "WORK_ORDER" || candidate.workOrderId != null ? "WO" : "ORD",
            candidate.orderNumber,
          )
        : null,
    ].filter((reference): reference is string => !!reference);

  // Exact matches retain priority over the leading-zero fallback.
  const exactMatches = candidates.filter((candidate) =>
    references(candidate).some((reference) => normalizeBarcodeScannerInput(reference) === trackingRef),
  );
  const trackingMatches = exactMatches.length > 0 ? exactMatches : candidates.filter((candidate) =>
    references(candidate).some((reference) => trackingRefsEquivalent(reference, trackingRef)),
  );
  const systemRef = normalizeKnownSystemBarcode(trackingRef);
  const upperRef = systemRef.toUpperCase();
  const matches =
    trackingMatches.length > 0
      ? trackingMatches
      : /^(?:CNS?|SHP|INV|WO|ORD)-/i.test(systemRef)
        ? candidates.filter((candidate) =>
            documentReferences(candidate).some(
              (reference) => normalizeBarcodeScannerInput(reference).toUpperCase() === upperRef,
            ),
          )
        : [];
  if (matches.length === 0) return { kind: "NOT_FOUND", trackingRef };

  const groups = new Map<number, CompanyStatementQueueCandidate[]>();
  for (const candidate of matches) {
    const leaderId = candidate.shipmentLeaderConsignmentId ?? candidate.id;
    groups.set(leaderId, [...(groups.get(leaderId) ?? []), candidate]);
  }
  if (groups.size > 1) return { kind: "AMBIGUOUS", trackingRef, matches: groups.size };

  const [leaderId, matched] = groups.entries().next().value!;
  const candidate = matched.find((row) => row.id === leaderId) ?? matched[0];
  const shipment = shipmentStatementCandidates(candidates, candidate.id);
  return shipment.every((member) => queuedIds.has(member.id))
    ? { kind: "DUPLICATE", trackingRef, candidate }
    : { kind: "ADDED", trackingRef, candidate };
}


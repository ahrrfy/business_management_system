/** Identify a cart return by its ledger entry, never by a nullable receipt alone. */
export const SALES_RETURN_CART_RESULT_ACTION = "sale.return_cart.result";
export type ReturnHistoryEntry = {
  id: number;
  receiptId: number | null;
  notes: string | null;
  receiptDescription?: string | null;
};

type AuditRow = { newValue: unknown; action?: string; entityId?: string | null };

export function returnNumberFromText(text: string | null | undefined): string | null {
  const source = text ?? "";
  // Direct cart notes and receipts place the number immediately after a fixed prefix;
  // the customer name after it is untrusted and may itself contain [SR-...].
  const direct = /^(?:مرتجع مبيعات سلة|استرداد نقدي لمرتجع مبيعات|استرداد بطاقة لمرتجع مبيعات)\s+\[(SR-[^\]]+)\]/.exec(source);
  if (direct) return direct[1];
  // Core returns append the number to the reason before the fixed disposition suffix.
  const core = /؛ سبب المرتجع=[\s\S]*\[(SR-[^\]]+)\]؛ مصير البضاعة=(?:إعادة للرف|تالف)(?:$|؛)/.exec(source);
  return core?.[1] ?? null;
}

function valueOf(row: AuditRow): Record<string, unknown> | null {
  return row.newValue && typeof row.newValue === "object" && !Array.isArray(row.newValue)
    ? row.newValue as Record<string, unknown>
    : null;
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * New records contain the immutable ledger id. Old records may be matched by
 * a non-null receipt or by a number only when that evidence is unique among
 * BOTH the entries and the audit rows for this invoice.
 */
export function matchReturnAudit<T extends AuditRow>(
  entry: ReturnHistoryEntry,
  entries: readonly ReturnHistoryEntry[],
  audits: readonly T[],
): T | undefined {
  const exact = audits.filter((row) => positiveId(valueOf(row)?.returnEntryId) === entry.id &&
    (row.action !== SALES_RETURN_CART_RESULT_ACTION || row.entityId === String(entry.id)));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;

  const receiptId = positiveId(entry.receiptId);
  if (receiptId != null && entries.filter((other) => positiveId(other.receiptId) === receiptId).length === 1) {
    const matches = audits.filter((row) => positiveId(valueOf(row)?.receiptId) === receiptId);
    if (matches.length === 1 && positiveId(valueOf(matches[0])?.returnEntryId) == null) return matches[0];
    if (matches.length > 0) return undefined;
  }

  const number = returnNumberFromText(entry.notes) ?? returnNumberFromText(entry.receiptDescription);
  if (!number) return undefined;
  const relatedEntries = entries.filter((other) =>
    (returnNumberFromText(other.notes) ?? returnNumberFromText(other.receiptDescription)) === number,
  );
  const relatedAudits = audits.filter((row) => valueOf(row)?.returnNumber === number);
  if (relatedEntries.length !== 1 || relatedAudits.length !== 1) return undefined;
  return positiveId(valueOf(relatedAudits[0])?.returnEntryId) == null ? relatedAudits[0] : undefined;
}

/** Prefer the compact source-bound result; carry line details only when they agree. */
export function combineReturnAudits(detail: AuditRow | undefined, result: AuditRow | undefined): AuditRow | undefined {
  if (!result) return detail;
  const recorded = valueOf(result);
  const extra = detail && valueOf(detail);
  if (!recorded || !extra || positiveId(recorded.returnEntryId) !== positiveId(extra.returnEntryId) ||
    recorded.returnNumber !== extra.returnNumber) return result;
  return { newValue: { ...extra, ...recorded } };
}

/** A core return may store its receipt only in the source-bound audit result. */
export function returnReceiptId(entry: ReturnHistoryEntry, audit: AuditRow | undefined): number | null {
  const ledgerId = positiveId(entry.receiptId);
  const auditId = audit ? positiveId(valueOf(audit)?.receiptId) : null;
  if (ledgerId != null && auditId != null && ledgerId !== auditId) return null;
  return auditId ?? ledgerId;
}

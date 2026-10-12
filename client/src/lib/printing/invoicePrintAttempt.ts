export type InvoicePrintPurpose = "THERMAL" | "A4" | "SHIPPING_LABEL" | "WAREHOUSE";
export type InvoicePrintAttempt = {
  userId: number;
  invoiceId: number;
  purpose: InvoicePrintPurpose;
  mode: "PRINT" | "REPRINT";
  requestId: string;
};

const memory = new Map<string, InvoicePrintAttempt>();
const keyFor = (userId: number, invoiceId: number, purpose: InvoicePrintPurpose, mode: InvoicePrintAttempt["mode"]) =>
  `invoice-print-attempt:${userId}:${invoiceId}:${purpose}:${mode}`;

function pending(userId: number, invoiceId: number, purpose: InvoicePrintPurpose, mode: InvoicePrintAttempt["mode"]): InvoicePrintAttempt | undefined {
  const key = keyFor(userId, invoiceId, purpose, mode);
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as InvoicePrintAttempt | null;
    if (saved?.userId === userId && saved.invoiceId === invoiceId && saved.purpose === purpose && saved.mode === mode &&
        typeof saved.requestId === "string" && /^[0-9a-f-]{36}$/i.test(saved.requestId)) return saved;
  } catch { /* Storage can be unavailable; retain this tab's in-memory attempt. */ }
  return memory.get(key);
}

export function hasPendingFirstInvoicePrint(userId: number | null | undefined, invoiceId: number, purpose: InvoicePrintPurpose): boolean {
  return userId != null && Boolean(pending(userId, invoiceId, purpose, "PRINT"));
}

/** Persist before authorization so a lost response or failed renderer can resume. */
export function beginInvoicePrintAttempt(userId: number, invoiceId: number, purpose: InvoicePrintPurpose, reprint: boolean, canResumeFirst = true): InvoicePrintAttempt {
  const mode = reprint ? "REPRINT" : "PRINT";
  const previous = (!reprint || canResumeFirst ? pending(userId, invoiceId, purpose, "PRINT") : undefined) ?? pending(userId, invoiceId, purpose, mode);
  if (previous) return previous;
  const attempt: InvoicePrintAttempt = { userId, invoiceId, purpose, mode, requestId: crypto.randomUUID() };
  const key = keyFor(userId, invoiceId, purpose, mode);
  memory.set(key, attempt);
  try { sessionStorage.setItem(key, JSON.stringify(attempt)); } catch { /* Memory fallback above. */ }
  return attempt;
}

/** Transport success means submission/preview opening, never physical paper proof. */
export function completeInvoicePrintAttempt(attempt: InvoicePrintAttempt): void {
  const key = keyFor(attempt.userId, attempt.invoiceId, attempt.purpose, attempt.mode);
  if (pending(attempt.userId, attempt.invoiceId, attempt.purpose, attempt.mode)?.requestId !== attempt.requestId) return;
  memory.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Memory state is already cleared. */ }
  if (attempt.mode === "REPRINT") {
    const first = pending(attempt.userId, attempt.invoiceId, attempt.purpose, "PRINT");
    if (first) completeInvoicePrintAttempt(first);
  }
}

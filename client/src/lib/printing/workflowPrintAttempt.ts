import type { PrintResult } from "./print";
import type { WorkflowDocumentSnapshot } from "./workflowDocuments";

export interface WorkflowPrintAttempt {
  userId: number;
  request: {
    snapshotId: number;
    branchId: number;
    clientRequestId: string;
    copyType: "ORIGINAL" | "REPRINT";
    reason?: string;
    printerKey?: string;
  };
  printId?: number;
  outcome?: {
    status: "SENT" | "FAILED" | "CANCELLED";
    errorMessage?: string;
    via?: PrintResult["via"];
  };
}

const keyFor = (userId: number, branchId: number, snapshotId: number) =>
  `workflow-print-attempt:${userId}:${branchId}:${snapshotId}`;

export function saveWorkflowPrintAttempt(attempt: WorkflowPrintAttempt): void {
  try {
    localStorage.setItem(
      keyFor(
        attempt.userId,
        attempt.request.branchId,
        attempt.request.snapshotId,
      ),
      JSON.stringify(attempt),
    );
  } catch {
    // Do not authorize a request whose identity cannot survive reopening the UI.
    throw new Error(
      "تعذر حفظ محاولة الطباعة؛ فعّل تخزين المتصفح ثم أعد المحاولة دون إعادة المعاملة",
    );
  }
}

/** Persist the exact request before the API; a lost response must reuse its key. */
export function beginWorkflowPrintAttempt(
  userId: number,
  branchId: number,
  snapshot: WorkflowDocumentSnapshot,
  reprintReason: string,
): WorkflowPrintAttempt {
  let saved: WorkflowPrintAttempt | null = null;
  try {
    saved = JSON.parse(
      localStorage.getItem(keyFor(userId, branchId, snapshot.id)) ?? "null",
    ) as WorkflowPrintAttempt | null;
  } catch {
    /* A malformed entry can be replaced; unavailable storage fails on save. */
  }
  if (
    saved?.userId === userId &&
    saved.request?.branchId === branchId &&
    saved.request.snapshotId === snapshot.id &&
    typeof saved.request.clientRequestId === "string" &&
    saved.request.clientRequestId.length >= 8 &&
    saved.request.clientRequestId.length <= 80 &&
    (saved.request.copyType === "ORIGINAL" ||
      (saved.request.copyType === "REPRINT" &&
        typeof saved.request.reason === "string" &&
        saved.request.reason.trim().length >= 3)) &&
    (!saved.outcome ||
      (saved.printId != null &&
        ["SENT", "FAILED", "CANCELLED"].includes(saved.outcome.status)))
  )
    return saved;

  const copyType = snapshot.printHistory.some((row) => row.status === "SENT")
    ? "REPRINT"
    : "ORIGINAL";
  const pending = snapshot.printHistory.find(
    (row) =>
      row.status === "REQUESTED" &&
      row.requestedBy === userId &&
      row.copyType === copyType &&
      Number.isSafeInteger(row.id) &&
      row.id! > 0 &&
      (row.snapshotId == null || row.snapshotId === snapshot.id) &&
      typeof row.clientRequestId === "string" &&
      row.clientRequestId.length >= 8 &&
      row.clientRequestId.length <= 80 &&
      (copyType !== "REPRINT" ||
        (typeof row.reason === "string" && row.reason.trim().length >= 3)),
  );
  const attempt: WorkflowPrintAttempt = {
    userId,
    request: {
      snapshotId: snapshot.id,
      branchId,
      clientRequestId: pending?.clientRequestId ?? crypto.randomUUID(),
      copyType,
      ...(pending?.reason != null
        ? { reason: pending.reason }
        : copyType === "REPRINT"
          ? { reason: reprintReason }
          : {}),
      ...(pending?.printerKey != null
        ? { printerKey: pending.printerKey }
        : {}),
    },
    ...(pending ? { printId: pending.id } : {}),
  };
  saveWorkflowPrintAttempt(attempt);
  return attempt;
}

/** Clear only after the server acknowledged the same transport outcome. */
export function finishWorkflowPrintAttempt(
  attempt: WorkflowPrintAttempt,
): void {
  const key = keyFor(
    attempt.userId,
    attempt.request.branchId,
    attempt.request.snapshotId,
  );
  const current = JSON.parse(
    localStorage.getItem(key) ?? "null",
  ) as WorkflowPrintAttempt | null;
  if (current?.request.clientRequestId === attempt.request.clientRequestId)
    localStorage.removeItem(key);
}

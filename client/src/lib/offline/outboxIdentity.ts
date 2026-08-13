export const LEGACY_OUTBOX_REVIEW_MESSAGE =
  "تعذّر تحديد الموظف الذي قبض هذه العملية القديمة — عُلّقت للمراجعة الإدارية ولا يمكن ترحيلها تلقائياً";

export type OutboxIdentityDisposition =
  | "PROCESS"
  | "SKIP_OTHER_USER"
  | "QUARANTINE_LEGACY"
  | "BLOCK_NO_SESSION";

/** Pure identity gate shared by the durable outbox and its regression tests. */
export function outboxIdentityDisposition(
  capturedByUserId: number | null | undefined,
  currentUserId: number | null | undefined,
): OutboxIdentityDisposition {
  if (!Number.isInteger(currentUserId) || Number(currentUserId) <= 0)
    return "BLOCK_NO_SESSION";
  if (!Number.isInteger(capturedByUserId) || Number(capturedByUserId) <= 0)
    return "QUARANTINE_LEGACY";
  return Number(capturedByUserId) === Number(currentUserId)
    ? "PROCESS"
    : "SKIP_OTHER_USER";
}

export function partitionOutboxByIdentity<
  T extends { capturedByUserId?: number | null },
>(
  items: readonly T[],
  currentUserId: number | null | undefined,
): { replayable: T[]; legacy: T[] } {
  const replayable: T[] = [];
  const legacy: T[] = [];
  for (const item of items) {
    const disposition = outboxIdentityDisposition(
      item.capturedByUserId,
      currentUserId,
    );
    if (disposition === "PROCESS") replayable.push(item);
    else if (disposition === "QUARANTINE_LEGACY") legacy.push(item);
  }
  return { replayable, legacy };
}

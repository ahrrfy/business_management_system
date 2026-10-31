import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { offlineRecoveryItems } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * Call inside the actual replay transaction, after its shared financial gate.
 * Discard takes the exclusive form of that gate before its first read, so this
 * snapshot cannot race a discard decision. No missing-key/gap lock is needed;
 * ordinary replays remain concurrent and need no recovery row on success.
 */
export async function assertOfflineReplayNotDiscardedTx(
  tx: Tx,
  clientRequestId: string,
): Promise<void> {
  const [item] = await tx
    .select({ status: offlineRecoveryItems.recoveryStatus })
    .from(offlineRecoveryItems)
    .where(eq(offlineRecoveryItems.clientRequestId, clientRequestId))
    .limit(1);
  if (item?.status === "DISCARDED") {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر ترحيل العملية الأوفلاينية",
        why: "أُهمل عنصر الاسترداد المرتبط بهذا المفتاح بقرار موثّق",
        doThis: "راجع قرار الإهمال ومستنده مع مسؤول النظام قبل أي إجراء جديد",
      }),
    });
  }
}

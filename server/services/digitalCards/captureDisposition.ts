import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { digitalSaleIntents, externalPaymentAttempts } from "../../../drizzle/schema";
import { digitalIntentSettlements } from "../../../drizzle/digitalSettlementSchema";
import type { Tx } from "../../db";
import { appErrorMessage } from "../../../shared/errors";
import { isCapturedReceptionCash } from "./receptionSource";

/** A cost writeoff cannot silently dispose of money already entrusted by a customer. */
export async function assertCaptureResolvedBeforeClosure(tx: Tx, intent: typeof digitalSaleIntents.$inferSelect, operation = "شطب") {
  const [settlement] = await tx.select().from(digitalIntentSettlements)
    .where(eq(digitalIntentSettlements.intentId, Number(intent.id))).for("update").limit(1);
  if (settlement?.status === "COMPLETED") return;
  const [attempt] = intent.externalPaymentAttemptId == null ? [] : await tx.select().from(externalPaymentAttempts)
    .where(eq(externalPaymentAttempts.id, Number(intent.externalPaymentAttemptId))).for("update").limit(1);
  const receptionCash = isCapturedReceptionCash(intent.paymentMethod, intent.checkoutSnapshot);
  if (settlement || receptionCash || (attempt && (attempt.state === "CONFIRMED" || attempt.consumedAt != null))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: `تعذّر ${operation} عملية الكروت`,
      why: "قبض العميل لم يُسوَّ للبيع أو الرد بعد؛ شطب حصة المزوّد لا يحسم مال العميل",
      doThis: "طابق القبض ثم اعتمد تسوية المبلغ المحصّل وفوترة الصادر ورد غير الصادر قبل أي شطب",
    }) });
  }
}

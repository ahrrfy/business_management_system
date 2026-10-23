import { TRPCError } from "@trpc/server";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../db";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "./idempotency";

/** One provider success reference funds one actual refund, across source workflows. */
export async function reserveExternalRefundConfirmationTx(
  tx: Tx,
  input: { receiptId: number; method: string; reference: string },
) {
  const reference = input.reference.trim();
  const key = reference.toUpperCase();
  const conflict = () =>
    new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر إثبات تنفيذ الاسترداد الخارجي",
        why: "مرجع نجاح المزوّد مستخدم لطلب رد آخر؛ لا يسند استرداد واحد إيصالين",
        doThis:
          "راجع قسيمة المزوّد وأدخل رقم عملية استرداد مستقلة لهذا الطلب فقط",
      }),
    });
  for (const operation of [
    `workOrder.refund.confirmation.${input.method}`,
    `delivery.providerRefund.${input.method}`,
  ]) {
    for (const legacyKey of Array.from(new Set([reference, key]))) {
      const previous = await checkIdempotency(tx, operation, legacyKey);
      if (previous != null && previous !== input.receiptId) throw conflict();
    }
  }
  const operation = `external.refund.confirmation.${input.method}`;
  const fingerprint = idempotencyHash({
    receiptId: input.receiptId,
    method: input.method,
    reference: key,
  });
  const existing = await checkIdempotency(tx, operation, key, fingerprint);
  if (existing != null) {
    if (existing !== input.receiptId) throw conflict();
    return;
  }
  try {
    await recordIdempotencyKey(
      tx,
      operation,
      key,
      input.receiptId,
      fingerprint,
    );
  } catch (error) {
    if (isDupEntry(error)) throw conflict();
    throw error;
  }
}

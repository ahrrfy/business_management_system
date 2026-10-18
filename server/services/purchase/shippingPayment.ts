import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  accountingEntries,
  accrualObligationEvents,
  accrualObligations,
  receipts,
} from "../../../drizzle/schema";
import { appErrorMessage } from "../../../shared/errors";
import type { Tx } from "../../db";
import { money } from "../money";

/** Immutable cash evidence, including after a governed refund. Review must never pay it again. */
export async function recordedPurchaseShippingPaymentTx(
  tx: Tx,
  input: {
    purchaseOrderId: number;
    branchId: number;
    creatorId: number;
    amount: string;
    shiftId: number | null;
  },
): Promise<number | null> {
  const rows = await tx
    .select({
      obligation: accrualObligations,
      event: accrualObligationEvents,
      entry: accountingEntries,
      receipt: receipts,
    })
    .from(accrualObligations)
    .innerJoin(
      accrualObligationEvents,
      eq(accrualObligationEvents.obligationId, accrualObligations.id),
    )
    .leftJoin(
      accountingEntries,
      eq(accountingEntries.id, accrualObligationEvents.accountingEntryId),
    )
    .leftJoin(receipts, eq(receipts.id, accrualObligationEvents.receiptId))
    .where(
      and(
        eq(accrualObligations.purchaseOrderId, input.purchaseOrderId),
        eq(accrualObligations.kind, "PURCHASE_SHIPPING"),
        eq(accrualObligationEvents.eventType, "PAYMENT_SETTLED"),
      ),
    );
  if (!rows.length) return null;
  const [proof] = rows;
  const { obligation, event, entry, receipt } = proof;
  if (
    !entry ||
    !receipt ||
    rows.length !== 1 ||
    input.shiftId == null ||
    ![
      obligation.recognizedAmount,
      event.amount,
      entry.amount,
      receipt.amount,
    ].every((value) => money(value).eq(input.amount)) ||
    Number(obligation.branchId) !== input.branchId ||
    entry.entryType !== "PAYMENT_OUT" ||
    Number(entry.purchaseOrderId) !== input.purchaseOrderId ||
    Number(entry.branchId) !== input.branchId ||
    Number(entry.receiptId) !== Number(receipt.id) ||
    Number(entry.createdBy) !== input.creatorId ||
    receipt.direction !== "OUT" ||
    receipt.status !== "COMPLETED" ||
    receipt.approvalStatus !== "APPROVED" ||
    receipt.paymentMethod !== "CASH" ||
    receipt.cashBucket !== "DRAWER" ||
    Number(receipt.shiftId) !== input.shiftId ||
    Number(receipt.branchId) !== input.branchId ||
    Number(receipt.createdBy) !== input.creatorId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر مطابقة دفع شحن فاتورة الشراء",
        why: "دليل الصرف المسجل لا يطابق مبلغ الشحن ودرج المنشئ",
        doThis:
          "راجع إيصال الشحن وقيده؛ لا تعدل الدفع المسجل ولا تنشئ صرفاً بديلاً",
      }),
    });
  }
  return Number(receipt.id);
}

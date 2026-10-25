import { and, eq, or, sql } from "drizzle-orm";
import {
  aftercareCases,
  aftercareExecutions,
} from "../../../drizzle/fulfillmentSchema";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryLedgerEntries,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  assertOperationAuthorityTx,
  loadOperationUserTx,
} from "../authorization/operationAuthority";
import { appendDeliveryEvent } from "../delivery/lifecycle";
import { repairDeliveryCustodyFromRecordedEventsTx } from "../delivery/custody";
import type { DeliveryTxActor } from "../delivery/types";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import {
  aftercareStaffResultRoleAllowed,
  assertAftercareCourierTx,
  confirmAftercareDeliveryTx,
  type AftercareResultAuthorization,
} from "./aftercare";
import {
  assertFulfillmentBranch,
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentFingerprint,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "./core";

export type AftercareDeliveryResultInput = {
  consignmentId: number;
  result: "DELIVERED" | "FAILED" | "RETURNED";
  proof: string;
  clientRequestId: string;
  feeEarned?: boolean;
  customerCollectedAmount?: string;
  authorization: AftercareResultAuthorization;
};
function scopedSourceActor(
  actor: DeliveryTxActor,
  current: Awaited<ReturnType<typeof loadOperationUserTx>>,
  branchId: number,
  courier = false,
): Actor {
  if (
    !courier &&
    actor.branchId == null &&
    current.role !== "admin" &&
    current.isOwner !== true
  )
    throw fulfillmentError("لا يوجد فرع عمل مسند للحساب", "FORBIDDEN");
  const actualBranchId =
    courier || actor.branchId == null ? branchId : actor.branchId;
  const value: Actor = {
    userId: actor.userId,
    branchId: actualBranchId,
    role: current.role,
    isOwner: current.isOwner === true,
  };
  assertFulfillmentBranch(value, branchId);
  return value;
}

async function currentSourceTx(tx: Tx, consignmentId: number) {
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, consignmentId))
    .for("share")
    .limit(1);
  if (!cn) throw fulfillmentError("الإرسالية غير موجودة", "NOT_FOUND");
  if (cn.sourceType !== "AFTERCARE_EXECUTION") return null;
  if (
    !cn.aftercareExecutionId ||
    cn.invoiceId != null ||
    cn.feeCollection !== "SHOP" ||
    !money(cn.codAmount).isZero()
  )
    throw fulfillmentError(
      "مصدر إرسالية المعالجة أو شروط التحصيل والأجرة غير صحيح",
    );
  return cn;
}

/** Call before generic parcel, fee-accrual, sale-return or collection writes. No nested Tx. */
export async function routeAftercareDeliveryResultTx(
  tx: Tx,
  input: AftercareDeliveryResultInput,
  actor: DeliveryTxActor,
) {
  const cn = await currentSourceTx(tx, input.consignmentId);
  if (!cn) return { handled: false as const };
  if (!money(input.customerCollectedAmount ?? "0").isZero())
    throw fulfillmentError(
      "معالجة ما بعد البيع لا تقبل تحصيلاً من العميل؛ قيمة التحصيل صفر",
    );
  const current = await loadOperationUserTx(tx, actor.userId);
  const scoped = scopedSourceActor(
    actor,
    current,
    cn.branchId,
    input.authorization.kind === "COURIER",
  );
  if (input.authorization.kind === "COURIER") {
    await assertAftercareCourierTx(tx, cn, actor.userId);
    if (
      input.result === "RETURNED" ||
      (input.result !== "DELIVERED" && input.feeEarned)
    )
      throw fulfillmentError(
        "استلام العهدة واعتماد أجرة فشل التوصيل يحتاج موظف المكتبة المخول",
        "FORBIDDEN",
      );
  } else {
    assertFulfillmentBranch(scoped, cn.branchId);
    const operationPath = input.authorization.operationPath;
    await assertOperationAuthorityTx(
      tx,
      actor,
      operationPath,
      (user) => aftercareStaffResultRoleAllowed(user.role, operationPath),
      input.authorization.operationAuthority,
    );
  }
  const context = fulfillmentMutationContext(
    "aftercare.deliveryResult",
    input,
    input,
    scoped,
    cn.branchId,
  );
  const replay = await findFulfillmentReplayTx(tx, context);
  if (replay) {
    await repairDeliveryCustodyFromRecordedEventsTx(tx, cn.id);
    return { handled: true as const, executionId: replay, replay: true };
  }
  const [execution] = await tx
    .select()
    .from(aftercareExecutions)
    .where(eq(aftercareExecutions.id, cn.aftercareExecutionId!))
    .for("share")
    .limit(1);
  if (
    !execution ||
    execution.consignmentId !== cn.id ||
    execution.branchId !== cn.branchId
  )
    throw fulfillmentError("دفعة المعالجة لا تطابق مصدر الإرسالية");
  await confirmAftercareDeliveryTx(
    tx,
    {
      id: execution.id,
      expectedVersion: execution.version,
      result: input.result,
      proof: input.proof,
      feeEarned: input.feeEarned,
      clientRequestId: fulfillmentFingerprint({
        operation: "deliveryResult",
        key: input.clientRequestId,
        id: cn.id,
      }),
    },
    scoped,
    input.authorization,
  );
  await recordFulfillmentMutationTx(tx, context, execution.id);
  return { handled: true as const, executionId: execution.id, replay: false };
}

/** Synchronize the existing fee writer's actual receipt/ledger; never posts or pays again. */
export async function syncAftercareFeePaymentTx(
  tx: Tx,
  input: { consignmentId: number; receiptId: number; actorId: number },
) {
  const cn = await currentSourceTx(tx, input.consignmentId);
  if (!cn) return { handled: false as const };
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, input.receiptId))
    .for("share")
    .limit(1);
  if (
    !receipt ||
    receipt.branchId !== cn.branchId ||
    receipt.direction !== "OUT" ||
    receipt.status !== "COMPLETED" ||
    !money(receipt.amount).gt(0)
  )
    throw fulfillmentError("سند صرف أجرة المعالجة غير فعلي أو لا يطابق الفرع");
  const [posted] = await tx
    .select({
      amount: sql<string>`COALESCE(SUM(${accountingEntries.amount}),0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.receiptId, receipt.id),
        eq(accountingEntries.branchId, cn.branchId),
        eq(accountingEntries.deliveryPartyId, cn.partyId),
        eq(accountingEntries.entryType, "DELIVERY_FEE"),
        or(
          sql`${accountingEntries.dedupeKey} LIKE ${`DELIVERY_FEE_PAID:${cn.id}:%`}`,
          eq(
            accountingEntries.dedupeKey,
            `AFTERCARE_FEE_PAYMENT:${receipt.id}`,
          ),
        ),
      ),
    )
    .for("share");
  if (
    !money(posted?.amount ?? "0").gt(0) ||
    money(posted?.amount ?? "0").gt(receipt.amount)
  )
    throw fulfillmentError(
      "لا يوجد قيد تسديد حقيقي مرتبط بسند الأجرة وهذه الإرسالية",
    );
  const [sums] = await tx
    .select({
      paid: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
      due: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET','FEE_REFUNDED') THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
    })
    .from(deliveryLedgerEntries)
    .where(eq(deliveryLedgerEntries.consignmentId, cn.id))
    .for("share");
  const [execution] = await tx
    .select()
    .from(aftercareExecutions)
    .where(eq(aftercareExecutions.id, cn.aftercareExecutionId!))
    .for("update")
    .limit(1);
  if (
    !execution ||
    execution.consignmentId !== cn.id ||
    execution.branchId !== cn.branchId
  )
    throw fulfillmentError("مصدر دفع أجرة المعالجة لا يطابق الدفعة");
  const [parentCase] = await tx
    .select({ createdBy: aftercareCases.createdBy })
    .from(aftercareCases)
    .where(eq(aftercareCases.id, execution.caseId))
    .limit(1);
  if (!parentCase || parentCase.createdBy === input.actorId)
    throw fulfillmentError(
      "صرف أجرة المعالجة يحتاج موظفاً آخر غير طالب المعالجة",
      "FORBIDDEN",
    );
  const paid = money(sums?.paid ?? "0");
  const due = money(sums?.due ?? "0");
  if (paid.gt(execution.deliveryFee) || due.lt(0))
    throw fulfillmentError("رصيد أجرة المعالجة يتجاوز الاستحقاق الفعلي");
  const receiptId = Math.max(execution.feeReceiptId ?? 0, input.receiptId);
  if (!paid.eq(execution.feePaidAmount) || execution.feeReceiptId !== receiptId)
    await tx
      .update(aftercareExecutions)
      .set({
        feePaidAmount: toDbMoney(paid),
        feeReceiptId: receiptId,
        version: execution.version + 1,
      })
      .where(eq(aftercareExecutions.id, execution.id));
  return {
    handled: true as const,
    executionId: execution.id,
    paidAmount: toDbMoney(paid),
    dueAmount: toDbMoney(due),
  };
}

export async function assertAftercareAssignmentCancellationTx(
  tx: Tx,
  consignmentId: number,
) {
  const cn = await currentSourceTx(tx, consignmentId);
  if (!cn) return;
  throw fulfillmentError(
    "هذه إرسالية معالجة بعهدة مثبتة؛ افتح معالجة ما بعد البيع وثبّت استلام العهدة العائدة وفحصها قبل إعادة الإرسال أو الإقفال؛ إلغاء الإسناد لا يثبت رجوع القطعة",
  );
}

/** Declaration is evidence of expected return only: no stock/custody/issue-right release. */
export async function declareAftercareReturnTx(
  tx: Tx,
  input: { consignmentId: number; reason: string; clientRequestId: string },
  actor: DeliveryTxActor,
) {
  const cn = await currentSourceTx(tx, input.consignmentId);
  if (!cn) return { handled: false as const };
  const current = await loadOperationUserTx(tx, actor.userId);
  const scoped = scopedSourceActor(actor, current, cn.branchId);
  assertFulfillmentBranch(scoped, cn.branchId);
  await assertOperationAuthorityTx(
    tx,
    actor,
    "delivery.declareReturn",
    (user) => ["admin", "manager", "cashier", "warehouse"].includes(user.role),
    actor.operationAuthority,
  );
  const context = fulfillmentMutationContext(
    "aftercare.declareReturn",
    input,
    input,
    scoped,
    cn.branchId,
  );
  if (await findFulfillmentReplayTx(tx, context))
    return {
      handled: true as const,
      consignmentId: cn.id,
      declared: true as const,
      idempotentReplay: true,
    };
  const [locked] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, cn.id))
    .for("update")
    .limit(1);
  if (
    !locked ||
    locked.parcelStatus === "DELIVERED" ||
    locked.parcelStatus === "RETURNED" ||
    locked.parcelStatus === "CANCELLED" ||
    locked.returnDeclaredAt
  )
    throw fulfillmentError(
      "إرسالية المعالجة منتهية أو رجوعها معلن سلفاً؛ راجع سجل العهدة",
    );
  if (input.reason.trim().length < 3 || input.reason.length > 500)
    throw fulfillmentError("أدخل سبب رجوع واضحاً من 3 إلى 500 محرف");
  await tx
    .update(deliveryConsignments)
    .set({
      returnDeclaredAt: new Date(),
      returnDeclaredBy: actor.userId,
      returnDeclaredReason: input.reason.trim(),
    })
    .where(eq(deliveryConsignments.id, cn.id));
  await appendDeliveryEvent(tx, {
    eventKey: `AC:${cn.aftercareExecutionId}:RETURN_DECLARED:${input.clientRequestId}`,
    consignmentId: cn.id,
    eventType: "AFTERCARE_RETURN_DECLARED",
    actorUserId: actor.userId,
    payload: {
      reason: input.reason.trim(),
      aftercareExecutionId: cn.aftercareExecutionId,
    },
  });
  await recordFulfillmentMutationTx(tx, context, cn.id);
  return {
    handled: true as const,
    consignmentId: cn.id,
    declared: true as const,
    idempotentReplay: false,
  };
}

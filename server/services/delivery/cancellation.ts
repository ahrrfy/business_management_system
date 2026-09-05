import { TRPCError } from "@trpc/server";
import { assertNotReturnDeclared } from "./declaredReturn";
import { eq } from "drizzle-orm";
import { deliveryConsignments } from "../../../drizzle/schema";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { withTx } from "../tx";
import { appendDeliveryEvent, appendDeliveryLedgerEntry, assertConsignmentStatusTransition } from "./lifecycle";
import type { DeliveryTxActor } from "./types";

export interface CancelDeliveryAssignmentInput {
  consignmentId: number;
  reason: string;
  clientRequestId: string;
}

/**
 * يلغي إسناد التوصيل فقط. لا يعكس البيع، ولا يعيد المخزون، ولا يكتب إيصالاً.
 * تحرير تعرّض COD يتم بقيد دفتر غير قابل للتعديل، ويبقى سجل الإرسالية نفسه
 * متاحاً لإعادة التنشيط لاحقاً كي لا نفقد سلسلة المسؤولية.
 */
export async function cancelDeliveryAssignment(
  input: CancelDeliveryAssignmentInput,
  actor: DeliveryTxActor,
) {
  const reason = input.reason.trim();
  if (!reason)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب إلغاء الإسناد إلزامي",
    });
  if (reason.length > 500)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب إلغاء الإسناد أطول من الحد المسموح",
    });
  if (actor.role !== "manager" && actor.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "إلغاء إسناد التوصيل صلاحية مدير",
    });
  }

  const payloadHash = idempotencyHash({
    consignmentId: Number(input.consignmentId),
    reason,
  });

  return withTx(async (tx) => {
    // افحص الفرع قبل إعادة نتيجة idempotent كي لا تتحول إعادة التشغيل إلى قناة IDOR.
    const scopedBranch =
      actor.role === "admin" ? null : (actor.branchId ?? null);
    if (actor.role !== "admin" && scopedBranch == null) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا فرع مُسنَد لهذا المدير",
      });
    }
    const owned = (
      await tx
        .select({ branchId: deliveryConsignments.branchId })
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .limit(1)
    )[0];
    if (
      owned &&
      scopedBranch != null &&
      Number(owned.branchId) !== Number(scopedBranch)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "الإرسالية تخصّ فرعاً آخر",
      });
    }

    const replay = await checkIdempotency(
      tx,
      "delivery.cancelAssignment",
      input.clientRequestId,
      payloadHash,
    );
    if (replay != null) {
      if (Number(replay) !== Number(input.consignmentId)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح الإلغاء مرتبط بإرسالية أخرى",
        });
      }
      return { consignmentId: Number(replay), idempotentReplay: true as const };
    }

    const cn = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .for("update")
        .limit(1)
    )[0];
    if (!cn)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "الإرسالية غير موجودة",
      });
    if (scopedBranch != null && Number(cn.branchId) !== Number(scopedBranch)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "الإرسالية تخصّ فرعاً آخر",
      });
    }

    // يغلق سباق طلبين وصلا قبل تسجيل مفتاح العملية الأول.
    const replayAfterLock = await checkIdempotency(
      tx,
      "delivery.cancelAssignment",
      input.clientRequestId,
      payloadHash,
    );
    if (replayAfterLock != null) {
      return {
        consignmentId: Number(replayAfterLock),
        idempotentReplay: true as const,
      };
    }

    // رجوعٌ مُعلَن: تعرّضُه حُرِّر سلفاً، وإلغاءُ الإسناد يكتب `COD_RELEASED` ثانياً ⇒ تحريرٌ
    // مزدوج (ولا فهرسَ فريد على `eventKey` يمنعه). المخرجُ الوحيد: الاسترجاع بعد الاستلام.
    assertNotReturnDeclared(cn, "cancel");
    if (cn.parcelStatus !== "ASSIGNED" && cn.parcelStatus !== "FAILED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "لا يُلغى الإسناد بعد قبول الطرد أو استلامه؛ أعد العهدة مادياً أولاً",
      });
    }
    if (
      !round2(money(cn.collectedAmount ?? "0")).isZero() ||
      cn.remittanceId != null
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يُلغى إسناد بدأ تحصيله أو رُبط بتوريد",
      });
    }

    const remaining = round2(
      money(cn.codAmount).minus(money(cn.collectedAmount ?? "0")),
    );
    if (remaining.lt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "بيانات تحصيل الإرسالية غير متسقة",
      });
    }

    const cancelledAt = new Date();
    if (remaining.gt(0)) {
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${cn.id}:COD_RELEASED:CANCEL:${input.clientRequestId}`,
        partyId: Number(cn.partyId),
        consignmentId: Number(cn.id),
        branchId: Number(cn.branchId),
        entryType: "COD_RELEASED",
        amount: toDbMoney(remaining),
        notes: reason,
        actorUserId: actor.userId,
        occurredAt: cancelledAt,
      });
    }

    assertConsignmentStatusTransition(cn.status, "CANCELLED");
    await tx
      .update(deliveryConsignments)
      .set({
        assignedUserId: null,
        parcelStatus: "CANCELLED",
        moneyStatus: "CANCELLED",
        status: "CANCELLED",
        cancelledAt,
        cancellationReason: reason,
        cancelledBy: actor.userId,
        settledAt: cancelledAt,
      })
      .where(eq(deliveryConsignments.id, Number(cn.id)));

    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:ASSIGNMENT_CANCELLED:${input.clientRequestId}`,
      consignmentId: Number(cn.id),
      eventType: "ASSIGNMENT_CANCELLED",
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: "CANCELLED",
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: "CANCELLED",
      actorUserId: actor.userId,
      payload: {
        reason,
        partyId: Number(cn.partyId),
        assignedUserId:
          cn.assignedUserId == null ? null : Number(cn.assignedUserId),
        releasedCod: remaining.toFixed(2),
      },
    });

    await recordIdempotencyKey(
      tx,
      "delivery.cancelAssignment",
      input.clientRequestId,
      Number(cn.id),
      payloadHash,
    );
    return { consignmentId: Number(cn.id), idempotentReplay: false as const };
  });
}

import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  aftercareCases,
  aftercareLines,
  aftercareExecutions,
  aftercareExecutionLines,
} from "../../../drizzle/fulfillmentSchema";
import {
  deliveryConsignments,
  deliveryParties,
  deliveryPartyMembers,
  receipts,
} from "../../../drizzle/schema";
import type {
  AftercareDisposition,
  FulfillmentMutationIdentity,
} from "../../../shared/fulfillment";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { canonicalIraqiMobile } from "../../lib/phone";
import {
  assertOperationAuthorityTx,
  loadOperationUserTx,
  type ServiceOperationAuthority,
} from "../authorization/operationAuthority";
import { logAuditTx } from "../auditService";
import { applyMovement } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import {
  assertCashOutAvailable,
  authorizeExternalTreasuryDisbursement,
  assertApprovedTreasuryOutAvailable,
  lockCashSourceForUpdate,
  lockMaterializedCashReceiptSourceForWrite,
} from "../cash/cashAvailability";
import { postEntry } from "../ledgerService";
import { checkIdempotency } from "../idempotency";
import { money, toDbMoney } from "../money";
import { nextConsignmentNumber } from "../delivery/numbering";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
  assertMemberCanUseConsignment,
} from "../delivery/lifecycle";
import {
  deliveryFeeAccrualIntent,
  deliveryFeeSettlementIntent,
} from "../delivery/posting";
import {
  assertExternalTrackingRefAvailable,
  requireExternalTrackingRef,
} from "../delivery/trackingRefPolicy";
import { assertPeriodOpen } from "../periodLockService";
import { withTx, type Actor } from "../tx";
import {
  assertFulfillmentBranch,
  assertFulfillmentVersion,
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentMutationContext,
  loadAftercareCaseTx,
  recordFulfillmentMutationTx,
} from "./core";
import {
  assertAftercareCapsTx,
  caseSource,
  loadAftercareProductTx,
  lockAftercareSourceTx,
  validateOriginalConsignmentTx,
  type AftercareSourceInput,
} from "./aftercareSources";
import { postAftercareIssueTx } from "./aftercarePosting";

type Identity = FulfillmentMutationIdentity & { id: number };
export type CreateAftercareCaseInput = AftercareSourceInput & {
  branchId: number;
  clientRequestId: string;
  reason: string;
  evidence: string;
  originalConsignmentId?: number;
  lines: {
    originalInvoiceItemId?: number | null;
    sourceWorkOrderId?: number | null;
    originalBundleComponentId?: number;
    componentVariantId?: number | null;
    baseQuantity: number;
    disposition: AftercareDisposition;
    originalMovementId?: number;
    physicalHeldConfirmed?: boolean;
    evidence: string;
  }[];
};
export type PrepareAftercareExecutionInput = Identity & {
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  deliveryFee: string;
  lines: {
    aftercareLineId: number;
    baseQuantity: number;
    materials?: { variantId: number; baseQuantity: number }[];
  }[];
  reuseExecutionId?: number;
};

const path = (action: string) => `delivery.fulfillment.aftercare.${action}`;
async function permission(tx: Tx, actor: Actor, action: string) {
  await assertOperationAuthorityTx(
    tx,
    actor,
    path(action),
    (current) =>
      current.role === "admin" ||
      current.role === "manager" ||
      (action === "create" && current.role === "cashier"),
  );
}
function nonempty(value: string, label: string, max = 2000) {
  if (!value?.trim() || value.length > max)
    throw fulfillmentError(`${label} مطلوب وبطول لا يتجاوز ${max} محرف`);
  return value.trim();
}
function positiveQuantity(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw fulfillmentError("الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً");
  return value;
}
function positiveId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw fulfillmentError("معرّف السجل غير صالح");
  return value;
}
function fee(value: string) {
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(value))
    throw fulfillmentError("أجرة التوصيل غير صالحة");
  return toDbMoney(money(value));
}
async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  id: number,
  data: unknown,
) {
  await logAuditTx(
    tx,
    { userId: actor.userId, branchId: actor.branchId },
    {
      action: path(action),
      entityType: "aftercare",
      entityId: id,
      newValue: data,
    },
  );
}

/** Lock source before case. This agrees with the invoice return/correction mutex. */
async function lockedCase(tx: Tx, id: number, actor: Actor) {
  const preview = await loadAftercareCaseTx(tx, id, actor);
  const source = await lockAftercareSourceTx(tx, caseSource(preview), actor);
  const row = await loadAftercareCaseTx(tx, id, actor, { lock: true });
  const lines = await tx
    .select()
    .from(aftercareLines)
    .where(eq(aftercareLines.caseId, id))
    .orderBy(aftercareLines.id)
    .for("update");
  return { row, source, lines };
}
async function lockedExecution(tx: Tx, id: number, actor: Actor) {
  const [preview] = await tx
    .select()
    .from(aftercareExecutions)
    .where(eq(aftercareExecutions.id, positiveId(id)))
    .limit(1);
  if (!preview) throw fulfillmentError("دفعة المعالجة غير موجودة", "NOT_FOUND");
  assertFulfillmentBranch(actor, preview.branchId);
  const parent = await lockedCase(tx, preview.caseId, actor);
  const [execution] = await tx
    .select()
    .from(aftercareExecutions)
    .where(eq(aftercareExecutions.id, id))
    .for("update")
    .limit(1);
  if (!execution || execution.caseId !== parent.row.id)
    throw fulfillmentError("تغير مصدر دفعة المعالجة", "CONFLICT");
  const executionLines = await tx
    .select()
    .from(aftercareExecutionLines)
    .where(eq(aftercareExecutionLines.executionId, id))
    .orderBy(aftercareExecutionLines.id)
    .for("update");
  return { ...parent, execution, executionLines };
}

export async function createAftercareCase(
  input: CreateAftercareCaseInput,
  actor: Actor,
) {
  assertFulfillmentBranch(actor, input.branchId);
  nonempty(input.reason, "سبب المعالجة");
  nonempty(input.evidence, "الدليل");
  if (!input.lines.length || input.lines.length > 100)
    throw fulfillmentError("أدخل من 1 إلى 100 سطر معالجة");
  return withTx(async (tx) => {
    await permission(tx, actor, "create");
    const source = await lockAftercareSourceTx(tx, input, actor);
    if (source.invoice.branchId !== input.branchId)
      throw fulfillmentError("فرع الحالة لا يطابق الأصل");
    const context = fulfillmentMutationContext(
      "aftercare.create",
      input,
      input,
      actor,
      input.branchId,
    );
    const replay = await findFulfillmentReplayTx(tx, context);
    if (replay) return { id: replay, replay: true };
    await assertAftercareCapsTx(tx, source, input.lines);
    await validateOriginalConsignmentTx(
      tx,
      input.originalConsignmentId,
      source,
    );
    for (const line of input.lines) {
      nonempty(line.evidence, "دليل السطر");
      if (
        line.disposition === "MISSING_HELD" &&
        line.physicalHeldConfirmed !== true
      )
        throw fulfillmentError(
          "يلزم إثبات وجود المبيع فعلياً وفصله بعهدة العميل",
        );
    }
    const id = extractInsertId(
      await tx.insert(aftercareCases).values({
        branchId: input.branchId,
        caseNumber: `AC-${input.branchId}-${randomUUID()}`,
        customerId: source.invoice.customerId,
        invoiceId: input.invoiceId,
        workOrderId: input.workOrderId,
        originalConsignmentId: input.originalConsignmentId,
        reason: input.reason.trim(),
        evidence: input.evidence.trim(),
        createdBy: actor.userId,
        clientRequestId: input.clientRequestId,
        sourceHash: context.sourceHash,
      }),
    );
    await tx.insert(aftercareLines).values(
      input.lines.map((line) => ({
        caseId: id,
        originalInvoiceItemId: line.originalInvoiceItemId,
        sourceWorkOrderId: line.sourceWorkOrderId,
        originalBundleComponentId: line.originalBundleComponentId,
        componentVariantId: line.componentVariantId,
        disposition: line.disposition,
        baseQuantity: line.baseQuantity,
        originalMovementId: line.originalMovementId,
        heldConfirmedBy:
          line.disposition === "MISSING_HELD" ? actor.userId : null,
        heldConfirmedAt:
          line.disposition === "MISSING_HELD" ? new Date() : null,
        evidence: line.evidence.trim(),
      })),
    );
    await recordFulfillmentMutationTx(tx, context, id);
    await audit(tx, actor, "create", id, input);
    return { id, replay: false };
  });
}

export async function approveAftercareCase(input: Identity, actor: Actor) {
  return withTx(async (tx) => {
    await permission(tx, actor, "approve");
    const { row, source, lines } = await lockedCase(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.approve",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return { id: row.id, replay: true };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (row.status !== "DRAFT")
      throw fulfillmentError("تعتمد الحالة المسودة فقط");
    if (row.createdBy === actor.userId)
      throw fulfillmentError(
        "يلزم اعتماد موظف آخر بعد مراجعة الدليل والعهدة",
        "FORBIDDEN",
      );
    await assertAftercareCapsTx(tx, source, lines, row.id);
    await tx
      .update(aftercareCases)
      .set({
        status: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(aftercareCases.id, row.id));
    await recordFulfillmentMutationTx(tx, context, row.id);
    await audit(tx, actor, "approve", row.id, input);
    return { id: row.id, replay: false };
  });
}

export async function prepareAftercareExecution(
  input: PrepareAftercareExecutionInput,
  actor: Actor,
) {
  nonempty(input.recipientName, "اسم المستلم", 255);
  nonempty(input.deliveryAddress, "العنوان");
  const phone = canonicalIraqiMobile(input.recipientPhone);
  if (!phone) throw fulfillmentError("أدخل رقم هاتف عراقي صالحاً للمستلم");
  const deliveryFee = fee(input.deliveryFee);
  return withTx(async (tx) => {
    await permission(tx, actor, "prepare");
    const { row, source, lines } = await lockedCase(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.prepare",
      input,
      input,
      actor,
      row.branchId,
    );
    const replay = await findFulfillmentReplayTx(tx, context);
    if (replay) return { id: replay, replay: true };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (!["APPROVED", "IN_PROGRESS"].includes(row.status) || !row.approvedBy)
      throw fulfillmentError("يلزم اعتماد الحالة أولاً");
    await assertAftercareCapsTx(tx, source, lines, row.id);
    if (
      !input.lines.length ||
      new Set(input.lines.map((line) => line.aftercareLineId)).size !==
        input.lines.length
    )
      throw fulfillmentError("حدّد أسطر دفعة غير مكررة");
    if (
      !input.reuseExecutionId &&
      row.createdBy === actor.userId &&
      input.lines.some(
        (selected) =>
          lines.find((line) => line.id === selected.aftercareLineId)
            ?.disposition !== "MISSING_HELD",
      )
    )
      throw fulfillmentError(
        "صرف البديل أو خامات التصنيع يحتاج منفذاً مراجعاً غير طالب المعالجة",
        "FORBIDDEN",
      );
    const reuse = input.reuseExecutionId
      ? await tx
          .select()
          .from(aftercareExecutions)
          .where(
            and(
              eq(aftercareExecutions.id, input.reuseExecutionId),
              eq(aftercareExecutions.caseId, row.id),
            ),
          )
          .for("update")
          .limit(1)
      : [];
    if (
      input.reuseExecutionId &&
      (reuse[0]?.status !== "RETURNED" || !reuse[0].returnEvidence)
    )
      throw fulfillmentError("إعادة الإرسال تتطلب دفعة عائدة مثبتة الاستلام");
    const previousOutputs = input.reuseExecutionId
      ? await tx
          .select()
          .from(aftercareExecutionLines)
          .where(
            and(
              eq(aftercareExecutionLines.executionId, input.reuseExecutionId),
              eq(aftercareExecutionLines.kind, "OUTPUT"),
            ),
          )
          .orderBy(aftercareExecutionLines.id)
          .for("update")
      : [];
    if (input.reuseExecutionId && input.lines.length !== previousOutputs.length)
      throw fulfillmentError(
        "إعادة إرسال العهدة العائدة تكون بكامل مخارج الدفعة السابقة",
      );
    const variantIds: number[] = [];
    for (const selected of input.lines) {
      const line = lines.find(
        (candidate) => candidate.id === selected.aftercareLineId,
      );
      positiveQuantity(selected.baseQuantity);
      if (!line) throw fulfillmentError("السطر لا ينتمي لحالة المعالجة");
      if (input.reuseExecutionId) {
        const previous = previousOutputs.find(
          (output) => output.aftercareLineId === line.id,
        );
        if (
          !previous ||
          previous.returnedBaseQuantity !== previous.fulfilledBaseQuantity ||
          selected.baseQuantity !== previous.fulfilledBaseQuantity ||
          selected.materials?.length
        )
          throw fulfillmentError(
            "العهدة العائدة لا تطابق كمية إعادة الإرسال أو تحتوي خامات جديدة",
          );
        const [used] = await tx
          .select({ id: aftercareExecutionLines.id })
          .from(aftercareExecutionLines)
          .where(eq(aftercareExecutionLines.reusedFromLineId, previous.id))
          .for("share")
          .limit(1);
        if (used)
          throw fulfillmentError(
            "أعيد تخصيص هذه العهدة العائدة بالفعل",
            "CONFLICT",
          );
      } else {
        if (
          line.executedBaseQuantity + selected.baseQuantity >
          line.baseQuantity
        )
          throw fulfillmentError(
            "كمية الدفعة تتجاوز حق الصرف المتبقي؛ الفشل لا يعيد حق الصرف",
            "CONFLICT",
          );
        if (line.disposition === "REPRINT") {
          if (!selected.materials?.length || selected.materials.length > 100)
            throw fulfillmentError(
              "إعادة التصنيع تستلزم خامات جديدة محددة ومثبتة",
            );
          for (const material of selected.materials) {
            positiveQuantity(material.baseQuantity);
            variantIds.push(positiveId(material.variantId));
          }
        } else {
          if (selected.materials?.length)
            throw fulfillmentError("الخامات الإضافية تخص إعادة التصنيع فقط");
          if (line.disposition === "REPLACEMENT") {
            if (line.componentVariantId == null)
              throw fulfillmentError(
                "البديل الإضافي يحتاج صنف مخزون أصلياً؛ الخدمة الخالصة تعالج بإعادة التنفيذ فقط",
              );
            variantIds.push(line.componentVariantId);
          }
        }
      }
    }
    await lockInventoryVariants(tx, variantIds);
    const id = extractInsertId(
      await tx.insert(aftercareExecutions).values({
        caseId: row.id,
        branchId: row.branchId,
        recipientName: input.recipientName.trim(),
        recipientPhone: phone,
        deliveryAddress: input.deliveryAddress.trim(),
        deliveryFee,
        codAmount: "0.00",
        feeCollection: "SHOP",
        preparedBy: actor.userId,
        checkedBy: row.approvedBy,
        checkedAt: row.approvedAt,
        clientRequestId: input.clientRequestId,
        sourceHash: context.sourceHash,
      }),
    );
    let totalCost = new Decimal(0);
    for (const selected of input.lines) {
      const line = lines.find(
        (candidate) => candidate.id === selected.aftercareLineId,
      )!;
      let movementId: number | null = null;
      let unitCost = "0.00";
      let lineCost = "0.00";
      const previous = previousOutputs.find(
        (output) => output.aftercareLineId === line.id,
      );
      if (!previous && line.disposition === "REPLACEMENT") {
        if (line.componentVariantId == null)
          throw fulfillmentError("صنف البديل غير محدد");
        const variant = await loadAftercareProductTx(
          tx,
          line.componentVariantId,
        );
        unitCost = variant.costPrice;
        lineCost = toDbMoney(money(unitCost).mul(selected.baseQuantity));
        const movement = await applyMovement(tx, {
          variantId: line.componentVariantId,
          branchId: row.branchId,
          baseQuantity: selected.baseQuantity,
          movementType: "OUT",
          referenceType: "AFTERCARE",
          referenceId: id,
          documentNumber: row.caseNumber,
          createdBy: actor.userId,
          respectProductBackorder: false,
          notes: "بديل إضافي معتمد — مصروف جودة",
        });
        if (!movement.movementId)
          throw fulfillmentError("لا توجد حركة صرف مخزون حقيقية للصنف");
        movementId = movement.movementId;
        totalCost = totalCost.add(lineCost);
      }
      await tx.insert(aftercareExecutionLines).values({
        executionId: id,
        aftercareLineId: line.id,
        kind: "OUTPUT",
        variantId: line.componentVariantId,
        baseQuantity: selected.baseQuantity,
        fulfilledBaseQuantity: selected.baseQuantity,
        custodyBaseQuantity: selected.baseQuantity,
        movementId,
        unitCost,
        lineCost,
        reusedFromLineId: previous?.id,
      });
      if (!previous && line.disposition === "REPRINT") {
        for (const material of selected.materials ?? []) {
          const variant = await loadAftercareProductTx(tx, material.variantId);
          const cost = toDbMoney(
            money(variant.costPrice).mul(material.baseQuantity),
          );
          const movement = await applyMovement(tx, {
            variantId: material.variantId,
            branchId: row.branchId,
            baseQuantity: material.baseQuantity,
            movementType: "OUT",
            referenceType: "AFTERCARE",
            referenceId: id,
            documentNumber: row.caseNumber,
            createdBy: actor.userId,
            respectProductBackorder: false,
            notes: "خامة جديدة لأمر إعادة تصنيع مرتبط بالأصل",
          });
          if (!movement.movementId)
            throw fulfillmentError(
              "خامة إعادة التصنيع لا تملك حركة صرف حقيقية",
            );
          await tx.insert(aftercareExecutionLines).values({
            executionId: id,
            aftercareLineId: line.id,
            kind: "MATERIAL",
            variantId: material.variantId,
            baseQuantity: material.baseQuantity,
            fulfilledBaseQuantity: 0,
            movementId: movement.movementId,
            unitCost: variant.costPrice,
            lineCost: cost,
          });
          totalCost = totalCost.add(cost);
        }
      }
      if (!previous)
        await tx
          .update(aftercareLines)
          .set({
            executedBaseQuantity:
              line.executedBaseQuantity + selected.baseQuantity,
          })
          .where(eq(aftercareLines.id, line.id));
    }
    await tx
      .update(aftercareExecutions)
      .set({ totalCost: toDbMoney(totalCost) })
      .where(eq(aftercareExecutions.id, id));
    await postAftercareIssueTx(tx, {
      executionId: id,
      branchId: row.branchId,
      actorId: actor.userId,
      cost: totalCost,
    });
    await tx
      .update(aftercareCases)
      .set({ status: "IN_PROGRESS", version: row.version + 1 })
      .where(eq(aftercareCases.id, row.id));
    await recordFulfillmentMutationTx(tx, context, id);
    await audit(tx, actor, "prepare", row.id, {
      ...input,
      executionId: id,
      totalCost: toDbMoney(totalCost),
    });
    return { id, replay: false };
  });
}

export async function dispatchAftercareExecution(
  input: Identity & { partyId: number; externalTrackingRef?: string },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await permission(tx, actor, "dispatch");
    const { row, execution } = await lockedExecution(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.dispatch",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return {
        id: execution.id,
        consignmentId: execution.consignmentId,
        replay: true,
      };
    assertFulfillmentVersion(execution, input.expectedVersion);
    if (execution.status !== "PREPARED" || execution.consignmentId)
      throw fulfillmentError("هذه الدفعة ليست جاهزة لإسناد جديد");
    const [party] = await tx
      .select()
      .from(deliveryParties)
      .where(eq(deliveryParties.id, input.partyId))
      .for("update")
      .limit(1);
    if (
      !party?.isActive ||
      (party.branchId != null && party.branchId !== row.branchId)
    )
      throw fulfillmentError("جهة التوصيل غير فعالة أو تخص فرعاً آخر");
    const tracking = requireExternalTrackingRef(
      party.partyType,
      input.externalTrackingRef,
    );
    if (tracking)
      await assertExternalTrackingRefAvailable(tx, party.id, tracking);
    const number = await nextConsignmentNumber(tx, row.branchId);
    const consignmentId = extractInsertId(
      await tx.insert(deliveryConsignments).values({
        consignmentNumber: number,
        branchId: row.branchId,
        partyId: party.id,
        invoiceId: null,
        sourceType: "AFTERCARE_EXECUTION",
        sourceId: execution.id,
        aftercareExecutionId: execution.id,
        codAmount: "0.00",
        feeCollection: "SHOP",
        deliveryFee: execution.deliveryFee,
        parcelStatus: "ASSIGNED",
        moneyStatus: "NOT_APPLICABLE",
        status: "DISPATCHED",
        recipientName: execution.recipientName,
        recipientPhone: execution.recipientPhone,
        deliveryAddress: execution.deliveryAddress,
        endCustomerId: row.customerId,
        externalTrackingRef: tracking,
        dispatchedBy: actor.userId,
        notes: "معالجة بعد البيع — لا يطالب العميل بأي مبلغ",
      }),
    );
    await tx
      .update(aftercareExecutions)
      .set({
        partyId: party.id,
        consignmentId,
        status: "DISPATCHED",
        dispatchedBy: actor.userId,
        dispatchedAt: new Date(),
        version: execution.version + 1,
      })
      .where(eq(aftercareExecutions.id, execution.id));
    await appendDeliveryEvent(tx, {
      eventKey: `AC:${execution.id}:DISPATCH`,
      consignmentId,
      eventType: "AFTERCARE_DISPATCHED",
      toParcelStatus: "ASSIGNED",
      toMoneyStatus: "NOT_APPLICABLE",
      actorUserId: actor.userId,
      payload: {
        aftercareExecutionId: execution.id,
        caseId: row.id,
        codAmount: "0.00",
      },
    });
    await recordFulfillmentMutationTx(tx, context, execution.id);
    await audit(tx, actor, "dispatch", row.id, { ...input, consignmentId });
    return { id: execution.id, consignmentId, replay: false };
  });
}

export type DeliveryResult = Identity & {
  proof: string;
  result: "DELIVERED" | "FAILED" | "RETURNED";
  feeEarned?: boolean;
};
export async function assertAftercareCourierTx(
  tx: Tx,
  cn: typeof deliveryConsignments.$inferSelect,
  userId: number,
) {
  const [party] = await tx
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, cn.partyId))
    .for("share")
    .limit(1);
  if (!party?.isActive)
    throw fulfillmentError("جهة التوصيل غير فعالة", "FORBIDDEN");
  const [member] = await tx
    .select()
    .from(deliveryPartyMembers)
    .where(
      and(
        eq(deliveryPartyMembers.partyId, cn.partyId),
        eq(deliveryPartyMembers.userId, userId),
      ),
    )
    .for("share")
    .limit(1);
  if (!member && party.userId !== userId)
    throw fulfillmentError(
      "هذه المعالجة لا تخص جهة التوصيل المرتبطة بحسابك",
      "FORBIDDEN",
    );
  if (member && !member.isActive)
    throw fulfillmentError(
      "عضوية جهة التوصيل أوقفت؛ لا يمكن تأكيد حركة العهدة بهذا الحساب",
      "FORBIDDEN",
    );
  if (member?.memberRole === "ACCOUNTANT")
    throw fulfillmentError(
      "عضوية محاسب جهة التوصيل لا تسمح بتأكيد حركة العهدة أو التسليم",
      "FORBIDDEN",
    );
  assertMemberCanUseConsignment(
    {
      userId,
      partyId: cn.partyId,
      partyName: party.name,
      partyType: party.partyType,
      memberRole:
        member?.memberRole ??
        (party.partyType === "COMPANY" ? "MANAGER" : "DRIVER"),
    },
    cn,
  );
}
/** Store manager evidence gate; never invokes sale return or changes original AR. */
export async function confirmAftercareDelivery(
  input: DeliveryResult,
  actor: Actor,
) {
  return withTx((tx) => confirmAftercareDeliveryTx(tx, input, actor));
}

export type AftercareResultAuthorization =
  | { kind: "COURIER" }
  | {
      kind: "STAFF";
      operationPath:
        | "delivery.staffConfirm"
        | "delivery.manualProof"
        | "delivery.staffMarkFailed"
        | "delivery.returnConsignment"
        | "delivery.returnByBarcode"
        | "delivery.recordCompanyStatement";
      operationAuthority?: ServiceOperationAuthority;
    };
export function aftercareStaffResultRoleAllowed(
  role: string,
  operationPath: string,
) {
  return (
    role === "admin" ||
    role === "manager" ||
    (role === "cashier" &&
      !["delivery.manualProof", "delivery.recordCompanyStatement"].includes(
        operationPath,
      )) ||
    (role === "warehouse" &&
      ["delivery.returnConsignment", "delivery.returnByBarcode"].includes(
        operationPath,
      ))
  );
}

/** Single physical/fee writer for aftercare; joins the caller's existing transaction. */
export async function confirmAftercareDeliveryTx(
  tx: Tx,
  input: DeliveryResult,
  actor: Actor,
  authorization?: AftercareResultAuthorization,
) {
  nonempty(input.proof, "إثبات التسليم أو الرجوع");
  if (!authorization) await permission(tx, actor, "confirm");
  else if (authorization.kind === "STAFF")
    await assertOperationAuthorityTx(
      tx,
      actor,
      authorization.operationPath,
      (current) =>
        aftercareStaffResultRoleAllowed(
          current.role,
          authorization.operationPath,
        ),
      authorization.operationAuthority,
    );
  else await loadOperationUserTx(tx, actor.userId);
  if (
    authorization?.kind === "COURIER" &&
    (input.result === "RETURNED" ||
      (input.result !== "DELIVERED" && input.feeEarned === true))
  )
    throw fulfillmentError(
      "استلام العهدة العائدة أو اعتماد أجرة محاولة فاشلة يحتاج موظف المكتبة المخول",
      "FORBIDDEN",
    );
  const { row, lines, execution, executionLines } = await lockedExecution(
    tx,
    input.id,
    actor,
  );
  const context = fulfillmentMutationContext(
    "aftercare.confirm",
    input,
    input,
    actor,
    row.branchId,
  );
  if (await findFulfillmentReplayTx(tx, context))
    return { id: execution.id, replay: true };
  assertFulfillmentVersion(execution, input.expectedVersion);
  if (
    execution.status !== "DISPATCHED" ||
    !execution.consignmentId ||
    !execution.partyId
  )
    throw fulfillmentError("يلزم إرسالية معالجة بعهدة الناقل");
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, execution.consignmentId))
    .for("update")
    .limit(1);
  if (
    !cn ||
    cn.sourceType !== "AFTERCARE_EXECUTION" ||
    cn.aftercareExecutionId !== execution.id ||
    cn.invoiceId != null ||
    !money(cn.codAmount).isZero()
  )
    throw fulfillmentError(
      "مصدر الإرسالية أو قيمة التحصيل لا يطابق عقد المعالجة",
    );
  if (authorization?.kind === "COURIER")
    await assertAftercareCourierTx(tx, cn, actor.userId);
  if (cn.returnDeclaredAt && input.result !== "RETURNED")
    throw fulfillmentError(
      "رجوع عهدة المعالجة معلن؛ أكد استلامها وفحصها فعلياً قبل أي إجراء آخر",
    );
  if (["DELIVERED", "RETURNED", "CANCELLED"].includes(cn.parcelStatus))
    throw fulfillmentError(
      "الإرسالية منتهية بالفعل؛ راجع سجل الإثبات",
      "CONFLICT",
    );
  await assertPeriodOpen(tx, new Date());
  const delivered = input.result === "DELIVERED";
  const returned = input.result === "RETURNED";
  for (const output of executionLines.filter(
    (line) => line.kind === "OUTPUT",
  )) {
    if (delivered || returned)
      await tx
        .update(aftercareExecutionLines)
        .set({
          custodyBaseQuantity: 0,
          deliveredBaseQuantity: delivered ? output.fulfilledBaseQuantity : 0,
          returnedBaseQuantity: returned ? output.fulfilledBaseQuantity : 0,
        })
        .where(eq(aftercareExecutionLines.id, output.id));
    if (delivered) {
      const line = lines.find(
        (candidate) => candidate.id === output.aftercareLineId,
      )!;
      if (
        line.deliveredBaseQuantity + output.fulfilledBaseQuantity >
        line.baseQuantity
      )
        throw fulfillmentError(
          "التسليم يتجاوز كمية المعالجة المعتمدة",
          "CONFLICT",
        );
      await tx
        .update(aftercareLines)
        .set({
          deliveredBaseQuantity:
            line.deliveredBaseQuantity + output.fulfilledBaseQuantity,
        })
        .where(eq(aftercareLines.id, line.id));
    }
  }
  const now = new Date();
  await tx
    .update(aftercareExecutions)
    .set({
      status: delivered ? "DELIVERED" : returned ? "RETURNED" : "DISPATCHED",
      deliveredBy: delivered ? actor.userId : undefined,
      deliveredAt: delivered ? now : undefined,
      returnedAt: returned ? now : undefined,
      deliveryProof: delivered ? input.proof : undefined,
      returnEvidence: returned ? input.proof : undefined,
      notes: input.result === "FAILED" ? input.proof : execution.notes,
      version: execution.version + 1,
    })
    .where(eq(aftercareExecutions.id, execution.id));
  await tx
    .update(deliveryConsignments)
    .set({
      parcelStatus: input.result,
      status: delivered ? "DELIVERED" : returned ? "RETURNED" : "DISPATCHED",
      moneyStatus: "NOT_APPLICABLE",
      courierDeliveredAt: delivered ? now : undefined,
      returnedAt: returned ? now : undefined,
      failedAt: input.result === "FAILED" ? now : undefined,
      failureReason: input.result === "FAILED" ? input.proof : undefined,
    })
    .where(eq(deliveryConsignments.id, cn.id));
  // A failed/returned attempt earns a fee only when the manager explicitly verifies it.
  if (
    (delivered || input.feeEarned === true) &&
    money(execution.deliveryFee).gt(0)
  ) {
    const { deliveryLedgerEntries } = await import("../../../drizzle/schema");
    const [earned] = await tx
      .select({ id: deliveryLedgerEntries.id })
      .from(deliveryLedgerEntries)
      .where(
        eq(deliveryLedgerEntries.eventKey, `AC:${execution.id}:FEE_EARNED`),
      )
      .for("share")
      .limit(1);
    if (!earned) {
      const amount = money(execution.deliveryFee);
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `AC:${execution.id}:FEE_EARNED`,
        partyId: execution.partyId,
        consignmentId: cn.id,
        branchId: row.branchId,
        entryType: "FEE_EARNED",
        amount: execution.deliveryFee,
        actorUserId: actor.userId,
        notes: input.proof,
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE",
        branchId: row.branchId,
        deliveryPartyId: execution.partyId,
        dedupeKey: `AFTERCARE_FEE:${execution.id}`,
        amount,
        cost: amount,
        profit: amount.neg(),
        postingIntent: deliveryFeeAccrualIntent(amount),
        postingSourceComponents: {
          roleDebits: { DELIVERY_EXPENSE: amount },
          roleCredits: { COURIER_PAYABLE: amount },
        },
        createdBy: actor.userId,
        notes: `استحقاق أجرة معالجة ${row.caseNumber}`,
      });
    }
  }
  await appendDeliveryEvent(tx, {
    eventKey: `AC:${execution.id}:${input.result}:${input.clientRequestId}`,
    consignmentId: cn.id,
    eventType: `AFTERCARE_${input.result}`,
    fromParcelStatus: cn.parcelStatus,
    toParcelStatus: input.result,
    actorUserId: actor.userId,
    payload: {
      proof: input.proof,
      caseId: row.id,
      aftercareExecutionId: execution.id,
    },
  });
  await tx
    .update(aftercareCases)
    .set({ version: row.version + 1 })
    .where(eq(aftercareCases.id, row.id));
  await recordFulfillmentMutationTx(tx, context, execution.id);
  await audit(tx, actor, "confirm", row.id, input);
  return { id: execution.id, replay: false };
}

export async function payAftercareDeliveryFee(
  input: Identity & {
    shiftId?: number;
    cashBucket: "DRAWER" | "TREASURY";
    amount: string;
  },
  actor: Actor,
) {
  const amount = money(fee(input.amount));
  if (!amount.gt(0)) throw fulfillmentError("أدخل مبلغ صرف موجباً");
  return withTx(async (tx) => {
    await permission(tx, actor, "payFee");
    const [preview] = await tx
      .select()
      .from(aftercareExecutions)
      .where(eq(aftercareExecutions.id, input.id))
      .limit(1);
    if (!preview)
      throw fulfillmentError("دفعة المعالجة غير موجودة", "NOT_FOUND");
    assertFulfillmentBranch(actor, preview.branchId);
    const replayContext = fulfillmentMutationContext(
      "aftercare.payFee",
      input,
      input,
      actor,
      preview.branchId,
    );
    // A read-only retry remains recoverable even after the cash day/shift closes.
    const completed = await checkIdempotency(
      tx,
      replayContext.operation,
      replayContext.clientRequestId,
      replayContext.sourceHash,
      { requireStoredHash: true },
    );
    if (completed)
      return { id: preview.id, receiptId: completed, replay: true };
    // Cash lock first, consistent with existing courier payout services.
    const cashSource = await lockCashSourceForUpdate(tx, {
      branchId: preview.branchId,
      cashBucket: input.cashBucket,
      shiftId: input.shiftId,
    });
    const { row, execution } = await lockedExecution(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.payFee",
      input,
      input,
      actor,
      row.branchId,
    );
    const replay = await findFulfillmentReplayTx(tx, context);
    if (replay) return { id: execution.id, receiptId: replay, replay: true };
    assertFulfillmentVersion(execution, input.expectedVersion);
    if (
      !execution.consignmentId ||
      !execution.partyId ||
      execution.status === "PREPARED"
    )
      throw fulfillmentError("الدفعة لا تملك استحقاق ناقل مثبتاً");
    const { deliveryLedgerEntries } = await import("../../../drizzle/schema");
    const [sums] = await tx
      .select({
        due: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET','FEE_REFUNDED') THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
      })
      .from(deliveryLedgerEntries)
      .where(eq(deliveryLedgerEntries.consignmentId, execution.consignmentId))
      .for("share");
    const due = money(sums?.due ?? "0");
    if (amount.gt(due))
      throw fulfillmentError("الصرف يتجاوز استحقاق الناقل المتبقي", "CONFLICT");
    if (actor.userId === row.createdBy)
      throw fulfillmentError(
        "صرف الأجرة يحتاج موظفاً آخر غير طالب المعالجة",
        "FORBIDDEN",
      );
    if (input.cashBucket === "TREASURY") {
      const approval = await authorizeExternalTreasuryDisbursement(tx, {
        actor,
        makerUserIds: [row.createdBy],
        branchIds: [row.branchId],
        operation: "صرف أجرة المعالجة",
      });
      await assertApprovedTreasuryOutAvailable(
        tx,
        { branchId: row.branchId, amount, operation: "صرف أجرة المعالجة" },
        approval,
      );
    } else {
      await assertCashOutAvailable(tx, {
        branchId: row.branchId,
        cashBucket: input.cashBucket,
        shiftId: cashSource.shiftId,
        amount,
        operation: "صرف أجرة المعالجة",
      });
    }
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId: row.branchId,
      cashBucket: input.cashBucket,
      shiftId: cashSource.shiftId,
      paymentMethod: "CASH",
      status: "COMPLETED",
    });
    const receiptId = extractInsertId(
      await tx.insert(receipts).values({
        branchId: row.branchId,
        shiftId: cashSource.shiftId,
        direction: "OUT",
        amount: toDbMoney(amount),
        paymentMethod: "CASH",
        cashBucket: input.cashBucket,
        status: "COMPLETED",
        partyType: "OTHER",
        referenceNumber: `ACF-${execution.id}-${randomUUID()}`,
        description: `صرف استحقاق ناقل للمعالجة ${row.caseNumber}`,
        createdBy: actor.userId,
      }),
    );
    await postEntry(tx, {
      entryType: "DELIVERY_FEE",
      branchId: row.branchId,
      deliveryPartyId: execution.partyId,
      receiptId,
      dedupeKey: `AFTERCARE_FEE_PAYMENT:${receiptId}`,
      amount,
      postingIntent: deliveryFeeSettlementIntent(amount, input.cashBucket),
      postingSourceComponents: {
        roleDebits: { COURIER_PAYABLE: amount },
        roleCredits: {
          [input.cashBucket === "DRAWER" ? "CASH" : "TREASURY_CASH"]: amount,
        },
      },
      createdBy: actor.userId,
      notes: "تسديد استحقاق معالجة سابق — دون مصروف جديد",
    });
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `AC:${execution.id}:FEE_PAID:${receiptId}`,
      partyId: execution.partyId,
      consignmentId: execution.consignmentId,
      branchId: row.branchId,
      entryType: "FEE_PAID",
      amount: toDbMoney(amount),
      actorUserId: actor.userId,
    });
    const paid = money(execution.deliveryFee).minus(due).add(amount);
    await tx
      .update(aftercareExecutions)
      .set({
        feePaidAmount: toDbMoney(paid),
        feeReceiptId: receiptId,
        version: execution.version + 1,
      })
      .where(eq(aftercareExecutions.id, execution.id));
    if (amount.eq(due))
      await tx
        .update(deliveryConsignments)
        .set({ feeSettledAt: new Date() })
        .where(eq(deliveryConsignments.id, execution.consignmentId));
    await recordFulfillmentMutationTx(tx, context, receiptId);
    await audit(tx, actor, "payFee", row.id, { ...input, receiptId });
    return { id: execution.id, receiptId, replay: false };
  });
}

export async function cancelAftercareCase(
  input: Identity & { reason: string },
  actor: Actor,
) {
  nonempty(input.reason, "سبب الإلغاء");
  return withTx(async (tx) => {
    await permission(tx, actor, "cancel");
    const { row, lines } = await lockedCase(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.cancel",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return { id: row.id, replay: true };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (
      row.status === "CANCELLED" ||
      row.status === "RESOLVED" ||
      lines.some((line) => line.executedBaseQuantity > 0)
    )
      throw fulfillmentError(
        "الحالة منفذة أو منتهية؛ سوّ العهدة والالتزامات بمستند معالجة ولا تلغ أثر صرف فعلي",
      );
    await tx
      .update(aftercareCases)
      .set({
        status: "CANCELLED",
        cancelledBy: actor.userId,
        cancelledAt: new Date(),
        cancellationReason: input.reason.trim(),
        version: row.version + 1,
      })
      .where(eq(aftercareCases.id, row.id));
    await recordFulfillmentMutationTx(tx, context, row.id);
    await audit(tx, actor, "cancel", row.id, input);
    return { id: row.id, replay: false };
  });
}

export async function resolveAftercareCase(
  input: Identity & { resolution: string },
  actor: Actor,
) {
  nonempty(input.resolution, "نتيجة المعالجة");
  return withTx(async (tx) => {
    await permission(tx, actor, "resolve");
    const { row, lines } = await lockedCase(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.resolve",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return { id: row.id, replay: true };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (
      row.status !== "IN_PROGRESS" ||
      lines.some((line) => line.deliveredBaseQuantity !== line.baseQuantity)
    )
      throw fulfillmentError("لا تغلق الحالة قبل تسليم كامل الكميات المعتمدة");
    const executions = await tx
      .select()
      .from(aftercareExecutions)
      .where(eq(aftercareExecutions.caseId, row.id))
      .orderBy(aftercareExecutions.id)
      .for("update");
    if (
      executions.some((execution) =>
        ["PREPARED", "DISPATCHED"].includes(execution.status),
      )
    )
      throw fulfillmentError("توجد عهدة مفتوحة؛ سوّها أولاً");
    const { deliveryLedgerEntries } = await import("../../../drizzle/schema");
    if (executions.length) {
      const ids = executions.flatMap((execution) =>
        execution.consignmentId ? [execution.consignmentId] : [],
      );
      const [balance] = ids.length
        ? await tx
            .select({
              due: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET','FEE_REFUNDED') THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
            })
            .from(deliveryLedgerEntries)
            .where(inArray(deliveryLedgerEntries.consignmentId, ids))
            .for("share")
        : [];
      if (money(balance?.due ?? "0").gt(0))
        throw fulfillmentError("يوجد استحقاق ناقل مفتوح على محاولة سابقة");
    }
    await tx
      .update(aftercareCases)
      .set({
        status: "RESOLVED",
        resolution: input.resolution.trim(),
        resolvedBy: actor.userId,
        resolvedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(aftercareCases.id, row.id));
    await recordFulfillmentMutationTx(tx, context, row.id);
    await audit(tx, actor, "resolve", row.id, input);
    return { id: row.id, replay: false };
  });
}

import Decimal from "decimal.js";
import { eq, inArray } from "drizzle-orm";
import {
  aftercareCases,
  aftercareExecutionLines,
  aftercareExecutions,
  aftercareLines,
  aftercareSettlementLines,
  aftercareSettlements,
} from "../../../drizzle/fulfillmentSchema";
import {
  deliveryConsignments,
  deliveryLedgerEntries,
  inventoryMovements,
} from "../../../drizzle/schema";
import type {
  AftercareSettlementDecision,
  AftercareSettlementSourceRight,
  FulfillmentMutationIdentity,
} from "../../../shared/fulfillment";
import { aftercareDispositionLabel } from "../../../shared/fulfillment";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { logAuditTx } from "../auditService";
import { applyValuedInboundMovement } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { money, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { aftercarePermissionTx, lockedCase } from "./aftercare";
import { postAftercareIssueReturnTx } from "./aftercarePosting";
import {
  assertFulfillmentVersion,
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentFingerprint,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "./core";
import { fulfillmentCostVisibleTx } from "./visibility";
import {
  createDeliveryDocumentSnapshotTx,
  listDeliveryDocumentSnapshotsTx,
  type GenericWorkflowDocumentPayload,
} from "../delivery/documentSnapshots";

export type AftercareSettlementInput = {
  id: number;
  expectedVersion: number;
  reason: string;
  evidence: string;
  physicalHeldConfirmed: boolean;
  decisions: AftercareSettlementDecision[];
  sourceRights: AftercareSettlementSourceRight[];
};
type SettlementIdentity = FulfillmentMutationIdentity & { id: number };

function evidence(value: string) {
  if (!value || value.trim().length < 3 || value.length > 2000)
    throw fulfillmentError("أدخل محضر فحص وسبباً واضحاً من 3 إلى 2000 محرف");
}
function quantity(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw fulfillmentError("كميات التسوية يجب أن تكون أعداداً صحيحة غير سالبة");
}

/** Source mutex -> case -> executions -> movement -> variant. Same source lock as real returns. */
async function snapshotTx(
  tx: Tx,
  input: AftercareSettlementInput,
  actor: Actor,
  excludingSettlementId?: number,
) {
  evidence(input.reason);
  evidence(input.evidence);
  if (input.physicalHeldConfirmed !== true)
    throw fulfillmentError(
      "يلزم إثبات الفحص والوجود الفعلي لكل الكميات القابلة للإرجاع",
    );
  const state = await lockedCase(tx, input.id, actor);
  assertFulfillmentVersion(state.row, input.expectedVersion);
  if (!["APPROVED", "IN_PROGRESS"].includes(state.row.status))
    throw fulfillmentError("تسوّى حالة معتمدة أو قيد المعالجة فقط");
  if (
    state.lines.every(
      (line) => line.deliveredBaseQuantity === line.baseQuantity,
    )
  )
    throw fulfillmentError(
      "كل الكميات مسلّمة؛ استخدم الإقفال المعتاد بعد تسديد الأجور",
    );
  const executions = await tx
    .select()
    .from(aftercareExecutions)
    .where(eq(aftercareExecutions.caseId, input.id))
    .orderBy(aftercareExecutions.id)
    .for("update");
  if (executions.some((row) => row.status === "DISPATCHED"))
    throw fulfillmentError(
      "توجد عهدة ناقل؛ أعلن الرجوع ثم سجل الاستلام والفحص الفعلي قبل التسوية",
    );
  const consignmentIds = executions.flatMap((row) =>
    row.consignmentId ? [row.consignmentId] : [],
  );
  const consignments = consignmentIds.length
    ? await tx
        .select()
        .from(deliveryConsignments)
        .where(inArray(deliveryConsignments.id, consignmentIds))
        .orderBy(deliveryConsignments.id)
        .for("update")
    : [];
  if (
    consignments.some(
      (row) =>
        !["DELIVERED", "RETURNED", "CANCELLED"].includes(row.parcelStatus) ||
        !money(row.collectedAmount).isZero() ||
        !money(row.counterSettledAmount).isZero(),
    )
  )
    throw fulfillmentError(
      "توجد إرسالية أو حقوق تحصيل مفتوحة؛ أكمل حركة العهدة والتحصيل أولاً",
    );
  const ledger = consignmentIds.length
    ? await tx
        .select()
        .from(deliveryLedgerEntries)
        .where(inArray(deliveryLedgerEntries.consignmentId, consignmentIds))
        .orderBy(deliveryLedgerEntries.id)
        .for("share")
    : [];
  // Check each consignment: a credit on another attempt must never mask an unpaid carrier.
  for (const id of consignmentIds) {
    let due = money(0);
    for (const entry of ledger.filter((row) => row.consignmentId === id)) {
      if (entry.entryType === "FEE_EARNED") due = due.add(entry.amount);
      else if (
        ["FEE_PAID", "FEE_OFFSET", "FEE_REFUNDED"].includes(entry.entryType)
      )
        due = due.minus(entry.amount);
      else if (money(entry.amount).gt(0))
        throw fulfillmentError(
          "يوجد أثر تحصيل أو عهدة مالية غير متوقعة؛ راجع سندات الإرسالية",
        );
    }
    if (!due.isZero())
      throw fulfillmentError(
        "سوّ استحقاق الناقل الفعلي لكل محاولة قبل تسوية الكميات",
      );
  }
  const ids = executions.map((row) => row.id);
  const allLines = ids.length
    ? await tx
        .select()
        .from(aftercareExecutionLines)
        .where(inArray(aftercareExecutionLines.executionId, ids))
        .orderBy(aftercareExecutionLines.id)
        .for("update")
    : [];
  const reusedIds = new Set(
    allLines.flatMap((row) =>
      row.reusedFromLineId ? [row.reusedFromLineId] : [],
    ),
  );
  const leaf = (
    line: typeof aftercareExecutionLines.$inferSelect,
  ): typeof aftercareExecutionLines.$inferSelect => {
    const next = allLines.find((row) => row.reusedFromLineId === line.id);
    return next ? leaf(next) : line;
  };
  const selected = allLines.filter((line) => {
    if (line.kind === "OUTPUT")
      return (
        !reusedIds.has(line.id) &&
        line.deliveredBaseQuantity < line.fulfilledBaseQuantity
      );
    const output = allLines.find(
      (row) =>
        row.executionId === line.executionId &&
        row.aftercareLineId === line.aftercareLineId &&
        row.kind === "OUTPUT",
    );
    return !!output && leaf(output).deliveredBaseQuantity === 0;
  });
  if (
    input.decisions.length !== selected.length ||
    new Set(input.decisions.map((row) => row.executionLineId)).size !==
      selected.length
  )
    throw fulfillmentError(
      "حدّد مصير كامل مخارج الدفعات المتوقفة وخاماتها دون تكرار أو إسقاط",
    );
  const projected = [];
  for (const line of selected) {
    const decision = input.decisions.find(
      (row) => row.executionLineId === line.id,
    );
    if (!decision)
      throw fulfillmentError(
        "تغيّرت أسطر التسوية؛ أعد الفحص والمعاينة",
        "CONFLICT",
      );
    evidence(decision.evidence);
    [
      decision.usableBaseQuantity,
      decision.consumedBaseQuantity,
      decision.damagedBaseQuantity,
    ].forEach(quantity);
    const required = line.baseQuantity - line.deliveredBaseQuantity;
    if (
      decision.usableBaseQuantity +
        decision.consumedBaseQuantity +
        decision.damagedBaseQuantity !==
        required ||
      line.settledBaseQuantity
    )
      throw fulfillmentError(
        "مجموع الصالح والمستهلك والتالف يجب أن يساوي الكمية المتوقفة غير المسواة بالضبط",
      );
    const parent = state.lines.find((row) => row.id === line.aftercareLineId)!;
    if (
      line.kind === "OUTPUT" &&
      parent.disposition === "MISSING_HELD" &&
      decision.consumedBaseQuantity
    )
      throw fulfillmentError(
        "المبيع الأصلي حق للعميل؛ صفه صالحاً أو تالفاً مع حقه الأصلي، ولا تسقطه كخامة مستهلكة",
      );
    if (
      line.kind === "OUTPUT" &&
      parent.disposition === "REPRINT" &&
      decision.usableBaseQuantity
    )
      throw fulfillmentError(
        "المطبوع النهائي ليس خامة متاحة؛ سجّل الخامات الصالحة الأصلية وحدها في أسطر المواد",
      );
    const execution = executions.find((row) => row.id === line.executionId)!;
    if (
      line.kind === "OUTPUT" &&
      execution.status !== "PREPARED" &&
      (line.returnedBaseQuantity !== line.fulfilledBaseQuantity ||
        !execution.returnEvidence)
    )
      throw fulfillmentError(
        "لا توجد كمية عائدة مستلمة ومفحوصة تطابق مخرج الدفعة",
      );
    let original = line;
    const visited = new Set<number>();
    while (original.reusedFromLineId) {
      if (visited.has(original.id))
        throw fulfillmentError("سلسلة إعادة الإرسال غير صحيحة");
      visited.add(original.id);
      const previous = allLines.find(
        (row) => row.id === original.reusedFromLineId,
      );
      if (!previous || previous.aftercareLineId !== line.aftercareLineId)
        throw fulfillmentError("لا يوجد أصل صرف صحيح للعهدة المعاد إرسالها");
      original = previous;
    }
    let restoredValue = money(0);
    if (decision.usableBaseQuantity && original.movementId) {
      const [movement] = await tx
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.id, original.movementId))
        .for("share")
        .limit(1);
      if (
        !movement ||
        movement.branchId !== state.row.branchId ||
        movement.variantId !== original.variantId ||
        movement.movementType !== "OUT" ||
        movement.referenceType !== "AFTERCARE" ||
        movement.referenceId !== original.executionId ||
        movement.quantity !== original.baseQuantity
      )
        throw fulfillmentError(
          "حركة الصرف الأصلية لا تطابق هوية وكمية وتكلفة الخامة أو البديل",
        );
      restoredValue = money(original.lineCost)
        .mul(decision.usableBaseQuantity)
        .div(original.baseQuantity)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    projected.push({
      ...decision,
      aftercareLineId: line.aftercareLineId,
      kind: line.kind,
      disposition: parent.disposition,
      originalIssueLineId: original.movementId ? original.id : null,
      originalMovementId: original.movementId,
      variantId: original.variantId,
      restoredValue: toDbMoney(restoredValue),
      baseQuantity: required,
    });
  }
  const held = state.lines.filter(
    (line) =>
      line.disposition === "MISSING_HELD" &&
      line.deliveredBaseQuantity < line.baseQuantity,
  );
  const sourceRights = input.sourceRights;
  if (sourceRights.length !== held.length)
    throw fulfillmentError(
      "حدّد حق العميل الأصلي لكل سطر مبيع بعهدتنا دون إسقاط أو إضافة",
    );
  const usedRights = new Set<number>();
  for (const right of sourceRights) {
    const index = held.findIndex(
      (line, index) =>
        !usedRights.has(index) &&
        line.originalInvoiceItemId === right.invoiceItemId &&
        (line.originalBundleComponentId ?? null) ===
          right.originalBundleComponentId &&
        line.componentVariantId === right.componentVariantId &&
        line.originalMovementId === right.originalMovementId &&
        line.baseQuantity - line.deliveredBaseQuantity === right.baseQuantity,
    );
    if (index < 0)
      throw fulfillmentError(
        "حق العميل لا يطابق هوية وكمية وحركة المبيع الأصلي",
        "CONFLICT",
      );
    usedRights.add(index);
    [
      right.baseQuantity,
      right.usableBaseQuantity,
      right.damagedBaseQuantity,
    ].forEach(quantity);
    if (
      right.usableBaseQuantity + right.damagedBaseQuantity !==
      right.baseQuantity
    )
      throw fulfillmentError(
        "مجموع الأصل الصالح والتالف يجب أن يطابق حق العميل الأصلي",
      );
    const preparedRights = projected.filter(
      (line) =>
        line.kind === "OUTPUT" && line.aftercareLineId === held[index].id,
    );
    if (
      preparedRights.reduce((sum, line) => sum + line.usableBaseQuantity, 0) >
        right.usableBaseQuantity ||
      preparedRights.reduce((sum, line) => sum + line.damagedBaseQuantity, 0) >
        right.damagedBaseQuantity
    )
      throw fulfillmentError(
        "فحص حق الأصل يناقض الكميات الصالحة والتالفة المثبتة في دفعاته",
      );
    if (
      ![right.commercialAmount, right.originalIssueValue].every((value) =>
        /^\d{1,13}(\.\d{1,2})?$/.test(value),
      )
    )
      throw fulfillmentError("قيم حق العميل والأصل غير صالحة");
    evidence(right.costEvidence);
    evidence(right.costEvidenceReference);
  }
  const restoredValue = toDbMoney(
    projected.reduce((sum, row) => sum.add(row.restoredValue), money(0)),
  );
  if (sourceRights.length) {
    const { validateAftercareSourceRightsTx } =
      await import("./componentRights");
    await validateAftercareSourceRightsTx(
      tx,
      { source: state.source, rights: sourceRights, excludingSettlementId },
      actor,
    );
  }
  const hash = fulfillmentFingerprint({
    input: {
      id: input.id,
      expectedVersion: input.expectedVersion,
      physicalHeldConfirmed: input.physicalHeldConfirmed,
      decisions: input.decisions,
      sourceRights: input.sourceRights,
      reason: input.reason.trim(),
      evidence: input.evidence.trim(),
    },
    row: state.row,
    lines: state.lines,
    executions,
    allLines,
    consignments,
    ledger,
    projected,
    sourceRights,
    invoice: state.source.invoice,
    items: state.source.items,
  });
  return {
    ...state,
    executions,
    allLines,
    projected,
    sourceRights,
    restoredValue,
    hash,
  };
}

export async function previewAftercareSettlement(
  input: AftercareSettlementInput,
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      await aftercarePermissionTx(tx, actor, "settlementPreview");
      const data = await snapshotTx(tx, input, actor);
      const visible = await fulfillmentCostVisibleTx(tx, actor);
      return {
        previewHash: data.hash,
        restoredValue: visible ? data.restoredValue : null,
        lines: data.projected.map((row) => ({
          ...row,
          restoredValue: visible ? row.restoredValue : null,
        })),
        sourceRights: data.sourceRights,
      };
    },
    { gate: "NONE" },
  );
}

export async function requestAftercareSettlement(
  input: AftercareSettlementInput & {
    previewHash: string;
    clientRequestId: string;
  },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await aftercarePermissionTx(tx, actor, "settlementRequest");
    const state = await lockedCase(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.settlementRequest",
      input,
      input,
      actor,
      state.row.branchId,
    );
    const replay = await findFulfillmentReplayTx(tx, context);
    if (replay) return { id: replay, replay: true };
    const { previewHash, clientRequestId: _key, ...previewInput } = input;
    const data = await snapshotTx(tx, previewInput, actor);
    if (data.hash !== previewHash)
      throw fulfillmentError(
        "تغيّرت حقائق المعاينة؛ أعد المعاينة قبل طلب التسوية",
        "CONFLICT",
      );
    const [existing] = await tx
      .select({ id: aftercareSettlements.id })
      .from(aftercareSettlements)
      .where(eq(aftercareSettlements.activeCaseId, input.id))
      .for("share")
      .limit(1);
    if (existing)
      throw fulfillmentError(
        "توجد تسوية لهذه الحالة؛ راجع المستند القائم",
        "CONFLICT",
      );
    const id = extractInsertId(
      await tx.insert(aftercareSettlements).values({
        caseId: input.id,
        branchId: data.row.branchId,
        caseVersion: input.expectedVersion,
        previewHash,
        reason: input.reason.trim(),
        evidence: input.evidence.trim(),
        decisions: input.decisions,
        sourceRights: data.sourceRights,
        restoredValue: data.restoredValue,
        createdBy: actor.userId,
        clientRequestId: input.clientRequestId,
        sourceHash: context.sourceHash,
      }),
    );
    await recordFulfillmentMutationTx(tx, context, id);
    await logAuditTx(tx, actor, {
      action: "delivery.fulfillment.aftercare.settlementRequest",
      entityType: "aftercareSettlement",
      entityId: id,
      newValue: { caseId: input.id, previewHash },
    });
    return { id, replay: false };
  });
}

function storedInput(
  row: typeof aftercareSettlements.$inferSelect,
): AftercareSettlementInput {
  return {
    id: row.caseId,
    expectedVersion: row.caseVersion,
    reason: row.reason,
    evidence: row.evidence,
    decisions: row.decisions,
    sourceRights: row.sourceRights,
    physicalHeldConfirmed: true,
  };
}
async function settlementTx(tx: Tx, id: number, actor: Actor) {
  const [preview] = await tx
    .select()
    .from(aftercareSettlements)
    .where(eq(aftercareSettlements.id, id))
    .limit(1);
  if (!preview)
    throw fulfillmentError("مستند تسوية المعالجة غير موجود", "NOT_FOUND");
  await lockedCase(tx, preview.caseId, actor);
  const [row] = await tx
    .select()
    .from(aftercareSettlements)
    .where(eq(aftercareSettlements.id, id))
    .for("update")
    .limit(1);
  if (!row) throw fulfillmentError("مستند التسوية غير موجود", "NOT_FOUND");
  return row;
}
export async function approveAftercareSettlement(
  input: SettlementIdentity,
  actor: Actor,
) {
  return withTx(async (tx) => {
    await aftercarePermissionTx(tx, actor, "approveSettlement");
    const row = await settlementTx(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.approveSettlement",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return { id: row.id, replay: true };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (row.status !== "REQUESTED")
      throw fulfillmentError("تعتمد تسوية بانتظار المراجعة فقط");
    if (row.createdBy === actor.userId)
      throw fulfillmentError(
        "مراجع التسوية يجب أن يكون مستقلاً عن طالبها حتى لحساب المالك",
        "FORBIDDEN",
      );
    const data = await snapshotTx(tx, storedInput(row), actor, row.id);
    if (data.hash !== row.previewHash)
      throw fulfillmentError(
        "تغيّرت حقائق الكمية أو الحقوق منذ المعاينة؛ يلزم فحص جديد",
        "CONFLICT",
      );
    await tx
      .update(aftercareSettlements)
      .set({
        status: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(aftercareSettlements.id, row.id));
    await recordFulfillmentMutationTx(tx, context, row.id);
    await logAuditTx(tx, actor, {
      action: "delivery.fulfillment.aftercare.approveSettlement",
      entityType: "aftercareSettlement",
      entityId: row.id,
      newValue: { previewHash: row.previewHash },
    });
    return { id: row.id, replay: false };
  });
}

export async function postAftercareSettlement(
  input: SettlementIdentity,
  actor: Actor,
) {
  return withTx(async (tx) => {
    await aftercarePermissionTx(tx, actor, "settlementPost");
    const row = await settlementTx(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.settlementPost",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return {
        id: row.id,
        replay: true,
        documentSnapshotIds: (
          await listDeliveryDocumentSnapshotsTx(tx, {
            sourceType: "AFTERCARE_SETTLEMENT",
            sourceId: row.id,
            branchId: row.branchId,
          })
        )
          .filter(
            (snapshot) =>
              snapshot.eventKey === `AFTERCARE_SETTLEMENT:${row.id}:POSTED`,
          )
          .map((snapshot) => snapshot.id),
      };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (
      row.status !== "APPROVED" ||
      !row.approvedBy ||
      row.approvedBy === row.createdBy
    )
      throw fulfillmentError(
        "يلزم اعتماد تسوية مستقل قبل الترحيل",
        "FORBIDDEN",
      );
    if (row.createdBy === actor.userId)
      throw fulfillmentError(
        "ترحيل الاسترجاع يحتاج موظفاً مستقلاً عن طالب التسوية",
        "FORBIDDEN",
      );
    const data = await snapshotTx(tx, storedInput(row), actor, row.id);
    if (data.hash !== row.previewHash)
      throw fulfillmentError(
        "تغيّرت أدلة التسوية المعتمدة؛ لم يرحّل أي أثر",
        "CONFLICT",
      );
    await lockInventoryVariants(
      tx,
      data.projected.flatMap((line) =>
        line.variantId && line.usableBaseQuantity && line.originalMovementId
          ? [line.variantId]
          : [],
      ),
    );
    for (const line of data.projected) {
      let returnMovementId: number | null = null;
      if (
        line.usableBaseQuantity &&
        line.originalMovementId &&
        line.variantId
      ) {
        const returned = await applyValuedInboundMovement(tx, {
          branchId: row.branchId,
          variantId: line.variantId,
          baseQuantity: line.usableBaseQuantity,
          historicalValue: line.restoredValue,
          movementType: "RETURN",
          referenceType: "AFTERCARE_SETTLEMENT",
          referenceId: row.id,
          documentNumber: data.row.caseNumber,
          createdBy: actor.userId,
          notes: `استلام صالح مفحوص من حركة الصرف ${line.originalMovementId} — سطر ${line.executionLineId}`,
        });
        if (!returned.movementId)
          throw fulfillmentError("لم تسجل حركة استلام فعلية للصنف المخزني");
        returnMovementId = returned.movementId;
      }
      await tx.insert(aftercareSettlementLines).values({
        settlementId: row.id,
        executionLineId: line.executionLineId,
        originalIssueLineId: line.originalIssueLineId,
        originalMovementId: line.originalMovementId,
        returnMovementId,
        usableBaseQuantity: line.usableBaseQuantity,
        consumedBaseQuantity: line.consumedBaseQuantity,
        damagedBaseQuantity: line.damagedBaseQuantity,
        restoredValue: line.restoredValue,
        evidence: line.evidence,
      });
      await tx
        .update(aftercareExecutionLines)
        .set({ settledBaseQuantity: line.baseQuantity, custodyBaseQuantity: 0 })
        .where(eq(aftercareExecutionLines.id, line.executionLineId));
    }
    await postAftercareIssueReturnTx(tx, {
      settlementId: row.id,
      branchId: row.branchId,
      actorId: actor.userId,
      cost: money(data.restoredValue),
    });
    for (const execution of data.executions.filter(
      (value) => value.status === "PREPARED",
    ))
      await tx
        .update(aftercareExecutions)
        .set({
          status: "CANCELLED",
          returnEvidence: row.evidence,
          returnedAt: new Date(),
          version: execution.version + 1,
        })
        .where(eq(aftercareExecutions.id, execution.id));
    for (const line of data.lines)
      await tx
        .update(aftercareLines)
        .set({
          settledBaseQuantity: line.baseQuantity - line.deliveredBaseQuantity,
        })
        .where(eq(aftercareLines.id, line.id));
    await tx
      .update(aftercareSettlements)
      .set({
        status: "POSTED",
        postedBy: actor.userId,
        postedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(aftercareSettlements.id, row.id));
    await tx
      .update(aftercareCases)
      .set({ status: "IN_PROGRESS", version: data.row.version + 1 })
      .where(eq(aftercareCases.id, row.caseId));
    const [posted] = await tx
      .select({ postedAt: aftercareSettlements.postedAt })
      .from(aftercareSettlements)
      .where(eq(aftercareSettlements.id, row.id))
      .limit(1);
    if (!posted?.postedAt)
      throw fulfillmentError(
        "تعذر إثبات وقت ترحيل التسوية؛ لم تحفظ المطبوعات",
        "CONFLICT",
      );
    const payload: GenericWorkflowDocumentPayload = {
      schemaVersion: 1,
      title: "محضر تسوية عهدة المعالجة",
      documentNumber: `${data.row.caseNumber}/SET-${row.id}`,
      eventOccurredAt: posted.postedAt.toISOString(),
      rows: [
        { label: "حالة المعالجة", value: data.row.caseNumber },
        { label: "رقم التسوية", value: String(row.id) },
        {
          label: "مرجع أصل المبيع",
          value:
            data.row.invoiceId != null
              ? `فاتورة #${data.row.invoiceId}`
              : `أمر شغل #${data.row.workOrderId}`,
        },
        { label: "طالب التسوية", value: `#${row.createdBy}` },
        {
          label: "المراجع المستقل",
          value: `#${row.approvedBy} — ${row.approvedAt?.toISOString() ?? "الاعتماد المحفوظ"}`,
        },
        { label: "منفذ الترحيل", value: `#${actor.userId}` },
        ...data.projected.map((line) => ({
          label: `سطر دفعة المعالجة #${line.executionLineId}`,
          value: `${aftercareDispositionLabel[line.disposition]}؛ صالح ${line.usableBaseQuantity}؛ مستهلك ${line.consumedBaseQuantity}؛ تالف ${line.damagedBaseQuantity}؛ ${line.originalMovementId == null ? "لا حركة صرف مخزني أصلية لهذا السطر" : `مرجع الصرف #${line.originalMovementId}`}`,
        })),
        ...data.sourceRights.map((right) => ({
          label: `حق أصل المبيع المتبقي — بند #${right.invoiceItemId}`,
          value: `المصدر #${right.originalMovementId}؛ صالح ${right.usableBaseQuantity}؛ تالف ${right.damagedBaseQuantity}؛ تنفيذه التجاري والمالي من مساره المستقل`,
        })),
      ],
      totals: [
        {
          label: "عدد أسطر عهدة المعالجة المسواة",
          value: String(data.projected.length),
        },
      ],
      notice:
        "يثبت مصائر عهدة المعالجة التي رحلت بهذه التسوية فقط. حقوق أصل المبيع والتحصيل ورد الأموال تبقى على مستنداتها المستقلة. لا يتضمن هذا المحضر تكاليف داخلية ولا ينشئ قيداً أو قبضاً جديداً.",
    };
    const document = await createDeliveryDocumentSnapshotTx(tx, {
      documentType: "AFTERCARE_SETTLEMENT",
      layout: "THERMAL_80_CONTENT_72",
      sourceType: "AFTERCARE_SETTLEMENT",
      sourceId: row.id,
      sourceVersion: row.previewHash,
      branchId: row.branchId,
      eventKey: `AFTERCARE_SETTLEMENT:${row.id}:POSTED`,
      eventOccurredAt: posted.postedAt,
      payload,
      createdBy: actor.userId,
    });
    await recordFulfillmentMutationTx(tx, context, row.id);
    await logAuditTx(tx, actor, {
      action: "delivery.fulfillment.aftercare.settlementPost",
      entityType: "aftercareSettlement",
      entityId: row.id,
      newValue: {
        restoredValue: data.restoredValue,
        sourceRights: data.sourceRights,
        originalSourceReturnRequired: data.sourceRights.length > 0,
      },
    });
    return {
      id: row.id,
      replay: false,
      documentSnapshotIds: [Number(document.snapshot.id)],
    };
  });
}

/** Withdraw before posting only; keep the old reviewed evidence and release the preparation hold. */
export async function withdrawAftercareSettlement(
  input: SettlementIdentity & { reason: string },
  actor: Actor,
) {
  evidence(input.reason);
  return withTx(async (tx) => {
    await aftercarePermissionTx(tx, actor, "settlementWithdraw");
    const row = await settlementTx(tx, input.id, actor);
    const context = fulfillmentMutationContext(
      "aftercare.settlementWithdraw",
      input,
      input,
      actor,
      row.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return { id: row.id, replay: true };
    assertFulfillmentVersion(row, input.expectedVersion);
    if (!["REQUESTED", "APPROVED"].includes(row.status))
      throw fulfillmentError("لا يسحب مستند مرحّل؛ صحح آثاره بمستند مرتبط");
    if (row.createdBy !== actor.userId && row.approvedBy !== actor.userId)
      throw fulfillmentError(
        "سحب التسوية غير المرحّلة لطالبها أو مراجعها فقط",
        "FORBIDDEN",
      );
    await tx
      .update(aftercareSettlements)
      .set({ status: "WITHDRAWN", version: row.version + 1 })
      .where(eq(aftercareSettlements.id, row.id));
    await recordFulfillmentMutationTx(tx, context, row.id);
    await logAuditTx(tx, actor, {
      action: "delivery.fulfillment.aftercare.settlementWithdraw",
      entityType: "aftercareSettlement",
      entityId: row.id,
      newValue: {
        reason: input.reason,
        previousStatus: row.status,
        previewHash: row.previewHash,
      },
    });
    return { id: row.id, replay: false };
  });
}

/** Closure checks source quantities and actual money, never a textual waiver or paidAmount echo. */
export async function assertAftercareSettlementRightsClosedTx(
  tx: Tx,
  caseId: number,
) {
  const [settlement] = await tx
    .select()
    .from(aftercareSettlements)
    .where(eq(aftercareSettlements.activeCaseId, caseId))
    .for("share")
    .limit(1);
  if (!settlement) return;
  if (settlement.status !== "POSTED")
    throw fulfillmentError(
      "توجد تسوية غير مرحّلة؛ أكمل الاعتماد والترحيل أولاً",
    );
  if (!settlement.sourceRights.length) return;
  const { assertComponentRightsClosedTx } = await import("./componentRights");
  await assertComponentRightsClosedTx(tx, settlement.id);
}

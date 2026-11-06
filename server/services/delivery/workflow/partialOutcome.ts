import { and, asc, eq } from "drizzle-orm";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
  deliveryParties,
  deliveryRemittances,
  deliveryRemittanceLines,
  deliveryShipmentMembers,
  invoiceItems,
  invoices,
  products,
  productVariants,
  receipts,
} from "../../../../drizzle/schema";
import { deliveryCustodyItems } from "../../../../drizzle/fulfillmentSchema";
import type { Tx } from "../../../db";
import { retryOnDup } from "../../../lib/retryDup";
import { assertOperationAuthorityTx } from "../../authorization/operationAuthority";
import { logAuditTx } from "../../auditService";
import {
  assertFulfillmentBranch,
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentFingerprint,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "../../fulfillment/core";
import { money, round2, toDbMoney } from "../../money";
import { loadAssignedChargeClaimsTx } from "../../fulfillment/chargeDelivery";
import { withTx, type Actor } from "../../tx";
import { confirmConsignmentDelivery } from "../courier";
import { appendDeliveryEvent } from "../lifecycle";
import { effectiveDeliveryLedgerEntrySql } from "../legacyLedger";
import {
  lockDeliveryRemittanceCashSourceInTx,
  recordDeliveryRemittanceInTx,
} from "../remittance";
import { currentWorkflowActorTx } from "./preview";
import {
  PHYSICAL_RETURN_RECEIVED,
  physicalReturnReceiptTx,
} from "./returnReceipt";

export const PARTIAL_DELIVERY_SCOPE_CORRECTED =
  "PARTIAL_DELIVERY_SCOPE_CORRECTED";

async function loadPlan(
  tx: Tx,
  consignmentId: number,
  actor: Actor,
  lock = false,
) {
  const query = tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, consignmentId));
  const [cn] = await (lock ? query.for("update") : query).limit(1);
  if (!cn) throw fulfillmentError("الإرسالية غير موجودة", "NOT_FOUND");
  assertFulfillmentBranch(actor, Number(cn.branchId));
  const invoiceQuery = tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, Number(cn.invoiceId)));
  const [invoice] = await (
    lock ? invoiceQuery.for("update") : invoiceQuery
  ).limit(1);
  if (!invoice || invoice.branchId !== cn.branchId)
    throw fulfillmentError("لا توجد فاتورة أصلية متطابقة مع فرع الإرسالية");
  const itemQuery = tx
    .select({ item: invoiceItems, name: products.name })
    .from(invoiceItems)
    .leftJoin(productVariants, eq(productVariants.id, invoiceItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .where(eq(invoiceItems.invoiceId, invoice.id))
    .orderBy(asc(invoiceItems.id));
  const items = await (lock ? itemQuery.for("share") : itemQuery);
  const custodyQuery = tx
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.consignmentId, cn.id))
    .orderBy(asc(deliveryCustodyItems.id));
  const custody = await (lock ? custodyQuery.for("share") : custodyQuery);
  const ledgerQuery = tx
    .select()
    .from(deliveryLedgerEntries)
    .where(
      and(
        eq(deliveryLedgerEntries.consignmentId, cn.id),
        effectiveDeliveryLedgerEntrySql(),
      ),
    )
    .orderBy(asc(deliveryLedgerEntries.id));
  const ledger = await (lock ? ledgerQuery.for("share") : ledgerQuery);
  const eventQuery = tx
    .select()
    .from(deliveryEvents)
    .where(eq(deliveryEvents.consignmentId, cn.id))
    .orderBy(asc(deliveryEvents.id));
  const events = await (lock ? eventQuery.for("share") : eventQuery);
  const assignedCharges = await loadAssignedChargeClaimsTx(tx, cn.id, { lock });
  const returnQuery = tx
    .select({ id: accountingEntries.id, amount: accountingEntries.amount })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.invoiceId, invoice.id),
        eq(accountingEntries.entryType, "RETURN"),
      ),
    )
    .orderBy(asc(accountingEntries.id));
  const returns = await (lock ? returnQuery.for("share") : returnQuery);
  const receiptQuery = tx
    .select({
      id: receipts.id,
      amount: receipts.amount,
      status: receipts.status,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.invoiceId, invoice.id),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
      ),
    )
    .orderBy(asc(receipts.id));
  const cashReceipts = await (lock ? receiptQuery.for("share") : receiptQuery);
  const memberQuery = tx
    .select()
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, cn.id));
  const [membership] = await (
    lock ? memberQuery.for("share") : memberQuery
  ).limit(1);
  const siblingsQuery = membership
    ? tx
        .select({ id: deliveryShipmentMembers.consignmentId })
        .from(deliveryShipmentMembers)
        .where(
          eq(
            deliveryShipmentMembers.leaderConsignmentId,
            membership.leaderConsignmentId,
          ),
        )
        .orderBy(asc(deliveryShipmentMembers.consignmentId))
    : null;
  const siblings = siblingsQuery
    ? await (lock ? siblingsQuery.for("share") : siblingsQuery)
    : [];
  const physicalReceipt =
    cn.parcelStatus === "RETURNED"
      ? await physicalReturnReceiptTx(tx, cn, { currentRead: lock })
      : null;
  const scopedReceipts = events.filter((event) => {
    const p = event.payload as Record<string, unknown> | null;
    return (
      event.eventType === PHYSICAL_RETURN_RECEIVED &&
      p?.scope === "ITEMS" &&
      p.version === 1 &&
      p.inspected === true &&
      p.invoiceId === invoice.id &&
      p.branchId === cn.branchId &&
      p.sourceType === cn.sourceType &&
      p.sourceId === cn.sourceId &&
      p.dispatchedAt === cn.dispatchedAt.toISOString() &&
      typeof p.claimVersion === "number" &&
      p.claimVersion <= cn.codClaimVersion
    );
  });
  const returnedLines = items
    .filter(({ item }) => Number(item.returnedBaseQuantity) > 0)
    .map(({ item, name }) => ({
      invoiceItemId: Number(item.id),
      name: name ?? `بند ${item.id}`,
      baseQuantity: Number(item.returnedBaseQuantity),
    }));
  const deliveredLines = items
    .filter(
      ({ item }) =>
        Number(item.baseQuantity) > Number(item.returnedBaseQuantity),
    )
    .map(({ item, name }) => ({
      invoiceItemId: Number(item.id),
      name: name ?? `بند ${item.id}`,
      baseQuantity:
        Number(item.baseQuantity) - Number(item.returnedBaseQuantity),
    }));
  const covered = new Map<number, number>();
  let malformedScope = false;
  for (const event of scopedReceipts) {
    const lines = (event.payload as { receivedLines?: unknown }).receivedLines;
    if (!Array.isArray(lines)) {
      malformedScope = true;
      continue;
    }
    for (const line of lines) {
      const item = items.find(
        ({ item }) => item.id === line?.invoiceItemId,
      )?.item;
      if (
        !item ||
        !Number.isSafeInteger(line?.baseQuantity) ||
        line.baseQuantity <= 0
      ) {
        malformedScope = true;
        continue;
      }
      const total = (covered.get(item.id) ?? 0) + line.baseQuantity;
      if (total > Number(item.baseQuantity)) malformedScope = true;
      covered.set(item.id, total);
    }
  }
  const receivedReturnCovered =
    physicalReceipt != null ||
    (!malformedScope &&
      returnedLines.every(
        (line) => (covered.get(line.invoiceItemId) ?? 0) >= line.baseQuantity,
      ));
  const cashInCustody = round2(
    ledger.reduce(
      (sum, row) =>
        row.entryType === "COD_COLLECTED"
          ? sum.plus(money(row.amount))
          : ["COD_REMITTED", "COD_RETURNED", "COD_WRITTEN_OFF"].includes(
                row.entryType,
              )
            ? sum.minus(money(row.amount))
            : sum,
      money(0),
    ),
  );
  const invoiceRemaining = round2(
    money(invoice.total)
      .minus(money(invoice.returnedTotal))
      .minus(money(invoice.paidAmount)),
  );
  const priorQuery = tx
    .select()
    .from(deliveryRemittances)
    .where(eq(deliveryRemittances.id, cn.remittanceId ?? 0));
  const [priorRemittance] = await (
    lock ? priorQuery.for("share") : priorQuery
  ).limit(1);
  const allocationQuery = tx
    .select()
    .from(deliveryRemittanceLines)
    .where(eq(deliveryRemittanceLines.remittanceId, priorRemittance?.id ?? 0))
    .orderBy(asc(deliveryRemittanceLines.id));
  const allocations = await (lock
    ? allocationQuery.for("share")
    : allocationQuery);
  const priorReceiptQuery = tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, priorRemittance?.receiptInId ?? 0));
  const [priorReceipt] = await (
    lock ? priorReceiptQuery.for("share") : priorReceiptQuery
  ).limit(1);
  const postingQuery = tx
    .select()
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.receiptId, priorReceipt?.id ?? 0),
        eq(
          accountingEntries.dedupeKey,
          `DELIVERY_REMIT:${cn.id}:${priorRemittance?.id ?? 0}`,
        ),
      ),
    );
  const [priorPosting] = await (
    lock ? postingQuery.for("share") : postingQuery
  ).limit(1);
  const receiptUseQuery = tx
    .select({ id: deliveryRemittances.id })
    .from(deliveryRemittances)
    .where(eq(deliveryRemittances.receiptInId, priorReceipt?.id ?? 0));
  const receiptUses = await (lock
    ? receiptUseQuery.for("share")
    : receiptUseQuery);
  // Reuse only a complete, exactly allocated system remittance. Generic vouchers
  // can already carry cash/party effects and require their own allocation path.
  const cashAlreadyRecorded =
    !!physicalReceipt &&
    cn.parcelStatus === "RETURNED" &&
    invoiceRemaining.isZero() &&
    cashInCustody.isZero() &&
    cn.courierDeliveredAt != null &&
    priorRemittance?.partyId === cn.partyId &&
    priorRemittance.branchId === cn.branchId &&
    priorRemittance.status === "BALANCED" &&
    allocations.length === 1 &&
    allocations[0].consignmentId === cn.id &&
    money(allocations[0].cashReceived).gt(0) &&
    money(allocations[0].cashReceived).eq(money(allocations[0].grossApplied)) &&
    priorReceipt?.status === "COMPLETED" &&
    priorReceipt.direction === "IN" &&
    priorReceipt.paymentMethod === "CASH" &&
    priorReceipt.branchId === cn.branchId &&
    priorReceipt.referenceNumber === priorRemittance.remittanceNumber &&
    money(priorReceipt.amount).eq(money(allocations[0].cashReceived)) &&
    receiptUses.length === 1 &&
    priorPosting?.entryType === "DELIVERY_REMIT" &&
    priorPosting.invoiceId === invoice.id &&
    priorPosting.deliveryPartyId === cn.partyId &&
    priorPosting.branchId === cn.branchId &&
    money(priorPosting.amount).eq(money(priorReceipt.amount));
  const goods = cashAlreadyRecorded
    ? money(priorReceipt!.amount)
    : round2(invoiceRemaining.plus(cashInCustody));
  const block =
    !["DISPATCHED", "PARTIAL"].includes(cn.status) && !cashAlreadyRecorded
      ? "الإرسالية مغلقة؛ راجع التسوية المثبتة بدلاً من تسجيل نقد جديد"
      : ["CANCELLED", "RETURNED", "SUPERSEDED"].includes(invoice.status) ||
          invoice.sourceType === "WORKORDER" ||
          cn.sourceType === "AFTERCARE_EXECUTION"
        ? "هذا المصدر يحتاج مسار التصحيح الخاص به"
        : siblings.length > 1
          ? "هذه إرسالية من شحنة مجمعة؛ راجع أعضاء الشحنة قبل تسويتها"
          : cn.returnDeclaredAt != null
            ? "يوجد إعلان رجوع كامل؛ راجع نطاق الإعلان وقيود تحرير المطالبة قبل تسوية تسليم جزئي"
            : assignedCharges.remaining.gt(0)
              ? "للإرسالية مطالبات أجور إضافية؛ طابق البضاعة والأجور من تحصيل طلب التوصيل قبل استكمال التسوية"
              : !returnedLines.length ||
                  !deliveredLines.length ||
                  !money(invoice.returnedTotal).gt(0)
                ? "يلزم مرتجع تجاري جزئي منفذ مع بضاعة متبقية مسلمة للعميل"
                : !returns.length
                  ? "لا يوجد مستند مرتجع تجاري منفذ مرتبط بالفاتورة"
                  : !receivedReturnCovered
                    ? "محاضر الاستلام لا تغطي بنود المرتجع التجاري وكمياته؛ طابق البنود المستلمة قبل التسوية"
                    : items.some(
                          ({ item }) =>
                            !item.variantId || Number(item.baseQuantity) <= 0,
                        ) ||
                        custody.some(
                          (row) =>
                            !["STOCKED_ITEM"].includes(row.itemKind) ||
                            row.reviewStatus === "REVIEW_REQUIRED",
                        )
                      ? "تتضمن العهدة بنوداً تحتاج مراجعة مكوناتها أو كمياتها الأصلية"
                      : cashReceipts.some(
                            (row) => row.status === "COMPLETED",
                          ) && !cashAlreadyRecorded
                        ? "يوجد إيصال نقد سابق مرتبط بالفاتورة؛ طابق تخصيصه من مساره الأصلي لمنع قبض مكرر"
                        : cashInCustody.lt(0) ||
                            invoiceRemaining.lt(0) ||
                            !goods.gt(0)
                          ? "لا يوجد مبلغ بضاعة موجب قابل للتوريد؛ راجع القيود السابقة"
                          : cashInCustody.gt(0) && invoiceRemaining.gt(0)
                            ? "يوجد تحصيل جزئي سابق؛ أكمل إثبات التحصيل من كشفه الأصلي أولاً"
                            : null;
  const version = fulfillmentFingerprint({
    cn,
    invoice,
    items,
    custody,
    ledger,
    events: events.map((event) => event.id),
    physicalReceiptId: physicalReceipt?.id ?? null,
    returns,
    cashReceipts,
    siblings,
    priorRemittance,
    allocations,
    priorReceipt,
    priorPosting,
    receiptUses,
    assignedCharges: {
      event: assignedCharges.event,
      rows: assignedCharges.rows,
      remaining: toDbMoney(assignedCharges.remaining),
    },
  });
  return {
    cn,
    invoice,
    physicalReceipt,
    invoiceRemaining,
    cashInCustody,
    returnedLines,
    deliveredLines,
    priorRemittance,
    preview: {
      consignmentId: cn.id,
      branchId: cn.branchId,
      invoiceNumber: invoice.invoiceNumber,
      version,
      allowed: block == null,
      blockedReason: block,
      goodsAmount: toDbMoney(goods),
      feeAmount: cn.deliveryFee,
      feeCollection: cn.feeCollection,
      returnedLines,
      deliveredLines,
      cashAlreadyRecorded,
      existingRemittanceNumber: cashAlreadyRecorded
        ? priorRemittance!.remittanceNumber
        : null,
      items: items.map(({ item, name }) => ({
        invoiceItemId: Number(item.id),
        name: name ?? `بند ${item.id}`,
        baseQuantity: Number(item.baseQuantity),
        returnedBaseQuantity: Number(item.returnedBaseQuantity),
      })),
    },
  };
}

export function previewPartialDeliverySettlement(
  input: { consignmentId: number },
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor);
      return (await loadPlan(tx, input.consignmentId, auth.actor)).preview;
    },
    { gate: "NONE" },
  );
}

export interface SettlePartialDeliveryInput {
  consignmentId: number;
  expectedVersion: string;
  cashReceivedAmount: string;
  targetShiftId?: number;
  evidence: string;
  clientRequestId: string;
}

/** Records the witnessed historical outcome; no new sale, stock return or courier fee cash. */
export function settlePartialDeliveryOutcome(
  input: SettlePartialDeliveryInput,
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor);
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        "delivery.manualProof",
        (user) =>
          user.isOwner === true || user.resolvedPermissions?.store === "FULL",
      );
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        "delivery.recordRemittance",
        (user) =>
          user.isOwner === true || user.resolvedPermissions?.store === "FULL",
      );
      const [identity] = await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .limit(1);
      if (!identity)
        throw fulfillmentError("الإرسالية غير موجودة", "NOT_FOUND");
      assertFulfillmentBranch(auth.actor, Number(identity.branchId));
      const context = fulfillmentMutationContext(
        "workflow.partialOutcome",
        input,
        input,
        auth.actor,
        identity.branchId,
      );
      const replay = await findFulfillmentReplayTx(tx, context);
      if (replay) {
        const [saved] = await tx
          .select()
          .from(deliveryRemittances)
          .where(eq(deliveryRemittances.id, replay))
          .limit(1);
        return {
          remittanceId: replay,
          remittanceNumber: saved?.remittanceNumber ?? "",
          idempotentReplay: true,
        };
      }
      const received = round2(money(input.cashReceivedAmount));
      if (
        !received.isFinite() ||
        !received.gt(0) ||
        input.evidence.trim().length < 5
      )
        throw fulfillmentError(
          "حدد النقد المستلم ودليل التسليم والتحصيل والتوريد الفعلي",
        );
      const remitInput = {
        branchId: identity.branchId,
        partyId: identity.partyId,
        lines: [
          { consignmentId: identity.id, collectedAmount: toDbMoney(received) },
        ],
        countedCash: toDbMoney(received),
        targetShiftId: input.targetShiftId,
        clientRequestId: `PARTIAL:${input.clientRequestId}`,
      };
      const initial = await loadPlan(tx, input.consignmentId, auth.actor);
      if (
        !initial.preview.cashAlreadyRecorded &&
        (!Number.isSafeInteger(input.targetShiftId) ||
          input.targetShiftId! <= 0)
      )
        throw fulfillmentError(
          "حدد الدرج الذي استلم النقد فعلياً قبل إثبات التوريد",
        );
      const cashSource = initial.preview.cashAlreadyRecorded
        ? undefined
        : await lockDeliveryRemittanceCashSourceInTx(
            tx,
            remitInput,
            auth.actor,
          );
      await tx
        .select()
        .from(deliveryParties)
        .where(eq(deliveryParties.id, identity.partyId))
        .for("update")
        .limit(1);
      const plan = await loadPlan(tx, input.consignmentId, auth.actor, true);
      const lockedReplay = await findFulfillmentReplayTx(tx, context);
      if (lockedReplay)
        return {
          remittanceId: lockedReplay,
          remittanceNumber: "",
          idempotentReplay: true,
        };
      if (plan.preview.version !== input.expectedVersion)
        throw fulfillmentError(
          "تغيرت الفاتورة أو المرتجع أو النقد منذ المعاينة",
          "CONFLICT",
        );
      if (!plan.preview.allowed)
        throw fulfillmentError(plan.preview.blockedReason!);
      if (received.gt(money(plan.preview.goodsAmount)))
        throw fulfillmentError(
          "النقد المستلم يتجاوز مبلغ البضاعة؛ أجرة المندوب من العميل خارج نقد المكتبة",
        );
      const correctionId = await appendDeliveryEvent(tx, {
        eventKey: `CN:${identity.id}:PARTIAL_SCOPE:${input.clientRequestId}`,
        consignmentId: identity.id,
        eventType: PARTIAL_DELIVERY_SCOPE_CORRECTED,
        actorUserId: auth.actor.userId,
        payload: {
          invoiceId: plan.invoice.id,
          branchId: plan.cn.branchId,
          dispatchedAt: plan.cn.dispatchedAt.toISOString(),
          claimVersion: plan.cn.codClaimVersion,
          deliveredLines: plan.deliveredLines,
          receivedLines: plan.returnedLines,
          supersedesPhysicalReceiptEventId: plan.physicalReceipt?.id ?? null,
          evidence: input.evidence.trim(),
        },
      });
      let result: { remittanceId: number; remittanceNumber: string };
      if (plan.preview.cashAlreadyRecorded) {
        if (!received.eq(money(plan.preview.goodsAmount)))
          throw fulfillmentError(
            "المبلغ لا يطابق إيصال التوريد السابق؛ لا يمكن تغيير النقد بإجراء ربط العهدة",
            "CONFLICT",
          );
        await tx
          .update(deliveryConsignments)
          .set({ parcelStatus: "DELIVERED" })
          .where(eq(deliveryConsignments.id, identity.id));
        result = {
          remittanceId: plan.priorRemittance!.id,
          remittanceNumber: plan.priorRemittance!.remittanceNumber,
        };
      } else {
        await confirmConsignmentDelivery(
          {
            consignmentId: identity.id,
            clientRequestId: `PARTIAL:${input.clientRequestId}`,
            statementWitness: {
              partyId: identity.partyId,
              statementNumber: `تسوية جزئية: ${input.evidence}`.slice(0, 160),
              kind: "MANUAL_PROOF",
              collectedAmount: toDbMoney(plan.invoiceRemaining),
            },
          },
          auth.actor,
          tx,
          { shipmentMember: true, partialOutcomeEventId: correctionId },
        );
        result = await recordDeliveryRemittanceInTx(
          tx,
          remitInput,
          auth.actor,
          cashSource,
        );
      }
      await logAuditTx(tx, auth.actor, {
        action: "delivery.partialOutcome.settled",
        entityType: "deliveryConsignment",
        entityId: identity.id,
        oldValue: {
          parcelStatus: plan.cn.parcelStatus,
          paidAmount: plan.invoice.paidAmount,
          returnedTotal: plan.invoice.returnedTotal,
        },
        newValue: {
          evidence: input.evidence.trim(),
          correctionEventId: correctionId,
          goodsCollectedAmount: plan.preview.goodsAmount,
          cashReceivedAmount: toDbMoney(received),
          cashAlreadyRecorded: plan.preview.cashAlreadyRecorded,
          targetShiftId: input.targetShiftId,
          remittanceId: result.remittanceId,
          returnedLines: plan.returnedLines,
          deliveredLines: plan.deliveredLines,
        },
      });
      await recordFulfillmentMutationTx(tx, context, result.remittanceId);
      return {
        remittanceId: result.remittanceId,
        remittanceNumber: result.remittanceNumber,
        idempotentReplay: false,
      };
    }),
  );
}

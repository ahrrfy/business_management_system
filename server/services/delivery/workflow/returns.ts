import { asc, eq, inArray } from "drizzle-orm";
import { deliveryConsignments, deliveryShipmentMembers } from "../../../../drizzle/schema";
import {
  hasOperationPolicy,
  operationDecision,
} from "../../../../shared/operationPermissions";
import type { WorkflowDispatchSource } from "../../../../shared/deliveryWorkflow";
import { retryOnDup } from "../../../lib/retryDup";
import { assertOperationAuthorityTx } from "../../authorization/operationAuthority";
import { logAuditTx } from "../../auditService";
import {
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "../../fulfillment/core";
import { routeAftercareDeliveryResultTx } from "../../fulfillment/aftercareDelivery";
import { money } from "../../money";
import { withTx, type Actor } from "../../tx";
import { appendDeliveryEvent } from "../lifecycle";
import { repairDeliveryCustodyFromRecordedEventsTx } from "../custody";
import { loadShipmentMembersTx, operationalShipmentMembers } from "../shipments";
import { currentWorkflowActorTx, loadWorkflowPreviewTx } from "./preview";
import {
  PHYSICAL_RETURN_RECEIVED,
  physicalReturnReceiptTx,
} from "./returnReceipt";
import {
  createRecordedShipmentDocumentTx,
  listDeliveryDocumentSnapshotsTx,
  type WorkflowDocumentBody,
} from "../documentSnapshots";

export interface ReceiveWorkflowReturnInput {
  source: WorkflowDispatchSource;
  branchId?: number;
  evidence: string;
  inspected: true;
  receivedConsignmentIds?: number[];
  clientRequestId: string;
}

/** Actual inspected shop custody only. Commercial return and cash refund remain explicit actions. */
export function receiveWorkflowReturn(
  input: ReceiveWorkflowReturnInput,
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      const returnPath =
        hasOperationPolicy(auth.current) &&
        !operationDecision(auth.current, "delivery.returnConsignment")
          .allowed &&
        operationDecision(auth.current, "delivery.returnByBarcode").allowed
          ? ("delivery.returnByBarcode" as const)
          : ("delivery.returnConsignment" as const);
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        returnPath,
        (user) =>
          user.isOwner === true || user.resolvedPermissions?.store === "FULL",
      );
      const preview = await loadWorkflowPreviewTx(
        tx,
        input.source,
        auth.current,
        input.branchId,
        true,
      );
      const leaderId =
        preview.group?.leaderConsignmentId ?? preview.relations.consignmentId;
      if (leaderId == null)
        throw fulfillmentError("المصدر لا يحمل إرسالية قائمة للاستلام الفعلي");
      const members = await loadShipmentMembersTx(tx, leaderId, {
        currentRead: true,
      });
      const ids =
        input.receivedConsignmentIds ??
        (members.length === 1 ? [members[0]!.id] : []);
      if (
        !ids.length ||
        ids.length > 30 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !members.some((row) => row.id === id))
      )
        throw fulfillmentError(
          "حدد كل طرد استلمته وفحصته فعلياً من أعضاء الشحنة؛ لا يُفترض رجوع المجموعة كاملة",
        );
      const context = fulfillmentMutationContext(
        "workflow.receiveReturn",
        input,
        input,
        auth.actor,
        preview.source.branchId,
      );
      const replay = await findFulfillmentReplayTx(tx, context);
      const hasCommercialSource =
        preview.relations.aftercareExecutionId == null &&
        members.some(
          (member) => member.invoiceId != null || member.workOrderId != null,
        );
      const hasStandaloneRequestSource = members.some(
        (member) =>
          member.sourceType === "FULFILLMENT_REQUEST" &&
          member.invoiceId == null,
      );
      let documentSnapshotIds: number[] = [];
      const result = (idempotentReplay: boolean) => ({
        consignmentId: leaderId,
        consignmentIds: [...ids].sort((a, b) => a - b),
        mode: "PHYSICAL_RECEIPT" as const,
        idempotentReplay,
        documentSnapshotIds,
        commercialActionRequired: hasCommercialSource,
        sourceClosureRequired: hasStandaloneRequestSource,
        refundActionRequired:
          hasCommercialSource &&
          (money(preview.money.paidAmount).gt(0) ||
            money(preview.money.heldDeliveryFee).gt(0) ||
            preview.money.pendingRefundReceiptIds.length > 0),
        ...(preview.relations.aftercareExecutionId == null
          ? {}
          : { aftercareExecutionId: preview.relations.aftercareExecutionId }),
      });
      if (replay) {
        for (const id of ids)
          await repairDeliveryCustodyFromRecordedEventsTx(tx, id);
        const eventKeys = new Set(
          ids.map((id) => `CN:${id}:PHYSICAL_RETURN:${input.clientRequestId}`),
        );
        documentSnapshotIds = (
          await listDeliveryDocumentSnapshotsTx(tx, {
            sourceType: "SHIPMENT",
            sourceId: leaderId,
            branchId: preview.source.branchId,
          })
        )
          .filter(
            (row) =>
              eventKeys.has(row.eventKey) &&
              row.documentType === "PHYSICAL_RETURN_RECEIPT",
          )
          .map((row) => row.id)
          .sort((a, b) => a - b);
        return result(true);
      }
      if (preview.source.version !== input.source.expectedVersion)
        throw fulfillmentError(
          "تغيرت الشحنة أو حقوقها منذ المعاينة؛ حدثها قبل إثبات العهدة",
          "CONFLICT",
        );
      if (input.inspected !== true || input.evidence.trim().length < 5)
        throw fulfillmentError(
          "يلزم استلام وفحص فعلي ومحضر يصف الطرود العائدة وحالتها",
        );
      const selected = await tx
        .select()
        .from(deliveryConsignments)
        .where(inArray(deliveryConsignments.id, ids))
        .orderBy(asc(deliveryConsignments.id))
        .for("update");
      const removedReceiptEventIds: number[] = [];
      for (const row of selected) {
        if (row.branchId !== preview.source.branchId)
          throw fulfillmentError(
            "الطرد لا ينتمي إلى فرع الاستلام",
            "FORBIDDEN",
          );
        const documentEventKey = `CN:${row.id}:PHYSICAL_RETURN:${input.clientRequestId}`;
        const document: WorkflowDocumentBody = {
          title: "محضر استلام وفحص طرد عائد",
          documentNumber: row.consignmentNumber,
          rows: [
            { label: "الإرسالية المستلمة", value: row.consignmentNumber },
            {
              label: "مصدر العهدة",
              value: `${row.sourceType} #${row.sourceId}`,
            },
            { label: "صاحب العهدة", value: row.recipientName ?? "غير مسجل" },
            { label: "نتيجة الاستلام والفحص", value: input.evidence.trim() },
          ],
          totals: [],
          notice:
            "يثبت الاستلام والفحص المادي فقط. لا يلغي البيع، ولا يعيد المبيع إلى المخزون المتاح، ولا يرد مال العميل. الحقوق التجارية والمالية على مستنداتها الأصلية.",
        };
        const documentEvidence = {
          branchId: row.branchId,
          leaderConsignmentId: leaderId,
          documentType: "PHYSICAL_RETURN_RECEIPT",
          document,
        };
        if (row.sourceType === "AFTERCARE_EXECUTION") {
          await routeAftercareDeliveryResultTx(
            tx,
            {
              consignmentId: row.id,
              result: "RETURNED",
              proof: input.evidence.trim(),
              clientRequestId: `${input.clientRequestId}:${row.id}`,
              customerCollectedAmount: "0.00",
              authorization: {
                kind: "STAFF",
                operationPath: returnPath,
              },
            },
            auth.actor,
          );
          await appendDeliveryEvent(tx, {
            eventKey: documentEventKey,
            consignmentId: row.id,
            eventType: "WORKFLOW_PHYSICAL_RETURN_RECEIPT",
            actorUserId: auth.actor.userId,
            payload: { ...documentEvidence, metadataOnly: true },
          });
          documentSnapshotIds.push(
            await createRecordedShipmentDocumentTx(tx, {
              consignmentId: leaderId,
              branchId: row.branchId,
              eventKey: documentEventKey,
              documentType: "PHYSICAL_RETURN_RECEIPT",
            }),
          );
          continue;
        }
        if (
          row.parcelStatus === "RETURNED" ||
          (await physicalReturnReceiptTx(tx, row))
        )
          throw fulfillmentError(
            "سُجل استلام هذا الطرد سابقاً؛ راجع الحقوق التجارية والمالية المتبقية",
            "CONFLICT",
          );
        if (
          !["DISPATCHED", "PARTIAL", "DELIVERED"].includes(row.status) ||
          row.parcelStatus === "CANCELLED"
        )
          throw fulfillmentError(
            "لا توجد عهدة مرسلة حالية تقبل إثبات الاستلام؛ لا يمثل الإلغاء الإداري رجوعاً فعلياً",
          );
        const receivedAt = new Date();
        await tx
          .update(deliveryConsignments)
          .set({ parcelStatus: "RETURNED", returnedAt: receivedAt })
          .where(eq(deliveryConsignments.id, row.id));
        const receiptEventId = await appendDeliveryEvent(tx, {
          eventKey: documentEventKey,
          consignmentId: row.id,
          eventType: PHYSICAL_RETURN_RECEIVED,
          fromParcelStatus: row.parcelStatus,
          toParcelStatus: "RETURNED",
          actorUserId: auth.actor.userId,
          payload: {
            ...documentEvidence,
            version: 1,
            inspected: true,
            branchId: row.branchId,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            invoiceId: row.invoiceId,
            workOrderId: row.workOrderId,
            fulfillmentRequestId: row.fulfillmentRequestId,
            claimVersion: row.codClaimVersion,
            dispatchedAt: row.dispatchedAt.toISOString(),
            ownerCustomerId: row.endCustomerId,
            evidence: input.evidence.trim(),
            commercialActionPending: true,
            availableStockAdded: false,
          },
        });
        if (operationalShipmentMembers([row]).length) removedReceiptEventIds.push(receiptEventId);
        documentSnapshotIds.push(
          await createRecordedShipmentDocumentTx(tx, {
            consignmentId: leaderId,
            branchId: row.branchId,
            eventKey: documentEventKey,
            documentType: "PHYSICAL_RETURN_RECEIPT",
          }),
        );
        await logAuditTx(tx, auth.actor, {
          action: "delivery.physicalReturn.received",
          entityType: "deliveryConsignment",
          entityId: row.id,
          oldValue: { parcelStatus: row.parcelStatus },
          newValue: {
            parcelStatus: "RETURNED",
            receivedAt,
            evidence: input.evidence.trim(),
            commercialActionPending: true,
            availableStockAdded: false,
          },
        });
      }
      // Removing one or more parcels changes the claim presented to the driver.
      // Advance once per physical receipt transaction, not once per parcel.
      if (members.length > 1 && removedReceiptEventIds.length) {
        const [leader] = await tx.select().from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, leaderId)).for("update").limit(1);
        const [leaderMembership] = await tx.select().from(deliveryShipmentMembers)
          .where(eq(deliveryShipmentMembers.consignmentId, leaderId)).for("share").limit(1);
        const currentMembers = await loadShipmentMembersTx(tx, leaderId, { currentRead: true });
        const remaining = operationalShipmentMembers(currentMembers);
        if (!leader || Number(leaderMembership?.leaderConsignmentId) !== Number(leaderId) ||
            currentMembers.length !== members.length ||
            currentMembers.some((row) => !members.some((original) => original.id === row.id)))
          throw fulfillmentError("تغيرت روابط الشحنة أثناء إثبات المرتجع؛ حدّث المعاينة وأعد المحاولة", "CONFLICT");
        if (remaining.length) {
          const receipt = leader.parcelStatus === "RETURNED"
            ? await physicalReturnReceiptTx(tx, leader, { currentRead: true }) : null;
          const claimVersion = Number(leader.codClaimVersion) + 1;
          await tx.update(deliveryConsignments).set({ codClaimVersion: claimVersion })
            .where(eq(deliveryConsignments.id, leaderId));
          await appendDeliveryEvent(tx, {
            eventKey: `CN:${leaderId}:CLAIM_CHANGED:PHYSICAL_RETURN:${input.clientRequestId}`,
            consignmentId: leaderId,
            eventType: "COD_CLAIM_CHANGED",
            actorUserId: auth.actor.userId,
            payload: {
              source: "PHYSICAL_RETURN", claimVersion, removedReceiptEventIds,
              ...(receipt ? { physicalReturnReceiptEventId: Number(receipt.id) } : {}),
              ackRequired: remaining.some((row) => money(row.codAmount)
                .gt(money(row.collectedAmount ?? "0").plus(money(row.counterSettledAmount ?? "0")))),
            },
          });
        }
      }
      await recordFulfillmentMutationTx(tx, context, leaderId);
      return result(false);
    }),
  );
}

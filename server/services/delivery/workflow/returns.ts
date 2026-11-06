import { and, asc, eq, inArray } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryShipmentMembers,
  invoiceItems,
  products,
  productVariants,
} from "../../../../drizzle/schema";
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
import {
  initializeConsignmentCustodyTx,
  repairDeliveryCustodyFromRecordedEventsTx,
} from "../custody";
import {
  loadShipmentMembersTx,
  operationalShipmentMembers,
} from "../shipments";
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
  receivedLines?: Array<{
    consignmentId: number;
    invoiceItemId: number;
    baseQuantity: number;
  }>;
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
      if (
        input.receivedLines !== undefined &&
        (!input.receivedLines.length ||
          input.receivedLines.length > 300 ||
          input.receivedLines.some(
            (line) =>
              !ids.includes(line.consignmentId) ||
              !Number.isSafeInteger(line.invoiceItemId) ||
              line.invoiceItemId <= 0 ||
              !Number.isSafeInteger(line.baseQuantity) ||
              line.baseQuantity <= 0,
          ) ||
          new Set(
            input.receivedLines.map(
              (line) => `${line.consignmentId}:${line.invoiceItemId}`,
            ),
          ).size !== input.receivedLines.length ||
          ids.some(
            (id) =>
              !input.receivedLines!.some((line) => line.consignmentId === id),
          ))
      )
        throw fulfillmentError(
          "حدد بنوداً مخزنية فريدة وكميات أساس صحيحة موجبة لكل طرد مستلم",
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
        const receivedLines = input.receivedLines
          ?.filter((line) => line.consignmentId === row.id)
          .map(({ invoiceItemId, baseQuantity }) => ({
            invoiceItemId,
            baseQuantity,
          }));
        let wholeParcel = receivedLines === undefined;
        if (receivedLines) {
          if (row.invoiceId == null || row.sourceType !== "INVOICE")
            throw fulfillmentError(
              "الاستلام الجزئي يتطلب فاتورة أصناف مخزنية؛ استخدم استلام الطرد الكامل للمصادر الأخرى",
            );
          const items = await tx
            .select({
              id: invoiceItems.id,
              baseQuantity: invoiceItems.baseQuantity,
              isService: products.isService,
              isBundle: products.isBundle,
              productType: products.productType,
            })
            .from(invoiceItems)
            .innerJoin(
              productVariants,
              eq(productVariants.id, invoiceItems.variantId),
            )
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(eq(invoiceItems.invoiceId, row.invoiceId))
            .for("share");
          const custody = await initializeConsignmentCustodyTx(tx, {
            consignmentId: row.id,
            actorUserId: auth.actor.userId,
            operationId: `physical-return:${input.clientRequestId}`,
          });
          const priorEvents = await tx
            .select()
            .from(deliveryEvents)
            .where(
              and(
                eq(deliveryEvents.consignmentId, row.id),
                eq(deliveryEvents.eventType, PHYSICAL_RETURN_RECEIVED),
              ),
            )
            .for("share");
          const cumulativeReceived = new Map<number, number>();
          for (const event of priorEvents) {
            const payload = event.payload as Record<string, unknown> | null;
            if (
              !Number.isSafeInteger(event.id) ||
              event.id <= 0 ||
              !payload ||
              payload.version !== 1 ||
              payload.inspected !== true ||
              payload.branchId !== row.branchId ||
              payload.sourceType !== row.sourceType ||
              payload.sourceId !== row.sourceId ||
              payload.invoiceId !== row.invoiceId ||
              payload.workOrderId !== row.workOrderId ||
              payload.fulfillmentRequestId !== row.fulfillmentRequestId ||
              payload.dispatchedAt !== row.dispatchedAt.toISOString() ||
              typeof payload.claimVersion !== "number" ||
              !Number.isSafeInteger(payload.claimVersion) ||
              payload.claimVersion <= 0 ||
              payload.claimVersion > row.codClaimVersion ||
              typeof payload.evidence !== "string" ||
              payload.evidence.trim().length < 5
            )
              continue;
            if (payload.scope === undefined)
              throw fulfillmentError(
                "سُجل استلام هذا الطرد كاملاً سابقاً؛ راجع محاضر الاستلام",
                "CONFLICT",
              );
            if (
              payload.scope !== "ITEMS" ||
              !Array.isArray(payload.receivedLines) ||
              !payload.receivedLines.length ||
              new Set(payload.receivedLines.map((line) => line?.invoiceItemId))
                .size !== payload.receivedLines.length ||
              payload.receivedLines.some(
                (line) =>
                  !line ||
                  !Number.isSafeInteger(line.invoiceItemId) ||
                  !Number.isSafeInteger(line.baseQuantity) ||
                  line.baseQuantity <= 0 ||
                  !items.some(
                    (item) =>
                      item.id === line.invoiceItemId &&
                      line.baseQuantity <= Number(item.baseQuantity),
                  ),
              )
            )
              continue;
            for (const line of payload.receivedLines) {
              cumulativeReceived.set(
                line.invoiceItemId,
                (cumulativeReceived.get(line.invoiceItemId) ?? 0) +
                  line.baseQuantity,
              );
            }
          }
          if (
            items.some(
              (item) =>
                !Number.isSafeInteger(cumulativeReceived.get(item.id) ?? 0) ||
                (cumulativeReceived.get(item.id) ?? 0) >
                  Number(item.baseQuantity),
            )
          )
            throw fulfillmentError(
              "محاضر الاستلام السابقة تتجاوز كمية البند الأصلية؛ يلزم تدقيق العهدة",
              "CONFLICT",
            );
          for (const line of receivedLines) {
            const item = items.find((item) => item.id === line.invoiceItemId);
            const matching = custody.filter(
              (item) => item.invoiceItemId === line.invoiceItemId,
            );
            if (
              !item ||
              item.isService ||
              item.isBundle ||
              item.productType === "DIGITAL_CARD" ||
              matching.length !== 1 ||
              matching[0]!.itemKind !== "STOCKED_ITEM" ||
              Number(matching[0]!.baseQuantity) !== Number(item.baseQuantity)
            )
              throw fulfillmentError(
                "البند لا يطابق صنفاً مخزنياً منفرداً في فاتورة الطرد؛ لا يقبل البكج أو الخدمة",
              );
            const priorQuantity =
              cumulativeReceived.get(line.invoiceItemId) ?? 0;
            if (
              !Number.isSafeInteger(priorQuantity) ||
              priorQuantity + line.baseQuantity > Number(item.baseQuantity)
            )
              throw fulfillmentError(
                "سُجل استلام كمية هذا البند سابقاً أو تجاوزت الكمية الأصلية؛ راجع محاضر الاستلام",
                "CONFLICT",
              );
            cumulativeReceived.set(
              line.invoiceItemId,
              priorQuantity + line.baseQuantity,
            );
          }
          wholeParcel =
            items.length > 0 &&
            items.every(
              (item) =>
                cumulativeReceived.get(item.id) === Number(item.baseQuantity),
            );
        }
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
          ...(receivedLines ? { scope: "ITEMS", receivedLines } : {}),
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
        if (wholeParcel)
          await tx
            .update(deliveryConsignments)
            .set({ parcelStatus: "RETURNED", returnedAt: receivedAt })
            .where(eq(deliveryConsignments.id, row.id));
        const receiptEventId = await appendDeliveryEvent(tx, {
          eventKey: documentEventKey,
          consignmentId: row.id,
          eventType: PHYSICAL_RETURN_RECEIVED,
          fromParcelStatus: row.parcelStatus,
          toParcelStatus: wholeParcel ? "RETURNED" : row.parcelStatus,
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
        if (wholeParcel && operationalShipmentMembers([row]).length)
          removedReceiptEventIds.push(receiptEventId);
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
            parcelStatus: wholeParcel ? "RETURNED" : row.parcelStatus,
            ...(receivedLines ? { scope: "ITEMS", receivedLines } : {}),
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
        const [leader] = await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, leaderId))
          .for("update")
          .limit(1);
        const [leaderMembership] = await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(eq(deliveryShipmentMembers.consignmentId, leaderId))
          .for("share")
          .limit(1);
        const currentMembers = await loadShipmentMembersTx(tx, leaderId, {
          currentRead: true,
        });
        const remaining = operationalShipmentMembers(currentMembers);
        if (
          !leader ||
          Number(leaderMembership?.leaderConsignmentId) !== Number(leaderId) ||
          currentMembers.length !== members.length ||
          currentMembers.some(
            (row) => !members.some((original) => original.id === row.id),
          )
        )
          throw fulfillmentError(
            "تغيرت روابط الشحنة أثناء إثبات المرتجع؛ حدّث المعاينة وأعد المحاولة",
            "CONFLICT",
          );
        if (remaining.length) {
          const receipt =
            leader.parcelStatus === "RETURNED"
              ? await physicalReturnReceiptTx(tx, leader, { currentRead: true })
              : null;
          const claimVersion = Number(leader.codClaimVersion) + 1;
          await tx
            .update(deliveryConsignments)
            .set({ codClaimVersion: claimVersion })
            .where(eq(deliveryConsignments.id, leaderId));
          await appendDeliveryEvent(tx, {
            eventKey: `CN:${leaderId}:CLAIM_CHANGED:PHYSICAL_RETURN:${input.clientRequestId}`,
            consignmentId: leaderId,
            eventType: "COD_CLAIM_CHANGED",
            actorUserId: auth.actor.userId,
            payload: {
              source: "PHYSICAL_RETURN",
              claimVersion,
              removedReceiptEventIds,
              ...(receipt
                ? { physicalReturnReceiptEventId: Number(receipt.id) }
                : {}),
              ackRequired: remaining.some((row) =>
                money(row.codAmount).gt(
                  money(row.collectedAmount ?? "0").plus(
                    money(row.counterSettledAmount ?? "0"),
                  ),
                ),
              ),
            },
          });
        }
      }
      await recordFulfillmentMutationTx(tx, context, leaderId);
      return result(false);
    }),
  );
}

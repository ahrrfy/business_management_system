import { and, eq, inArray } from "drizzle-orm";
import { mysqlCodeFrom } from "@shared/errorMap.ar";
import {
  aftercareExecutions,
  fulfillmentRequests,
  fulfillmentRequestItems,
  fulfillmentCharges,
} from "../../../../drizzle/fulfillmentSchema";
import type { WorkflowDispatchSource } from "../../../../shared/deliveryWorkflow";
import { retryOnDup } from "../../../lib/retryDup";
import { assertOperationAuthorityTx } from "../../authorization/operationAuthority";
import {
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "../../fulfillment/core";
import {
  authorizeWorkflowRequestCompositionTx,
  reassignFulfillmentRequestInTx,
} from "../../fulfillment/requests";
import { withTx, type Actor } from "../../tx";
import { cancelDeliveryAssignmentInTx } from "../cancellation";
import { declareConsignmentReturn } from "../declaredReturn";
import { reassignDeliveryConsignment } from "../parties";
import {
  dispatchInvoiceShipmentInTx,
  loadShipmentMembersTx,
  operationalShipmentMembers,
} from "../shipments";
import { currentWorkflowActorTx, loadWorkflowPreviewTx } from "./preview";
import { validateDriverTx } from "./dispatch";
import {
  heldCustomerParcelReissueTx,
  returnCarrierRightsTx,
} from "./returnReceipt";
import { dispatchInvoiceInTx } from "../dispatchInvoice";
import { deliveryConsignments, onlineOrders } from "../../../../drizzle/schema";
import { appendDeliveryEvent } from "../lifecycle";
import { money } from "../../money";
import { listDeliveryDocumentSnapshotsTx } from "../documentSnapshots";
import { physicalHandoverConsignmentIdsTx } from "../handoverEvidence";

export interface WorkflowAssignmentInput {
  source: WorkflowDispatchSource;
  branchId?: number;
  action: "cancelAssignment" | "reassign" | "declareReturn";
  reason: string;
  clientRequestId: string;
  partyId?: number;
  assignedUserId?: number;
  externalTrackingRef?: string;
  physicalHeldConfirmed?: boolean;
}
/** Source routing happens under the same lock/replay transaction as custody changes. */
export async function mutateWorkflowAssignment(
  input: WorkflowAssignmentInput,
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      let pendingOnlineUpdate: { id: number; invoiceId: number; branchId: number; partyId: number } | undefined;
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      const preview = await loadWorkflowPreviewTx(
        tx,
        input.source,
        auth.current,
        input.branchId,
        true,
      );
      const path =
        input.action === "cancelAssignment"
          ? preview.relations.aftercareExecutionId != null
            ? "delivery.fulfillment.aftercare.cancelExecution"
            : "delivery.cancelAssignment"
          : input.action === "declareReturn"
            ? "delivery.declareReturn"
            : preview.relations.fulfillmentRequestId != null &&
                (preview.source.kind === "fulfillmentRequest" ||
                  preview.relations.invoiceId == null)
              ? "delivery.fulfillment.requests.reassign"
              : "delivery.reassignConsignment";
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        path,
        (current) =>
          current.isOwner === true ||
          current.resolvedPermissions?.store === "FULL",
      );
      const context = fulfillmentMutationContext(
        `workflow.${input.action}`,
        input,
        input,
        auth.actor,
        preview.source.branchId,
      );
      const replay = await findFulfillmentReplayTx(tx, context);
      if (replay)
        return {
          consignmentId: replay,
          idempotentReplay: true,
          documentSnapshotIds: (
            await listDeliveryDocumentSnapshotsTx(tx, {
              sourceType: "SHIPMENT",
              sourceId: replay,
              branchId: preview.source.branchId,
            })
          ).map((row) => row.id),
        };
      if (preview.source.version !== input.source.expectedVersion)
        throw fulfillmentError(
          "تغيرت الإرسالية أو المطالبة منذ المعاينة؛ حدّثها قبل الإجراء",
          "CONFLICT",
        );
      const consignmentId =
        preview.group?.leaderConsignmentId ?? preview.relations.consignmentId;
      if (consignmentId == null)
        throw fulfillmentError(
          "المصدر ليس له إرسالية حالية؛ امسح باركود الشحنة القائمة",
        );
      if (input.reason.trim().length < 3)
        throw fulfillmentError("سبب الإجراء مطلوب");
      const members = await loadShipmentMembersTx(tx, consignmentId, {
        currentRead: true,
      });
      const operationalMembers = operationalShipmentMembers(members);
      if (preview.relations.aftercareExecutionId != null) {
        if (input.action === "reassign")
          throw fulfillmentError(
            "ألغ إسناد دفعة المعالجة قبل الاستلام، أو استلم الراجع فعلياً ثم جهز إعادة الإصدار من نفس العهدة دون صرف مواد جديد",
          );
        if (input.action === "cancelAssignment") {
          if (input.physicalHeldConfirmed !== true)
            throw fulfillmentError(
              "أثبت وجود الدفعة فعلياً في عهدة المكتبة قبل إلغاء الإسناد",
            );
          const { cancelAftercareExecutionTx } =
            await import("../../fulfillment/aftercare");
          const [execution] = await tx
            .select()
            .from(aftercareExecutions)
            .where(
              eq(
                aftercareExecutions.id,
                preview.relations.aftercareExecutionId,
              ),
            )
            .for("update")
            .limit(1);
          if (!execution)
            throw fulfillmentError("دفعة المعالجة غير موجودة", "NOT_FOUND");
          await cancelAftercareExecutionTx(
            tx,
            {
              id: execution.id,
              expectedVersion: execution.version,
              clientRequestId: input.clientRequestId,
              reason: input.reason,
              physicalHeldConfirmed: true,
            },
            auth.actor,
          );
        } else
          await declareConsignmentReturn(
            {
              consignmentId,
              reason: input.reason,
              clientRequestId: input.clientRequestId,
            },
            auth.actor,
            tx,
          );
      } else if (input.action === "cancelAssignment") {
        if (input.physicalHeldConfirmed !== true)
          throw fulfillmentError(
            "تحقق فعلياً أن كامل الشحنة عادت إلى عهدة المكتبة قبل إلغاء الإسناد",
          );
        const physicalHandoverIds = await physicalHandoverConsignmentIdsTx(
          tx,
          operationalMembers.map((member) => Number(member.id)),
        );
        if (
          operationalMembers.some(
            (c) =>
              c.pickedUpAt != null ||
              physicalHandoverIds.has(Number(c.id)) ||
              c.returnDeclaredAt != null ||
              !money(c.collectedAmount).isZero() ||
              c.remittanceId != null ||
              !["ASSIGNED", "ACCEPTED", "OUT_FOR_DELIVERY", "FAILED"].includes(
                c.parcelStatus,
              ),
          )
        )
          throw fulfillmentError(
            "تقدمت الشحنة بعد الإسناد؛ أعلن الرجوع ثم استلمها وافحصها فعلياً قبل فك العهدة",
          );
        for (const member of operationalMembers)
          await cancelDeliveryAssignmentInTx(
            tx,
            {
              consignmentId: member.id,
              reason: input.reason,
              clientRequestId: `${input.clientRequestId}:${member.id}`,
              physicalHeldConfirmed: true,
            },
            auth.actor,
            { shipmentMember: true },
          );
      } else if (input.action === "declareReturn") {
        for (const member of members) {
          const rights = await returnCarrierRightsTx(tx, [member.id]);
          if (money(member.collectedAmount).gt(0) || rights.cash.gt(0)) {
            if (
              member.returnDeclaredAt != null ||
              !["DISPATCHED", "PARTIAL", "DELIVERED"].includes(member.status) ||
              ["CANCELLED", "RETURNED"].includes(member.parcelStatus)
            )
              throw fulfillmentError("الإرسالية لا تقبل إعلان رجوع جديد");
            await tx
              .update(deliveryConsignments)
              .set({
                returnDeclaredAt: new Date(),
                returnDeclaredBy: auth.actor.userId,
                returnDeclaredReason: input.reason.slice(0, 500),
              })
              .where(eq(deliveryConsignments.id, member.id));
            await appendDeliveryEvent(tx, {
              eventKey: `CN:${member.id}:WORKFLOW_RETURN_DECLARED:${input.clientRequestId}`,
              consignmentId: member.id,
              eventType: "RETURN_DECLARED",
              actorUserId: auth.actor.userId,
              payload: {
                reason: input.reason,
                physicalReceiptPending: true,
                cashRightsPreserved: true,
                releasedExposure: "0.00",
              },
            });
          } else
            await declareConsignmentReturn(
              {
                consignmentId: member.id,
                reason: input.reason,
                clientRequestId: `${input.clientRequestId}:${member.id}`,
              },
              auth.actor,
              tx,
              { shipmentMember: true },
            );
        }
      } else {
        const leader = members.find((c) => c.id === consignmentId);
        if (!leader)
          throw fulfillmentError("قائد الشحنة غير موجود", "CONFLICT");
        const partyId = input.partyId ?? leader.partyId;
        const targetParty = await validateDriverTx(
          tx,
          { partyId, assignedUserId: input.assignedUserId },
          preview.source.branchId,
        );
        let heldReturnReissue = members.length > 0;
        for (const member of members)
          if (!(await heldCustomerParcelReissueTx(tx, member)))
            heldReturnReissue = false;
        if (
          members.some((member) => member.parcelStatus === "RETURNED") &&
          !heldReturnReissue
        )
          throw fulfillmentError(
            "لا تنقل حقوق الناقل القديمة إلى محاولة جديدة؛ افتح تسويته من محطة التحصيل ثم معالجة MISSING_HELD المرتبطة بالمصدر لإعادة إرسال عهدة العميل دون مخزون جديد",
          );
        const changesParty = partyId !== leader.partyId;
        if (
          changesParty &&
          targetParty.partyType === "COMPANY" &&
          !input.externalTrackingRef?.trim()
        )
          throw fulfillmentError(
            "اكتب رقم بوليصة الشركة الجديدة صراحةً قبل إعادة الإسناد",
          );
        if (
          changesParty &&
          leader.status !== "CANCELLED" &&
          !heldReturnReissue
        ) {
          if (
            members.some(
              (member) =>
                member.pickedUpAt != null ||
                member.outForDeliveryAt != null ||
                !["ASSIGNED", "ACCEPTED", "FAILED"].includes(
                  member.parcelStatus,
                ),
            )
          )
            throw fulfillmentError(
              "الطرد خرج بعهدة الناقل؛ أعلن رجوعه واستلمه فعلياً قبل تحويله إلى جهة أخرى",
            );
          for (const member of members)
            await cancelDeliveryAssignmentInTx(
              tx,
              {
                consignmentId: member.id,
                reason: input.reason,
                clientRequestId: `${input.clientRequestId}:cancel:${member.id}`,
                // The branch is reached only while the shipment remains
                // eligible for deassignment under the custody guard above.
                physicalHeldConfirmed: true,
              },
              auth.actor,
              { shipmentMember: true },
            );
        }
        if (
          leader.status === "CANCELLED" ||
          changesParty ||
          heldReturnReissue
        ) {
          if (preview.relations.fulfillmentRequestId != null) {
            const [request] = await tx
              .select()
              .from(fulfillmentRequests)
              .where(
                eq(
                  fulfillmentRequests.id,
                  preview.relations.fulfillmentRequestId,
                ),
              )
              .for("update")
              .limit(1);
            if (!request)
              throw fulfillmentError("طلب التجهيز غير موجود", "NOT_FOUND");
            let compositionAuthority;
            if (path === "delivery.reassignConsignment") {
              const sourceItems = await tx
                .select()
                .from(fulfillmentRequestItems)
                .where(
                  and(
                    eq(fulfillmentRequestItems.requestId, request.id),
                    eq(fulfillmentRequestItems.isActive, true),
                  ),
                )
                .for("update");
              const charges = await tx
                .select({ id: fulfillmentCharges.id })
                .from(fulfillmentCharges)
                .where(
                  and(
                    eq(fulfillmentCharges.requestId, request.id),
                    inArray(fulfillmentCharges.status, [
                      "APPROVED",
                      "COMPLETED",
                    ]),
                  ),
                )
                .for("update");
              compositionAuthority =
                await authorizeWorkflowRequestCompositionTx(tx, auth.actor, {
                  fields: {
                    ...request,
                    sources: sourceItems.map((row) =>
                      row.invoiceId != null
                        ? { invoiceId: row.invoiceId }
                        : { workOrderId: row.workOrderId! },
                    ),
                  },
                  nativePaths: [path],
                  requestId: request.id,
                  reassignConsignmentId: consignmentId,
                  chargeIds: charges.map((row) => row.id),
                });
            }
            await reassignFulfillmentRequestInTx(
              tx,
              {
                id: request.id,
                expectedVersion: request.version,
                consignmentId,
                partyId,
                assignedUserId: input.assignedUserId,
                externalTrackingRef: input.externalTrackingRef,
                clientRequestId: input.clientRequestId,
              },
              auth.actor,
              { heldReturnReissue, compositionAuthority },
            );
          } else {
            const invoiceIds = members.flatMap((c) =>
              c.invoiceId == null ? [] : [c.invoiceId],
            );
            if (!invoiceIds.length)
              throw fulfillmentError(
                "المصدر الملغى يحتاج مساره الأصلي لإعادة الإسناد",
              );
            // Resolve from the authoritative invoice link, never from the scanned namespace.
            const [onlineOrder] = invoiceIds.length === 1 && members.length === 1
              ? await tx.select().from(onlineOrders).where(and(
                  eq(onlineOrders.invoiceId, invoiceIds[0]!),
                  eq(onlineOrders.branchId, leader.branchId),
                )).limit(1)
              : [];
            if (onlineOrder && (onlineOrder.status === "CANCELLED" || onlineOrder.status === "DELIVERED"))
              throw fulfillmentError("طلب المتجر مغلق؛ راجع حالته قبل إعادة الإسناد", "CONFLICT");
            if (leader.sourceType === "ONLINE_ORDER" && (!onlineOrder || onlineOrder.id !== leader.sourceId))
              throw fulfillmentError("ارتباط إرسالية المتجر غير متسق؛ راجع الطلب الأصلي", "CONFLICT");
            const dispatchInput = {
              invoiceId: leader.invoiceId!,
              invoiceIds,
              partyId,
              assignedUserId: input.assignedUserId,
              externalTrackingRef: input.externalTrackingRef,
              clientRequestId: input.clientRequestId,
              deliveryFee: leader.deliveryFee,
              feeCollection: leader.feeCollection,
              recipientName: leader.recipientName,
              recipientPhone: leader.recipientPhone,
              deliveryAddress: leader.deliveryAddress,
              notes: leader.notes,
              governorate: leader.governorate,
              latitude: leader.latitude,
              longitude: leader.longitude,
              onlineOrderId: onlineOrder?.id,
            };
            if (invoiceIds.length === 1 && members.length === 1)
              await dispatchInvoiceInTx(tx, dispatchInput, auth.actor, {
                heldReturnReissue,
              });
            else
              await dispatchInvoiceShipmentInTx(tx, dispatchInput, auth.actor, {
                heldReturnReissue,
              });
            if (onlineOrder) pendingOnlineUpdate = {
              id: onlineOrder.id, invoiceId: leader.invoiceId!, branchId: leader.branchId, partyId,
            };
          }
        } else {
          // Existing parcel reassignment preserves all source sale/custody/fee identities.
          for (const member of members)
            await reassignDeliveryConsignment(
              {
                consignmentId: member.id,
                partyId,
                assignedUserId: input.assignedUserId,
                clientRequestId: `${input.clientRequestId}:${member.id}`,
              },
              auth.actor,
              tx,
              { shipmentMember: true },
            );
        }
      }
      await recordFulfillmentMutationTx(tx, context, consignmentId);
      const result = {
        consignmentId,
        idempotentReplay: false,
        documentSnapshotIds: (
          await listDeliveryDocumentSnapshotsTx(tx, {
            sourceType: "SHIPMENT",
            sourceId: consignmentId,
            branchId: preview.source.branchId,
          })
        ).map((row) => row.id),
      };
      // Terminal domain lock: source dispatch owns order before parcel, so never wait
      // for that backwards edge while this transaction owns the parcel. All parcel,
      // document and replay writes above roll back if the current order is busy.
      if (pendingOnlineUpdate) {
        const [currentOrder] = await tx.select().from(onlineOrders)
          .where(eq(onlineOrders.id, pendingOnlineUpdate.id))
          .for("update", { noWait: true }).limit(1);
        if (!currentOrder || currentOrder.invoiceId !== pendingOnlineUpdate.invoiceId
          || currentOrder.branchId !== pendingOnlineUpdate.branchId
          || !["CONFIRMED", "PROCESSING", "SHIPPED"].includes(currentOrder.status))
          throw fulfillmentError("تغير ارتباط طلب المتجر أو أُغلق أثناء إعادة الإسناد؛ حدّث المعاينة", "CONFLICT");
        await tx.update(onlineOrders).set({ status: "SHIPPED", deliveryPartyId: pendingOnlineUpdate.partyId })
          .where(eq(onlineOrders.id, currentOrder.id));
      }
      return result;
    }),
  ).catch((error: unknown) => {
    if (mysqlCodeFrom(error) === "ER_LOCK_NOWAIT")
      throw fulfillmentError("طلب المتجر قيد إجراء آخر الآن؛ لم تُحفظ إعادة الإسناد، حدّث المعاينة وأعد المحاولة", "CONFLICT");
    throw error;
  });
}

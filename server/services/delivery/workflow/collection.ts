import { eq } from "drizzle-orm";
import { invoices } from "../../../../drizzle/schema";
import type { WorkflowDispatchSource } from "../../../../shared/deliveryWorkflow";
import { retryOnDup } from "../../../lib/retryDup";
import { assertOperationAuthorityTx } from "../../authorization/operationAuthority";
import {
  assignedGoodsCodDue,
  loadAssignedChargeClaimsTx,
} from "../../fulfillment/chargeDelivery";
import {
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "../../fulfillment/core";
import { money, round2, toDbMoney } from "../../money";
import { withTx, type Actor } from "../../tx";
import { confirmConsignmentDelivery } from "../courier";
import { allocateProportionally } from "../remittance";
import {
  loadShipmentMembersTx,
  operationalShipmentMembers,
} from "../shipments";
import { currentWorkflowActorTx, loadWorkflowPreviewTx } from "./preview";
import { isShortfallReason } from "../../../../shared/shortfallReason";

/** Staff explicitly witnesses customer collection; courier remittance remains a separate command. */
export function confirmWorkflowDelivery(
  input: {
    source: WorkflowDispatchSource;
    branchId?: number;
    evidence: string;
    /** Absent preserves the fast path: collect the full current customer claim. */
    collectedAmount?: string;
    /** Required when the explicit amount is below the current customer claim. */
    shortfallReason?: string;
    clientRequestId: string;
  },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx(async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        "delivery.staffConfirm",
        (current) =>
          current.isOwner === true ||
          current.resolvedPermissions?.store === "FULL",
      );
      const preview = await loadWorkflowPreviewTx(
        tx,
        input.source,
        auth.current,
        input.branchId,
        true,
      );
      const context = fulfillmentMutationContext(
        "workflow.confirmDelivery",
        input,
        input,
        auth.actor,
        preview.source.branchId,
      );
      const replay = await findFulfillmentReplayTx(tx, context);
      if (replay) return { consignmentId: replay, idempotentReplay: true };
      if (preview.source.version !== input.source.expectedVersion)
        throw fulfillmentError(
          "تغيرت مطالبة الشحنة منذ معاينتها؛ حدثها قبل إثبات القبض",
          "CONFLICT",
        );
      if (preview.relations.aftercareExecutionId != null)
        throw fulfillmentError(
          "دفعة المعالجة لا تحمل قبض عميل؛ أثبت نتيجتها وأجرة الناقل من حالة المعالجة",
        );
      const leaderId =
        preview.group?.leaderConsignmentId ?? preview.relations.consignmentId;
      if (leaderId == null || input.evidence.trim().length < 3)
        throw fulfillmentError(
          "اختر شحنة قائمة وأثبت مصدر تحقق التسليم الفعلي",
        );
      const members = operationalShipmentMembers(
        await loadShipmentMembersTx(tx, leaderId, { currentRead: true }),
      );
      if (
        !members.length ||
        members.some(
          (row) =>
            row.parcelStatus === "DELIVERED" || row.returnDeclaredAt != null,
        )
      )
        throw fulfillmentError(
          "الشحنة مسلمة أو أعلن رجوع بعض أعضائها؛ راجع النتيجة الحالية قبل إجراء جماعي",
        );
      const claims: Array<{
        row: (typeof members)[number];
        due: ReturnType<typeof money>;
      }> = [];
      for (const row of members) {
        const invoice =
          row.invoiceId == null
            ? undefined
            : (
                await tx
                  .select()
                  .from(invoices)
                  .where(eq(invoices.id, row.invoiceId))
                  .for("update")
                  .limit(1)
              )[0];
        const charges = await loadAssignedChargeClaimsTx(tx, row.id);
        claims.push({
          row,
          due: round2(assignedGoodsCodDue(invoice).plus(charges.remaining)),
        });
      }
      const totalDue = round2(
        claims.reduce((sum, claim) => sum.plus(claim.due), money(0)),
      );
      const collected =
        input.collectedAmount == null
          ? totalDue
          : round2(money(input.collectedAmount));
      if (!collected.isFinite() || collected.lt(0) || collected.gt(totalDue))
        throw fulfillmentError(
          `المقبوض ${collected.toFixed(2)} خارج مطالبة العميل الحالية ${totalDue.toFixed(2)}`,
        );
      const hasShortfall = collected.lt(totalDue);
      if (
        hasShortfall &&
        (!input.shortfallReason || !isShortfallReason(input.shortfallReason))
      )
        throw fulfillmentError(
          "اختر سبب العجز المعتمد قبل إثبات مبلغ تحصيل أقل من مطالبة العميل",
        );
      const allocations = allocateProportionally(
        collected,
        claims.map((claim) => claim.due),
      );
      for (let index = 0; index < claims.length; index += 1) {
        const { row } = claims[index];
        await confirmConsignmentDelivery(
          {
            consignmentId: row.id,
            clientRequestId: `${input.clientRequestId}:${row.id}`,
            statementWitness: {
              partyId: row.partyId,
              statementNumber: `STAFF:${input.evidence.trim()}`.slice(0, 160),
              kind: "STAFF_CONFIRMED",
              collectedAmount: toDbMoney(allocations[index]),
              ...(hasShortfall
                ? { shortfallReason: input.shortfallReason }
                : {}),
            },
          },
          auth.actor,
          tx,
          { shipmentMember: true },
        );
      }
      await recordFulfillmentMutationTx(tx, context, leaderId);
      return { consignmentId: leaderId, idempotentReplay: false };
    }),
  );
}

import { and, eq, inArray } from "drizzle-orm";
import {
  deliveryConsignments,
  invoices,
  onlineOrders,
} from "../../../../drizzle/schema";
import {
  fulfillmentRequestItems,
  fulfillmentRequests,
  fulfillmentCharges,
} from "../../../../drizzle/fulfillmentSchema";
import type {
  WorkflowBatchPreview,
  WorkflowDispatchBatchInput,
  WorkflowDispatchBatchResult,
  WorkflowDispatchSource,
  WorkflowScanPreview,
} from "../../../../shared/deliveryWorkflow";
import type { Tx } from "../../../db";
import { canonicalIraqiMobile } from "../../../lib/phone";
import { retryOnDup } from "../../../lib/retryDup";
import { assertOperationAuthorityTx } from "../../authorization/operationAuthority";
import {
  assertFulfillmentBranch,
  findFulfillmentReplayTx,
  fulfillmentError,
  fulfillmentMutationContext,
  recordFulfillmentMutationTx,
} from "../../fulfillment/core";
import {
  authorizeWorkflowRequestCompositionTx,
  type WorkflowRequestCompositionAuthority,
  createFulfillmentRequestInTx,
  releaseFulfillmentRequestInTx,
  updateFulfillmentRequestInTx,
  chargeDispatchEligibilityTx,
} from "../../fulfillment/requests";
import { money, toDbMoney } from "../../money";
import { withTx, type Actor } from "../../tx";
import { dispatchOnlineOrder } from "../../storeAdmin/dispatchOnlineOrder";
import { logAuditTx } from "../../auditService";
import { currentWorkflowActorTx, loadWorkflowPreviewTx } from "./preview";
import { workflowDispatchNativePaths } from "./nativeAuthority";
import { validateDeliveryDriverTx as validateDriverTx } from "../driverValidation";
import {
  hasOperationPolicy,
  operationDecision,
} from "../../../../shared/operationPermissions";

function validateSources(sources: WorkflowDispatchSource[]) {
  if (
    !sources.length ||
    sources.length > 30 ||
    sources.some(
      (s) => !Number.isSafeInteger(s.id) || s.id <= 0 || !s.expectedVersion,
    )
  )
    throw fulfillmentError(
      "اختر من مستند واحد إلى30 مستنداً صالحاً بنسخها الحالية",
    );
}
export function canonicalWorkflowSources(previews: WorkflowScanPreview[]) {
  const seen = new Set<string>();
  const duplicateCanonicalKeys: string[] = [];
  const sources = previews.filter((p) => {
    const key = p.group?.key ?? p.source.canonicalKey;
    if (seen.has(key)) {
      duplicateCanonicalKeys.push(key);
      return false;
    }
    seen.add(key);
    return true;
  });
  return { sources, duplicateCanonicalKeys };
}
function batchPreview(previews: WorkflowScanPreview[]): WorkflowBatchPreview {
  const { sources, duplicateCanonicalKeys } =
    canonicalWorkflowSources(previews);
  const blockedReasons: string[] = [];
  const first = sources[0];
  for (const p of sources) {
    if (first && p.source.branchId !== first.source.branchId)
      blockedReasons.push("لا يمكن تجميع فروع مختلفة");
    if (first && p.recipient.customerId !== first.recipient.customerId)
      blockedReasons.push("كل المستندات يجب أن تتبع العميل الحقيقي نفسه");
    if (
      sources.length > 1 &&
      first &&
      p.recipient.customerId == null &&
      (!p.recipient.phone || p.recipient.phone !== first.recipient.phone)
    )
      blockedReasons.push("هاتف المستندات العابرة يجب أن يتطابق بعد التطبيع");
    if (
      sources.length > 1 &&
      p.source.kind === "charge" &&
      p.recipient.customerId == null
    )
      blockedReasons.push(
        "خدمة العابر المدفوعة ترسل منفردة بهوية مستلم صريحة؛ لا يمكن دمج هويات غير مثبتة",
      );
    const dispatch = p.actions.find((a) => a.action === "dispatch");
    if (!dispatch?.allowed)
      blockedReasons.push(dispatch?.reason ?? "المصدر لا يقبل الإرسال");
  }
  if (
    sources.length > 1 &&
    sources.some(
      (p) =>
        p.source.kind === "onlineOrder" ||
        p.relations.onlineOrderId != null ||
        p.source.kind === "aftercareExecution" ||
        p.source.kind === "fulfillmentRequest" ||
        p.relations.fulfillmentRequestId != null,
    )
  )
    blockedReasons.push(
      "طلب المتجر أو دفعة المعالجة أو طلب التجهيز القائم يرسل من مجموعته الحالية منفرداً",
    );
  const sum = (
    key:
      | "currentTotal"
      | "paidAmount"
      | "remainingAmount"
      | "codAmount"
      | "heldDeliveryFee"
      | "serviceCharges",
  ) =>
    toDbMoney(sources.reduce((acc, row) => acc.plus(row.money[key]), money(0)));
  return {
    sources,
    duplicateCanonicalKeys,
    summary: {
      currentTotal: sum("currentTotal"),
      paidAmount: sum("paidAmount"),
      remainingAmount: sum("remainingAmount"),
      codAmount: sum("codAmount"),
      heldDeliveryFee: sum("heldDeliveryFee"),
      serviceCharges: sum("serviceCharges"),
      goodsCodAmount: sum("codAmount"),
      courierFeeAmount: "0.00",
    },
    blockedReasons: Array.from(new Set(blockedReasons)),
  };
}
export async function previewWorkflowBatch(
  input: {
    sources: WorkflowDispatchSource[];
    branchId?: number;
    deliveryFee?: string;
    feeCollection?: "COURIER" | "COUNTER" | "SHOP";
  },
  actor: Actor,
): Promise<WorkflowBatchPreview> {
  validateSources(input.sources);
  return withTx(
    async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      const previews = [];
      for (const source of input.sources)
        previews.push(
          await loadWorkflowPreviewTx(tx, source, auth.current, input.branchId),
        );
      const result = batchPreview(previews);
      if (input.deliveryFee != null) {
        const held = money(result.summary.heldDeliveryFee);
        const fee = money(input.deliveryFee);
        result.summary.courierFeeAmount =
          input.feeCollection === "COURIER" ? toDbMoney(fee) : "0.00";
        result.summary.codAmount = toDbMoney(
          money(result.summary.goodsCodAmount).plus(
            result.summary.courierFeeAmount,
          ),
        );
        const refund =
          input.feeCollection !== "COUNTER"
            ? held
            : held.gt(fee)
              ? held.minus(fee)
              : money(0);
        const reason =
          held.gt(0) && (input.feeCollection !== "COUNTER" || !held.eq(fee))
            ? "أمانة الأجرة مقبوضة على مصادرها الأصلية؛ أكمل رد الفرق الفعلي أو اضبط أجرة واحدة مساوية للأمانة الباقية قبل الإرسال"
            : null;
        result.feeRequirement = {
          heldAmount: toDbMoney(held),
          requestedFee: toDbMoney(fee),
          refundRequired: toDbMoney(refund),
          receiptIds: result.sources.flatMap((p) =>
            p.money.heldReceipts
              .filter((r) => r.direction === "IN" && r.status === "COMPLETED")
              .map((r) => r.id),
          ),
          reason,
        };
        if (reason) result.blockedReasons.push(reason);
      }
      return result;
    },
    { gate: "NONE" },
  );
}
async function resultTx(
  tx: Tx,
  consignmentId: number,
  idempotentReplay: boolean,
): Promise<WorkflowDispatchBatchResult> {
  const [row] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, consignmentId))
    .limit(1);
  if (!row)
    throw fulfillmentError(
      "تعذر استعادة الإرسالية الملتزمة؛ راجع مسؤول النظام",
      "CONFLICT",
    );
  const members = await tx
    .select({ invoiceId: deliveryConsignments.invoiceId })
    .from(deliveryConsignments)
    .where(
      row.fulfillmentRequestId == null
        ? eq(deliveryConsignments.id, row.id)
        : eq(
            deliveryConsignments.fulfillmentRequestId,
            row.fulfillmentRequestId,
          ),
    );
  return {
    consignmentId: row.id,
    consignmentNumber: row.consignmentNumber,
    fulfillmentRequestId: row.fulfillmentRequestId,
    invoiceIds: Array.from(
      new Set(
        members.flatMap((m) => (m.invoiceId == null ? [] : [m.invoiceId])),
      ),
    ),
    idempotentReplay,
  };
}
export { validateDeliveryDriverTx as validateDriverTx } from "../driverValidation";

/** One server command, one real fulfillment transaction, one sale/materialization per source. */
export async function dispatchWorkflowBatch(
  input: WorkflowDispatchBatchInput,
  actor: Actor,
): Promise<WorkflowDispatchBatchResult> {
  validateSources(input.sources);
  // Online orders retain their coupon/reservation/inventory transaction and recovery contract.
  // They cannot be mixed into a fulfillment request which explicitly forbids ONLINE sources.
  if (input.sources.length === 1 && input.sources[0]!.kind === "onlineOrder")
    return dispatchOnlineSingleton(input, actor);
  return retryOnDup(() =>
    withTx(async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        "delivery.workflow.dispatchBatch",
        (current) =>
          current.isOwner === true ||
          current.resolvedPermissions?.store === "FULL",
      );
      const previews = [];
      for (const source of [...input.sources].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.id - b.id,
      ))
        previews.push(
          await loadWorkflowPreviewTx(
            tx,
            source,
            auth.current,
            input.branchId,
            true,
          ),
        );
      const branchId = previews[0]!.source.branchId;
      assertFulfillmentBranch(auth.actor, branchId);
      const nativePaths: string[] = [];
      for (const preview of previews) {
        const paths = workflowDispatchNativePaths(
          preview.source.kind,
          preview.relations.invoiceId != null,
        );
        const path =
          paths.find((path) =>
            hasOperationPolicy(auth.current)
              ? operationDecision(auth.current, path).allowed
              : auth.current.isOwner === true ||
                auth.current.role === "admin" ||
                auth.current.resolvedPermissions?.store === "FULL",
          ) ?? paths[0]!;
        await assertOperationAuthorityTx(
          tx,
          auth.actor,
          path,
          (current) =>
            current.isOwner === true ||
            current.resolvedPermissions?.store === "FULL",
        );
        nativePaths.push(path);
      }
      const context = fulfillmentMutationContext(
        "workflow.dispatchBatch",
        input,
        input,
        auth.actor,
        branchId,
      );
      const replay = await findFulfillmentReplayTx(tx, context);
      if (replay) return resultTx(tx, replay, true);
      for (const p of previews) {
        const expected = input.sources.find(
          (s) => s.kind === p.source.kind && s.id === p.source.id,
        )!;
        if (expected.expectedVersion !== p.source.version)
          throw fulfillmentError(
            "تغير المستند أو المال أو الإسناد منذ المعاينة؛ حدّثه قبل التأكيد",
            "CONFLICT",
          );
      }
      const preview = batchPreview(previews);
      if (preview.duplicateCanonicalKeys.length)
        throw fulfillmentError(
          "مسحت المصدر الاقتصادي نفسه مرتين؛ احتفظ باختيار واحد لأمر الشغل وفاتورته",
          "CONFLICT",
        );
      if (preview.blockedReasons.length)
        throw fulfillmentError(preview.blockedReasons.join("؛ "));
      await validateDriverTx(tx, input, branchId);
      const first = preview.sources[0]!;
      if (first.source.kind === "aftercareExecution") {
        const { aftercareExecutions } =
          await import("../../../../drizzle/fulfillmentSchema");
        const { dispatchAftercareExecutionTx } =
          await import("../../fulfillment/aftercare");
        const [execution] = await tx
          .select()
          .from(aftercareExecutions)
          .where(eq(aftercareExecutions.id, first.source.id))
          .for("update")
          .limit(1);
        if (
          !execution ||
          input.feeCollection !== "SHOP" ||
          !money(input.deliveryFee).eq(execution.deliveryFee) ||
          input.recipientName.trim() !== first.recipient.name?.trim() ||
          canonicalIraqiMobile(input.recipientPhone) !==
            first.recipient.phone ||
          input.deliveryAddress.trim() !== first.recipient.address?.trim()
        )
          throw fulfillmentError(
            "دفعة المعالجة بلا COD وأجرتها المعتمدة تتحملها المكتبة؛ حدّث المعاينة",
          );
        const dispatched = await dispatchAftercareExecutionTx(
          tx,
          {
            id: execution.id,
            expectedVersion: execution.version,
            clientRequestId: input.clientRequestId,
            partyId: input.partyId,
            externalTrackingRef: input.externalTrackingRef,
            assignedUserId: input.assignedUserId,
          },
          auth.actor,
        );
        if (!dispatched.consignmentId)
          throw fulfillmentError(
            "لم ينتج إسناد فعلي لدفعة المعالجة",
            "CONFLICT",
          );
        await recordFulfillmentMutationTx(
          tx,
          context,
          dispatched.consignmentId,
        );
        return resultTx(tx, dispatched.consignmentId, false);
      }
      const phone = canonicalIraqiMobile(input.recipientPhone);
      if (
        first.recipient.customerId == null &&
        !(
          preview.sources.length === 1 &&
          first.source.kind === "charge" &&
          phone
        ) &&
        phone !== first.recipient.phone
      )
        throw fulfillmentError("هاتف المستلم العابر يختلف عن المصدر الحقيقي");
      const fields = {
        branchId,
        customerId: first.recipient.customerId,
        recipientName: input.recipientName,
        recipientPhone: input.recipientPhone,
        deliveryAddress: input.deliveryAddress,
        partyId: input.partyId,
        deliveryFee: input.deliveryFee,
        feeCollection: input.feeCollection,
        notes: input.notes,
      };
      let request;
      let requestAuthority: WorkflowRequestCompositionAuthority;
      const requestId = first.relations.fulfillmentRequestId;
      if (requestId != null) {
        const [existing] = await tx
          .select()
          .from(fulfillmentRequests)
          .where(eq(fulfillmentRequests.id, requestId))
          .for("update")
          .limit(1);
        if (!existing)
          throw fulfillmentError("طلب التجهيز المرتبط غير موجود", "CONFLICT");
        if (
          !money(input.deliveryFee).eq(existing.deliveryFee) ||
          input.feeCollection !== existing.feeCollection ||
          input.recipientName.trim() !== existing.recipientName.trim() ||
          canonicalIraqiMobile(input.recipientPhone) !==
            canonicalIraqiMobile(existing.recipientPhone) ||
          input.deliveryAddress.trim() !== existing.deliveryAddress.trim()
        )
          throw fulfillmentError(
            "أجرة طلب التجهيز ومستلمه محفوظان؛ عدّل الطلب من مساره المحكوم قبل إرساله",
          );
        const items = await tx
          .select()
          .from(fulfillmentRequestItems)
          .where(
            and(
              eq(fulfillmentRequestItems.requestId, requestId),
              eq(fulfillmentRequestItems.isActive, true),
            ),
          ).for("update");
        const canReleaseRequest = hasOperationPolicy(auth.current) ? operationDecision(auth.current,"delivery.fulfillment.requests.release").allowed : auth.current.isOwner === true || auth.current.role === "admin" || auth.current.resolvedPermissions?.store === "FULL";
        if (canReleaseRequest) nativePaths.push("delivery.fulfillment.requests.release");
        else for (const item of items) {
          const member = await loadWorkflowPreviewTx(tx,item.invoiceId != null ? {kind:"invoice",id:item.invoiceId}:{kind:"workOrder",id:item.workOrderId!},auth.current,branchId,true);
          const paths = workflowDispatchNativePaths(member.source.kind,member.relations.invoiceId != null);
          const path = paths.find(path=>hasOperationPolicy(auth.current)?operationDecision(auth.current,path).allowed:auth.current.isOwner===true||auth.current.role==="admin"||auth.current.resolvedPermissions?.store==="FULL") ?? paths[0]!;
          await assertOperationAuthorityTx(tx,auth.actor,path,current=>current.isOwner===true||current.resolvedPermissions?.store==="FULL");
          nativePaths.push(path);
        }
        const compositionSources = items.map((r) =>
          r.invoiceId != null
            ? { invoiceId: r.invoiceId }
            : { workOrderId: r.workOrderId! },
        );
        const currentCharges = await tx
          .select({ id: fulfillmentCharges.id })
          .from(fulfillmentCharges)
          .where(
            and(
              eq(fulfillmentCharges.requestId, requestId),
              eq(fulfillmentCharges.status, "APPROVED"),
            ),
          )
          .for("update");
        requestAuthority = await authorizeWorkflowRequestCompositionTx(
          tx,
          auth.actor,
          {
            fields: { ...fields, sources: compositionSources },
            nativePaths,
            requestId,
            chargeIds: currentCharges.map((row) => row.id),
          },
        );
        request = await updateFulfillmentRequestInTx(
          tx,
          {
            ...fields,
            id: requestId,
            expectedVersion: existing.version,
            clientRequestId: `${input.clientRequestId}:header`,
            sources: items.map((r) =>
              r.invoiceId != null
                ? { invoiceId: r.invoiceId }
                : { workOrderId: r.workOrderId! },
            ),
          },
          auth.actor,
          requestAuthority,
        );
      } else {
        const sources = preview.sources
          .filter((p) => p.source.kind !== "charge")
          .map((p) =>
            p.relations.invoiceId != null
              ? { invoiceId: p.relations.invoiceId }
              : p.relations.workOrderId != null
                ? { workOrderId: p.relations.workOrderId }
                : null,
          );
        if (sources.some((s) => !s))
          throw fulfillmentError(
            "المصدر يحتاج طلب تجهيز قائماً أو مسار إسناده الأصلي",
          );
        requestAuthority = await authorizeWorkflowRequestCompositionTx(
          tx,
          auth.actor,
          {
            fields: {
              ...fields,
              sources: sources.filter((source) => source != null),
            },
            nativePaths,
            chargeIds: preview.sources
              .filter((source) => source.source.kind === "charge")
              .map((source) => source.source.id),
          },
        );
        request = await createFulfillmentRequestInTx(
          tx,
          {
            ...fields,
            sources: sources.filter((s) => s != null),
            clientRequestId: `${input.clientRequestId}:create`,
          },
          auth.actor,
          requestAuthority,
        );
        for (const source of preview.sources.filter(
          (p) => p.source.kind === "charge",
        )) {
          const [charge] = await tx
            .select()
            .from(fulfillmentCharges)
            .where(eq(fulfillmentCharges.id, source.source.id))
            .for("update")
            .limit(1);
          if (
            !charge ||
            charge.requestId != null ||
            charge.branchId !== branchId ||
            charge.customerId !== first.recipient.customerId
          )
            throw fulfillmentError(
              "مستند الأجر تغير أو مرتبط بطلب آخر؛ حدّث المعاينة قبل ربط التحصيل",
              "CONFLICT",
            );
          const eligibility = await chargeDispatchEligibilityTx(tx, charge);
          if (!eligibility.eligible)
            throw fulfillmentError(
              eligibility.reason ?? "مصدر الأجر غير صالح للإرسال",
            );
          await tx
            .update(fulfillmentCharges)
            .set({ requestId: request.id, version: charge.version + 1 })
            .where(eq(fulfillmentCharges.id, charge.id));
          await logAuditTx(tx, auth.actor, {
            action: "fulfillment.charge.linkDelivery",
            entityType: "fulfillmentCharge",
            entityId: charge.id,
            oldValue: { requestId: null, version: charge.version },
            newValue: { requestId: request.id, version: charge.version + 1 },
          });
        }
      }
      const released = await releaseFulfillmentRequestInTx(
        tx,
        {
          id: request.id,
          expectedVersion: request.version,
          clientRequestId: `${input.clientRequestId}:release`,
          assignedUserId: input.assignedUserId,
          externalTrackingRef: input.externalTrackingRef,
        },
        auth.actor,
        requestAuthority,
      );
      await recordFulfillmentMutationTx(tx, context, released.consignmentId);
      return resultTx(tx, released.consignmentId, false);
    }),
  );
}

async function dispatchOnlineSingleton(
  input: WorkflowDispatchBatchInput,
  actor: Actor,
): Promise<WorkflowDispatchBatchResult> {
  const source = input.sources[0]!;
  const before = await withTx(
    async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        "delivery.workflow.dispatchBatch",
        (current) =>
          current.isOwner === true ||
          current.resolvedPermissions?.store === "FULL",
      );
      const preview = await loadWorkflowPreviewTx(
        tx,
        source,
        auth.current,
        input.branchId,
      );
      await assertOperationAuthorityTx(
        tx,
        auth.actor,
        "delivery.dispatchByBarcode",
        (current) =>
          current.isOwner === true ||
          current.resolvedPermissions?.store === "FULL",
      );
      const context = fulfillmentMutationContext(
        "workflow.dispatchBatch",
        input,
        input,
        auth.actor,
        preview.source.branchId,
      );
      const replay = await findFulfillmentReplayTx(tx, context);
      if (replay)
        return {
          replay: await resultTx(tx, replay, true),
          actor: auth.actor,
          context,
        };
      const intent = fulfillmentMutationContext(
        "workflow.onlineIntent",
        input,
        input,
        auth.actor,
        preview.source.branchId,
      );
      const pending = await findFulfillmentReplayTx(tx, intent);
      // Domain replay is recoverable even if the process stopped after online dispatch committed.
      // Existing order.invoiceId and consignment source prevent any second sale/material issue.
      const [order] = await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, source.id))
        .limit(1);
      if (
        !(pending && order?.status === "SHIPPED") &&
        source.expectedVersion !== preview.source.version
      )
        throw fulfillmentError("تغير طلب المتجر منذ المعاينة", "CONFLICT");
      if (
        !pending &&
        !preview.actions.some((a) => a.action === "dispatch" && a.allowed)
      )
        throw fulfillmentError(
          "طلب المتجر ليس جاهزاً لإسناد جديد؛ افتح إرساليته الحالية",
        );
      if (
        !pending &&
        (!money(input.deliveryFee).eq(preview.money.deliveryFee) ||
          input.feeCollection !== preview.money.feeCollection)
      )
        throw fulfillmentError(
          "أجرة طلب المتجر وطريقة تحملها محفوظتان على الطلب؛ حدّث المعاينة",
        );
      await validateDriverTx(tx, input, preview.source.branchId);
      if (!pending) await recordFulfillmentMutationTx(tx, intent, source.id);
      return { actor: auth.actor, context };
    },
    { gate: "NONE" },
  );
  if (before.replay) return before.replay;
  const dispatched = await dispatchOnlineOrder(
    {
      onlineOrderId: source.id,
      partyId: input.partyId,
      assignedUserId: input.assignedUserId,
      externalTrackingRef: input.externalTrackingRef,
      deliveryAddress: input.deliveryAddress,
      notes: input.notes,
    },
    before.actor,
  );
  return retryOnDup(() =>
    withTx(async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      const [cn] = await tx
        .select()
        .from(deliveryConsignments)
        .where(
          dispatched.consignmentId != null
            ? eq(deliveryConsignments.id, dispatched.consignmentId)
            : and(
                eq(deliveryConsignments.sourceType, "ONLINE_ORDER"),
                eq(deliveryConsignments.sourceId, source.id),
              ),
        )
        .limit(1);
      if (!cn)
        throw fulfillmentError(
          "الطلب التزم؛ أعد المحاولة بالمفتاح نفسه لاستعادة إرساليته",
          "CONFLICT",
        );
      assertFulfillmentBranch(auth.actor, cn.branchId);
      if (cn.partyId !== input.partyId)
        throw fulfillmentError(
          "طلب المتجر مسند لجهة أخرى؛ افتح الإرسالية الحالية",
          "CONFLICT",
        );
      const replay = await findFulfillmentReplayTx(tx, before.context);
      if (!replay) await recordFulfillmentMutationTx(tx, before.context, cn.id);
      return resultTx(
        tx,
        replay ?? cn.id,
        dispatched.alreadyDispatched === true || replay != null,
      );
    }),
  );
}

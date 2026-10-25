import { and, eq, inArray } from "drizzle-orm";
import {
  fulfillmentRequestItems,
  fulfillmentCharges,
  fulfillmentRequests,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import type {
  FulfillmentMutationIdentity,
  FulfillmentSource,
} from "../../../shared/fulfillment";
import { extractInsertId } from "../../lib/insertId";
import { canonicalIraqiMobile } from "../../lib/phone";
import { retryOnDup } from "../../lib/retryDup";
import { logAuditTx } from "../auditService";
import { money, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import type { Tx } from "../../db";
import { validateDeliveryDriverTx } from "../delivery/driverValidation";
import { assertOperationAuthorityTx } from "../authorization/operationAuthority";
import {
  assertFulfillmentBranch,
  assertFulfillmentVersion,
  fulfillmentError,
  fulfillmentFingerprint,
  fulfillmentMutationContext,
  findFulfillmentReplayTx,
  loadFulfillmentRequestTx,
  recordFulfillmentMutationTx,
} from "./core";
import {
  assertRequestOperationTx,
  loadRequestSourcesTx,
  normalizeRequestSources,
  validateRequestPartyTx,
  dispatchChargeOnlyRequestTx,
} from "./requestSources";
import { dispatchInvoiceShipmentInTx } from "../delivery/shipments";
import { prepareWorkOrderDeliveryInvoiceInTx } from "../delivery/dispatch";
import {
  attachFulfillmentRequestClaimsTx,
  restoreFulfillmentRequestClaimsTx,
} from "./chargeDelivery";
import { deliveryConsignments, receipts } from "../../../drizzle/schema";
import { loadShipmentMembersTx } from "../delivery/shipments";
import { heldCustomerParcelReissueTx } from "../delivery/workflow/returnReceipt";

export type FulfillmentRequestFields = {
  branchId: number;
  customerId?: number | null;
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  partyId?: number | null;
  deliveryFee: string;
  feeCollection: "COURIER" | "COUNTER" | "SHOP";
  partialReleaseAllowed?: boolean;
  futureFeeDecision?: string | null;
  notes?: string | null;
  sources: FulfillmentSource[];
};
export type RequestTransition = FulfillmentMutationIdentity & { id: number };

const workflowRequestMarker = Symbol("workflow-request-composition");
export interface WorkflowRequestCompositionAuthority {
  readonly [workflowRequestMarker]: true;
}
type WorkflowRequestScope = {
  tx: Tx;
  userId: number;
  branchId: number;
  bodyHash: string;
  chargeIds: number[];
  nativePaths: string[];
  requestId?: number;
  reassignConsignmentId?: number;
};
const workflowRequestScopes = new WeakMap<
  WorkflowRequestCompositionAuthority,
  WorkflowRequestScope
>();
const workflowRequestNativePaths = new Set([
  "delivery.dispatchByBarcode",
  "delivery.dispatchInvoice",
  "delivery.dispatch",
  "delivery.fulfillment.requests.release",
  "delivery.reassignConsignment",
]);
function workflowRequestBody(input: FulfillmentRequestFields) {
  return fulfillmentFingerprint({
    header: fields(input),
    sources: normalizeRequestSources(input.sources),
  });
}
/** Service-only capability; no router accepts it and a forged object has no registered scope. */
export async function authorizeWorkflowRequestCompositionTx(
  tx: Tx,
  actor: Actor,
  input: {
    fields: FulfillmentRequestFields;
    nativePaths: string[];
    chargeIds: number[];
    requestId?: number;
    reassignConsignmentId?: number;
  },
): Promise<WorkflowRequestCompositionAuthority> {
  if (
    !input.nativePaths.length ||
    input.nativePaths.some((path) => !workflowRequestNativePaths.has(path))
  )
    throw fulfillmentError("مسار تفويض إرسال المصدر غير صالح", "FORBIDDEN");
  if (
    input.nativePaths.some((path) =>
      input.reassignConsignmentId == null
        ? path === "delivery.reassignConsignment"
        : path !== "delivery.reassignConsignment",
    ) ||
    (input.reassignConsignmentId != null && input.requestId == null)
  )
    throw fulfillmentError(
      "نوع تفويض تكوين الطلب لا يطابق الإجراء الأصلي",
      "FORBIDDEN",
    );
  assertFulfillmentBranch(actor, input.fields.branchId);
  for (const path of input.nativePaths)
    await assertOperationAuthorityTx(
      tx,
      actor,
      path,
      (current) =>
        current.isOwner === true ||
        current.resolvedPermissions?.store === "FULL",
    );
  const authority: WorkflowRequestCompositionAuthority = Object.freeze({
    [workflowRequestMarker]: true as const,
  });
  workflowRequestScopes.set(authority, {
    tx,
    userId: actor.userId,
    branchId: input.fields.branchId,
    bodyHash: workflowRequestBody(input.fields),
    chargeIds: [...input.chargeIds].sort((a, b) => a - b),
    nativePaths: [...input.nativePaths],
    requestId: input.requestId,
    reassignConsignmentId: input.reassignConsignmentId,
  });
  return authority;
}
async function assertWorkflowRequestCompositionTx(
  tx: Tx,
  actor: Actor,
  action: "create" | "update" | "release" | "reassign",
  input: FulfillmentRequestFields & { id?: number; consignmentId?: number },
  authority?: WorkflowRequestCompositionAuthority,
) {
  if (!authority) return assertRequestOperationTx(tx, actor, action);
  const scope = workflowRequestScopes.get(authority);
  if (
    !scope ||
    scope.tx !== tx ||
    scope.userId !== actor.userId ||
    scope.branchId !== input.branchId ||
    scope.bodyHash !== workflowRequestBody(input) ||
    (scope.reassignConsignmentId != null
      ? action !== "reassign" ||
        scope.reassignConsignmentId !== input.consignmentId
      : action === "reassign") ||
    (action === "create"
      ? scope.requestId != null
      : scope.requestId !== input.id)
  )
    throw fulfillmentError(
      "تفويض تكوين الطلب لا يطابق المعاملة والمستخدم والفرع والمصادر",
      "FORBIDDEN",
    );
  for (const path of scope.nativePaths)
    await assertOperationAuthorityTx(
      tx,
      actor,
      path,
      (current) =>
        current.isOwner === true ||
        current.resolvedPermissions?.store === "FULL",
    );
  if (action === "release" || action === "reassign") {
    const charges = await tx
      .select({ id: fulfillmentCharges.id })
      .from(fulfillmentCharges)
      .where(
        and(
          eq(fulfillmentCharges.requestId, input.id!),
          inArray(fulfillmentCharges.status, ["APPROVED", "COMPLETED"]),
        ),
      )
      .for("update");
    if (
      charges
        .map((row) => row.id)
        .sort((a, b) => a - b)
        .join(",") !== scope.chargeIds.join(",")
    )
      throw fulfillmentError(
        "تغيرت مصادر الأجور منذ تفويض تكوين الإرسالية",
        "CONFLICT",
      );
  }
}
function bindWorkflowRequest(
  authority: WorkflowRequestCompositionAuthority | undefined,
  id: number,
) {
  if (!authority) return;
  const scope = workflowRequestScopes.get(authority);
  if (!scope || (scope.requestId != null && scope.requestId !== id))
    throw fulfillmentError("هوية طلب التفويض غير مطابقة", "FORBIDDEN");
  scope.requestId = id;
}

/** A paid charge is a physical source only with actual completed allocation evidence. */
export async function chargeDispatchEligibilityTx(
  tx: Tx,
  charge: typeof fulfillmentCharges.$inferSelect,
) {
  const paid = money(charge.paidAmount),
    remaining = money(charge.amount).minus(paid);
  const collectibleLifecycle = ["APPROVED", "COMPLETED"].includes(
    charge.status,
  );
  if (
    !collectibleLifecycle ||
    !money(charge.amount).gt(0) ||
    money(charge.refundedAmount).gt(0)
  )
    return {
      eligible: false,
      reason: "المصدر يحتاج أجراً معتمداً لم ترد حقوقه للعميل",
      receiptIds: [] as number[],
    };
  if (remaining.gt(0) && charge.customerId == null)
    return {
      eligible: false,
      reason:
        "المطالبة المؤجلة تحتاج عميل ذمة حقيقياً؛ خدمة العابر لا تنشئ ديناً",
      receiptIds: [] as number[],
    };
  if (paid.isZero())
    return {
      eligible: remaining.gt(0),
      reason: null,
      receiptIds: [] as number[],
    };
  const allocations = await tx
    .select({
      receiptId: receipts.id,
      amount: fulfillmentChargePayments.amount,
      receiptAmount: receipts.amount,
    })
    .from(fulfillmentChargePayments)
    .innerJoin(receipts, eq(receipts.id, fulfillmentChargePayments.receiptId))
    .where(
      and(
        eq(fulfillmentChargePayments.chargeId, charge.id),
        eq(fulfillmentChargePayments.branchId, charge.branchId),
        inArray(fulfillmentChargePayments.kind, [
          "COLLECTION",
          "COURIER_REMITTANCE",
        ]),
        eq(receipts.branchId, charge.branchId),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.direction, "IN"),
      ),
    )
    .for("share");
  const proven = allocations.reduce(
    (sum, row) =>
      sum.plus(
        money(row.amount).lte(row.receiptAmount) ? money(row.amount) : money(0),
      ),
    money(0),
  );
  return {
    eligible: proven.gte(paid),
    reason: proven.gte(paid)
      ? null
      : "مبلغ الأجر المدفوع لا يملك تخصيص قبض فعلي مكتمل؛ أكمل إثبات التحصيل قبل الإرسال",
    receiptIds: allocations.map((row) => row.receiptId),
  };
}

function fields(input: FulfillmentRequestFields) {
  const phone = canonicalIraqiMobile(input.recipientPhone);
  if (
    !phone ||
    input.recipientName.trim().length < 2 ||
    input.deliveryAddress.trim().length < 3
  )
    throw fulfillmentError("اسم المستلم وهاتفه العراقي وعنوانه الكامل مطلوبة");
  if (
    !/^\d+(\.\d{1,2})?$/.test(input.deliveryFee) ||
    money(input.deliveryFee).isNegative()
  )
    throw fulfillmentError("أجرة التوصيل غير صالحة");
  if (input.partialReleaseAllowed && !input.futureFeeDecision?.trim())
    throw fulfillmentError(
      "اكتب قرار أجرة الإرسال القادم قبل السماح بالإرسال الجزئي",
    );
  return {
    branchId: input.branchId,
    customerId: input.customerId ?? null,
    recipientName: input.recipientName.trim(),
    recipientPhone: phone,
    deliveryAddress: input.deliveryAddress.trim(),
    partyId: input.partyId ?? null,
    deliveryFee: toDbMoney(money(input.deliveryFee)),
    feeCollection: input.feeCollection,
    partialReleaseAllowed: input.partialReleaseAllowed ?? false,
    futureFeeDecision: input.futureFeeDecision?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}
function assertEditable(request: { status: string }) {
  if (!["DRAFT", "PREPARING", "READY"].includes(request.status))
    throw fulfillmentError(
      "لا يمكن تعديل أو إلغاء طلب بعد بدء إرساله؛ راجع الشحنة والبنود المتبقية",
    );
}

export async function createFulfillmentRequest(
  input: FulfillmentRequestFields & { clientRequestId: string },
  actor: Actor,
) {
  return retryOnDup(() =>
    withTx((tx) => createFulfillmentRequestInTx(tx, input, actor)),
  );
}

/** Composes creation and release in one financial transaction for barcode batches. */
export async function createFulfillmentRequestInTx(
  tx: Tx,
  input: FulfillmentRequestFields & { clientRequestId: string },
  actor: Actor,
  compositionAuthority?: WorkflowRequestCompositionAuthority,
) {
  const header = fields(input);
  assertFulfillmentBranch(actor, header.branchId);
  const sources = normalizeRequestSources(input.sources);
  const sourceHash = fulfillmentFingerprint({
    ...header,
    sources,
    actorId: actor.userId,
  });

  await assertWorkflowRequestCompositionTx(
    tx,
    actor,
    "create",
    input,
    compositionAuthority,
  );
  await validateRequestPartyTx(tx, header.partyId, header.branchId);
  const findReplay = async () => {
    const [existing] = await tx
      .select()
      .from(fulfillmentRequests)
      .where(
        and(
          eq(fulfillmentRequests.branchId, header.branchId),
          eq(fulfillmentRequests.clientRequestId, input.clientRequestId),
        ),
      )
      .for("update")
      .limit(1);
    if (existing && existing.sourceHash !== sourceHash)
      throw fulfillmentError(
        "استُخدم معرف المحاولة مع بيانات مختلفة",
        "CONFLICT",
      );
    return existing;
  };
  const replay = await findReplay();
  if (replay) {
    bindWorkflowRequest(compositionAuthority, replay.id);
    return replay;
  }
  // Locks serialize competing requests; retry after unique-key races observes the committed key.
  const rows = await loadRequestSourcesTx(tx, sources, actor, {
    ...header,
    lock: true,
  });
  const afterLocks = await findReplay();
  if (afterLocks) {
    bindWorkflowRequest(compositionAuthority, afterLocks.id);
    return afterLocks;
  }
  const identity = fulfillmentMutationContext(
    "requests.create",
    input,
    { header, sources },
    actor,
    header.branchId,
  );
  const requestNumber = `FR-${header.branchId}-${fulfillmentFingerprint({ sourceHash, key: input.clientRequestId }).slice(0, 20)}`;
  const id = extractInsertId(
    await tx.insert(fulfillmentRequests).values({
      ...header,
      createdBy: actor.userId,
      clientRequestId: identity.clientRequestId,
      sourceHash,
      requestNumber,
      status: "DRAFT",
    }),
  );
  if (rows.length)
    await tx.insert(fulfillmentRequestItems).values(
      rows.map((r) => ({
        requestId: id,
        invoiceId: r.invoiceId,
        workOrderId: r.workOrderId,
        status: r.ready ? ("READY" as const) : ("WAITING" as const),
      })),
    );
  await logAuditTx(tx, actor, {
    action: "fulfillment.request.create",
    entityType: "fulfillmentRequest",
    entityId: id,
    newValue: { ...header, sources },
  });
  bindWorkflowRequest(compositionAuthority, id);
  return loadFulfillmentRequestTx(tx, id, actor);
}

export function updateFulfillmentRequest(
  input: Parameters<typeof updateFulfillmentRequestInTx>[1],
  actor: Actor,
) {
  return withTx((tx) => updateFulfillmentRequestInTx(tx, input, actor));
}

export async function updateFulfillmentRequestInTx(
  tx: Tx,
  input: FulfillmentRequestFields & RequestTransition,
  actor: Actor,
  compositionAuthority?: WorkflowRequestCompositionAuthority,
) {
  const header = fields(input);
  const sources = normalizeRequestSources(input.sources);

  await assertWorkflowRequestCompositionTx(
    tx,
    actor,
    "update",
    input,
    compositionAuthority,
  );
  const request = await loadFulfillmentRequestTx(tx, input.id, actor, {
    lock: true,
  });
  const context = fulfillmentMutationContext(
    "requests.update",
    input,
    input,
    actor,
    request.branchId,
  );
  if (await findFulfillmentReplayTx(tx, context))
    return loadFulfillmentRequestTx(tx, input.id, actor);
  assertFulfillmentVersion(request, input.expectedVersion);
  assertEditable(request);
  if (header.branchId !== request.branchId)
    throw fulfillmentError("لا يمكن نقل الطلب بين الفروع");
  await validateRequestPartyTx(tx, header.partyId, header.branchId);
  const rows = await loadRequestSourcesTx(tx, sources, actor, {
    ...header,
    requestId: input.id,
    lock: true,
  });
  // Draft ownership changes are deliberate; no financial/shipping document is deleted.
  await tx
    .delete(fulfillmentRequestItems)
    .where(eq(fulfillmentRequestItems.requestId, input.id));
  if (rows.length)
    await tx.insert(fulfillmentRequestItems).values(
      rows.map((r) => ({
        requestId: input.id,
        invoiceId: r.invoiceId,
        workOrderId: r.workOrderId,
        status: r.ready ? ("READY" as const) : ("WAITING" as const),
      })),
    );
  await tx
    .update(fulfillmentRequests)
    .set({ ...header, status: "DRAFT", version: request.version + 1 })
    .where(eq(fulfillmentRequests.id, input.id));
  await recordFulfillmentMutationTx(tx, context, input.id);
  await logAuditTx(tx, actor, {
    action: "fulfillment.request.update",
    entityType: "fulfillmentRequest",
    entityId: input.id,
    oldValue: request,
    newValue: { ...header, sources },
  });
  return loadFulfillmentRequestTx(tx, input.id, actor);
}

export async function readyFulfillmentRequest(
  input: RequestTransition,
  actor: Actor,
) {
  return withTx(async (tx) => {
    await assertRequestOperationTx(tx, actor, "ready");
    const request = await loadFulfillmentRequestTx(tx, input.id, actor, {
      lock: true,
    });
    const context = fulfillmentMutationContext(
      "requests.ready",
      input,
      input,
      actor,
      request.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return loadFulfillmentRequestTx(tx, input.id, actor);
    assertFulfillmentVersion(request, input.expectedVersion);
    assertEditable(request);
    const items = await tx
      .select()
      .from(fulfillmentRequestItems)
      .where(
        and(
          eq(fulfillmentRequestItems.requestId, input.id),
          eq(fulfillmentRequestItems.isActive, true),
        ),
      );
    const sources = items.map((r) =>
      r.invoiceId != null
        ? { invoiceId: r.invoiceId }
        : { workOrderId: r.workOrderId! },
    );
    const rows = await loadRequestSourcesTx(tx, sources, actor, {
      ...request,
      requestId: request.id,
      lock: true,
    });
    for (const row of rows)
      await tx
        .update(fulfillmentRequestItems)
        .set({
          status: row.ready ? "READY" : "WAITING",
          checkedAt: row.ready ? new Date() : null,
          checkedBy: row.ready ? actor.userId : null,
        })
        .where(
          and(
            eq(fulfillmentRequestItems.requestId, input.id),
            row.invoiceId != null
              ? eq(fulfillmentRequestItems.invoiceId, row.invoiceId)
              : eq(fulfillmentRequestItems.workOrderId, row.workOrderId!),
          ),
        );
    await tx
      .update(fulfillmentRequests)
      .set({
        status: rows.every((r) => r.ready) ? "READY" : "PREPARING",
        version: request.version + 1,
      })
      .where(eq(fulfillmentRequests.id, input.id));
    await recordFulfillmentMutationTx(tx, context, input.id);
    await logAuditTx(tx, actor, {
      action: "fulfillment.request.ready",
      entityType: "fulfillmentRequest",
      entityId: input.id,
      newValue: {
        readiness: rows.map((r) => ({ number: r.number, ready: r.ready })),
      },
    });
    return loadFulfillmentRequestTx(tx, input.id, actor);
  });
}

export async function cancelFulfillmentRequest(
  input: RequestTransition & { reason: string },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await assertRequestOperationTx(tx, actor, "cancel");
    const request = await loadFulfillmentRequestTx(tx, input.id, actor, {
      lock: true,
    });
    const context = fulfillmentMutationContext(
      "requests.cancel",
      input,
      input,
      actor,
      request.branchId,
    );
    if (await findFulfillmentReplayTx(tx, context))
      return loadFulfillmentRequestTx(tx, input.id, actor);
    assertFulfillmentVersion(request, input.expectedVersion);
    const partial = request.status === "PARTIALLY_RELEASED";
    if (!partial) assertEditable(request);
    if (input.reason.trim().length < 3)
      throw fulfillmentError("سبب الإلغاء مطلوب");
    await tx
      .update(fulfillmentRequestItems)
      .set({ status: "CANCELLED", isActive: false })
      .where(
        and(
          eq(fulfillmentRequestItems.requestId, input.id),
          inArray(fulfillmentRequestItems.status, ["WAITING", "READY"]),
        ),
      );
    await tx
      .update(fulfillmentRequests)
      .set({
        status: partial ? "PARTIALLY_RELEASED" : "CANCELLED",
        cancellationReason: input.reason.trim(),
        cancelledBy: actor.userId,
        cancelledAt: new Date(),
        version: request.version + 1,
      })
      .where(eq(fulfillmentRequests.id, input.id));
    await recordFulfillmentMutationTx(tx, context, input.id);
    await logAuditTx(tx, actor, {
      action: "fulfillment.request.cancel",
      entityType: "fulfillmentRequest",
      entityId: input.id,
      newValue: { reason: input.reason },
    });
    return loadFulfillmentRequestTx(tx, input.id, actor);
  });
}

export function releaseFulfillmentRequest(
  input: Parameters<typeof releaseFulfillmentRequestInTx>[1],
  actor: Actor,
) {
  return withTx((tx) => releaseFulfillmentRequestInTx(tx, input, actor));
}

export async function releaseFulfillmentRequestInTx(
  tx: Tx,
  input: RequestTransition & {
    itemIds?: number[];
    partialReleaseConfirmed?: boolean;
    futureFeeDecision?: string;
    subsequentDeliveryFee?: string;
    subsequentFeeCollection?: "COURIER" | "COUNTER" | "SHOP";
    externalTrackingRef?: string;
    assignedUserId?: number;
  },
  actor: Actor,
  compositionAuthority?: WorkflowRequestCompositionAuthority,
) {
  if (!compositionAuthority)
    await assertRequestOperationTx(tx, actor, "release");
  const request = await loadFulfillmentRequestTx(tx, input.id, actor, {
    lock: true,
  });
  if (compositionAuthority) {
    const scope = workflowRequestScopes.get(compositionAuthority);
    if (
      !scope ||
      scope.tx !== tx ||
      scope.userId !== actor.userId ||
      scope.branchId !== request.branchId ||
      scope.requestId !== request.id ||
      scope.reassignConsignmentId != null
    )
      throw fulfillmentError("تفويض الطلب لا يطابق المصدر الحالي", "FORBIDDEN");
    for (const path of scope.nativePaths)
      await assertOperationAuthorityTx(
        tx,
        actor,
        path,
        (current) =>
          current.isOwner === true ||
          current.resolvedPermissions?.store === "FULL",
      );
  }
  const context = fulfillmentMutationContext(
    "requests.release",
    input,
    input,
    actor,
    request.branchId,
  );
  const replay = await findFulfillmentReplayTx(tx, context);
  if (replay)
    return {
      request: await loadFulfillmentRequestTx(tx, input.id, actor),
      consignmentId: replay,
      idempotentReplay: true,
    };
  assertFulfillmentVersion(request, input.expectedVersion);
  if (
    !["DRAFT", "PREPARING", "READY", "PARTIALLY_RELEASED"].includes(
      request.status,
    )
  )
    throw fulfillmentError("الطلب ملغى أو مرسل بالكامل");
  if (request.partyId == null)
    throw fulfillmentError("اختر جهة التوصيل قبل الإرسال");
  await validateDeliveryDriverTx(tx, {partyId:request.partyId,assignedUserId:input.assignedUserId}, request.branchId);
  const items = await tx
    .select()
    .from(fulfillmentRequestItems)
    .where(
      and(
        eq(fulfillmentRequestItems.requestId, input.id),
        eq(fulfillmentRequestItems.isActive, true),
      ),
    )
    .for("update");
  if (compositionAuthority)
    await assertWorkflowRequestCompositionTx(
      tx,
      actor,
      "release",
      {
        ...request,
        sources: items.map((row) =>
          row.invoiceId != null
            ? { invoiceId: row.invoiceId }
            : { workOrderId: row.workOrderId! },
        ),
      },
      compositionAuthority,
    );
  const pending = items.filter((r) => r.status !== "RELEASED");
  const chargeOnly = items.length === 0;
  const selected =
    input.itemIds == null
      ? pending
      : pending.filter((r) => input.itemIds!.includes(r.id));
  if (
    (!selected.length && !chargeOnly) ||
    (input.itemIds != null &&
      (new Set(input.itemIds).size !== input.itemIds.length ||
        selected.length !== input.itemIds.length))
  )
    throw fulfillmentError("اختر بنوداً متبقية صالحة للإرسال");
  const partial = selected.length !== pending.length;
  const decision = input.futureFeeDecision?.trim();
  if (
    partial &&
    (!request.partialReleaseAllowed ||
      input.partialReleaseConfirmed !== true ||
      !decision)
  )
    throw fulfillmentError(
      "الإرسال الجزئي يحتاج سماحاً محفوظاً وتأكيداً صريحاً وقرار أجرة البنود المتبقية",
    );
  // Subsequent release has its own fee contract: never silently charge the first fee again.
  const subsequent = request.status === "PARTIALLY_RELEASED";
  if (
    subsequent &&
    (input.subsequentDeliveryFee == null ||
      input.subsequentFeeCollection == null ||
      !/^\d+(\.\d{1,2})?$/.test(input.subsequentDeliveryFee))
  )
    throw fulfillmentError(
      "حدد أجرة الدفعة اللاحقة وطريقة تحملها صراحةً؛ أجرة الدفعة الأولى لا تتكرر تلقائياً",
    );
  const sources = selected.map((r) =>
    r.invoiceId != null
      ? { invoiceId: r.invoiceId }
      : { workOrderId: r.workOrderId! },
  );
  const rows = await loadRequestSourcesTx(tx, sources, actor, {
    ...request,
    requestId: request.id,
    lock: true,
  });
  if (rows.some((r) => !r.ready))
    throw fulfillmentError(
      "بعض أوامر الشغل لم تجهز؛ انتظر جاهزيتها أو اختر إرسالاً جزئياً صريحاً",
    );
  const invoiceIds: number[] = [];
  for (const item of selected) {
    let invoiceId = item.invoiceId;
    if (invoiceId == null) {
      const materialized = await prepareWorkOrderDeliveryInvoiceInTx(
        tx,
        {
          workOrderId: item.workOrderId!,
          partyId: request.partyId,
          requestId: request.id,
          partialDispatchConfirmed: partial,
        },
        actor,
      );
      invoiceId = materialized.invoiceId;
      await tx
        .update(fulfillmentRequestItems)
        .set({ materializedInvoiceId: invoiceId })
        .where(eq(fulfillmentRequestItems.id, item.id));
    }
    invoiceIds.push(invoiceId);
  }
  if (chargeOnly) {
    const charges = await tx
      .select()
      .from(fulfillmentCharges)
      .where(
        and(
          eq(fulfillmentCharges.requestId, request.id),
          inArray(fulfillmentCharges.status, ["APPROVED", "COMPLETED"]),
        ),
      )
      .for("update");
    if (!charges.length)
      throw fulfillmentError(
        "الطلب بلا مستندات بيع؛ اعتمد أجوراً حقيقية مستحقة قبل إسناد التحصيل",
      );
    for (const charge of charges) {
      const eligibility = await chargeDispatchEligibilityTx(tx, charge);
      if (!eligibility.eligible)
        throw fulfillmentError(
          eligibility.reason ?? "لا يوجد مصدر أجر فعلي صالح للإرسال",
        );
    }
  }
  const shipment = chargeOnly
    ? await dispatchChargeOnlyRequestTx(tx, request, input, actor)
    : await dispatchInvoiceShipmentInTx(
        tx,
        {
          invoiceId: invoiceIds[0]!,
          invoiceIds,
          fulfillmentRequestId: request.id,
          partyId: request.partyId,
          deliveryFee: subsequent
            ? input.subsequentDeliveryFee!
            : request.deliveryFee,
          feeCollection: subsequent
            ? input.subsequentFeeCollection!
            : request.feeCollection,
          recipientName: request.recipientName,
          recipientPhone: request.recipientPhone,
          deliveryAddress: request.deliveryAddress,
          clientRequestId: input.clientRequestId,
          partialDispatchConfirmed: partial,
          externalTrackingRef: input.externalTrackingRef,
          assignedUserId: input.assignedUserId,
          notes: request.notes,
        },
        actor,
      );
  await attachFulfillmentRequestClaimsTx(
    tx,
    {
      requestId: request.id,
      consignmentId: shipment.consignmentId,
      partyId: request.partyId,
      branchId: request.branchId,
      clientRequestId: input.clientRequestId,
    },
    actor,
  );
  if (selected.length)
    await tx
      .update(fulfillmentRequestItems)
      .set({
        status: "RELEASED",
        consignmentId: shipment.consignmentId,
        checkedAt: new Date(),
        checkedBy: actor.userId,
      })
      .where(
        inArray(
          fulfillmentRequestItems.id,
          selected.map((r) => r.id),
        ),
      );
  // Unreleased items retain preparation ownership and remain visible for the next explicit batch.
  const remaining = pending.filter((r) => !selected.includes(r));
  await tx
    .update(fulfillmentRequests)
    .set({
      status: partial ? "PARTIALLY_RELEASED" : "RELEASED",
      releasedBy: actor.userId,
      releasedAt: new Date(),
      futureFeeDecision: partial ? decision : request.futureFeeDecision,
      version: request.version + 1,
    })
    .where(eq(fulfillmentRequests.id, input.id));
  await recordFulfillmentMutationTx(tx, context, shipment.consignmentId);
  await logAuditTx(tx, actor, {
    action: "fulfillment.request.release",
    entityType: "fulfillmentRequest",
    entityId: input.id,
    newValue: {
      consignmentId: shipment.consignmentId,
      invoiceIds,
      remainingItemIds: remaining.map((r) => r.id),
      futureFeeDecision: decision ?? null,
    },
  });
  return {
    request: await loadFulfillmentRequestTx(tx, input.id, actor),
    consignmentId: shipment.consignmentId,
    idempotentReplay: false,
  };
}

/** Reactivates the original cancelled batch; never sells or materializes a source again. */
export function reassignFulfillmentRequest(
  input: Parameters<typeof reassignFulfillmentRequestInTx>[1],
  actor: Actor,
) {
  return withTx((tx) => reassignFulfillmentRequestInTx(tx, input, actor));
}

export async function reassignFulfillmentRequestInTx(
  tx: Tx,
  input: RequestTransition & {
    consignmentId: number;
    partyId?: number;
    externalTrackingRef?: string;
    assignedUserId?: number;
  },
  actor: Actor,
  serviceContext: {
    heldReturnReissue?: boolean;
    compositionAuthority?: WorkflowRequestCompositionAuthority;
  } = {},
) {
  if (!serviceContext.compositionAuthority)
    await assertRequestOperationTx(tx, actor, "reassign");
  const request = await loadFulfillmentRequestTx(tx, input.id, actor, {
    lock: true,
  });
  if (serviceContext.compositionAuthority) {
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
    await assertWorkflowRequestCompositionTx(
      tx,
      actor,
      "reassign",
      {
        ...request,
        consignmentId: input.consignmentId,
        sources: sourceItems.map((row) =>
          row.invoiceId != null
            ? { invoiceId: row.invoiceId }
            : { workOrderId: row.workOrderId! },
        ),
      },
      serviceContext.compositionAuthority,
    );
  }
  const context = fulfillmentMutationContext(
    "requests.reassign",
    input,
    input,
    actor,
    request.branchId,
  );
  const replay = await findFulfillmentReplayTx(tx, context);
  if (replay)
    return {
      request: await loadFulfillmentRequestTx(tx, request.id, actor),
      consignmentId: replay,
      idempotentReplay: true,
    };
  assertFulfillmentVersion(request, input.expectedVersion);
  if (!["RELEASED", "PARTIALLY_RELEASED"].includes(request.status))
    throw fulfillmentError(
      "إعادة الإسناد متاحة لدفعة سبق إرسالها وألغي إسنادها دون تحصيل فقط",
    );
  const [leader] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .limit(1);
  if (
    !leader ||
    leader.fulfillmentRequestId !== request.id ||
    leader.branchId !== request.branchId
  )
    throw fulfillmentError("الإرسالية لا تنتمي إلى طلب التجهيز", "FORBIDDEN");
  const partyId = input.partyId ?? leader.partyId;
  await validateDeliveryDriverTx(tx, {partyId,assignedUserId:input.assignedUserId}, request.branchId);
  const members = await loadShipmentMembersTx(tx, leader.id, {
    currentRead: true,
  });
  let heldReturnReissue =
    serviceContext.heldReturnReissue === true && members.length > 0;
  if (heldReturnReissue)
    for (const member of members)
      if (!(await heldCustomerParcelReissueTx(tx, member)))
        heldReturnReissue = false;
  if (serviceContext.heldReturnReissue && !heldReturnReissue)
    throw fulfillmentError(
      "لا تنقل حقوق الناقل القديمة إلى محاولة جديدة؛ افتح تسويته أو معالجة MISSING_HELD المرتبطة بالمصدر",
    );
  if (
    !members.length ||
    members.some(
      (c) =>
        c.fulfillmentRequestId !== request.id ||
        (!heldReturnReissue &&
          !(
            c.status === "CANCELLED" ||
            (c.sourceType === "FULFILLMENT_REQUEST" && c.status === "RETURNED")
          )) ||
        (!heldReturnReissue &&
          !(
            c.parcelStatus === "CANCELLED" ||
            (c.sourceType === "FULFILLMENT_REQUEST" &&
              c.parcelStatus === "RETURNED")
          )) ||
        (!heldReturnReissue && c.moneyStatus !== "CANCELLED") ||
        c.remittanceId != null ||
        !money(c.collectedAmount).isZero(),
    )
  )
    throw fulfillmentError(
      "يجب إلغاء إسناد الدفعة كاملةً دون أي تحصيل أو توريد قبل إعادة إسنادها",
    );
  const invoiceIds = members.flatMap((c) =>
    c.invoiceId != null ? [c.invoiceId] : [],
  );
  if (invoiceIds.length) {
    const linkedItems = await tx
      .select()
      .from(fulfillmentRequestItems)
      .where(
        and(
          eq(fulfillmentRequestItems.requestId, request.id),
          eq(fulfillmentRequestItems.consignmentId, leader.id),
        ),
      )
      .for("update");
    if (linkedItems.length !== invoiceIds.length)
      throw fulfillmentError("اختر قائد الشحنة الأصلي بجميع مستنداتها");
    const rows = await loadRequestSourcesTx(
      tx,
      invoiceIds.map((invoiceId) => ({ invoiceId })),
      actor,
      { ...request, requestId: request.id, lock: true, heldReturnReissue },
    );
    if (rows.some((r) => !r.ready))
      throw fulfillmentError("أحد مستندات الدفعة ليس جاهزاً لإعادة الإسناد");
  }
  const shipment = invoiceIds.length
    ? await dispatchInvoiceShipmentInTx(
        tx,
        {
          invoiceId: leader.invoiceId!,
          invoiceIds,
          fulfillmentRequestId: request.id,
          partyId,
          deliveryFee: leader.deliveryFee,
          feeCollection: leader.feeCollection,
          recipientName: request.recipientName,
          recipientPhone: request.recipientPhone,
          deliveryAddress: request.deliveryAddress,
          externalTrackingRef:
            input.externalTrackingRef ??
            leader.externalTrackingRef ??
            undefined,
          assignedUserId: input.assignedUserId,
          clientRequestId: input.clientRequestId,
          partialDispatchConfirmed: request.status === "PARTIALLY_RELEASED",
          notes: request.notes,
        },
        actor,
        { heldReturnReissue },
      )
    : await dispatchChargeOnlyRequestTx(
        tx,
        {
          ...request,
          partyId,
          deliveryFee: leader.deliveryFee,
          feeCollection: leader.feeCollection,
        },
        {
          ...input,
          externalTrackingRef:
            input.externalTrackingRef ??
            leader.externalTrackingRef ??
            undefined,
          reassignConsignmentId: leader.id,
          heldReturnReissue,
        },
        actor,
      );
  await restoreFulfillmentRequestClaimsTx(
    tx,
    {
      requestId: request.id,
      consignmentId: shipment.consignmentId,
      partyId,
      branchId: request.branchId,
      clientRequestId: input.clientRequestId,
    },
    actor,
  );
  await tx
    .update(fulfillmentRequests)
    .set({ version: request.version + 1 })
    .where(eq(fulfillmentRequests.id, request.id));
  await recordFulfillmentMutationTx(tx, context, shipment.consignmentId);
  await logAuditTx(tx, actor, {
    action: "fulfillment.request.reassign",
    entityType: "fulfillmentRequest",
    entityId: request.id,
    newValue: {
      consignmentId: shipment.consignmentId,
      invoiceIds,
      partyId,
      deliveryFee: leader.deliveryFee,
      feeCollection: leader.feeCollection,
    },
  });
  return {
    request: await loadFulfillmentRequestTx(tx, request.id, actor),
    consignmentId: shipment.consignmentId,
    idempotentReplay: false,
  };
}

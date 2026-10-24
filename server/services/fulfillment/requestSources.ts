import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryPartyMembers,
  deliveryLedgerEntries,
  invoices,
  workOrders,
} from "../../../drizzle/schema";
import {
  fulfillmentRequestItems,
  fulfillmentRequests,
  fulfillmentChargePayments,
} from "../../../drizzle/fulfillmentSchema";
import { isDeadInvoiceStatus } from "../../../shared/invoiceStatus";
import type { FulfillmentSource } from "../../../shared/fulfillment";
import type { Tx } from "../../db";
import { canonicalIraqiMobile } from "../../lib/phone";
import type { Actor } from "../tx";
import { money, round2, toDbMoney } from "../money";
import {
  assertFulfillmentBranch,
  fulfillmentError,
  loadFulfillmentRequestTx,
  fulfillmentMutationContext,
  findFulfillmentReplayTx,
  recordFulfillmentMutationTx,
} from "./core";
import { assertOperationAuthorityTx } from "../authorization/operationAuthority";
import { extractInsertId } from "../../lib/insertId";
import { nextConsignmentNumber } from "../delivery/numbering";
import {
  requireExternalTrackingRef,
  assertExternalTrackingRefAvailable,
} from "../delivery/trackingRefPolicy";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
} from "../delivery/lifecycle";
import type { DeliveryTxActor } from "../delivery/types";
import { logAuditTx } from "../auditService";
import { assertNoStaleOpenParcelsTx } from "../delivery/parties";
import { enqueuePostCommit } from "../tx";
import { publishRealtimeEvent } from "../../realtime";
import { REALTIME_EVENT_TYPES } from "../../../shared/realtimeEvents";

export async function assertRequestOperationTx(
  tx: Tx,
  actor: Actor,
  action: string,
) {
  await assertOperationAuthorityTx(
    tx,
    actor,
    `delivery.fulfillment.requests.${action}`,
    (current) => {
      const level = current.resolvedPermissions?.store;
      return current.isOwner === true || level === "FULL";
    },
  );
}

export function normalizeRequestSources(
  sources: FulfillmentSource[],
): FulfillmentSource[] {
  if (sources.length > 30)
    throw fulfillmentError("لا يمكن ضم أكثر من30 مستنداً إلى طلب واحد");
  const keys = new Set<string>();
  for (const source of sources) {
    if ((source.invoiceId != null) === (source.workOrderId != null))
      throw fulfillmentError("كل بند يرتبط بفاتورة أو أمر شغل حصراً");
    const id = source.invoiceId ?? source.workOrderId;
    const key = `${source.invoiceId != null ? "I" : "W"}:${id}`;
    if (!Number.isSafeInteger(id) || id! <= 0 || keys.has(key))
      throw fulfillmentError("المستندات مكررة أو غير صالحة");
    keys.add(key);
  }
  return [...sources].sort(
    (a, b) =>
      (a.workOrderId != null ? 0 : 1) - (b.workOrderId != null ? 0 : 1) ||
      (a.invoiceId ?? a.workOrderId)! - (b.invoiceId ?? b.workOrderId)!,
  );
}

export async function validateRequestPartyTx(
  tx: Tx,
  partyId: number | null | undefined,
  branchId: number,
) {
  if (partyId == null) return;
  const [party] = await tx
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, partyId))
    .for("update")
    .limit(1);
  if (
    !party?.isActive ||
    (party.branchId != null && party.branchId !== branchId)
  )
    throw fulfillmentError("اختر جهة توصيل نشطة ضمن الفرع");
  return party;
}

/** Charges have their own claims; no fake invoice or stock writer is involved. */
export async function dispatchChargeOnlyRequestTx(
  tx: Tx,
  request: typeof fulfillmentRequests.$inferSelect,
  input: {
    assignedUserId?: number;
    externalTrackingRef?: string;
    reassignConsignmentId?: number;
    clientRequestId?: string;
  },
  actor: Actor,
) {
  const party = await validateRequestPartyTx(
    tx,
    request.partyId,
    request.branchId,
  );
  if (!party) throw fulfillmentError("اختر جهة توصيل قبل الإرسال");
  if (request.feeCollection === "COUNTER" && money(request.deliveryFee).gt(0))
    throw fulfillmentError(
      "أجرة الكاونتر تحتاج مستند أمانة حقيقي مرتبط بمصدرها؛ اختر تحصيل الناقل أو تحمل المكتبة لهذا الطلب المستقل",
    );
  const tracking = requireExternalTrackingRef(
    party.partyType,
    input.externalTrackingRef,
  );
  const existing =
    input.reassignConsignmentId == null
      ? undefined
      : (
          await tx
            .select()
            .from(deliveryConsignments)
            .where(eq(deliveryConsignments.id, input.reassignConsignmentId))
            .for("update")
            .limit(1)
        )[0];
  if (
    input.reassignConsignmentId != null &&
    (!existing ||
      existing.fulfillmentRequestId !== request.id ||
      existing.sourceType !== "FULFILLMENT_REQUEST" ||
      existing.invoiceId != null ||
      existing.branchId !== request.branchId ||
      !["CANCELLED", "RETURNED"].includes(existing.status) ||
      !["CANCELLED", "RETURNED"].includes(existing.parcelStatus) ||
      existing.moneyStatus !== "CANCELLED" ||
      existing.remittanceId != null ||
      !money(existing.collectedAmount).isZero())
  )
    throw fulfillmentError(
      "الإرسالية المستقلة ليست ملغاة وخالية من التحصيل لإعادة إسنادها",
    );
  if (tracking)
    await assertExternalTrackingRefAvailable(
      tx,
      party.id,
      tracking,
      existing?.id,
    );
  let assignedUserId = input.assignedUserId ?? party.userId ?? null;
  if (assignedUserId == null && party.partyType === "INDIVIDUAL")
    assignedUserId =
      (
        await tx
          .select({ id: deliveryPartyMembers.userId })
          .from(deliveryPartyMembers)
          .where(
            and(
              eq(deliveryPartyMembers.partyId, party.id),
              eq(deliveryPartyMembers.memberRole, "DRIVER"),
              eq(deliveryPartyMembers.isActive, true),
            ),
          )
          .limit(1)
      )[0]?.id ?? null;
  if (assignedUserId != null && assignedUserId !== party.userId) {
    const [driver] = await tx
      .select({ id: deliveryPartyMembers.id })
      .from(deliveryPartyMembers)
      .where(
        and(
          eq(deliveryPartyMembers.partyId, party.id),
          eq(deliveryPartyMembers.userId, assignedUserId),
          eq(deliveryPartyMembers.memberRole, "DRIVER"),
          eq(deliveryPartyMembers.isActive, true),
        ),
      )
      .limit(1);
    if (!driver)
      throw fulfillmentError("السائق ليس عضواً نشطاً في جهة التوصيل المختارة");
  }
  await assertNoStaleOpenParcelsTx(tx, party);
  const consignmentNumber =
    existing?.consignmentNumber ??
    (await nextConsignmentNumber(tx, request.branchId));
  const now = new Date();
  const values: typeof deliveryConsignments.$inferInsert = {
    consignmentNumber,
    branchId: request.branchId,
    partyId: party.id,
    invoiceId: null,
    fulfillmentRequestId: request.id,
    sourceType: "FULFILLMENT_REQUEST",
    sourceId: request.id,
    assignedUserId,
    endCustomerId: request.customerId,
    codAmount: "0.00",
    collectedAmount: "0.00",
    deliveryFee: request.deliveryFee,
    feeCollection: request.feeCollection,
    recipientName: request.recipientName,
    recipientPhone: request.recipientPhone,
    deliveryAddress: request.deliveryAddress,
    externalTrackingRef: tracking,
    status: "DISPATCHED",
    parcelStatus: "OUT_FOR_DELIVERY",
    moneyStatus: "NOT_APPLICABLE",
    dispatchedBy: actor.userId,
    dispatchedAt: now,
    outForDeliveryAt: now,
    settledAt: now,
    notes: request.notes,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
  };
  let consignmentId: number;
  if (existing) {
    await tx
      .update(deliveryConsignments)
      .set(values)
      .where(eq(deliveryConsignments.id, existing.id));
    consignmentId = existing.id;
  } else
    consignmentId = extractInsertId(
      await tx.insert(deliveryConsignments).values(values),
    );
  await appendDeliveryEvent(tx, {
    eventKey: existing
      ? `CN:${consignmentId}:REASSIGNED:${input.clientRequestId}`
      : `CN:${consignmentId}:OUT_FOR_DELIVERY`,
    consignmentId,
    eventType: existing ? "REASSIGNED" : "OUT_FOR_DELIVERY",
    toParcelStatus: "OUT_FOR_DELIVERY",
    toMoneyStatus: "NOT_APPLICABLE",
    actorUserId: actor.userId,
    payload: { fulfillmentRequestId: request.id, partyId: party.id },
  });
  enqueuePostCommit(tx, () => {
    publishRealtimeEvent(
      REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
      {
        deliveryId: consignmentId,
        trackingNumber: consignmentNumber,
        driverId: assignedUserId ?? party.id,
        branchId: request.branchId,
      },
      { branchId: request.branchId },
    );
  });
  return { consignmentId, consignmentNumber };
}

/** Stable original-source locks are shared with release and active-ownership checks. */
export async function loadRequestSourcesTx(
  tx: Tx,
  sources: FulfillmentSource[],
  actor: Actor,
  input: {
    branchId: number;
    customerId?: number | null;
    recipientPhone: string;
    requestId?: number;
    lock?: boolean;
  },
) {
  const normalized = normalizeRequestSources(sources);
  assertFulfillmentBranch(actor, input.branchId);
  const invoiceIds = normalized.flatMap((s) =>
    s.invoiceId != null ? [s.invoiceId] : [],
  );
  const orderIds = normalized.flatMap((s) =>
    s.workOrderId != null ? [s.workOrderId] : [],
  );
  const woWhere = or(
    orderIds.length ? inArray(workOrders.id, orderIds) : undefined,
    invoiceIds.length ? inArray(workOrders.invoiceId, invoiceIds) : undefined,
  );
  const orderQuery = woWhere
    ? tx.select().from(workOrders).where(woWhere).orderBy(asc(workOrders.id))
    : null;
  const orders = orderQuery
    ? await (input.lock ? orderQuery.for("update") : orderQuery)
    : [];
  const invQuery = invoiceIds.length
    ? tx
        .select()
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds))
        .orderBy(asc(invoices.id))
    : null;
  const invoiceRows = invQuery
    ? await (input.lock ? invQuery.for("update") : invQuery)
    : [];
  const customer =
    input.customerId == null
      ? null
      : (
          await tx
            .select()
            .from(customers)
            .where(eq(customers.id, input.customerId))
            .limit(1)
        )[0];
  if (input.customerId != null && !customer?.isActive)
    throw fulfillmentError("العميل غير موجود أو غير نشط");
  const phone = canonicalIraqiMobile(input.recipientPhone);
  if (!phone) throw fulfillmentError("أدخل رقم موبايل عراقي صالحاً للمستلم");
  const ownershipWhere = or(
    invoiceIds.length
      ? inArray(fulfillmentRequestItems.activeInvoiceId, invoiceIds)
      : undefined,
    orderIds.length
      ? inArray(fulfillmentRequestItems.activeWorkOrderId, orderIds)
      : undefined,
  );
  const ownership = ownershipWhere
    ? await tx
        .select()
        .from(fulfillmentRequestItems)
        .where(
          and(
            ownershipWhere,
            input.requestId != null
              ? ne(fulfillmentRequestItems.requestId, input.requestId)
              : undefined,
          ),
        )
    : [];
  if (ownership.length)
    throw fulfillmentError(
      "أحد المستندات مرتبط بطلب توصيل نشط آخر",
      "CONFLICT",
    );
  const consignments =
    invoiceIds.length || orderIds.length
      ? await tx
          .select()
          .from(deliveryConsignments)
          .where(
            or(
              invoiceIds.length
                ? inArray(deliveryConsignments.invoiceId, invoiceIds)
                : undefined,
              orderIds.length
                ? inArray(deliveryConsignments.workOrderId, orderIds)
                : undefined,
            ),
          )
      : [];
  const result = normalized.map((source) => {
    const invoice =
      source.invoiceId != null
        ? invoiceRows.find((r) => r.id === source.invoiceId)
        : undefined;
    const order =
      source.workOrderId != null
        ? orders.find((r) => r.id === source.workOrderId)
        : undefined;
    const row = invoice ?? order;
    if (!row) throw fulfillmentError("أحد المستندات غير موجود", "NOT_FOUND");
    if (row.branchId !== input.branchId)
      throw fulfillmentError(
        "يجب أن تنتمي جميع المستندات إلى فرع الطلب",
        "FORBIDDEN",
      );
    if ((row.customerId ?? null) !== (input.customerId ?? null))
      throw fulfillmentError(
        "يجب أن تتبع جميع المستندات العميل الحقيقي نفسه؛ لا يكفي تشابه الاسم أو الهاتف",
      );
    if (
      row.customerId == null &&
      (canonicalIraqiMobile(order?.deliveryPhone) ??
        canonicalIraqiMobile(row.contactPhone)) !== phone
    )
      throw fulfillmentError(
        "هاتف المستند العابر لا يطابق هاتف المستلم بعد التطبيع",
      );
    if (
      invoice &&
      (isDeadInvoiceStatus(invoice.status) || invoice.sourceType === "ONLINE")
    )
      throw fulfillmentError(
        "الفاتورة ملغاة أو مستبدلة أو مرتجعة، أو لها مسار متجر مستقل",
      );
    if (
      order &&
      (order.invoiceId != null ||
        order.status === "CANCELLED" ||
        order.status === "DELIVERED")
    )
      throw fulfillmentError(
        "أمر الشغل مفوتر أو ملغى أو مسلّم؛ اختر فاتورته القائمة إن كان مفوتراً",
      );
    if (
      consignments.some(
        (c) =>
          (invoice
            ? c.invoiceId === invoice.id
            : c.workOrderId === order!.id) &&
          !(
            c.status === "CANCELLED" &&
            c.parcelStatus === "CANCELLED" &&
            c.moneyStatus === "CANCELLED" &&
            c.remittanceId == null &&
            money(c.collectedAmount).isZero()
          ),
      )
    )
      throw fulfillmentError(
        "المستند سبق إرساله أو يحمل عهدة توصيل؛ راجع إرساليته الأصلية",
        "CONFLICT",
      );
    const linkedOrders = invoice
      ? orders.filter((o) => o.invoiceId === invoice.id)
      : [order!];
    const ready = linkedOrders.every((o) => o.status === "READY");
    const total = invoice
      ? money(invoice.total).minus(invoice.returnedTotal ?? "0")
      : money(order!.salePrice);
    const paid = invoice
      ? money(invoice.paidAmount)
      : money(order!.deposit ?? "0");
    const remaining = round2(total.minus(paid));
    return {
      ...source,
      invoiceId: source.invoiceId ?? null,
      workOrderId: source.workOrderId ?? null,
      number: invoice?.invoiceNumber ?? order!.orderNumber,
      title: order?.title ?? null,
      ready,
      sourceStatus: row.status,
      customerId: row.customerId,
      customerName: customer?.name ?? row.contactName,
      phone: customer?.phone ?? row.contactPhone ?? order?.deliveryPhone,
      total: toDbMoney(total),
      paidAmount: toDbMoney(paid),
      remainingAmount: toDbMoney(remaining.lt(0) ? money(0) : remaining),
      paymentMode: row.paymentMode,
    };
  });
  return result;
}

/** Physical return for a no-invoice source; original charge receivables stay explicit. */
export async function returnFulfillmentRequestConsignmentTx(
  tx: Tx,
  input: { consignmentId: number; reason: string; clientRequestId: string },
  deliveryActor: DeliveryTxActor,
): Promise<
  | { handled: false }
  | { handled: true; result: { consignmentId: number; returned: true } }
> {
  const [preview] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .limit(1);
  if (!preview || preview.sourceType !== "FULFILLMENT_REQUEST")
    return { handled: false };
  const actor: Actor = {
    ...deliveryActor,
    branchId: deliveryActor.branchId ?? 0,
  };
  await assertOperationAuthorityTx(
    tx,
    actor,
    "delivery.returnConsignment",
    (current) =>
      current.isOwner === true || current.resolvedPermissions?.store === "FULL",
  );
  if (preview.fulfillmentRequestId == null || preview.invoiceId != null)
    throw fulfillmentError("مصدر إرسالية الأجور غير متسق؛ اطلب مراجعة المسؤول");
  const request = await loadFulfillmentRequestTx(
    tx,
    preview.fulfillmentRequestId,
    actor,
    { lock: true },
  );
  await tx
    .select({ id: deliveryParties.id })
    .from(deliveryParties)
    .where(eq(deliveryParties.id, preview.partyId))
    .for("update")
    .limit(1);
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (
    !cn ||
    cn.fulfillmentRequestId !== request.id ||
    cn.branchId !== request.branchId ||
    cn.invoiceId != null
  )
    throw fulfillmentError("تغير مصدر الإرسالية أثناء الاسترجاع");
  const context = fulfillmentMutationContext(
    "requests.return",
    input,
    input,
    actor,
    request.branchId,
  );
  if (await findFulfillmentReplayTx(tx, context))
    return { handled: true, result: { consignmentId: cn.id, returned: true } };
  if (input.reason.trim().length < 3)
    throw fulfillmentError("سبب استرجاع إرسالية الأجور مطلوب");
  if (!["DISPATCHED", "PARTIAL", "DELIVERED"].includes(cn.status))
    throw fulfillmentError("حالة إرسالية الأجور لا تقبل استرجاعاً جديداً");
  const ledger = await tx
    .select({
      kind: deliveryLedgerEntries.entryType,
      amount: sql<string>`SUM(${deliveryLedgerEntries.amount})`,
    })
    .from(deliveryLedgerEntries)
    .where(eq(deliveryLedgerEntries.consignmentId, cn.id))
    .groupBy(deliveryLedgerEntries.entryType);
  const amount = (kind: string) =>
    money(ledger.find((r) => r.kind === kind)?.amount ?? "0");
  const collections = await tx
    .select()
    .from(fulfillmentChargePayments)
    .where(
      and(
        eq(fulfillmentChargePayments.consignmentId, cn.id),
        eq(fulfillmentChargePayments.kind, "COURIER_COLLECTION"),
      ),
    )
    .for("update");
  const refunds = collections.length
    ? await tx
        .select()
        .from(fulfillmentChargePayments)
        .where(
          and(
            inArray(
              fulfillmentChargePayments.originalPaymentId,
              collections.map((r) => r.id),
            ),
            eq(fulfillmentChargePayments.kind, "REFUND"),
          ),
        )
        .for("update")
    : [];
  const collected = collections.reduce(
    (sum, r) => sum.plus(r.amount),
    money(0),
  );
  const refunded = refunds.reduce((sum, r) => sum.plus(r.amount), money(0));
  if (
    money(cn.collectedAmount).gt(0) ||
    collected.gt(refunded) ||
    amount("COD_COLLECTED").gt(amount("COD_REMITTED"))
  )
    throw fulfillmentError(
      "الإرسالية تحمل تحصيلاً فعلياً أو عهدة مالية؛ ورّد العهدة وسجّل ردّاً أو تخصيصاً موثقاً للعميل أولاً، ثم استرجع الطرد",
    );
  const exposure = amount("COD_ASSIGNED")
    .minus(amount("COD_RELEASED"))
    .minus(amount("COD_RETURNED"));
  if (exposure.gt(0))
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cn.id}:FULFILLMENT_RETURN:${input.clientRequestId}`,
      partyId: cn.partyId,
      consignmentId: cn.id,
      branchId: cn.branchId,
      entryType: "COD_RELEASED",
      amount: toDbMoney(exposure),
      actorUserId: actor.userId,
    });
  await tx
    .update(deliveryConsignments)
    .set({
      status: "RETURNED",
      parcelStatus: "RETURNED",
      moneyStatus: "CANCELLED",
      returnedAt: new Date(),
      settledAt: new Date(),
    })
    .where(eq(deliveryConsignments.id, cn.id));
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${cn.id}:FULFILLMENT_RETURNED:${input.clientRequestId}`,
    consignmentId: cn.id,
    eventType: "RETURNED",
    fromParcelStatus: cn.parcelStatus,
    toParcelStatus: "RETURNED",
    fromMoneyStatus: cn.moneyStatus,
    toMoneyStatus: "CANCELLED",
    actorUserId: actor.userId,
    payload: { fulfillmentRequestId: request.id, reason: input.reason.trim() },
  });
  await recordFulfillmentMutationTx(tx, context, cn.id);
  await logAuditTx(tx, actor, {
    action: "fulfillment.request.return",
    entityType: "fulfillmentRequest",
    entityId: request.id,
    newValue: { consignmentId: cn.id, reason: input.reason.trim() },
  });
  return { handled: true, result: { consignmentId: cn.id, returned: true } };
}

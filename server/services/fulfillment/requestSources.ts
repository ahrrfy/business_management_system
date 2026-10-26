import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryLedgerEntries,
  invoices,
  receipts,
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
import {
  assertOperationAuthorityTx,
  hasServiceOperationAuthority,
} from "../authorization/operationAuthority";
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
import { validateDeliveryDriverTx } from "../delivery/driverValidation";
import { heldCustomerParcelReissueTx } from "../delivery/workflow/returnReceipt";
import { effectiveDeliveryLedgerEntrySql } from "../delivery/legacyLedger";
import { DELIVERY_CASH_CUSTODY_SIGN } from "../../../shared/deliveryLedgerEntryType";
import { initializeConsignmentCustodyTx } from "../delivery/custody";

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
    heldReturnReissue?: boolean;
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
  const heldReturnReissue =
    !!existing &&
    input.heldReturnReissue === true &&
    (await heldCustomerParcelReissueTx(tx, existing));
  if (input.heldReturnReissue && !heldReturnReissue)
    throw fulfillmentError(
      "العهدة المستلمة تحمل حقوق ناقل سابقة أو لم يثبت استلامها؛ راجع تسوية الناقل أو المعالجة المرتبطة MISSING_HELD",
    );
  if (
    input.reassignConsignmentId != null &&
    (!existing ||
      existing.fulfillmentRequestId !== request.id ||
      existing.sourceType !== "FULFILLMENT_REQUEST" ||
      existing.invoiceId != null ||
      existing.branchId !== request.branchId ||
      (!heldReturnReissue &&
        !["CANCELLED", "RETURNED"].includes(existing.status)) ||
      !["CANCELLED", "RETURNED"].includes(existing.parcelStatus) ||
      (!heldReturnReissue && existing.moneyStatus !== "CANCELLED") ||
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
  await validateDeliveryDriverTx(
    tx,
    { partyId: party.id, assignedUserId: input.assignedUserId },
    request.branchId,
  );
  const assignedUserId = input.assignedUserId ?? null;
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
    ...(heldReturnReissue
      ? {
          returnedAt: null,
          returnDeclaredAt: null,
          returnDeclaredBy: null,
          returnDeclaredReason: null,
          codClaimVersion: existing!.codClaimVersion + 1,
        }
      : {}),
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
      ? `CN:${consignmentId}:ASSIGNMENT_REACTIVATED:${input.clientRequestId}`
      : `CN:${consignmentId}:OUT_FOR_DELIVERY`,
    consignmentId,
    eventType: existing ? "ASSIGNMENT_REACTIVATED" : "OUT_FOR_DELIVERY",
    toParcelStatus: "OUT_FOR_DELIVERY",
    toMoneyStatus: "NOT_APPLICABLE",
    actorUserId: actor.userId,
    payload: { fulfillmentRequestId: request.id, partyId: party.id },
  });
  await initializeConsignmentCustodyTx(tx, {
    consignmentId,
    actorUserId: actor.userId,
    operationId: `fulfillment.request.release:${input.clientRequestId}`,
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
    heldReturnReissue?: boolean;
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
  const heldIds = new Set<number>();
  if (input.heldReturnReissue)
    for (const cn of consignments)
      if (await heldCustomerParcelReissueTx(tx, cn)) heldIds.add(cn.id);
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
          !heldIds.has(c.id) &&
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
    const heldInvoice =
      invoice != null &&
      consignments.some((c) => c.invoiceId === invoice.id && heldIds.has(c.id));
    const ready = linkedOrders.every(
      (o) => o.status === "READY" || (heldInvoice && o.status === "DELIVERED"),
    );
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
    hasServiceOperationAuthority(
      deliveryActor.operationAuthority,
      actor.userId,
      "delivery.returnByBarcode",
    )
      ? "delivery.returnByBarcode"
      : "delivery.returnConsignment",
    (current) =>
      current.isOwner === true || current.resolvedPermissions?.store === "FULL",
    hasServiceOperationAuthority(
      deliveryActor.operationAuthority,
      actor.userId,
      "delivery.returnByBarcode",
    )
      ? deliveryActor.operationAuthority
      : undefined,
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
    .where(
      and(
        eq(deliveryLedgerEntries.consignmentId, cn.id),
        effectiveDeliveryLedgerEntrySql(),
      ),
    )
    .groupBy(deliveryLedgerEntries.entryType);
  const amount = (kind: string) =>
    money(ledger.find((r) => r.kind === kind)?.amount ?? "0");
  const custody = ledger.reduce((sum, row) => {
    const sign = (
      DELIVERY_CASH_CUSTODY_SIGN as Readonly<Record<string, number | undefined>>
    )[row.kind];
    return sign == null ? sum : sum.plus(money(row.amount).times(sign));
  }, money(0));
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
  if (
    collections.some(
      (row) => row.branchId !== cn.branchId || row.partyId !== cn.partyId,
    )
  )
    throw fulfillmentError(
      "تخصيص قبض الأجر لا يطابق مصدر الإرسالية وجهتها؛ راجع أصل العهدة",
    );
  const collectionById = new Map(collections.map((row) => [row.id, row]));
  const remittances = collections.length
    ? await tx
        .select()
        .from(fulfillmentChargePayments)
        .where(
          and(
            eq(fulfillmentChargePayments.consignmentId, cn.id),
            eq(fulfillmentChargePayments.kind, "COURIER_REMITTANCE"),
            inArray(
              fulfillmentChargePayments.chargeId,
              Array.from(new Set(collections.map((row) => row.chargeId))),
            ),
          ),
        )
        .for("update")
    : [];
  const receiptIds = remittances.flatMap((row) =>
    row.receiptId == null ? [] : [row.receiptId],
  );
  const remittanceReceipts = receiptIds.length
    ? await tx
        .select()
        .from(receipts)
        .where(inArray(receipts.id, receiptIds))
        .for("update")
    : [];
  const validRemittances = remittances.filter((row) => {
    const original =
      row.originalPaymentId == null
        ? undefined
        : collectionById.get(row.originalPaymentId);
    // The native grouped allocation writer uses a null root only when several
    // actual collections of this charge share this exact consignment.
    const roots = collections.filter((root) => root.chargeId === row.chargeId);
    const ancestry = original
      ? original.chargeId === row.chargeId
      : row.originalPaymentId == null && roots.length > 1;
    const receipt = remittanceReceipts.find(
      (receipt) => receipt.id === row.receiptId,
    );
    return (
      ancestry &&
      row.branchId === cn.branchId &&
      row.partyId === cn.partyId &&
      receipt?.branchId === cn.branchId &&
      receipt.direction === "IN" &&
      receipt.paymentMethod === "CASH" &&
      receipt.status === "COMPLETED" &&
      receipt.approvalStatus === "APPROVED" &&
      money(receipt.amount).gte(row.amount)
    );
  });
  const refundableSources = new Map(
    [...collections, ...validRemittances].map((row) => [row.id, row]),
  );
  const refunds = refundableSources.size
    ? await tx
        .select()
        .from(fulfillmentChargePayments)
        .where(
          and(
            inArray(
              fulfillmentChargePayments.originalPaymentId,
              Array.from(refundableSources.keys()),
            ),
            eq(fulfillmentChargePayments.kind, "REFUND"),
          ),
        )
        .for("update")
    : [];
  const refundReceiptIds = refunds.flatMap((row) =>
    row.receiptId == null ? [] : [row.receiptId],
  );
  const refundReceipts = refundReceiptIds.length
    ? await tx
        .select()
        .from(receipts)
        .where(inArray(receipts.id, refundReceiptIds))
        .for("update")
    : [];
  const completedRefunds = refunds.filter((row) => {
    const original =
      row.originalPaymentId == null
        ? undefined
        : refundableSources.get(row.originalPaymentId);
    const receipt = refundReceipts.find(
      (receipt) => receipt.id === row.receiptId,
    );
    return (
      original?.chargeId === row.chargeId &&
      row.branchId === cn.branchId &&
      receipt?.branchId === cn.branchId &&
      receipt.direction === "OUT" &&
      receipt.paymentMethod === "CASH" &&
      receipt.status === "COMPLETED" &&
      receipt.approvalStatus === "APPROVED" &&
      money(receipt.amount).gte(row.amount)
    );
  });
  const collected = collections.reduce(
    (sum, row) => sum.plus(row.amount),
    money(0),
  );
  const remitted = validRemittances.reduce(
    (sum, row) => sum.plus(row.amount),
    money(0),
  );
  const refunded = completedRefunds.reduce(
    (sum, row) => sum.plus(row.amount),
    money(0),
  );
  const allocationsConsistent = collections.every((root) => {
    const groupRoots = collections.filter(
      (row) => row.chargeId === root.chargeId,
    );
    const groupRemits = validRemittances.filter(
      (row) => row.chargeId === root.chargeId,
    );
    const groupRefunds = completedRefunds.filter(
      (row) => row.chargeId === root.chargeId,
    );
    return (
      groupRemits
        .reduce((sum, row) => sum.plus(row.amount), money(0))
        .lte(groupRoots.reduce((sum, row) => sum.plus(row.amount), money(0))) &&
      groupRefunds
        .reduce((sum, row) => sum.plus(row.amount), money(0))
        .eq(groupRoots.reduce((sum, row) => sum.plus(row.amount), money(0)))
    );
  });
  const refundCapsValid = Array.from(refundableSources.values()).every(
    (original) =>
      completedRefunds
        .filter((row) => row.originalPaymentId === original.id)
        .reduce((sum, row) => sum.plus(row.amount), money(0))
        .lte(money(original.amount)),
  );
  const receiptsCoverAllocations =
    remittanceReceipts.every((receipt) =>
      validRemittances
        .filter((row) => row.receiptId === receipt.id)
        .reduce((sum, row) => sum.plus(row.amount), money(0))
        .lte(money(receipt.amount)),
    ) &&
    refundReceipts.every((receipt) =>
      completedRefunds
        .filter((row) => row.receiptId === receipt.id)
        .reduce((sum, row) => sum.plus(row.amount), money(0))
        .lte(money(receipt.amount)),
    );
  if (
    !custody.isZero() ||
    !collected.eq(refunded) ||
    !allocationsConsistent ||
    !refundCapsValid ||
    !receiptsCoverAllocations ||
    money(cn.collectedAmount).gt(remitted) ||
    !amount("COD_COLLECTED").eq(collected)
  )
    throw fulfillmentError(
      "الإرسالية تحمل قبضاً أو عهدة لم تسو فعلياً؛ ورّد النقد من تخصيصه الأصلي ثم نفذ رد الأجر بإيصال OUT مكتمل مرتبط بالقبض أو تخصيص توريده، وراجع أي قبض زائد قبل إغلاق المصدر",
    );
  // Remittance and actual custody returns already extinguished their original
  // claim. Release only a genuinely uncollected remainder, never that history again.
  const exposure = amount("COD_ASSIGNED")
    .minus(amount("COD_RELEASED"))
    .minus(amount("COD_REMITTED"))
    .minus(amount("COD_RETURNED"))
    .minus(amount("COD_WRITTEN_OFF"))
    .minus(amount("SHORTFALL_SETTLED"));
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

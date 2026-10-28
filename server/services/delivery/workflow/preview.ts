import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryLedgerEntries,
  invoices,
  onlineOrders,
  receipts,
  workOrders,
} from "../../../../drizzle/schema";
import {
  aftercareCases,
  aftercareExecutions,
  deliveryCustodyItems,
  deliveryDocumentSnapshots,
  fulfillmentCharges,
  fulfillmentRequestItems,
  fulfillmentRequests,
} from "../../../../drizzle/fulfillmentSchema";
import { normalizeKnownSystemBarcode } from "../../../../shared/barcodeScanner";
import { docBarcode } from "../../../../shared/documentNumber";
import type {
  WorkflowAction,
  WorkflowScanPreview,
  WorkflowSourceKind,
  WorkflowStation,
} from "../../../../shared/deliveryWorkflow";
import { isDeadInvoiceStatus } from "../../../../shared/invoiceStatus";
import {
  hasOperationPolicy,
  operationDecision,
} from "../../../../shared/operationPermissions";
import type { Tx } from "../../../db";
import { canonicalIraqiMobile } from "../../../lib/phone";
import { canCrossBranches } from "../../../lib/branchAuthority";
import { loadOperationUserTx } from "../../authorization/operationAuthority";
import {
  assertFulfillmentBranch,
  fulfillmentError,
} from "../../fulfillment/core";
import { idempotencyHash } from "../../idempotency";
import { money, toDbMoney } from "../../money";
import { withTx, type Actor } from "../../tx";
import {
  prepareDeliveryBarcodeLookup,
  namespaceAllowsTarget,
} from "../barcodeLookupPolicy";
import {
  loadShipmentMembersTx,
  operationalShipmentMembers,
} from "../shipments";
import { physicalHandoverConsignmentIdsTx } from "../handoverEvidence";
import {
  assignedGoodsCodDue,
  loadAssignedChargeClaimsTx,
} from "../../fulfillment/chargeDelivery";
import { correctionRequestBlockReasonTx } from "../../sale/correctionLookup";
import { chargeDispatchEligibilityTx } from "../../fulfillment/requests";
import { effectiveDeliveryLedgerEntrySql } from "../legacyLedger";
import {
  heldCustomerParcelReissueTx,
  physicalReturnReceiptTx,
  returnCarrierRightsTx,
} from "./returnReceipt";

import { workflowDispatchNativePaths } from "./nativeAuthority";
import { onlineOrderDispatchSnapshotTx } from "../../storeAdmin/onlineOrderTracking";

type SourceRef = { kind: WorkflowSourceKind; id: number };
type CurrentUser = Awaited<ReturnType<typeof loadOperationUserTx>>;

const positive = (value: ReturnType<typeof money>) =>
  value.gt(0) ? value : money(0);
export const workflowMoney = (value: ReturnType<typeof money>) =>
  toDbMoney(positive(value));

/** All reference matches use printed document numbers; never a bare database ID. */
export async function resolveWorkflowSourceTx(
  tx: Tx,
  raw: string,
  branchId?: number,
): Promise<SourceRef> {
  let code = normalizeKnownSystemBarcode(raw).trim();
  try {
    const url = new URL(code, "http://localhost");
    code = normalizeKnownSystemBarcode(
      url.searchParams.get("payload") ?? url.searchParams.get("order") ?? code,
    );
  } catch {
    /* A plain barcode has no URL envelope. */
  }
  const physical = /^(AE|CHG)[-|](\d+)(?:\||$)/i.exec(code);
  if (
    physical &&
    Number.isSafeInteger(Number(physical[2])) &&
    Number(physical[2]) > 0
  )
    return {
      kind:
        physical[1].toUpperCase() === "AE" ? "aftercareExecution" : "charge",
      id: Number(physical[2]),
    };
  const requestCode = /^FR\|([^|]+)/i.exec(code)?.[1] ?? code;
  if (/^FR-/i.test(code) || /^FR\|/i.test(code)) {
    const rows = await tx
      .select({ id: fulfillmentRequests.id })
      .from(fulfillmentRequests)
      .where(
        and(
          eq(fulfillmentRequests.requestNumber, docBarcode("FR", requestCode)),
          branchId == null
            ? undefined
            : eq(fulfillmentRequests.branchId, branchId),
        ),
      )
      .limit(2);
    if (rows.length !== 1)
      throw fulfillmentError(
        "طلب التجهيز الممسوح غير موجود في الفرع",
        "NOT_FOUND",
      );
    return { kind: "fulfillmentRequest", id: rows[0]!.id };
  }
  const lookup = prepareDeliveryBarcodeLookup(code);
  const candidates: SourceRef[] = [];
  if (namespaceAllowsTarget(lookup.namespace, "INVOICE")) {
    const rows = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          or(
            eq(invoices.invoiceNumber, lookup.documentCode),
            eq(invoices.invoiceNumber, lookup.systemCode),
            eq(invoices.offlineReceiptNumber, lookup.systemCode),
          ),
          branchId == null ? undefined : eq(invoices.branchId, branchId),
        ),
      )
      .limit(3);
    candidates.push(
      ...rows.map((row) => ({ kind: "invoice" as const, id: row.id })),
    );
  }
  if (namespaceAllowsTarget(lookup.namespace, "WORK_ORDER")) {
    const rows = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(
        and(
          or(
            eq(workOrders.orderNumber, lookup.documentCode),
            eq(workOrders.orderNumber, lookup.systemCode),
          ),
          branchId == null ? undefined : eq(workOrders.branchId, branchId),
        ),
      )
      .limit(3);
    candidates.push(
      ...rows.map((row) => ({ kind: "workOrder" as const, id: row.id })),
    );
  }
  if (namespaceAllowsTarget(lookup.namespace, "ONLINE_ORDER")) {
    const rows = await tx
      .select({ id: onlineOrders.id })
      .from(onlineOrders)
      .where(
        and(
          or(
            eq(onlineOrders.orderNumber, lookup.systemCode),
            eq(onlineOrders.orderNumber, lookup.documentCode),
            eq(
              onlineOrders.orderNumber,
              docBarcode("ORD", lookup.documentCode),
            ),
          ),
          branchId == null ? undefined : eq(onlineOrders.branchId, branchId),
        ),
      )
      .limit(3);
    candidates.push(
      ...rows.map((row) => ({ kind: "onlineOrder" as const, id: row.id })),
    );
  }
  if (namespaceAllowsTarget(lookup.namespace, "CONSIGNMENT")) {
    const rows = await tx
      .select({ id: deliveryConsignments.id })
      .from(deliveryConsignments)
      .where(
        and(
          or(
            eq(deliveryConsignments.consignmentNumber, lookup.systemCode),
            eq(deliveryConsignments.consignmentNumber, lookup.documentCode),
            eq(
              deliveryConsignments.consignmentNumber,
              docBarcode("CN", lookup.documentCode),
            ),
            lookup.namespace === "REFERENCE" || lookup.namespace === "NUMERIC"
              ? or(
                  eq(
                    deliveryConsignments.externalTrackingRef,
                    lookup.trackingCode,
                  ),
                  sql`TRIM(LEADING '0' FROM ${deliveryConsignments.externalTrackingRef}) = ${lookup.strippedTrackingCode}`,
                )
              : undefined,
          ),
          branchId == null
            ? undefined
            : eq(deliveryConsignments.branchId, branchId),
        ),
      )
      .limit(3);
    candidates.push(
      ...rows.map((row) => ({ kind: "consignment" as const, id: row.id })),
    );
  }
  if (!candidates.length)
    throw fulfillmentError(
      "لم يعثر على مستند برقم العرض الممسوح؛ استعمل البادئة المطبوعة مثل INV أو WO أو CN",
      "NOT_FOUND",
    );
  if (candidates.length === 1) return candidates[0]!;
  // Unified transaction numbering can identify several linked stages, but never unrelated sources.
  const previews = [];
  for (const candidate of candidates)
    previews.push(
      await loadWorkflowPreviewTx(tx, candidate, undefined, branchId),
    );
  const keys = new Set(
    previews.map((p) => p.group?.key ?? p.source.canonicalKey),
  );
  if (keys.size !== 1)
    throw fulfillmentError(
      "الرقم يطابق مستندات مختلفة؛ امسح الباركود الكامل مع بادئة النوع",
      "CONFLICT",
    );
  return (
    candidates.find(
      (c) => c.kind === "workOrder" || c.kind === "onlineOrder",
    ) ?? candidates[0]!
  );
}

export async function currentWorkflowActorTx(
  tx: Tx,
  actor: Actor,
  branchId?: number,
) {
  const current = await loadOperationUserTx(tx, actor.userId);
  if (
    current.isOwner !== true &&
    current.role !== "admin" &&
    !["READ", "FULL"].includes(current.resolvedPermissions?.store ?? "NONE")
  )
    throw fulfillmentError(
      "صلاحية قراءة التوصيل الحالية غير متاحة للحساب",
      "FORBIDDEN",
    );
  const effective: Actor = {
    userId: actor.userId,
    role: current.role,
    isOwner: current.isOwner === true,
    branchId: current.branchId ?? 0,
  };
  if (branchId != null) assertFulfillmentBranch(effective, branchId);
  return { current, actor: effective };
}

function authority(current: CurrentUser | undefined, path: string) {
  if (!current) return false;
  return hasOperationPolicy(current)
    ? operationDecision(current, path).allowed
    : current.isOwner === true ||
        current.role === "admin" ||
        current.resolvedPermissions?.store === "FULL";
}

/** Source rows are locked before committing; preview itself writes no financial or stock rows. */
export async function loadWorkflowPreviewTx(
  tx: Tx,
  ref: SourceRef,
  current?: CurrentUser,
  requestedBranchId?: number,
  lock = false,
  selectedStation: WorkflowStation = "dispatch",
): Promise<WorkflowScanPreview> {
  let invoice: typeof invoices.$inferSelect | undefined;
  let order: typeof workOrders.$inferSelect | undefined;
  let online: typeof onlineOrders.$inferSelect | undefined;
  let cn: typeof deliveryConsignments.$inferSelect | undefined;
  let request: typeof fulfillmentRequests.$inferSelect | undefined;
  let execution: typeof aftercareExecutions.$inferSelect | undefined;
  let charge: typeof fulfillmentCharges.$inferSelect | undefined;
  let originalInvoice: typeof invoices.$inferSelect | undefined;
  const readInvoice = async (id: number) => {
    const query = tx.select().from(invoices).where(eq(invoices.id, id));
    return (await (lock ? query.for("update") : query).limit(1))[0];
  };
  if (ref.kind === "invoice") invoice = await readInvoice(ref.id);
  if (ref.kind === "workOrder") {
    const q = tx.select().from(workOrders).where(eq(workOrders.id, ref.id));
    order = (await (lock ? q.for("update") : q).limit(1))[0];
    if (order?.invoiceId != null) invoice = await readInvoice(order.invoiceId);
  }
  if (ref.kind === "onlineOrder") {
    const q = tx.select().from(onlineOrders).where(eq(onlineOrders.id, ref.id));
    online = (await (lock ? q.for("update") : q).limit(1))[0];
    if (online?.invoiceId != null)
      invoice = await readInvoice(online.invoiceId);
  }
  if (ref.kind === "consignment") {
    const q = tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, ref.id));
    cn = (await (lock ? q.for("update") : q).limit(1))[0];
    if (cn?.invoiceId != null) invoice = await readInvoice(cn.invoiceId);
  }
  if (ref.kind === "fulfillmentRequest") {
    const q = tx
      .select()
      .from(fulfillmentRequests)
      .where(eq(fulfillmentRequests.id, ref.id));
    request = (await (lock ? q.for("update") : q).limit(1))[0];
  }
  if (ref.kind === "aftercareExecution" || cn?.aftercareExecutionId != null) {
    const q = tx
      .select()
      .from(aftercareExecutions)
      .where(eq(aftercareExecutions.id, cn?.aftercareExecutionId ?? ref.id));
    execution = (await (lock ? q.for("update") : q).limit(1))[0];
    if (!cn && execution?.consignmentId != null)
      cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, execution.consignmentId))
          .limit(1)
      )[0];
  }
  if (ref.kind === "charge") {
    const q = tx
      .select()
      .from(fulfillmentCharges)
      .where(eq(fulfillmentCharges.id, ref.id));
    charge = (await (lock ? q.for("update") : q).limit(1))[0];
  }
  if (invoice) {
    originalInvoice = invoice;
    const visited = new Set<number>();
    while (invoice.correctedByInvoiceId != null) {
      if (visited.has(invoice.id) || visited.size >= 16)
        throw fulfillmentError(
          "سلسلة تصحيح الفاتورة غير متسقة؛ راجع المسؤول",
          "CONFLICT",
        );
      visited.add(invoice.id);
      const next = await readInvoice(invoice.correctedByInvoiceId);
      if (!next || next.branchId !== originalInvoice.branchId)
        throw fulfillmentError(
          "الفاتورة الحالية المرتبطة غير متسقة",
          "CONFLICT",
        );
      invoice = next;
    }
  }
  if (!invoice && !order && !online && !cn && !request && !execution && !charge)
    throw fulfillmentError("المستند غير موجود", "NOT_FOUND");
  if (invoice && !order)
    order = (
      await tx
        .select()
        .from(workOrders)
        .where(eq(workOrders.invoiceId, invoice.id))
        .limit(1)
    )[0];
  if (invoice && !online)
    online = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.invoiceId, invoice.id))
        .limit(1)
    )[0];
  if (
    !request &&
    (cn?.fulfillmentRequestId != null || charge?.requestId != null)
  )
    request = (
      await tx
        .select()
        .from(fulfillmentRequests)
        .where(
          eq(
            fulfillmentRequests.id,
            cn?.fulfillmentRequestId ?? charge!.requestId!,
          ),
        )
        .limit(1)
    )[0];
  const ownership =
    invoice || order
      ? (
          await tx
            .select()
            .from(fulfillmentRequestItems)
            .where(
              and(
                eq(fulfillmentRequestItems.isActive, true),
                or(
                  invoice
                    ? eq(fulfillmentRequestItems.invoiceId, invoice.id)
                    : undefined,
                  invoice
                    ? eq(
                        fulfillmentRequestItems.materializedInvoiceId,
                        invoice.id,
                      )
                    : undefined,
                  order
                    ? eq(fulfillmentRequestItems.workOrderId, order.id)
                    : undefined,
                ),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
  if (!request && ownership)
    request = (
      await tx
        .select()
        .from(fulfillmentRequests)
        .where(eq(fulfillmentRequests.id, ownership.requestId))
        .limit(1)
    )[0];
  if (charge && request) {
    const grouped = await loadWorkflowPreviewTx(
      tx,
      { kind: "fulfillmentRequest", id: request.id },
      current,
      requestedBranchId,
      lock,
      selectedStation,
    );
    return {
      ...grouped,
      source: {
        kind: "charge",
        id: charge.id,
        number: `CHG-${charge.id}`,
        branchId: charge.branchId,
        canonicalKey: `charge:${charge.id}`,
        version: idempotencyHash({
          charge: {
            id: charge.id,
            version: charge.version,
            status: charge.status,
            amount: charge.amount,
            paidAmount: charge.paidAmount,
            refundedAmount: charge.refundedAmount,
            requestId: charge.requestId,
          },
          groupVersion: grouped.source.version,
        }),
      },
      status: charge.status,
      relations: { ...grouped.relations, chargeId: charge.id },
      summaries: {
        ...grouped.summaries,
        commercial: {
          ...grouped.summaries.commercial,
          documentNumber: `CHG-${charge.id}`,
          status: charge.status,
          customerId: charge.customerId,
        },
      },
    };
  }
  if (!cn) {
    const where: SQL[] = [];
    if (invoice) where.push(eq(deliveryConsignments.invoiceId, invoice.id));
    if (order) where.push(eq(deliveryConsignments.workOrderId, order.id));
    if (request)
      where.push(eq(deliveryConsignments.fulfillmentRequestId, request.id));
    if (where.length)
      cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(or(...where))
          .orderBy(desc(deliveryConsignments.id))
          .limit(1)
      )[0];
  }
  const branchId = (
    ref.kind === "invoice"
      ? invoice
      : ref.kind === "workOrder"
        ? order
        : ref.kind === "onlineOrder"
          ? online
          : ref.kind === "consignment"
            ? cn
            : ref.kind === "fulfillmentRequest"
              ? request
              : ref.kind === "aftercareExecution"
                ? execution
                : charge
  )?.branchId;
  if (
    branchId == null ||
    (requestedBranchId != null && branchId !== requestedBranchId)
  )
    throw fulfillmentError("المستند لا يخص الفرع المختار", "FORBIDDEN");
  if (current && !canCrossBranches(current) && current.branchId !== branchId)
    throw fulfillmentError(
      "المستند خارج نطاق الفرع الحالي للحساب",
      "FORBIDDEN",
    );
  const caseRow = execution
    ? (
        await tx
          .select()
          .from(aftercareCases)
          .where(eq(aftercareCases.id, execution.caseId))
          .limit(1)
      )[0]
    : undefined;
  const customerId =
    caseRow?.customerId ??
    request?.customerId ??
    charge?.customerId ??
    invoice?.customerId ??
    order?.customerId ??
    online?.customerId ??
    cn?.endCustomerId ??
    null;
  const customer =
    customerId == null
      ? undefined
      : (
          await tx
            .select({
              name: customers.name,
              phone: customers.phone,
              address: customers.address,
            })
            .from(customers)
            .where(eq(customers.id, customerId))
            .limit(1)
        )[0];
  const sourceRow =
    ref.kind === "invoice"
      ? (originalInvoice ?? invoice)
      : ref.kind === "workOrder"
        ? order
        : ref.kind === "onlineOrder"
          ? online
          : ref.kind === "consignment"
            ? cn
            : ref.kind === "fulfillmentRequest"
              ? request
              : ref.kind === "aftercareExecution"
                ? execution
                : charge;
  const number =
    ref.kind === "invoice"
      ? sourceRow && "invoiceNumber" in sourceRow
        ? sourceRow.invoiceNumber
        : invoice!.invoiceNumber
      : ref.kind === "workOrder"
        ? order!.orderNumber
        : ref.kind === "onlineOrder"
          ? online!.orderNumber
          : ref.kind === "consignment"
            ? cn!.consignmentNumber
            : ref.kind === "fulfillmentRequest"
              ? request!.requestNumber
              : `${ref.kind === "aftercareExecution" ? "AE" : "CHG"}-${ref.id}`;
  const canonicalKey = execution
    ? `aftercareExecution:${execution.id}`
    : invoice
      ? `invoice:${invoice.id}`
      : order
        ? `workOrder:${order.id}`
        : online
          ? `onlineOrder:${online.id}`
          : request
            ? `fulfillmentRequest:${request.id}`
            : charge
              ? `charge:${charge.id}`
              : `consignment:${cn!.id}`;
  let total = execution
    ? money(0)
    : invoice
      ? positive(money(invoice.total).minus(invoice.returnedTotal))
      : order
        ? money(order.salePrice)
        : charge
          ? money(charge.amount)
          : online
            ? money(online.total).minus(online.shippingCost)
            : money(0);
  let paid = execution
    ? money(0)
    : invoice
      ? money(invoice.paidAmount)
      : order
        ? money(order.deposit ?? "0")
        : charge
          ? money(charge.paidAmount)
          : money(0);
  const linkedCharges = request
    ? await tx
        .select({
          amount: fulfillmentCharges.amount,
          paidAmount: fulfillmentCharges.paidAmount,
        })
        .from(fulfillmentCharges)
        .where(
          and(
            eq(fulfillmentCharges.requestId, request.id),
            inArray(fulfillmentCharges.status, ["APPROVED", "COMPLETED"]),
          ),
        )
    : [];
  let serviceCharges = linkedCharges.reduce(
    (sum, row) => sum.plus(positive(money(row.amount).minus(row.paidAmount))),
    money(0),
  );
  const requestItems = request
    ? await tx
        .select()
        .from(fulfillmentRequestItems)
        .where(
          and(
            eq(fulfillmentRequestItems.requestId, request.id),
            eq(fulfillmentRequestItems.isActive, true),
          ),
        )
    : [];
  if (request && !cn) {
    total = money(0);
    paid = money(0);
    for (const item of requestItems) {
      const invId = item.invoiceId ?? item.materializedInvoiceId;
      if (invId != null) {
        const row = await readInvoice(invId);
        if (row) {
          total = total.plus(
            positive(money(row.total).minus(row.returnedTotal)),
          );
          paid = paid.plus(row.paidAmount);
        }
      } else if (item.workOrderId != null) {
        const row = (
          await tx
            .select()
            .from(workOrders)
            .where(eq(workOrders.id, item.workOrderId))
            .limit(1)
        )[0];
        if (row) {
          total = total.plus(row.salePrice);
          paid = paid.plus(row.deposit ?? "0");
        }
      }
    }
  }
  const members = cn ? await loadShipmentMembersTx(tx, cn.id) : [];
  const operationalMembers = operationalShipmentMembers(members);
  const physicalHandoverIds = await physicalHandoverConsignmentIdsTx(
    tx,
    operationalMembers.map((member) => Number(member.id)),
  );
  const feeSource =
    members.find((member) => money(member.deliveryFee).gt(0)) ?? members[0];
  if (members.some((member) => member.branchId !== branchId))
    throw fulfillmentError(
      "تضم الشحنة علاقة من فرع مختلف؛ راجع المسؤول",
      "FORBIDDEN",
    );
  const invoiceIds = Array.from(
    new Set(members.flatMap((r) => (r.invoiceId == null ? [] : [r.invoiceId]))),
  );
  const feeInvoiceIds = Array.from(
    new Set([
      ...invoiceIds,
      ...(invoice ? [invoice.id] : []),
      ...requestItems.flatMap((i) =>
        (i.invoiceId ?? i.materializedInvoiceId)
          ? [i.invoiceId ?? i.materializedInvoiceId!]
          : [],
      ),
    ]),
  );
  const linkedFeeOrders = feeInvoiceIds.length
    ? await tx
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(inArray(workOrders.invoiceId, feeInvoiceIds))
    : [];
  const feeOrderIds = Array.from(
    new Set([
      ...linkedFeeOrders.map((o) => o.id),
      ...(order ? [order.id] : []),
      ...requestItems.flatMap((i) =>
        i.workOrderId == null ? [] : [i.workOrderId],
      ),
    ]),
  );
  const feeRefs = [
    ...feeInvoiceIds.map((id) => `DLV-FEE-INV-${id}`),
    ...feeOrderIds.map((id) => `DLV-FEE-WO-${id}`),
  ];
  const heldRows = feeRefs.length
    ? await tx
        .select({
          id: receipts.id,
          amount: receipts.amount,
          direction: receipts.direction,
          status: receipts.status,
        })
        .from(receipts)
        .where(
          and(
            eq(receipts.branchId, branchId),
            inArray(receipts.referenceNumber, feeRefs),
          ),
        )
    : [];
  const held = heldRows
    .filter((r) => r.status === "COMPLETED")
    .reduce(
      (sum, r) =>
        sum.plus(
          r.direction === "IN" ? money(r.amount) : money(r.amount).neg(),
        ),
      money(0),
    );
  const pendingRefundReceiptIds = heldRows
    .filter((r) => r.direction === "OUT" && r.status === "PENDING")
    .map((r) => r.id);
  const paymentMode =
    invoice?.paymentMode ?? order?.paymentMode ?? (online ? "COD" : null);
  let cod =
    execution || paymentMode === "CREDIT"
      ? money(0)
      : positive(total.minus(paid));
  if (cn) {
    cod = money(0);
    serviceCharges = money(0);
    if (invoiceIds.length && !execution) {
      total = money(0);
      paid = money(0);
    }
    for (const member of members) {
      const row =
        member.invoiceId == null
          ? undefined
          : await readInvoice(member.invoiceId);
      cod = cod.plus(assignedGoodsCodDue(row));
      if (row && !execution) {
        total = total.plus(positive(money(row.total).minus(row.returnedTotal)));
        paid = paid.plus(row.paidAmount);
      }
      const claims = await loadAssignedChargeClaimsTx(tx, member.id);
      serviceCharges = serviceCharges.plus(claims.remaining);
    }
  }
  if (request && !cn) {
    cod = money(0);
    for (const item of requestItems) {
      const invId = item.invoiceId ?? item.materializedInvoiceId;
      const row = invId == null ? undefined : await readInvoice(invId);
      if (row && row.paymentMode !== "CREDIT")
        cod = cod.plus(
          positive(
            money(row.total).minus(row.returnedTotal).minus(row.paidAmount),
          ),
        );
      if (invId == null && item.workOrderId != null) {
        const wo = (
          await tx
            .select()
            .from(workOrders)
            .where(eq(workOrders.id, item.workOrderId))
            .limit(1)
        )[0];
        if (wo && wo.paymentMode !== "CREDIT")
          cod = cod.plus(
            positive(money(wo.salePrice).minus(wo.deposit ?? "0")),
          );
      }
    }
  }
  cod = cod.plus(serviceCharges);
  if (request) {
    total = total.plus(
      linkedCharges.reduce((sum, row) => sum.plus(row.amount), money(0)),
    );
    paid = paid.plus(
      linkedCharges.reduce((sum, row) => sum.plus(row.paidAmount), money(0)),
    );
  }
  const [activeLinkedCase] =
    !execution && (invoice || order)
      ? await tx
          .select({
            id: aftercareCases.id,
            status: aftercareCases.status,
            version: aftercareCases.version,
          })
          .from(aftercareCases)
          .where(
            and(
              eq(aftercareCases.branchId, branchId),
              inArray(aftercareCases.status, [
                "DRAFT",
                "APPROVED",
                "IN_PROGRESS",
              ]),
              or(
                invoice ? eq(aftercareCases.invoiceId, invoice.id) : undefined,
                order ? eq(aftercareCases.workOrderId, order.id) : undefined,
              ),
            ),
          )
          .orderBy(desc(aftercareCases.id))
          .limit(1)
      : [];
  const relations: WorkflowScanPreview["relations"] = {
    invoiceId: invoice?.id,
    workOrderId: order?.id,
    onlineOrderId: online?.id,
    consignmentId: cn?.id,
    fulfillmentRequestId: request?.id,
    aftercareCaseId: execution?.caseId ?? activeLinkedCase?.id,
    aftercareCaseStatus: activeLinkedCase?.status,
    aftercareExecutionId: execution?.id,
    chargeId: charge?.id,
    correctedByInvoiceId: invoice?.correctedByInvoiceId ?? undefined,
    originalInvoiceId:
      caseRow?.invoiceId ??
      (originalInvoice && invoice?.id !== originalInvoice.id
        ? originalInvoice.id
        : undefined),
  };
  const moneyView: WorkflowScanPreview["money"] = {
    currentTotal: workflowMoney(total),
    paidAmount: workflowMoney(paid),
    remainingAmount: workflowMoney(total.minus(paid)),
    codAmount: workflowMoney(cod),
    cashInCourierCustody: cn
      ? workflowMoney(
          money(
            (
              await tx
                .select({
                  amount: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED','COD_RETURNED','COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
                })
                .from(deliveryLedgerEntries)
                .where(
                  and(
                    inArray(
                      deliveryLedgerEntries.consignmentId,
                      members.map((member) => member.id),
                    ),
                    effectiveDeliveryLedgerEntrySql(),
                  ),
                )
            )[0]?.amount ?? "0",
          ),
        )
      : "0.00",
    heldDeliveryFee: workflowMoney(held),
    serviceCharges: workflowMoney(serviceCharges),
    deliveryFee:
      feeSource?.deliveryFee ??
      cn?.deliveryFee ??
      execution?.deliveryFee ??
      request?.deliveryFee ??
      (online
        ? online.deliveryFree
          ? online.deliveryWaivedAmount
          : online.shippingCost
        : undefined) ??
      invoice?.deliveryFee ??
      order?.deliveryCost ??
      "0.00",
    feeCollection:
      feeSource?.feeCollection ??
      cn?.feeCollection ??
      execution?.feeCollection ??
      request?.feeCollection ??
      (online ? (online.deliveryFree ? "SHOP" : "COURIER") : undefined) ??
      order?.deliveryFeeCollection ??
      (held.gt(0) ? "COUNTER" : "COURIER"),
    paymentMode,
    heldReceipts: heldRows,
    pendingRefundReceiptIds,
  };
  const status = ref.kind === "invoice" ? invoice!.status : sourceRow!.status;
  const activeCn = cn && !["CANCELLED", "RETURNED"].includes(cn.status);
  const dead = invoice
    ? isDeadInvoiceStatus(invoice.status)
    : status === "CANCELLED";
  const ready = execution
    ? execution.status === "PREPARED"
    : ref.kind === "workOrder" && order
      ? order.status === "READY"
      : order && !invoice
        ? order.status === "READY"
        : request && ref.kind === "fulfillmentRequest"
          ? ["DRAFT", "PREPARING", "READY"].includes(request.status)
          : online && !invoice
            ? ["CONFIRMED", "PROCESSING"].includes(online.status)
            : true;
  const allowedPaths: Record<WorkflowAction, string> = {
    dispatch: "delivery.dispatchByBarcode",
    collect:
      charge && !cn
        ? "delivery.fulfillment.charges.collect"
        : "delivery.recordRemittance",
    cancelAssignment: execution
      ? "delivery.fulfillment.aftercare.cancelExecution"
      : "delivery.cancelAssignment",
    reassign:
      request && (ref.kind === "fulfillmentRequest" || !invoice)
        ? "delivery.fulfillment.requests.reassign"
        : "delivery.reassignConsignment",
    declareReturn: "delivery.declareReturn",
    return: "delivery.returnConsignment",
    edit: "sales.correct",
    aftercare: "delivery.fulfillment.aftercare.create",
  };
  const correctionBlockReason = invoice
    ? await correctionRequestBlockReasonTx(tx, invoice)
    : null;
  const returnMembers: NonNullable<
    WorkflowScanPreview["returnState"]
  >["members"] = [];
  let allHeldReissuable = members.length > 0;
  for (const member of members) {
    const receipt = await physicalReturnReceiptTx(tx, member);
    const carrierRights = await returnCarrierRightsTx(tx, [member.id]);
    const received =
      member.sourceType === "AFTERCARE_EXECUTION"
        ? member.parcelStatus === "RETURNED"
        : receipt != null;
    const inv =
      member.invoiceId == null
        ? undefined
        : await readInvoice(member.invoiceId);
    const [returnOrder] =
      member.workOrderId != null || member.invoiceId != null
        ? await tx
            .select({
              id: workOrders.id,
              number: workOrders.orderNumber,
              status: workOrders.status,
            })
            .from(workOrders)
            .where(
              member.workOrderId != null
                ? eq(workOrders.id, member.workOrderId)
                : eq(workOrders.invoiceId, member.invoiceId!),
            )
            .limit(1)
        : [];
    const commercialActionRequired =
      received &&
      member.sourceType !== "AFTERCARE_EXECUTION" &&
      (inv
        ? !isDeadInvoiceStatus(inv.status)
        : returnOrder?.status === "DELIVERED");
    const sourceClosureRequired =
      received &&
      member.sourceType === "FULFILLMENT_REQUEST" &&
      member.invoiceId == null &&
      ["DISPATCHED", "PARTIAL", "DELIVERED"].includes(member.status);
    returnMembers.push({
      consignmentId: member.id,
      consignmentNumber: member.consignmentNumber,
      invoiceId: member.invoiceId,
      invoiceNumber: inv?.invoiceNumber ?? null,
      invoiceSourceType: inv?.sourceType ?? null,
      workOrderId: returnOrder?.id ?? null,
      workOrderNumber: returnOrder?.number ?? null,
      cashInCourierCustody: workflowMoney(carrierRights.cash),
      declared: member.returnDeclaredAt != null,
      canReceive:
        !received &&
        ["DISPATCHED", "PARTIAL", "DELIVERED"].includes(member.status) &&
        member.parcelStatus !== "CANCELLED" &&
        (member.sourceType !== "AFTERCARE_EXECUTION" ||
          member.returnDeclaredAt != null),
      received,
      receivedAt: received
        ? (member.returnedAt?.toISOString() ??
          receipt?.occurredAt.toISOString() ??
          null)
        : null,
      heldCustomerOwned: commercialActionRequired,
      commercialActionRequired,
      sourceClosureRequired,
    });
    if (!(await heldCustomerParcelReissueTx(tx, member)))
      allHeldReissuable = false;
  }
  const physicallyReceived =
    returnMembers.length > 0 &&
    returnMembers.every((member) => member.received);
  const pendingCommercial = returnMembers.some(
    (member) => member.commercialActionRequired,
  );
  const pendingSourceClosure = returnMembers.some(
    (member) => member.sourceClosureRequired,
  );
  const standaloneRequestSource =
    members.length > 0 &&
    members.every(
      (member) =>
        member.sourceType === "FULFILLMENT_REQUEST" && member.invoiceId == null,
    );
  const returnState: WorkflowScanPreview["returnState"] = cn
    ? {
        declared: returnMembers.some((member) => member.declared),
        received: physicallyReceived,
        heldCustomerOwned: returnMembers.some(
          (member) => member.heldCustomerOwned,
        ),
        commercialActionRequired: pendingCommercial,
        sourceClosureRequired: pendingSourceClosure,
        refundActionRequired:
          pendingCommercial &&
          (money(moneyView.paidAmount).gt(0) ||
            money(moneyView.heldDeliveryFee).gt(0) ||
            pendingRefundReceiptIds.length > 0),
        reissueAllowed: !execution && allHeldReissuable,
        ...(!execution && pendingCommercial && !allHeldReissuable
          ? {
              reissueBlockedReason:
                "نموذج الإرسالية الحالية يحتفظ بحقوق الناقل الأصلي؛ لا تُنقل عهدته النقدية أو أجوره إلى إسناد جديد. افتح تسوية الناقل من محطة التحصيل ثم معالجة MISSING_HELD المرتبطة بالمصدر لإعادة إرسال نفس عهدة العميل، دون صرف مخزون جديد ودون عكس أجرة تاريخية مدفوعة",
            }
          : {}),
        nextStep: execution
          ? "تابع العهدة وإعادة الإصدار أو التسوية من حالة المعالجة؛ لا بيع أو قبض عميل جديد"
          : standaloneRequestSource && physicallyReceived
            ? pendingSourceClosure
              ? "استلمت طرود طلب الأجور المستقل؛ أغلق إرساليته من مسار المصدر بعد مراجعة عهدة الناقل وأي قبض فعلي. لا يوجد بيع لإرجاعه، وإغلاق الإرسالية لا يلغي الأجور المعتمدة ولا يرد قبضها؛ تابع حقوق الأجر والتحصيل من محطة التحصيل"
              : "أغلقت إرسالية طلب الأجور المستقل؛ تبقى حقوق الأجور وإيصالات قبضها الأصلية قائمة، وأي تصحيح أو رد مالي يحتاج مساره المعتمد من محطة التحصيل"
            : pendingCommercial
              ? allHeldReissuable
                ? "الطرد مستلم بعهدة المكتبة ويظل مملوكاً للعميل؛ أعد إرساله من نفس المصدر بلا صرف ثانٍ، أو نفذ المرتجع التجاري ورد المال صراحةً. الاستلام لا يضيف مخزوناً متاحاً"
                : "الطرد مستلم بعهدة المكتبة ويظل مملوكاً للعميل؛ راجع عهدة وأجرة الناقل من محطة التحصيل. لإعادة الإرسال افتح معالجة MISSING_HELD مرتبطة بالمصدر من نفس العهدة دون مخزون جديد؛ لا تعكس أجرة تاريخية مدفوعة. المرتجع التجاري ورد المال إجراءان صريحان منفصلان"
              : "أعلن الرجوع ثم حدد كل طرد استلمته وفحصته فعلياً؛ رد البيع والمال خطوتان مستقلتان",
        members: returnMembers,
      }
    : undefined;
  let expandedRequestDispatchAllowed = true;
  if (request && !authority(current, "delivery.fulfillment.requests.release")) {
    for (const item of requestItems) {
      const workOrder =
        item.workOrderId == null
          ? undefined
          : (
              await tx
                .select({ invoiceId: workOrders.invoiceId })
                .from(workOrders)
                .where(eq(workOrders.id, item.workOrderId))
                .limit(1)
            )[0];
      if (
        !workflowDispatchNativePaths(
          item.invoiceId != null ? "invoice" : "workOrder",
          item.invoiceId != null || workOrder?.invoiceId != null,
        ).some((path) => authority(current, path))
      )
        expandedRequestDispatchAllowed = false;
    }
  }
  const chargeEligibility = charge
    ? await chargeDispatchEligibilityTx(tx, charge)
    : undefined;
  const states: Record<WorkflowAction, [boolean, string]> = {
    dispatch: [
      !dead &&
        !activeCn &&
        ready &&
        (!charge || chargeEligibility?.eligible === true) &&
        !pendingRefundReceiptIds.length &&
        expandedRequestDispatchAllowed,
      !expandedRequestDispatchAllowed
        ? "طلب التجهيز يضم مستنداً لا تملك صلاحية إرساله الأصلية؛ راجع كل مصدر أو اطلب تفويض إصدار الطلب الكامل"
        : activeCn
          ? "للمصدر إرسالية قائمة؛ افتحها لإعادة الإسناد أو إعلان الرجوع"
          : pendingRefundReceiptIds.length
            ? "أكمل رد أمانة الأجرة المعلق أولاً"
            : charge
              ? (chargeEligibility?.reason ??
                "حدد هوية مستلم حقيقية ومصدراً معتمداً أو قبضاً مثبتاً قبل الإرسال")
              : "المصدر غير جاهز أو ملغى؛ راجع المستند الحالي",
    ],
    collect: [
      charge && !cn
        ? ["APPROVED", "COMPLETED"].includes(charge.status) &&
          money(charge.amount).gt(charge.paidAmount)
        : !!activeCn && !execution && cn!.returnDeclaredAt == null,
      execution
        ? "دفعة المعالجة بلا تحصيل من العميل"
        : "لا توجد مطالبة توصيل قائمة قابلة للتحصيل",
    ],
    cancelAssignment: [
      !!activeCn &&
        operationalMembers.length > 0 &&
        operationalMembers.every(
          (member) =>
            !["CANCELLED", "RETURNED"].includes(member.status) &&
            member.returnDeclaredAt == null &&
            ["ASSIGNED", "ACCEPTED", "OUT_FOR_DELIVERY", "FAILED"].includes(
              member.parcelStatus,
            ) &&
            member.pickedUpAt == null &&
            !physicalHandoverIds.has(Number(member.id)) &&
            money(member.collectedAmount).isZero() &&
            member.remittanceId == null,
        ),
      "ثبت تقدم الشحنة بعد الإسناد أو بدأ تحصيلها؛ استخدم إعلان الرجوع ثم الاستلام الفعلي",
    ],
    reassign: [
      !!cn &&
        !execution &&
        (allHeldReissuable ||
          ((cn.status === "CANCELLED" || !!activeCn) &&
            cn.returnDeclaredAt == null)),
      pendingCommercial
        ? "الطرد مستلم، لكن تحصيل الناقل أو تاريخه المالي/أجرته يحتاج تسوية مستقلة قبل إعادة الإصدار؛ لا تعاد حركة المخزون"
        : "إعادة الإسناد تتطلب إلغاءً محكوماً أو شحنة مفتوحة أو عهدة عائدة مستلمة مثبتة",
    ],
    declareReturn: [
      !!activeCn &&
        cn!.returnDeclaredAt == null &&
        !returnMembers.every((member) => member.received),
      "لا توجد شحنة بالطريق تقبل إعلان رجوع",
    ],
    return: [
      !!cn && returnMembers.some((member) => member.canReceive),
      "استلم الطرد وافحصه فعلياً؛ عكس البيع ورد المال إجراءات مرتبطة منفصلة",
    ],
    edit: [
      !!invoice && !dead && !correctionBlockReason,
      correctionBlockReason ??
        "راجع الفاتورة الحالية وعلاقاتها؛ أمر الشغل يصحح من مساره المحكوم",
    ],
    aftercare: [
      !!invoice || !!order || !!execution,
      "اختر مصدر بيع أو أمر شغل حقيقياً للمعالجة",
    ],
  };
  const actions = (Object.keys(states) as WorkflowAction[]).map((action) => {
    const can =
      action === "dispatch"
        ? workflowDispatchNativePaths(ref.kind, invoice != null).some((path) =>
            authority(current, path),
          )
        : action === "return"
          ? ["delivery.returnConsignment", "delivery.returnByBarcode"].some(
              (path) => authority(current, path),
            )
          : authority(current, allowedPaths[action]);
    return {
      action,
      allowed: states[action][0] && can,
      ...(!can
        ? { reason: "الصلاحية التشغيلية الحالية لا تسمح بهذا الإجراء" }
        : !states[action][0]
          ? { reason: states[action][1] }
          : {}),
    };
  });
  const group =
    cn || request
      ? {
          key: cn
            ? `shipment:${members[0]?.id ?? cn.id}`
            : `fulfillmentRequest:${request!.id}`,
          leaderConsignmentId: members[0]?.id ?? null,
          consignmentNumber:
            members[0]?.consignmentNumber ?? cn?.consignmentNumber ?? null,
          consignmentIds: members.map((r) => r.id),
          invoiceIds,
          fulfillmentRequestId: request?.id ?? null,
          partyId: cn?.partyId ?? request?.partyId ?? null,
        }
      : undefined;
  const printSource: WorkflowScanPreview["printSource"] = execution
    ? {
        sourceType: "AFTERCARE_EXECUTION",
        sourceId: execution.id,
        number: `AE-${execution.id}`,
        aftercareExecutionId: execution.id,
      }
    : request
      ? {
          sourceType: "FULFILLMENT_REQUEST",
          sourceId: request.id,
          number: request.requestNumber,
          fulfillmentRequestId: request.id,
        }
      : online
        ? {
            sourceType: "ONLINE_ORDER",
            sourceId: online.id,
            number: online.orderNumber,
            invoiceId: invoice?.id,
            invoiceNumber: invoice?.invoiceNumber,
          }
        : order
          ? {
              sourceType: "WORK_ORDER",
              sourceId: order.id,
              number: order.orderNumber,
              workOrderId: order.id,
              invoiceId: invoice?.id,
              invoiceNumber: invoice?.invoiceNumber,
            }
          : invoice
            ? {
                sourceType: "INVOICE",
                sourceId: invoice.id,
                number: invoice.invoiceNumber,
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
              }
            : charge
              ? {
                  sourceType: "CHARGE",
                  sourceId: charge.id,
                  number: `CHG-${charge.id}`,
                }
              : {
                  sourceType: "CONSIGNMENT",
                  sourceId: cn!.id,
                  number: cn!.consignmentNumber,
                };
  const custodySource = execution
    ? ({ type: "AFTERCARE_EXECUTION", id: execution.id } as const)
    : request
      ? ({ type: "FULFILLMENT_REQUEST", id: request.id } as const)
      : online
        ? ({ type: "ONLINE_ORDER", id: online.id } as const)
        : order
          ? ({ type: "WORK_ORDER", id: order.id } as const)
          : invoice
            ? ({ type: "INVOICE", id: invoice.id } as const)
            : null;
  const custodyRows = await tx
    .select({
      baseQuantity: deliveryCustodyItems.baseQuantity,
      preparedHeld: deliveryCustodyItems.preparedHeldBaseQuantity,
      carrierCustody: deliveryCustodyItems.carrierCustodyBaseQuantity,
      customerDelivered: deliveryCustodyItems.customerDeliveredBaseQuantity,
      returnedPendingInspection:
        deliveryCustodyItems.returnedPendingInspectionBaseQuantity,
      customerOwnedHeld: deliveryCustodyItems.customerOwnedHeldBaseQuantity,
      reworkWip: deliveryCustodyItems.reworkWipBaseQuantity,
      restockedClosed: deliveryCustodyItems.restockedClosedBaseQuantity,
      damagedClosed: deliveryCustodyItems.damagedClosedBaseQuantity,
      reviewStatus: deliveryCustodyItems.reviewStatus,
    })
    .from(deliveryCustodyItems)
    .where(
      members.length
        ? inArray(
            deliveryCustodyItems.consignmentId,
            members.map((member) => member.id),
          )
        : custodySource
          ? and(
              eq(deliveryCustodyItems.branchId, branchId),
              eq(deliveryCustodyItems.sourceType, custodySource.type),
              eq(deliveryCustodyItems.sourceId, custodySource.id),
            )
          : sql`FALSE`,
    );
  const custodyTotals = custodyRows.reduce(
    (sum, row) => ({
      base: sum.base + row.baseQuantity,
      prepared: sum.prepared + row.preparedHeld,
      carrier: sum.carrier + row.carrierCustody,
      delivered: sum.delivered + row.customerDelivered,
      returned: sum.returned + row.returnedPendingInspection,
      customerOwned: sum.customerOwned + row.customerOwnedHeld,
      rework: sum.rework + row.reworkWip,
      restocked: sum.restocked + row.restockedClosed,
      damaged: sum.damaged + row.damagedClosed,
    }),
    {
      base: 0,
      prepared: 0,
      carrier: 0,
      delivered: 0,
      returned: 0,
      customerOwned: 0,
      rework: 0,
      restocked: 0,
      damaged: 0,
    },
  );
  const allCustodyStates: [string, number][] = [
    ["PREPARED_HELD", custodyTotals.prepared],
    ["CARRIER_CUSTODY", custodyTotals.carrier],
    ["CUSTOMER_DELIVERED", custodyTotals.delivered],
    ["RETURNED_PENDING_INSPECTION", custodyTotals.returned],
    ["CUSTOMER_OWNED_HELD", custodyTotals.customerOwned],
    ["REWORK_WIP", custodyTotals.rework],
    ["RESTOCKED_CLOSED", custodyTotals.restocked],
    ["DAMAGED_CLOSED", custodyTotals.damaged],
  ];
  const custodyStates = allCustodyStates.filter(
    ([, baseQuantity]) => baseQuantity > 0,
  );
  const parcelStatuses = new Set(members.map((member) => member.parcelStatus));
  const parcelStatus =
    parcelStatuses.size === 0
      ? null
      : parcelStatuses.size === 1
        ? Array.from(parcelStatuses)[0]!
        : "MIXED";
  const collectedByCustomer = members.reduce(
    (sum, member) =>
      sum.plus(member.collectedAmount).plus(member.counterSettledAmount),
    money(0),
  );
  const remittanceIds = Array.from(
    new Set(
      members.flatMap((member) =>
        member.remittanceId == null ? [] : [member.remittanceId],
      ),
    ),
  );
  const remittanceId = remittanceIds.length === 1 ? remittanceIds[0]! : null;
  const snapshotSources: SQL[] = [];
  if (invoice)
    snapshotSources.push(
      and(
        eq(deliveryDocumentSnapshots.sourceType, "INVOICE"),
        eq(deliveryDocumentSnapshots.sourceId, invoice.id),
      )!,
    );
  const shipmentSourceId =
    group?.leaderConsignmentId ?? members[0]?.id ?? cn?.id;
  if (shipmentSourceId != null)
    snapshotSources.push(
      and(
        inArray(deliveryDocumentSnapshots.sourceType, [
          "CONSIGNMENT",
          "SHIPMENT",
          "RETURN_RECEIPT",
        ]),
        eq(deliveryDocumentSnapshots.sourceId, shipmentSourceId),
      )!,
    );
  if (remittanceId != null)
    snapshotSources.push(
      and(
        eq(deliveryDocumentSnapshots.sourceType, "REMITTANCE"),
        eq(deliveryDocumentSnapshots.sourceId, remittanceId),
      )!,
    );
  if (execution)
    snapshotSources.push(
      and(
        eq(deliveryDocumentSnapshots.sourceType, "AFTERCARE_EXECUTION"),
        eq(deliveryDocumentSnapshots.sourceId, execution.id),
      )!,
    );
  const documentSnapshots = snapshotSources.length
    ? await tx
        .select({
          id: deliveryDocumentSnapshots.id,
          documentType: deliveryDocumentSnapshots.documentType,
        })
        .from(deliveryDocumentSnapshots)
        .where(
          and(
            eq(deliveryDocumentSnapshots.branchId, branchId),
            ne(deliveryDocumentSnapshots.documentType, "INVOICE"),
            or(...snapshotSources),
          ),
        )
        .orderBy(desc(deliveryDocumentSnapshots.id))
    : [];
  const snapshotByDocument = new Map<
    (typeof documentSnapshots)[number]["documentType"],
    number
  >();
  for (const snapshot of documentSnapshots)
    if (!snapshotByDocument.has(snapshot.documentType))
      snapshotByDocument.set(snapshot.documentType, snapshot.id);
  const courierCustody = money(moneyView.cashInCourierCustody);
  const feeSettledCount = members.filter(
    (member) => member.feeSettledAt != null,
  ).length;
  const legacyInventoryState = !cn
    ? "NOT_ASSIGNED"
    : physicallyReceived && pendingCommercial
      ? "RETURNED_PENDING_COMMERCIAL_DECISION"
      : physicallyReceived
        ? "RETURNED_RECEIVED"
        : parcelStatus === "DELIVERED"
          ? "CUSTOMER_DELIVERED"
          : "CARRIER_CUSTODY";
  const inventoryState =
    custodyStates.length === 0
      ? legacyInventoryState
      : custodyStates.length === 1
        ? custodyStates[0]![0]
        : "MIXED";
  const inventoryReviewRequired =
    custodyRows.some((row) => row.reviewStatus === "REVIEW_REQUIRED") ||
    (cn != null && custodyRows.length === 0) ||
    (custodyRows.length === 0 &&
      physicallyReceived &&
      (pendingCommercial || pendingSourceClosure));
  const openCustodyBaseQuantity =
    custodyTotals.prepared +
    custodyTotals.carrier +
    custodyTotals.returned +
    custodyTotals.customerOwned +
    custodyTotals.rework;
  const remittanceStatus = !cn
    ? "NOT_APPLICABLE"
    : courierCustody.gt(0)
      ? "COURIER_CUSTODY_OPEN"
      : remittanceId != null
        ? "REMITTED"
        : "NO_RECORDED_CUSTODY";
  const settlementStatus = pendingRefundReceiptIds.length
    ? "REFUND_PENDING"
    : courierCustody.gt(0)
      ? "COURIER_CUSTODY_OPEN"
      : money(moneyView.deliveryFee).gt(0) && feeSettledCount < members.length
        ? "DELIVERY_FEE_OPEN"
        : cn
          ? "SETTLED_OR_NOT_APPLICABLE"
          : "NOT_STARTED";
  const actionRoles: Record<WorkflowAction, string> = {
    dispatch: "موظف إسناد مخوّل",
    collect: "موظف تحصيل مخوّل",
    cancelAssignment: "موظف إسناد مخوّل",
    reassign: "موظف إسناد مخوّل",
    declareReturn: "موظف متابعة توصيل مخوّل",
    return: "موظف استلام مرتجعات مخوّل",
    edit: "موظف تصحيح مبيعات مخوّل",
    aftercare: "موظف معالجة مخوّل",
  };
  const actionNextSteps: Record<WorkflowAction, string> = {
    dispatch: "راجع الجهة والمستلم ثم أكّد الإسناد مرة واحدة",
    collect: "أثبت التسليم ومبلغ تحصيل العميل الفعلي ثم أكّد",
    cancelAssignment:
      "تحقق أن كامل الشحنة عادت إلى عهدة المكتبة ولا توجد عهدة نقدية ثم أكّد تحرير الطلب لإعادة الإسناد",
    reassign: "اختر جهة التوصيل الجديدة ثم أكّد إعادة الإسناد",
    declareReturn: "سجّل سبب طلب الرجوع وانتظر الاستلام المادي",
    return:
      "حدّد الطرود المستلمة فعلياً وأثبت الفحص؛ لا تنفذ مرتجع بيع أو استرداد تلقائياً",
    edit: "افتح التصحيح المحكوم مع النسخة الحالية للمستند",
    aftercare: "افتح قضية نقص أو تعويض مرتبطة بأصل البيع",
  };
  const allowedActions: WorkflowScanPreview["allowedActions"] = actions.map(
    (action) => ({
      ...action,
      ...(action.action === "cancelAssignment"
        ? { requiresPhysicalHeldConfirmation: true }
        : {}),
      requiredRole: actionRoles[action.action],
      nextStep: action.allowed
        ? actionNextSteps[action.action]
        : (action.reason ?? "راجع المسؤول المخوّل وحالة المستند الحالية"),
    }),
  );
  const none = (description: string) => ({
    direction: "NONE" as const,
    description,
  });
  const conditional = (description: string, amount?: string) => ({
    direction: "CONDITIONAL" as const,
    ...(amount == null ? {} : { amount }),
    description,
  });
  const effectPreview: WorkflowScanPreview["effectPreview"] = {
    sale: none("المسح قراءة فقط ولا ينشئ بيعاً"),
    inventory: none("المسح قراءة فقط ولا يخصم أو يعيد مخزوناً"),
    accountsReceivable: none("المسح قراءة فقط ولا يغيّر ذمة العميل"),
    courierCustody: none("المسح قراءة فقط ولا يغيّر عهدة جهة التوصيل"),
    drawerCash: none("المسح لا يحرّك نقد الدرج"),
    bankCash: none("المسح لا يحرّك رصيد البنك"),
    deliveryFee: none("المسح لا يستحق ولا يدفع أجرة توصيل"),
    refund: none("المسح لا ينشئ استرداداً"),
  };
  const selectedActionAllowed =
    actions.find((action) => action.action === selectedStation)?.allowed ===
    true;
  if (selectedStation === "dispatch" && selectedActionAllowed) {
    if (online && !invoice) {
      effectPreview.sale = {
        direction: "INCREASE",
        amount: workflowMoney(total),
        description: "عند التأكيد فقط يُنشأ بيع طلب المتجر مرة واحدة",
      };
      effectPreview.inventory = {
        direction: "DECREASE",
        description: "عند التأكيد فقط يُصرف مخزون طلب المتجر مرة واحدة",
      };
    } else if (order && !invoice) {
      effectPreview.sale = {
        direction: "INCREASE",
        amount: workflowMoney(total),
        description: "عند التأكيد فقط تُنشأ فاتورة أمر الشغل مرة واحدة",
      };
      effectPreview.inventory = {
        direction: "TRANSFER",
        description:
          "عند التأكيد فقط تنتقل تكلفة أمر الشغل من تحت التنفيذ إلى تكلفة المبيعات؛ لا خصم مخزون ثانٍ",
      };
    } else if (
      request &&
      requestItems.some(
        (item) => item.invoiceId == null && item.materializedInvoiceId == null,
      )
    ) {
      effectPreview.sale = conditional(
        "عند التأكيد تُنشأ الآثار الأصلية مرة واحدة للمصادر غير المفوترة داخل الطلب الجامع",
      );
      effectPreview.inventory = conditional(
        "كل مصدر غير مفوتر ينفذ صرفه الأصلي مرة واحدة؛ المصادر المفوترة تنتقل عهدتها فقط",
      );
    } else {
      effectPreview.inventory = {
        direction: "TRANSFER",
        description:
          "عند التأكيد تنتقل العهدة إلى جهة التوصيل بلا خصم مخزون أو بيع جديد",
      };
    }
    effectPreview.deliveryFee = money(moneyView.deliveryFee).isZero()
      ? none("لا توجد أجرة توصيل")
      : moneyView.feeCollection === "SHOP"
        ? conditional(
            "الأجرة على المكتبة وتصبح مصروفاً أو التزاماً عند استحقاقها الفعلي",
            moneyView.deliveryFee,
          )
        : moneyView.feeCollection === "COUNTER"
          ? conditional(
              "الأجرة المقبوضة بالكاونتر تبقى أمانة حتى تسويتها مع جهة التوصيل",
              moneyView.deliveryFee,
            )
          : none("جهة التوصيل تقبض الأجرة مباشرة خارج درج المكتبة");
  }
  if (selectedStation === "collect" && selectedActionAllowed) {
    effectPreview.accountsReceivable = {
      direction: "DECREASE",
      amount: moneyView.codAmount,
      description:
        "عند التأكيد تنخفض مطالبة العميل مرة واحدة بالمبلغ المحصل والعجز المثبت",
    };
    effectPreview.courierCustody = {
      direction: "CONDITIONAL",
      description:
        "عند التأكيد فقط تزداد العهدة النقدية بالمحصّل الفعلي؛ ويثبت أي عجز بذمة مستقلة على جهة التوصيل بسبب معتمد",
    };
    effectPreview.drawerCash = none(
      "تحصيل العميل مع جهة التوصيل لا يعني توريد النقد إلى الدرج",
    );
    effectPreview.bankCash = none(
      "تحصيل العميل لا يثبت تحويلاً بنكياً؛ التوريد أمر مستقل بإثباته",
    );
  }
  if (selectedStation === "cancelAssignment" && selectedActionAllowed) {
    effectPreview.inventory = none(
      "إلغاء الإسناد بعد عودة كامل الشحنة يفك عهدة الجهة فقط ولا يعيد مخزوناً مصروفاً ولا يعكس البيع",
    );
  }
  if (selectedStation === "return" && selectedActionAllowed) {
    effectPreview.inventory = none(
      "استلام المرتجع يثبت العهدة والفحص فقط؛ الإتاحة تحتاج قراراً منفصلاً وتكلفة الصرف الأصلية",
    );
    effectPreview.accountsReceivable = none(
      "استلام الطرد لا ينفذ مرتجع بيع ولا يخفض ذمة العميل تلقائياً",
    );
    effectPreview.refund = conditional(
      "إن تقرر مرتجع البيع، ينفذ الاسترداد لاحقاً بمستنده وعلى السكة الأصلية",
    );
  }
  if (selectedStation === "edit" && selectedActionAllowed) {
    effectPreview.sale = conditional(
      "التصحيح المحكوم قد يستبدل القيم التجارية مع حفظ الأصل ومنع التكرار",
    );
    effectPreview.inventory = conditional(
      "فروق الكميات وحدها تتحرك عند اعتماد التصحيح، لا عند المسح",
    );
    effectPreview.accountsReceivable = conditional(
      "ذمة العميل تتبع فرق التصحيح المعتمد فقط",
    );
    effectPreview.refund = conditional(
      "أي مبلغ واجب الرد ينفذ بمستند استرداد مستقل",
    );
  }
  if (selectedStation === "aftercare" && selectedActionAllowed) {
    effectPreview.inventory = conditional(
      "لا صرف عند فتح القضية؛ البديل أو خامات الإعادة تصرف مرة واحدة بعد اعتماد خطة المواد وتجهيزها",
    );
    effectPreview.deliveryFee = conditional(
      "أجرة إرسال المعالجة على المكتبة عند الإسناد الفعلي",
      moneyView.deliveryFee,
    );
  }
  const dispatchCreatesSnapshot =
    selectedStation === "dispatch" && selectedActionAllowed;
  const snapshotDocument = (
    type: WorkflowScanPreview["availableDocuments"][number]["type"],
    canCreateOnSelectedAction: boolean,
    reason: string,
  ): WorkflowScanPreview["availableDocuments"][number] => {
    const snapshotId = snapshotByDocument.get(type);
    if (snapshotId != null)
      return {
        type,
        action: "REPRINT",
        snapshotId,
        allowed: true,
      };
    if (canCreateOnSelectedAction)
      return {
        type,
        action: "PRINT",
        allowed: true,
      };
    return {
      type,
      action: "REPRINT",
      allowed: false,
      reason,
    };
  };
  const availableDocuments: WorkflowScanPreview["availableDocuments"] = [
    {
      type: "INVOICE",
      action: "PRINT",
      allowed: false,
      reason: invoice
        ? "اطبع النسخة الحالية من مسار الفاتورة وصلاحية الطباعة المستقلة"
        : "لا توجد فاتورة مرتبطة بهذا المصدر",
    },
    snapshotDocument(
      "SHIPPING_LABEL",
      dispatchCreatesSnapshot,
      cn
        ? "لقطة ملصق الشحن مفقودة؛ راجع سجل عملية الإسناد ولا تطبع من القيم الحية"
        : "يصبح ملصق الشحن متاحاً ضمن تأكيد الإسناد",
    ),
    snapshotDocument(
      "DISPATCH_SLIP",
      dispatchCreatesSnapshot,
      cn
        ? "لقطة بوليصة الإسناد مفقودة؛ راجع سجل العملية"
        : "تصدر بوليصة الإسناد ضمن التأكيد",
    ),
    snapshotDocument(
      "DELIVERY_MANIFEST",
      dispatchCreatesSnapshot,
      cn
        ? "لقطة محضر التسليم مفقودة؛ راجع سجل العملية"
        : "يتطلب محضر التسليم تأكيد الإسناد",
    ),
    snapshotDocument(
      "REMITTANCE_RECEIPT",
      false,
      remittanceId == null
        ? "لا يوجد توريد جهة مثبت لهذه الشحنة"
        : "لقطة إيصال التوريد مفقودة؛ لا تعِد طباعته من القيم الحية",
    ),
    snapshotDocument(
      "PARTY_SETTLEMENT",
      false,
      remittanceId == null
        ? "لا توجد تسوية جهة مرتبطة قابلة للطباعة"
        : "لقطة تسوية الجهة مفقودة؛ راجع سجل التسوية",
    ),
    snapshotDocument(
      "PHYSICAL_RETURN_RECEIPT",
      false,
      physicallyReceived
        ? "لقطة محضر الاستلام المادي مفقودة؛ لا تطبع من الحالة الحية"
        : "يصدر المحضر بعد استلام الطرد وفحصه فعلياً",
    ),
    snapshotDocument(
      "AFTERCARE_WAYBILL",
      execution != null && dispatchCreatesSnapshot,
      execution && cn
        ? "لقطة بوليصة المعالجة مفقودة؛ راجع سجل الإسناد"
        : "تتاح بوليصة المعالجة ضمن إسناد دفعة المعالجة",
    ),
  ];
  const summaries: WorkflowScanPreview["summaries"] = {
    commercial: {
      documentNumber: number,
      status,
      customerId,
      currentTotal: moneyView.currentTotal,
    },
    parcel: {
      shipmentNumber:
        members[0]?.consignmentNumber ?? cn?.consignmentNumber ?? null,
      consignmentCount: members.length,
      parcelStatus,
      dispatchedAt:
        members[0]?.dispatchedAt?.toISOString() ??
        cn?.dispatchedAt?.toISOString() ??
        null,
      physicallyReturned: physicallyReceived,
    },
    inventory: {
      custodyTracked: custodyRows.length > 0,
      reviewRequired: inventoryReviewRequired,
      state: inventoryState,
      baseQuantity: custodyRows.length ? custodyTotals.base : null,
      openBaseQuantity: custodyRows.length ? openCustodyBaseQuantity : null,
    },
    collection: {
      customerDue: moneyView.codAmount,
      customerCollected: workflowMoney(collectedByCustomer),
      cashInCourierCustody: moneyView.cashInCourierCustody,
    },
    remittance: {
      status: remittanceStatus,
      courierCustodyDue: moneyView.cashInCourierCustody,
      remittanceId,
    },
    settlement: {
      status: settlementStatus,
      deliveryFee: moneyView.deliveryFee,
      feeCollection: moneyView.feeCollection,
      pendingRefundCount: pendingRefundReceiptIds.length,
    },
  };
  return {
    source: {
      ...ref,
      number,
      branchId,
      canonicalKey,
      version: idempotencyHash({
        onlineOrderSnapshot: online ? await onlineOrderDispatchSnapshotTx(tx, online, lock ? "nowait" : false) : undefined,
        source: {
          kind: ref.kind,
          id: ref.id,
          number,
          branchId,
          status: sourceRow!.status,
          version: "version" in sourceRow! ? sourceRow!.version : undefined,
        },
        invoice: invoice
          ? {
              id: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              status: invoice.status,
              total: invoice.total,
              returnedTotal: invoice.returnedTotal,
              paidAmount: invoice.paidAmount,
              paymentMode: invoice.paymentMode,
              correctedByInvoiceId: invoice.correctedByInvoiceId,
              customerId: invoice.customerId,
              contactName: invoice.contactName,
              contactPhone: invoice.contactPhone,
            }
          : undefined,
        relations,
        activeLinkedCase,
        money: moneyView,
        members,
        requestItems,
        recipient: {
          customerId,
          name: customer?.name,
          phone: customer?.phone,
          address: customer?.address,
        },
      }),
    },
    status,
    printSource,
    relations,
    recipient: {
      customerId,
      name:
        execution?.recipientName ??
        request?.recipientName ??
        cn?.recipientName ??
        customer?.name ??
        invoice?.contactName ??
        order?.contactName ??
        null,
      phone:
        canonicalIraqiMobile(
          execution?.recipientPhone ??
            request?.recipientPhone ??
            cn?.recipientPhone ??
            order?.deliveryPhone ??
            customer?.phone ??
            invoice?.contactPhone ??
            order?.contactPhone,
        ) ?? null,
      address:
        execution?.deliveryAddress ??
        request?.deliveryAddress ??
        cn?.deliveryAddress ??
        online?.shippingAddress ??
        order?.deliveryAddress ??
        customer?.address ??
        null,
    },
    money: moneyView,
    actions,
    summaries,
    allowedActions,
    effectPreview,
    availableDocuments,
    returnState,
    group,
  };
}

export async function previewWorkflowScan(
  input: { raw: string; station: WorkflowStation; branchId?: number },
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      const branchId =
        input.branchId ??
        (auth.current.role === "admin" || auth.current.isOwner
          ? undefined
          : auth.actor.branchId);
      const ref = await resolveWorkflowSourceTx(tx, input.raw, branchId);
      return loadWorkflowPreviewTx(
        tx,
        ref,
        auth.current,
        branchId,
        false,
        input.station,
      );
    },
    { gate: "NONE" },
  );
}

export async function previewWorkflowSource(
  input: { source: SourceRef; station: WorkflowStation; branchId?: number },
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      const auth = await currentWorkflowActorTx(tx, actor, input.branchId);
      return loadWorkflowPreviewTx(
        tx,
        input.source,
        auth.current,
        input.branchId,
        false,
        input.station,
      );
    },
    { gate: "NONE" },
  );
}

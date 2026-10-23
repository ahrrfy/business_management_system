import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
  notExists,
  not,
} from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  customers,
  deliveryConsignments,
  deliveryShipmentMembers,
  invoices,
  workOrders,
} from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentRequestItems,
  fulfillmentRequests,
} from "../../../drizzle/fulfillmentSchema";
import { DEAD_INVOICE_STATUSES } from "../../../shared/invoiceStatus";
import type { FulfillmentRequestStatus } from "../../../shared/fulfillment";
import { requireDb, withTx, type Actor } from "../tx";
import { money, round2, toDbMoney } from "../money";
import { assertFulfillmentBranch, loadFulfillmentRequestTx } from "./core";
import { deliverySearchSql } from "../delivery/readSearch";

export async function listFulfillmentRequests(
  input: {
    branchId?: number;
    status?: FulfillmentRequestStatus;
    search?: string;
    limit?: number;
    offset?: number;
  },
  actor: Actor,
) {
  const branchId = input.branchId ?? actor.branchId;
  assertFulfillmentBranch(actor, branchId);
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const offset = Math.max(0, input.offset ?? 0);
  const term = input.search?.trim();
  const where = and(
    eq(fulfillmentRequests.branchId, branchId),
    input.status ? eq(fulfillmentRequests.status, input.status) : undefined,
    term
      ? deliverySearchSql(term, {
          names: [fulfillmentRequests.recipientName],
          phones: [fulfillmentRequests.recipientPhone],
          references: [fulfillmentRequests.requestNumber],
        }).where
      : undefined,
  );
  const db = requireDb();
  const [rows, count] = await Promise.all([
    db
      .select()
      .from(fulfillmentRequests)
      .where(where)
      .orderBy(desc(fulfillmentRequests.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(fulfillmentRequests)
      .where(where),
  ]);
  return { rows, total: Number(count[0]?.count ?? 0), limit, offset };
}

/** Bounded grouped reads keep current amounts separate from physical readiness. */
export async function getFulfillmentRequest(id: number, actor: Actor) {
  return withTx(
    async (tx) => {
      const request = await loadFulfillmentRequestTx(tx, id, actor);
      const rawItems = await tx
        .select()
        .from(fulfillmentRequestItems)
        .where(eq(fulfillmentRequestItems.requestId, id));
      const invoiceIds = rawItems.flatMap((r) =>
        (r.invoiceId ?? r.materializedInvoiceId)
          ? [r.invoiceId ?? r.materializedInvoiceId!]
          : [],
      );
      const orderIds = rawItems.flatMap((r) =>
        r.workOrderId != null ? [r.workOrderId] : [],
      );
      const invoiceRows = invoiceIds.length
        ? await tx
            .select()
            .from(invoices)
            .where(inArray(invoices.id, invoiceIds))
        : [];
      const orderRows =
        orderIds.length || invoiceIds.length
          ? await tx
              .select()
              .from(workOrders)
              .where(
                or(
                  orderIds.length
                    ? inArray(workOrders.id, orderIds)
                    : undefined,
                  invoiceIds.length
                    ? inArray(workOrders.invoiceId, invoiceIds)
                    : undefined,
                ),
              )
          : [];
      const charges = await tx
        .select()
        .from(fulfillmentCharges)
        .where(eq(fulfillmentCharges.requestId, id));
      const consignmentIds = Array.from(
        new Set(
          rawItems.flatMap((r) =>
            r.consignmentId != null ? [r.consignmentId] : [],
          ),
        ),
      );
      const leaders = await tx
        .select()
        .from(deliveryConsignments)
        .where(
          or(
            eq(deliveryConsignments.fulfillmentRequestId, request.id),
            consignmentIds.length
              ? inArray(deliveryConsignments.id, consignmentIds)
              : undefined,
          ),
        );
      const members = consignmentIds.length
        ? await tx
            .select({ consignment: deliveryConsignments })
            .from(deliveryShipmentMembers)
            .innerJoin(
              deliveryConsignments,
              eq(
                deliveryConsignments.id,
                deliveryShipmentMembers.consignmentId,
              ),
            )
            .where(
              inArray(
                deliveryShipmentMembers.leaderConsignmentId,
                consignmentIds,
              ),
            )
        : [];
      const consignments = Array.from(
        new Map(
          [...leaders, ...members.map((r) => r.consignment)].map((r) => [
            r.id,
            r,
          ]),
        ).values(),
      );
      const items = rawItems.map((item) => {
        const invoice = invoiceRows.find(
          (r) => r.id === (item.invoiceId ?? item.materializedInvoiceId),
        );
        const order = orderRows.find((r) => r.id === item.workOrderId);
        const linked = invoice
          ? orderRows.filter((r) => r.invoiceId === invoice.id)
          : order
            ? [order]
            : [];
        const ready =
          item.status === "RELEASED" ||
          linked.every((r) => r.status === "READY");
        const total = invoice
          ? money(invoice.total).minus(invoice.returnedTotal ?? "0")
          : money(order?.salePrice ?? "0");
        const paid = money(invoice?.paidAmount ?? order?.deposit ?? "0");
        const remaining = round2(total.minus(paid));
        return {
          ...item,
          number:
            invoice?.invoiceNumber ?? order?.orderNumber ?? String(item.id),
          title: order?.title ?? null,
          invoiceId: invoice?.id ?? null,
          originalInvoiceId: item.invoiceId,
          ready,
          sourceStatus: invoice?.status ?? order?.status ?? null,
          total: toDbMoney(total),
          paidAmount: toDbMoney(paid),
          remainingAmount: toDbMoney(remaining.lt(0) ? money(0) : remaining),
          paymentMode: invoice?.paymentMode ?? order?.paymentMode ?? null,
        };
      });
      const invoiceCodRemaining = items.reduce(
        (sum, r) =>
          sum.plus(r.paymentMode === "CREDIT" ? "0" : r.remainingAmount),
        money(0),
      );
      const invoiceRemaining = items.reduce(
        (sum, r) => sum.plus(r.remainingAmount),
        money(0),
      );
      const chargeRemaining = charges
        .filter((r) => r.status === "APPROVED")
        .reduce(
          (sum, r) => sum.plus(money(r.amount).minus(r.paidAmount)),
          money(0),
        );
      return {
        request,
        items,
        charges: charges.map((r) => ({
          ...r,
          remainingAmount:
            r.status === "APPROVED"
              ? toDbMoney(money(r.amount).minus(r.paidAmount))
              : "0.00",
        })),
        consignments,
        totals: {
          goods: toDbMoney(
            items.reduce((sum, r) => sum.plus(r.total), money(0)),
          ),
          invoiceRemaining: toDbMoney(invoiceRemaining),
          invoiceCodRemaining: toDbMoney(invoiceCodRemaining),
          chargeRemaining: toDbMoney(chargeRemaining),
          currentClaim: toDbMoney(invoiceRemaining.plus(chargeRemaining)),
          deliveryFee: request.deliveryFee,
        },
        remainingItems: items.filter(
          (r) => r.status !== "RELEASED" && r.status !== "CANCELLED",
        ),
        allReady: items
          .filter((r) => r.status !== "RELEASED" && r.status !== "CANCELLED")
          .every((r) => r.ready),
      };
    },
    { gate: "NONE" },
  );
}

export async function listFulfillmentRequestCandidates(
  input: {
    branchId?: number;
    customerId?: number | null;
    search?: string;
    invoiceId?: number;
    workOrderId?: number;
    limit?: number;
  },
  actor: Actor,
) {
  const branchId = input.branchId ?? actor.branchId;
  assertFulfillmentBranch(actor, branchId);
  const term = input.search?.trim();
  const limit = Math.min(100, input.limit ?? 50);
  const db = requireDb();
  const ownership = alias(fulfillmentRequestItems, "candidate_request_item");
  const delivery = alias(deliveryConsignments, "candidate_delivery");
  const activeInvoice = notExists(
    db
      .select({ id: ownership.id })
      .from(ownership)
      .where(eq(ownership.activeInvoiceId, invoices.id)),
  );
  const activeOrder = notExists(
    db
      .select({ id: ownership.id })
      .from(ownership)
      .where(eq(ownership.activeWorkOrderId, workOrders.id)),
  );
  const cancelledWithoutCustody = and(
    eq(delivery.status, "CANCELLED"),
    eq(delivery.parcelStatus, "CANCELLED"),
    eq(delivery.moneyStatus, "CANCELLED"),
    isNull(delivery.remittanceId),
    eq(delivery.collectedAmount, "0.00"),
  );
  const freeInvoice = notExists(
    db
      .select({ id: delivery.id })
      .from(delivery)
      .where(
        and(eq(delivery.invoiceId, invoices.id), not(cancelledWithoutCustody!)),
      ),
  );
  const freeOrder = notExists(
    db
      .select({ id: delivery.id })
      .from(delivery)
      .where(
        and(
          eq(delivery.workOrderId, workOrders.id),
          not(cancelledWithoutCustody!),
        ),
      ),
  );
  const invoiceRows = await db
    .select({
      invoice: invoices,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerAddress: customers.address,
    })
    .from(invoices)
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(invoices.branchId, branchId),
        notInArray(invoices.status, [...DEAD_INVOICE_STATUSES]),
        sql`${invoices.sourceType} <> 'ONLINE'`,
        activeInvoice,
        freeInvoice,
        input.customerId != null
          ? eq(invoices.customerId, input.customerId)
          : undefined,
        input.invoiceId != null ? eq(invoices.id, input.invoiceId) : undefined,
        term
          ? deliverySearchSql(term, {
              names: [customers.name, invoices.contactName],
              phones: [customers.phone, invoices.contactPhone],
              references: [invoices.invoiceNumber],
            }).where
          : undefined,
      ),
    )
    .orderBy(desc(invoices.id))
    .limit(limit);
  const orderRows = await db
    .select({
      order: workOrders,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(workOrders)
    .leftJoin(customers, eq(customers.id, workOrders.customerId))
    .where(
      and(
        eq(workOrders.branchId, branchId),
        isNull(workOrders.invoiceId),
        notInArray(workOrders.status, ["CANCELLED", "DELIVERED"]),
        activeOrder,
        freeOrder,
        input.customerId != null
          ? eq(workOrders.customerId, input.customerId)
          : undefined,
        input.workOrderId != null
          ? eq(workOrders.id, input.workOrderId)
          : undefined,
        term
          ? deliverySearchSql(term, {
              names: [customers.name, workOrders.contactName, workOrders.title],
              phones: [
                customers.phone,
                workOrders.contactPhone,
                workOrders.deliveryPhone,
              ],
              references: [workOrders.orderNumber],
            }).where
          : undefined,
      ),
    )
    .orderBy(desc(workOrders.id))
    .limit(limit);
  const linked = invoiceRows.length
    ? await db
        .select({ invoiceId: workOrders.invoiceId, status: workOrders.status })
        .from(workOrders)
        .where(
          inArray(
            workOrders.invoiceId,
            invoiceRows.map((r) => r.invoice.id),
          ),
        )
    : [];
  return [
    ...invoiceRows.map(
      ({ invoice: r, customerName, customerPhone, customerAddress }) => ({
        key: `I:${r.id}`,
        invoiceId: r.id as number | null,
        workOrderId: null as number | null,
        number: r.invoiceNumber,
        title: null as string | null,
        customerId: r.customerId,
        customerName: customerName ?? r.contactName,
        recipientPhone: customerPhone ?? r.contactPhone,
        deliveryAddress: customerAddress,
        ready: linked
          .filter((o) => o.invoiceId === r.id)
          .every((o) => o.status === "READY"),
        total: toDbMoney(money(r.total).minus(r.returnedTotal ?? "0")),
        paidAmount: r.paidAmount,
      }),
    ),
    ...orderRows.map(({ order: r, customerName, customerPhone }) => ({
      key: `W:${r.id}`,
      invoiceId: null as number | null,
      workOrderId: r.id as number | null,
      number: r.orderNumber,
      title: r.title,
      customerId: r.customerId,
      customerName: customerName ?? r.contactName,
      recipientPhone: r.deliveryPhone ?? customerPhone ?? r.contactPhone,
      deliveryAddress: r.deliveryAddress,
      ready: r.status === "READY",
      total: r.salePrice,
      paidAmount: r.deposit ?? "0.00",
    })),
  ];
}

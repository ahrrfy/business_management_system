import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  customers,
  suppliers,
  deliveryParties,
  deliveryConsignments,
  accountingEntries,
  users,
  receipts,
  shifts,
} from "../../../drizzle/schema";
import {
  fulfillmentCharges,
  fulfillmentChargePayments,
  fulfillmentRequests,
  fulfillmentRequestItems,
} from "../../../drizzle/fulfillmentSchema";
import type { FulfillmentChargeCategory } from "../../../shared/fulfillment";
import { requireDb, withTx, type Actor } from "../tx";
import { assertFulfillmentBranch, loadFulfillmentChargeTx } from "./core";
import { assertChargeOperationTx, chargeRemaining } from "./charges";
import {
  fulfillmentCostVisibleTx,
  projectFulfillmentChargeCost,
} from "./visibility";
import { money, toDbMoney } from "../money";

export type ListFulfillmentChargesInput = {
  branchId: number;
  search?: string;
  requestId?: number;
  customerId?: number;
  category?: FulfillmentChargeCategory;
  limit?: number;
  offset?: number;
};
export async function listFulfillmentCharges(
  input: ListFulfillmentChargesInput,
  actor: Actor,
) {
  assertFulfillmentBranch(actor, input.branchId);
  return withTx(
    async (tx) => {
      await assertChargeOperationTx(tx, actor, "list", false, true);
      const costVisible = await fulfillmentCostVisibleTx(tx, actor);
      const db = tx,
        pattern = `%${(input.search ?? "").replace(/[\\%_]/g, "\\$&")}%`;
      const where = and(
        eq(fulfillmentCharges.branchId, input.branchId),
        input.requestId
          ? eq(fulfillmentCharges.requestId, input.requestId)
          : undefined,
        input.customerId
          ? eq(fulfillmentCharges.customerId, input.customerId)
          : undefined,
        input.category
          ? eq(fulfillmentCharges.category, input.category)
          : undefined,
        input.search
          ? or(
              like(fulfillmentCharges.description, pattern),
              like(customers.name, pattern),
              like(customers.phone, pattern),
              sql`CAST(${fulfillmentCharges.id} AS CHAR) LIKE ${pattern}`,
            )
          : undefined,
      );
      const [rows, count] = await Promise.all([
        db
          .select({
            charge: fulfillmentCharges,
            customerName: customers.name,
            requestNumber: fulfillmentRequests.requestNumber,
          })
          .from(fulfillmentCharges)
          .leftJoin(customers, eq(customers.id, fulfillmentCharges.customerId))
          .leftJoin(
            fulfillmentRequests,
            eq(fulfillmentRequests.id, fulfillmentCharges.requestId),
          )
          .where(where)
          .orderBy(desc(fulfillmentCharges.id))
          .limit(Math.min(Math.max(input.limit ?? 25, 1), 100))
          .offset(Math.max(input.offset ?? 0, 0)),
        db
          .select({ total: sql<number>`COUNT(*)` })
          .from(fulfillmentCharges)
          .leftJoin(customers, eq(customers.id, fulfillmentCharges.customerId))
          .where(where),
      ]);
      return {
        rows: rows.map(({ charge, ...rest }) => ({
          ...projectFulfillmentChargeCost(charge, costVisible),
          ...rest,
          remainingAmount: chargeRemaining(charge),
          payeeRemaining: costVisible
            ? toDbMoney(
                money(charge.externalCost)
                  .minus(charge.payeePaidAmount)
                  .minus(
                    charge.category === "PASS_THROUGH"
                      ? charge.refundedAmount
                      : "0",
                  ),
              )
            : null,
        })),
        costVisible,
        total: Number(count[0]?.total ?? 0),
      };
    },
    { gate: "NONE" },
  );
}
export function getFulfillmentCharge(id: number, actor: Actor) {
  return withTx(
    async (tx) => {
      await assertChargeOperationTx(tx, actor, "get", false, true);
      const costVisible = await fulfillmentCostVisibleTx(tx, actor);
      const charge = await loadFulfillmentChargeTx(tx, id, actor);
      const payments = await tx
        .select({ payment: fulfillmentChargePayments, receipt: receipts })
        .from(fulfillmentChargePayments)
        .leftJoin(
          receipts,
          eq(receipts.id, fulfillmentChargePayments.receiptId),
        )
        .where(
          and(
            eq(fulfillmentChargePayments.chargeId, id),
            costVisible
              ? undefined
              : sql`${fulfillmentChargePayments.kind} <> 'PAYEE_PAYMENT'`,
          ),
        )
        .orderBy(desc(fulfillmentChargePayments.id));
      const request = charge.requestId
        ? (
            await tx
              .select()
              .from(fulfillmentRequests)
              .where(eq(fulfillmentRequests.id, charge.requestId))
              .limit(1)
          )[0]
        : null;
      const consignments = charge.requestId
        ? await tx
            .select({ id: fulfillmentRequestItems.consignmentId })
            .from(fulfillmentRequestItems)
            .where(
              and(
                eq(fulfillmentRequestItems.requestId, charge.requestId),
                sql`${fulfillmentRequestItems.consignmentId} IS NOT NULL`,
              ),
            )
        : [];
      const directConsignments = charge.requestId
        ? await tx
            .select({ id: deliveryConsignments.id })
            .from(deliveryConsignments)
            .where(
              eq(deliveryConsignments.fulfillmentRequestId, charge.requestId),
            )
        : [];
      const cnIds = Array.from(
        new Set(
          [...consignments, ...directConsignments]
            .map((c) => c.id)
            .filter((id): id is number => id != null),
        ),
      );
      const excessEntries = cnIds.length
        ? await tx
            .select({
              id: accountingEntries.id,
              amount: accountingEntries.amount,
              createdAt: accountingEntries.entryDate,
              notes: accountingEntries.notes,
              dedupeKey: accountingEntries.dedupeKey,
            })
            .from(accountingEntries)
            .where(
              and(
                eq(accountingEntries.customerId, charge.customerId!),
                eq(accountingEntries.branchId, charge.branchId),
                or(
                  ...cnIds.map((id) => {
                    const prefix = `FULFILLMENT_COURIER_EXCESS:${id}:`;
                    return sql`LEFT(${accountingEntries.dedupeKey},${prefix.length})=${prefix}`;
                  }),
                ),
              ),
            )
        : [];
      const excessRefunds = excessEntries.length
        ? await tx
            .select({
              reference: receipts.referenceNumber,
              amount: receipts.amount,
            })
            .from(receipts)
            .where(
              and(
                inArray(
                  receipts.referenceNumber,
                  excessEntries.map((e) => `FC-COURIER-EXCESS:${e.id}`),
                ),
                eq(receipts.direction, "OUT"),
                sql`${receipts.status} IN ('COMPLETED','REVERSED')`,
              ),
            )
        : [];
      const [customer] = charge.customerId
        ? await tx
            .select({
              id: customers.id,
              name: customers.name,
              phone: customers.phone,
            })
            .from(customers)
            .where(eq(customers.id, charge.customerId))
            .limit(1)
        : [];
      return {
        charge: projectFulfillmentChargeCost(charge, costVisible),
        costVisible,
        remainingAmount: chargeRemaining(charge),
        payeeRemaining: costVisible
          ? toDbMoney(
              money(charge.externalCost)
                .minus(charge.payeePaidAmount)
                .minus(
                  charge.category === "PASS_THROUGH"
                    ? charge.refundedAmount
                    : "0",
                ),
            )
          : null,
        payments: costVisible
          ? payments
          : payments.filter((p) => p.payment.kind !== "PAYEE_PAYMENT"),
        request: request ?? null,
        customer: customer ?? null,
        excessCollections: excessEntries.map((e) => ({
          ...e,
          consignmentId: Number(e.dedupeKey?.split(":")[1]),
          remainingAmount: toDbMoney(
            money(e.amount).minus(
              excessRefunds
                .filter((r) => r.reference === `FC-COURIER-EXCESS:${e.id}`)
                .reduce((s, r) => s.plus(money(r.amount)), money(0)),
            ),
          ),
        })),
        consignmentIds: Array.from(
          new Set(
            [...consignments, ...directConsignments]
              .map((c) => c.id)
              .filter((id): id is number => id != null),
          ),
        ),
      };
    },
    { gate: "NONE" },
  );
}
/** Bounded searchable selectors, shared by create and payment forms. */
export async function lookupFulfillmentChargeOptions(
  input: { branchId: number; search?: string },
  actor: Actor,
) {
  assertFulfillmentBranch(actor, input.branchId);
  const db = requireDb(),
    pattern = `%${(input.search ?? "").replace(/[\\%_]/g, "\\$&")}%`;
  const result = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
      })
      .from(customers)
      .where(
        input.search
          ? or(
              like(customers.name, pattern),
              like(customers.phone, pattern),
              sql`REPLACE(${customers.phone},'+964','0') LIKE ${pattern}`,
            )
          : undefined,
      )
      .limit(50),
    db
      .select({
        id: fulfillmentRequests.id,
        name: fulfillmentRequests.requestNumber,
        customerId: fulfillmentRequests.customerId,
        recipientName: fulfillmentRequests.recipientName,
      })
      .from(fulfillmentRequests)
      .where(
        and(
          eq(fulfillmentRequests.branchId, input.branchId),
          sql`${fulfillmentRequests.status} <> 'CANCELLED'`,
          input.search
            ? or(
                like(fulfillmentRequests.recipientName, pattern),
                like(fulfillmentRequests.recipientPhone, pattern),
                like(fulfillmentRequests.requestNumber, pattern),
              )
            : undefined,
        ),
      )
      .orderBy(desc(fulfillmentRequests.id))
      .limit(50),
    db
      .select({ id: suppliers.id, name: suppliers.name })
      .from(suppliers)
      .where(input.search ? like(suppliers.name, pattern) : undefined)
      .limit(50),
    db
      .select({ id: deliveryParties.id, name: deliveryParties.name })
      .from(deliveryParties)
      .where(
        and(
          eq(deliveryParties.isActive, true),
          or(
            eq(deliveryParties.branchId, input.branchId),
            sql`${deliveryParties.branchId} IS NULL`,
          ),
          input.search ? like(deliveryParties.name, pattern) : undefined,
        ),
      )
      .limit(50),
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(
          eq(users.branchId, input.branchId),
          eq(users.isActive, true),
          input.search ? like(users.name, pattern) : undefined,
        ),
      )
      .limit(50),
    db
      .select({ id: shifts.id, shiftType: shifts.shiftType })
      .from(shifts)
      .where(
        and(
          eq(shifts.branchId, input.branchId),
          eq(shifts.userId, actor.userId),
          eq(shifts.status, "OPEN"),
        ),
      )
      .limit(10),
  ]);
  return {
    customers: result[0],
    requests: result[1],
    suppliers: result[2],
    parties: result[3],
    users: result[4],
    shifts: result[5],
  };
}

/** Distinct claim reader for shipment/request integration. No invoice allocation or JOIN multiplication. */
export async function fulfillmentChargeClaimsForRequests(
  requestIds: number[],
  branchId: number,
) {
  if (!requestIds.length) return [];
  const rows = await requireDb()
    .select()
    .from(fulfillmentCharges)
    .where(
      and(
        eq(fulfillmentCharges.branchId, branchId),
        eq(fulfillmentCharges.status, "APPROVED"),
        inArray(fulfillmentCharges.requestId, requestIds),
      ),
    );
  return rows
    .filter((r) => money(chargeRemaining(r)).gt(0))
    .map((r) => ({
      kind: "FULFILLMENT_CHARGE" as const,
      chargeId: r.id,
      requestId: r.requestId,
      customerId: r.customerId,
      category: r.category,
      description: r.description,
      version: r.version,
      remainingAmount: chargeRemaining(r),
    }));
}

/** Courier-held customer excess, including requests with no charge document. */
export async function listFulfillmentCourierExcess(
  input: { branchId: number; search?: string; limit?: number; offset?: number },
  actor: Actor,
) {
  assertFulfillmentBranch(actor, input.branchId);
  return withTx(
    async (tx) => {
      await assertChargeOperationTx(
        tx,
        actor,
        "listCourierExcess",
        false,
        true,
      );
      const prefix = sql`CONCAT('FULFILLMENT_COURIER_EXCESS:',${deliveryConsignments.id},':')`;
      const sourceMatch = sql`LEFT(${accountingEntries.dedupeKey},LENGTH(${prefix}))=${prefix}`;
      const pattern = `%${(input.search ?? "").replace(/[\\%_]/g, "\\$&")}%`;
      const where = and(
        eq(deliveryConsignments.branchId, input.branchId),
        eq(fulfillmentRequests.branchId, input.branchId),
        eq(accountingEntries.branchId, input.branchId),
        eq(accountingEntries.entryType, "PAYMENT_IN"),
        sql`${accountingEntries.customerId} <=> ${fulfillmentRequests.customerId}`,
        sql`${accountingEntries.amount}>0`,
        input.search
          ? or(
              like(deliveryConsignments.consignmentNumber, pattern),
              like(fulfillmentRequests.requestNumber, pattern),
              like(customers.name, pattern),
              like(customers.phone, pattern),
              like(fulfillmentRequests.recipientName, pattern),
              like(fulfillmentRequests.recipientPhone, pattern),
              sql`REPLACE(${fulfillmentRequests.recipientPhone},'+964','0') LIKE ${pattern}`,
              sql`REPLACE(${customers.phone},'+964','0') LIKE ${pattern}`,
            )
          : undefined,
      );
      const base = () =>
        tx
          .select({
            originalExcessEntryId: accountingEntries.id,
            consignmentId: deliveryConsignments.id,
            consignmentNumber: deliveryConsignments.consignmentNumber,
            fulfillmentRequestId: fulfillmentRequests.id,
            requestNumber: fulfillmentRequests.requestNumber,
            requestVersion: fulfillmentRequests.version,
            customerId: fulfillmentRequests.customerId,
            customerName: sql<string>`COALESCE(${customers.name},${fulfillmentRequests.recipientName})`,
            customerPhone: sql<string>`COALESCE(${customers.phone},${fulfillmentRequests.recipientPhone})`,
            branchId: fulfillmentRequests.branchId,
            originalAmount: accountingEntries.amount,
            collectedAt: accountingEntries.entryDate,
            remainingAmount: sql<string>`${accountingEntries.amount} - COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.referenceNumber=CONCAT('FC-COURIER-EXCESS:',${accountingEntries.id}) AND r.direction='OUT' AND r.receiptStatus IN ('COMPLETED','REVERSED')),0)`,
          })
          .from(accountingEntries)
          .innerJoin(deliveryConsignments, sourceMatch)
          .innerJoin(
            fulfillmentRequests,
            eq(
              fulfillmentRequests.id,
              deliveryConsignments.fulfillmentRequestId,
            ),
          )
          .leftJoin(customers, eq(customers.id, fulfillmentRequests.customerId))
          .where(where);
      const rows = await base()
        .orderBy(desc(accountingEntries.id))
        .limit(Math.min(Math.max(input.limit ?? 25, 1), 100))
        .offset(Math.max(input.offset ?? 0, 0));
      const [count] = await tx
        .select({ total: sql<number>`COUNT(*)` })
        .from(accountingEntries)
        .innerJoin(deliveryConsignments, sourceMatch)
        .innerJoin(
          fulfillmentRequests,
          eq(fulfillmentRequests.id, deliveryConsignments.fulfillmentRequestId),
        )
        .leftJoin(customers, eq(customers.id, fulfillmentRequests.customerId))
        .where(where);
      return {
        rows: rows.map((r) => ({
          ...r,
          remainingAmount: toDbMoney(money(r.remainingAmount)),
        })),
        total: Number(count?.total ?? 0),
      };
    },
    { gate: "NONE" },
  );
}

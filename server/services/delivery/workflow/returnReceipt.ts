import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
} from "../../../../drizzle/schema";
import type { Tx } from "../../../db";
import { effectiveDeliveryLedgerEntrySql } from "../legacyLedger";
import { money } from "../../money";

export const PHYSICAL_RETURN_RECEIVED = "WORKFLOW_RETURN_RECEIVED";
type Consignment = typeof deliveryConsignments.$inferSelect;

/** Receipt evidence is bound to the actual source and dispatch claim, never just a CN number. */
export async function physicalReturnReceiptTx(tx: Tx, row: Consignment) {
  if (row.parcelStatus !== "RETURNED" || row.returnedAt == null) return null;
  const events = await tx
    .select()
    .from(deliveryEvents)
    .where(
      and(
        eq(deliveryEvents.consignmentId, row.id),
        eq(deliveryEvents.eventType, PHYSICAL_RETURN_RECEIVED),
      ),
    )
    .orderBy(desc(deliveryEvents.id))
    .limit(30);
  return (
    events.find((event) => {
      const value = event.payload as Record<string, unknown> | null;
      return (
        value?.version === 1 &&
        value.inspected === true &&
        value.branchId === row.branchId &&
        value.sourceType === row.sourceType &&
        value.sourceId === row.sourceId &&
        value.invoiceId === row.invoiceId &&
        value.workOrderId === row.workOrderId &&
        value.fulfillmentRequestId === row.fulfillmentRequestId &&
        value.claimVersion === row.codClaimVersion &&
        value.dispatchedAt === row.dispatchedAt.toISOString() &&
        typeof value.evidence === "string" &&
        value.evidence.trim().length >= 5
      );
    }) ?? null
  );
}

/** Cost-free read projection; the mutation rechecks the complete receipt event under source locks. */
export function physicalReturnReceiptExistsSql() {
  return sql<boolean>`(${deliveryConsignments.parcelStatus} = 'RETURNED' AND ${deliveryConsignments.returnedAt} IS NOT NULL AND EXISTS (
    SELECT 1 FROM deliveryEvents physical_receipt
    WHERE physical_receipt.consignmentId = ${deliveryConsignments.id}
      AND physical_receipt.eventType = ${PHYSICAL_RETURN_RECEIVED}
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.version')) = '1'
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.inspected')) = 'true'
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.branchId')) = CAST(${deliveryConsignments.branchId} AS CHAR)
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.sourceType')) = ${deliveryConsignments.sourceType}
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.sourceId')) = CAST(${deliveryConsignments.sourceId} AS CHAR)
      AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.invoiceId')), 'null') <=> CAST(${deliveryConsignments.invoiceId} AS CHAR)
      AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.workOrderId')), 'null') <=> CAST(${deliveryConsignments.workOrderId} AS CHAR)
      AND NULLIF(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.fulfillmentRequestId')), 'null') <=> CAST(${deliveryConsignments.fulfillmentRequestId} AS CHAR)
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) = CAST(${deliveryConsignments.codClaimVersion} AS CHAR)
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.dispatchedAt')) = DATE_FORMAT(${deliveryConsignments.dispatchedAt}, '%Y-%m-%dT%H:%i:%s.000Z')
  ))`;
}

export async function returnCarrierRightsTx(tx: Tx, consignmentIds: number[]) {
  if (!consignmentIds.length)
    return { cash: money(0), feeDue: money(0), feeHistory: money(0) };
  const [row] = await tx
    .select({
      cash: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='COD_COLLECTED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED','COD_RETURNED','COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
      feeDue: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET','FEE_REFUNDED') THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
      feeHistory: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_EARNED','FEE_PAID','FEE_OFFSET') THEN ABS(${deliveryLedgerEntries.amount}) ELSE 0 END),0)`,
    })
    .from(deliveryLedgerEntries)
    .where(
      and(
        inArray(deliveryLedgerEntries.consignmentId, consignmentIds),
        effectiveDeliveryLedgerEntrySql(),
      ),
    );
  return {
    cash: money(row?.cash ?? "0"),
    feeDue: money(row?.feeDue ?? "0"),
    feeHistory: money(row?.feeHistory ?? "0"),
  };
}

export async function heldCustomerParcelReissueTx(tx: Tx, row: Consignment) {
  const receipt = await physicalReturnReceiptTx(tx, row);
  if (
    !receipt ||
    row.status !== "DISPATCHED" ||
    row.returnDeclaredAt == null ||
    row.remittanceId != null ||
    row.custodyRecognizedAt != null ||
    (row.feeSettledAt != null && money(row.deliveryFee).gt(0)) ||
    !money(row.collectedAmount).isZero()
  )
    return false;
  const rights = await returnCarrierRightsTx(tx, [row.id]);
  // The existing one-invoice/one-CN model cannot move an old carrier's cash or
  // earned fee to a new attempt. Keep those original obligations until settled.
  return (
    rights.cash.isZero() && rights.feeDue.isZero() && rights.feeHistory.isZero()
  );
}

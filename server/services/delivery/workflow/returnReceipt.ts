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

/** Display-only evidence for the current attempt; never grants posting authority. */
export function partialReturnReceivedSql() {
  return sql<boolean>`EXISTS (SELECT 1 FROM deliveryEvents partial_receipt
    WHERE partial_receipt.consignmentId = ${deliveryConsignments.id}
      AND partial_receipt.eventType IN ('WORKFLOW_RETURN_RECEIVED','PARTIAL_DELIVERY_SCOPE_CORRECTED')
      AND JSON_UNQUOTE(JSON_EXTRACT(partial_receipt.payload, '$.invoiceId')) = ${deliveryConsignments.invoiceId}
      AND JSON_UNQUOTE(JSON_EXTRACT(partial_receipt.payload, '$.branchId')) = ${deliveryConsignments.branchId}
      AND JSON_UNQUOTE(JSON_EXTRACT(partial_receipt.payload, '$.dispatchedAt')) = DATE_FORMAT(${deliveryConsignments.dispatchedAt}, '%Y-%m-%dT%H:%i:%s.000Z'))`;
}
type Consignment = typeof deliveryConsignments.$inferSelect;

/** Receipt evidence is bound to the actual source and dispatch claim, never just a CN number. */
export async function physicalReturnReceiptTx(tx: Tx, row: Consignment, options: { currentRead?: boolean } = {}) {
  if (row.parcelStatus !== "RETURNED" || row.returnedAt == null) return null;
  const receiptQuery = tx
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
  const events = await (options.currentRead ? receiptQuery.for("share") : receiptQuery);
  const matching = events.filter((event) => {
      const value = event.payload as Record<string, unknown> | null;
      const safeId = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id);
      const safeNullableId = (id: unknown) => id === null || safeId(id);
      return (
        Number.isSafeInteger(event.id) && event.id > 0 &&
        value?.version === 1 &&
        value.inspected === true &&
        safeId(value.branchId) && safeId(value.sourceId) &&
        safeNullableId(value.invoiceId) && safeNullableId(value.workOrderId) && safeNullableId(value.fulfillmentRequestId) &&
        value.branchId === row.branchId &&
        value.sourceType === row.sourceType &&
        value.sourceId === row.sourceId &&
        value.invoiceId === row.invoiceId &&
        value.workOrderId === row.workOrderId &&
        value.fulfillmentRequestId === row.fulfillmentRequestId &&
        typeof value.claimVersion === "number" && Number.isSafeInteger(value.claimVersion) &&
        value.claimVersion > 0 && value.claimVersion <= row.codClaimVersion &&
        value.dispatchedAt === row.dispatchedAt.toISOString() &&
        typeof value.evidence === "string" &&
        value.evidence.trim().length >= 5
      );
    });
  const exact = matching.find((event) => (event.payload as Record<string, unknown>).claimVersion === row.codClaimVersion);
  if (exact || !matching.length) return exact ?? null;

  // A legitimate sale return or a later physical receipt can advance the claim
  // of a shipment whose leader has already been physically received. Only an
  // immutable change event linking this receipt may bridge the two versions.
  const changeQuery = tx.select().from(deliveryEvents).where(and(
    eq(deliveryEvents.consignmentId, row.id),
    eq(deliveryEvents.eventType, "COD_CLAIM_CHANGED"),
    sql`JSON_TYPE(JSON_EXTRACT(${deliveryEvents.payload}, '$.source')) = 'STRING'`,
    sql`BINARY JSON_UNQUOTE(JSON_EXTRACT(${deliveryEvents.payload}, '$.source')) IN (BINARY 'SALE_RETURN', BINARY 'PHYSICAL_RETURN')`,
    sql`JSON_TYPE(JSON_EXTRACT(${deliveryEvents.payload}, '$.claimVersion')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')`,
    sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${deliveryEvents.payload}, '$.claimVersion')) AS DOUBLE) = ${row.codClaimVersion}`,
    sql`JSON_TYPE(JSON_EXTRACT(${deliveryEvents.payload}, '$.physicalReturnReceiptEventId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')`,
    sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${deliveryEvents.payload}, '$.physicalReturnReceiptEventId')) AS DOUBLE) IN (${sql.join(matching.map((receipt) => sql`${Number(receipt.id)}`), sql`, `)})`,
    sql`${deliveryEvents.id} > CAST(JSON_UNQUOTE(JSON_EXTRACT(${deliveryEvents.payload}, '$.physicalReturnReceiptEventId')) AS UNSIGNED)`,
  )).orderBy(desc(deliveryEvents.id)).limit(1);
  const changes = await (options.currentRead ? changeQuery.for("share") : changeQuery);
  return matching.find((receipt) => changes.some((change) => {
    const payload = change.payload as Record<string, unknown> | null;
    return Number.isSafeInteger(change.id) && Number(change.id) > Number(receipt.id) &&
      (payload?.source === "SALE_RETURN" || payload?.source === "PHYSICAL_RETURN") &&
      payload.claimVersion === row.codClaimVersion && payload.physicalReturnReceiptEventId === Number(receipt.id);
  })) ?? null;
}

/** Cost-free read projection; the mutation rechecks the complete receipt event under source locks. */
export function physicalReturnReceiptExistsSql() {
  // Drizzle can omit the outer qualification in a single-table select; the
  // inner deliveryEvents.id would then shadow the consignment id.
  const consignmentId = sql.raw("`deliveryConsignments`.`id`");
  // JavaScript trim() uses the ECMAScript whitespace set and length counts
  // UTF-16 code units; reproduce both when testing receipt evidence in SQL.
  const whitespace = "\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
  const trimPattern = `^[${whitespace}]+|[${whitespace}]+$`;
  return sql<boolean>`(${deliveryConsignments.parcelStatus} = 'RETURNED' AND ${deliveryConsignments.returnedAt} IS NOT NULL AND EXISTS (
    SELECT 1 FROM deliveryEvents physical_receipt
    WHERE physical_receipt.consignmentId = ${consignmentId}
      AND physical_receipt.eventType = ${PHYSICAL_RETURN_RECEIVED}
      AND physical_receipt.id BETWEEN 1 AND 9007199254740991
      AND (SELECT COUNT(*) FROM deliveryEvents newer_receipt
        WHERE newer_receipt.consignmentId = physical_receipt.consignmentId
          AND newer_receipt.eventType = physical_receipt.eventType
          AND newer_receipt.id > physical_receipt.id) < 30
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.version')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.version')) AS DOUBLE) = 1
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.inspected')) = 'BOOLEAN'
      AND JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.inspected')) = 'true'
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.branchId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
      AND ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.branchId')) AS DOUBLE)) <= 9007199254740991
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.branchId')) AS DOUBLE) = ${deliveryConsignments.branchId}
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.sourceType')) = 'STRING'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.sourceType')) = BINARY ${deliveryConsignments.sourceType}
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.sourceId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
      AND ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.sourceId')) AS DOUBLE)) <= 9007199254740991
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.sourceId')) AS DOUBLE) = ${deliveryConsignments.sourceId}
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.invoiceId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL', 'NULL')
      AND (JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.invoiceId')) = 'NULL' OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.invoiceId')) AS DOUBLE)) <= 9007199254740991)
      AND CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.invoiceId')), 'null') AS DOUBLE) <=> CAST(${deliveryConsignments.invoiceId} AS DOUBLE)
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.workOrderId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL', 'NULL')
      AND (JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.workOrderId')) = 'NULL' OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.workOrderId')) AS DOUBLE)) <= 9007199254740991)
      AND CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.workOrderId')), 'null') AS DOUBLE) <=> CAST(${deliveryConsignments.workOrderId} AS DOUBLE)
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.fulfillmentRequestId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL', 'NULL')
      AND (JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.fulfillmentRequestId')) = 'NULL' OR ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.fulfillmentRequestId')) AS DOUBLE)) <= 9007199254740991)
      AND CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.fulfillmentRequestId')), 'null') AS DOUBLE) <=> CAST(${deliveryConsignments.fulfillmentRequestId} AS DOUBLE)
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) AS DOUBLE) > 0
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) AS DOUBLE) = FLOOR(CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) AS DOUBLE))
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) AS DOUBLE) <= 9007199254740991
      AND (CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) AS DOUBLE) = ${deliveryConsignments.codClaimVersion}
        OR (
          CAST(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.claimVersion')) AS DOUBLE) < ${deliveryConsignments.codClaimVersion}
          AND EXISTS (
            SELECT 1 FROM deliveryEvents receipt_claim_change
            WHERE receipt_claim_change.consignmentId = ${consignmentId}
              AND receipt_claim_change.id > physical_receipt.id
              AND receipt_claim_change.id <= 9007199254740991
              AND receipt_claim_change.eventType = 'COD_CLAIM_CHANGED'
              AND JSON_TYPE(JSON_EXTRACT(receipt_claim_change.payload, '$.source')) = 'STRING'
              AND BINARY JSON_UNQUOTE(JSON_EXTRACT(receipt_claim_change.payload, '$.source')) IN (BINARY 'SALE_RETURN', BINARY 'PHYSICAL_RETURN')
              AND JSON_TYPE(JSON_EXTRACT(receipt_claim_change.payload, '$.claimVersion')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
              AND CAST(JSON_UNQUOTE(JSON_EXTRACT(receipt_claim_change.payload, '$.claimVersion')) AS DOUBLE) = ${deliveryConsignments.codClaimVersion}
              AND JSON_TYPE(JSON_EXTRACT(receipt_claim_change.payload, '$.physicalReturnReceiptEventId')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
              AND CAST(JSON_UNQUOTE(JSON_EXTRACT(receipt_claim_change.payload, '$.physicalReturnReceiptEventId')) AS DOUBLE) = physical_receipt.id
          )
        ))
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.dispatchedAt')) = 'STRING'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.dispatchedAt')) = BINARY DATE_FORMAT(${deliveryConsignments.dispatchedAt}, '%Y-%m-%dT%H:%i:%s.000Z')
      AND JSON_TYPE(JSON_EXTRACT(physical_receipt.payload, '$.evidence')) = 'STRING'
      AND LENGTH(CONVERT(REGEXP_REPLACE(JSON_UNQUOTE(JSON_EXTRACT(physical_receipt.payload, '$.evidence')), ${trimPattern}, '') USING utf16)) >= 10
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

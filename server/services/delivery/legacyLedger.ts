import { sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import type { deliveryLedgerEntries } from "../../../drizzle/schema";
import { money } from "../money";

/** Validate current ledger rows; an exact older snapshot is evidence, not another event. */
export function verifiedConsignmentLedgerRows(
  cn: { id: number | string; partyId: number | string; branchId: number | string },
  rows: Array<typeof deliveryLedgerEntries.$inferSelect>,
  what: string,
): Array<typeof deliveryLedgerEntries.$inferSelect> {
  const invalidIdentity = rows.some((row) => Number(row.partyId) !== Number(cn.partyId) ||
    row.branchId == null || Number(row.branchId) !== Number(cn.branchId));
  const effective = rows.filter((row) => row.eventKey !== `BACKFILL:CN:${cn.id}:${row.entryType}` ||
    !rows.some((native) => !native.eventKey.startsWith("BACKFILL:") && native.entryType === row.entryType &&
      Number(native.partyId) === Number(row.partyId) && Number(native.branchId) === Number(row.branchId) &&
      money(native.amount).eq(money(row.amount)) && native.createdAt <= row.createdAt));
  const ambiguous = effective.some((row) => row.eventKey.startsWith("BACKFILL:") &&
    effective.some((native) => !native.eventKey.startsWith("BACKFILL:") && native.entryType === row.entryType));
  if (invalidIdentity || ambiguous || rows.some((row) => money(row.amount).lt(0))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what, why: "قيود الجهة أو الفرع أو القيود التاريخية غير متسقة أو ملتبسة",
      doThis: "راجع مستندات الشحنة قبل التسوية",
    }) });
  }
  return effective;
}

/**
 * A legacy snapshot is evidence, not a second occurrence of an already posted
 * native event. Suppress exact older counterparts, or a cumulative remittance
 * proven by its original lines at the snapshot cutoff. Partial collection
 * snapshots also require native collection covering the proven remittance.
 * Keep unknown partial snapshots, later native movements and unreviewed openings.
 * A reviewed opening is excluded only by its immutable, matching evidence row.
 * The alias is a trusted SQL table alias supplied only by server code.
 */
export function effectiveDeliveryLedgerEntrySql(
  alias = "deliveryLedgerEntries",
): SQL {
  const entry = sql.identifier(alias);
  return sql`NOT (
    ${entry}.consignmentId IS NULL
    AND ${entry}.entryType = 'COD_COLLECTED'
    AND ${entry}.eventKey = CONCAT('BACKFILL:PARTY:', ${entry}.partyId, ':CASH_CUSTODY')
    AND EXISTS (
      SELECT 1 FROM deliveryOpeningExclusions openingExclusion
      WHERE openingExclusion.ledgerEntryId = ${entry}.id
        AND openingExclusion.partyId = ${entry}.partyId
        AND openingExclusion.branchId <=> ${entry}.branchId
        AND openingExclusion.openingAmount = ${entry}.amount
    )
  ) AND NOT (
    ${entry}.eventKey = CONCAT('BACKFILL:CN:', ${entry}.consignmentId, ':', ${entry}.entryType)
    AND (EXISTS (
      SELECT 1 FROM deliveryLedgerEntries legacyNative
      WHERE legacyNative.consignmentId = ${entry}.consignmentId
        AND legacyNative.partyId = ${entry}.partyId
        AND legacyNative.branchId <=> ${entry}.branchId
        AND legacyNative.entryType = ${entry}.entryType
        AND legacyNative.amount = ${entry}.amount
        AND legacyNative.createdAt <= ${entry}.createdAt
        AND legacyNative.eventKey NOT LIKE 'BACKFILL:%'
        AND (
          ${entry}.entryType <> 'COD_REMITTED'
          OR (
            ${entry}.remittanceId IS NOT NULL
            AND legacyNative.remittanceId = ${entry}.remittanceId
            AND legacyNative.eventKey = CONCAT('CN:', ${entry}.consignmentId, ':REMIT:', ${entry}.remittanceId)
            AND EXISTS (
              SELECT 1 FROM deliveryRemittanceLines legacyLine
              JOIN deliveryRemittances legacyRemittance ON legacyRemittance.id = legacyLine.remittanceId
              WHERE legacyLine.consignmentId = ${entry}.consignmentId
                AND legacyLine.remittanceId = ${entry}.remittanceId
                AND legacyLine.legacySnapshot = FALSE
                AND legacyLine.grossApplied = legacyNative.amount
                AND legacyRemittance.partyId = ${entry}.partyId
                AND legacyRemittance.branchId <=> ${entry}.branchId
            )
          )
        )
    ) OR (
      ${entry}.entryType IN ('COD_COLLECTED', 'COD_REMITTED')
      AND ${entry}.remittanceId IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM deliveryLedgerEntries legacyRemitted
        WHERE legacyRemitted.consignmentId = ${entry}.consignmentId
          AND legacyRemitted.partyId = ${entry}.partyId
          AND legacyRemitted.branchId <=> ${entry}.branchId
          AND legacyRemitted.entryType = 'COD_REMITTED'
          AND legacyRemitted.createdAt <= ${entry}.createdAt
          AND legacyRemitted.eventKey = CONCAT('CN:', legacyRemitted.consignmentId, ':REMIT:', legacyRemitted.remittanceId)
          AND EXISTS (
            SELECT 1 FROM deliveryRemittanceLines legacyPart
            JOIN deliveryRemittances legacyHeader ON legacyHeader.id = legacyPart.remittanceId
            WHERE legacyPart.consignmentId = legacyRemitted.consignmentId
              AND legacyPart.remittanceId = legacyRemitted.remittanceId
              AND legacyPart.legacySnapshot = FALSE
              AND legacyPart.grossApplied = legacyRemitted.amount
              AND legacyHeader.partyId = ${entry}.partyId
              AND legacyHeader.branchId <=> ${entry}.branchId
          )
        GROUP BY legacyRemitted.consignmentId
        HAVING SUM(legacyRemitted.amount) = ${entry}.amount
          AND SUM(CASE WHEN legacyRemitted.remittanceId = ${entry}.remittanceId THEN 1 ELSE 0 END) > 0
      )
      AND (
        ${entry}.entryType = 'COD_REMITTED'
        OR (SELECT COALESCE(SUM(legacyCollected.amount), 0)
          FROM deliveryLedgerEntries legacyCollected
          WHERE legacyCollected.consignmentId = ${entry}.consignmentId
            AND legacyCollected.partyId = ${entry}.partyId
            AND legacyCollected.branchId <=> ${entry}.branchId
            AND legacyCollected.entryType = 'COD_COLLECTED'
            AND legacyCollected.createdAt <= ${entry}.createdAt
            AND (legacyCollected.eventKey = CONCAT('CN:', ${entry}.consignmentId, ':COD_COLLECTED')
              OR LOCATE(CONCAT('CN:', ${entry}.consignmentId, ':COD_COLLECTED_SUPP:'), legacyCollected.eventKey) = 1)
        ) >= ${entry}.amount
      )
    ))
  )`;
}

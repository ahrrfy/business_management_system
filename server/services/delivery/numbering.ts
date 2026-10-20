// ترقيم الإرسالية/دفعة الترحيل — ذرّي عبر documentCounters.
import { sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryRemittances,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDateStr } from "../money";
import { nextCounterValue } from "../numbering";

/** CN-{branchId}-{YYYYMMDD}-{seq} — ترقيم إرسالية ذرّي عبر عدّاد documentCounters. */
async function nextDeliveryNumber(
  tx: Tx,
  branchId: number,
  kind: "consignment" | "remittance",
): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `${kind === "consignment" ? "CN" : "DR"}-${branchId}-${ymd}-`;
  const counterKey = `${kind}_${branchId}_${ymd}`;
  const table =
    kind === "consignment" ? deliveryConsignments : deliveryRemittances;
  const column =
    kind === "consignment"
      ? deliveryConsignments.consignmentNumber
      : deliveryRemittances.remittanceNumber;

  // Acquire the shared counter row before reading history. Both new and existing
  // counter writers serialize here; never reset an advanced counter. Everything
  // stays inside the owning document transaction, including a later rollback.
  await tx.execute(sql`
    INSERT INTO documentCounters (counterKey, lastValue)
    VALUES (${counterKey}, 0)
    ON DUPLICATE KEY UPDATE lastValue = lastValue
  `);
  // The indexed prefix bounds the read to this branch/day. Include cancelled
  // documents, use numeric order beyond 99999, and ignore non-numeric suffixes.
  const result: any = await tx.execute(sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(${column}, ${prefix.length + 1}) AS UNSIGNED)), 0) AS legacyFloor
    FROM ${table}
    WHERE ${column} LIKE ${`${prefix}%`}
      AND SUBSTRING(${column}, ${prefix.length + 1}) REGEXP '^[0-9]+$'
  `);
  const row = Array.isArray(result) ? result[0]?.[0] : result?.rows?.[0];
  const seq = await nextCounterValue(
    tx,
    counterKey,
    Number(row?.legacyFloor ?? 0),
  );
  return prefix + String(seq).padStart(5, "0");
}

export async function nextConsignmentNumber(
  tx: Tx,
  branchId: number,
): Promise<string> {
  return nextDeliveryNumber(tx, branchId, "consignment");
}

/** DR-{branchId}-{YYYYMMDD}-{seq} — ترقيم دفعة ترحيل ذرّي عبر عدّاد documentCounters. */
export async function nextRemittanceNumber(
  tx: Tx,
  branchId: number,
): Promise<string> {
  return nextDeliveryNumber(tx, branchId, "remittance");
}

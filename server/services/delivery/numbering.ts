// ترقيم الإرسالية/دفعة الترحيل — ذرّي عبر GET_LOCK (نمط nextInvoiceNumber).
import { desc, like, sql } from "drizzle-orm";
import { deliveryConsignments } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDateStr } from "../money";

/** CN-{branchId}-{YYYYMMDD}-{seq} — ترقيم إرسالية ذرّي (نمط nextInvoiceNumber بـGET_LOCK). */
export async function nextConsignmentNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CN-${branchId}-${ymd}-`;
  const lockName = `numbering:consignment:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) throw new Error(`numbering lock timeout for ${lockName}`);
  try {
    const rows = await tx
      .select({ n: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments)
      .where(like(deliveryConsignments.consignmentNumber, `${prefix}%`))
      .orderBy(desc(deliveryConsignments.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** DR-{branchId}-{YYYYMMDD}-{seq} — ترقيم دفعة ترحيل ذرّي. */
export async function nextRemittanceNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `DR-${branchId}-${ymd}-`;
  const lockName = `numbering:remittance:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) throw new Error(`numbering lock timeout for ${lockName}`);
  try {
    const { deliveryRemittances } = await import("../../../drizzle/schema");
    const rows = await tx
      .select({ n: deliveryRemittances.remittanceNumber })
      .from(deliveryRemittances)
      .where(like(deliveryRemittances.remittanceNumber, `${prefix}%`))
      .orderBy(desc(deliveryRemittances.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

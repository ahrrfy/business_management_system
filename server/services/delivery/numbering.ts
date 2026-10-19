// ترقيم الإرسالية/دفعة الترحيل — ذرّي عبر documentCounters.
import type { Tx } from "../../db";
import { toDateStr } from "../money";
import { nextCounterValue } from "../numbering";

/** CN-{branchId}-{YYYYMMDD}-{seq} — ترقيم إرسالية ذرّي عبر عدّاد documentCounters. */
export async function nextConsignmentNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CN-${branchId}-${ymd}-`;
  const counterKey = `consignment_${branchId}_${ymd}`;
  const seq = await nextCounterValue(tx, counterKey);
  return prefix + String(seq).padStart(5, "0");
}

/** DR-{branchId}-{YYYYMMDD}-{seq} — ترقيم دفعة ترحيل ذرّي عبر عدّاد documentCounters. */
export async function nextRemittanceNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `DR-${branchId}-${ymd}-`;
  const counterKey = `remittance_${branchId}_${ymd}`;
  const seq = await nextCounterValue(tx, counterKey);
  return prefix + String(seq).padStart(5, "0");
}


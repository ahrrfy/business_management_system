// أدوات وحدة الهدايا: توليد رقم السند (نمط nextConsignmentNumber) + أنواع مشتركة.
import { desc, like, sql } from "drizzle-orm";
import { giftVouchers } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDateStr } from "../money";

export type GiftDirection = "OUT" | "IN";
export type GiftStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "DELIVERED" | "CANCELLED" | "REVERSED";

/**
 * رقم سند الهدية: `GFT-<branchId>-<YYYYMMDD>-<seq5>`. قفل تسمية (GET_LOCK) + مسح البادئة تحت `.for("update")`
 * لاشتقاق التسلسل، والقيد الفريد `uq_gift_number` حارسٌ أخير (التصادم اللحظيّ يُعاد في الراوتر عبر isDupEntry).
 * نمط `nextConsignmentNumber` حرفياً.
 */
export async function nextGiftNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `GFT-${branchId}-${ymd}-`;
  const lockName = `numbering:gift:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: giftVouchers.giftNumber })
      .from(giftVouchers)
      .where(like(giftVouchers.giftNumber, `${prefix}%`))
      .orderBy(desc(giftVouchers.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

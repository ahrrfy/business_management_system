// أدوات وحدة الهدايا: توليد رقم السند (نمط nextConsignmentNumber) + أنواع مشتركة.
import { desc, inArray, like, sql } from "drizzle-orm";
import { branchStock, giftVouchers } from "../../../drizzle/schema";
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

/**
 * يضمن وجود صفّ `branchStock` لكل (variant, branchId) ثمّ يقفل صفوف كلّ المتغيّرات FOR UPDATE.
 * ضروريّ قبل قراءة SUM المخزون (WAVG): بلا صفٍّ موجود لا يقفل FOR UPDATE شيئاً فيتسرّب سباقٌ بين
 * استلامٍ مجّانيّ وشراءٍ متزامنَين على متغيّرٍ جديد (تدقيق Codex P1). ويوحّد ترتيب القفل
 * (branchStock ثمّ productVariants) عبر مسارات الوارد/الصادر/الشراء ⇒ لا deadlock (تدقيق Codex P1).
 */
export async function ensureAndLockBranchStock(tx: Tx, variantIds: number[], branchId: number): Promise<void> {
  if (!variantIds.length) return;
  for (const variantId of variantIds) {
    await tx
      .insert(branchStock)
      .values({ variantId, branchId, quantity: 0 })
      .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });
  }
  await tx.select({ id: branchStock.id }).from(branchStock).where(inArray(branchStock.variantId, variantIds)).for("update");
}

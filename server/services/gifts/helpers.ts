// أدوات وحدة الهدايا: توليد رقم السند (نمط nextConsignmentNumber) + أنواع مشتركة.
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
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
  // المسار هـ-١ (١٧/٨) — نطاق القفل وترتيبه:
  //  ١) **بالفرع**: القفل كان `WHERE variantId IN (…)` بلا `branchId` رغم وجوده في التوقيع ⇒ يقفل
  //     صفوف **كلّ الفروع** لتلك المتغيّرات، فتُسلسَل مبيعات فرعٍ آخر خلف هديةٍ في فرعٍ لا علاقة له
  //     بها (اختناقٌ صامت، لا خطأ يظهر).
  //  ٢) **مرتّباً تصاعدياً بـvariantId** في الإدراج والقفل معاً — نفس نمط `sale/create.ts` المُثبَت:
  //     مسارانِ يمسكان المتغيّرين نفسيهما بترتيبين متعاكسين يصنعان `ER_LOCK_DEADLOCK`.
  const ordered = Array.from(new Set(variantIds)).sort((a, b) => a - b);
  for (const variantId of ordered) {
    await tx
      .insert(branchStock)
      .values({ variantId, branchId, quantity: 0 })
      .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });
  }
  await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(and(eq(branchStock.branchId, branchId), inArray(branchStock.variantId, ordered)))
    .orderBy(asc(branchStock.variantId))
    .for("update");
}

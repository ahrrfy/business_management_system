import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { branches, branchStock, products, productVariants } from "../../../drizzle/schema";
import type { Tx } from "../../db";

const variantLocks = new WeakSet<Tx>();
export function hasInventoryVariantLocks(tx: Tx): boolean {
  return variantLocks.has(tx);
}

/** يضمن صفوف رصيد حقيقية بترتيب variantId قبل أيّ قفل تكلفة/إتاحة. */
export async function ensureBranchStockRows(
  tx: Tx,
  variantIds: number[],
  branchId: number,
): Promise<number[]> {
  const ordered = Array.from(new Set(variantIds)).sort((a, b) => a - b);
  if (!ordered.length) return ordered;
  await tx
    .insert(branchStock)
    .values(ordered.map((variantId) => ({ variantId, branchId, quantity: 0 })))
    .onDuplicateKeyUpdate({
      set: { variantId: sql`${branchStock.variantId}` },
    });
  return ordered;
}

const SEED_CHUNK_SIZE = 500;

async function insertZeroBranchStockPairs(
  tx: Tx,
  pairs: Array<{ variantId: number; branchId: number }>,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += SEED_CHUNK_SIZE) {
    const chunk = pairs.slice(i, i + SEED_CHUNK_SIZE);
    await tx
      .insert(branchStock)
      .values(chunk.map((p) => ({ variantId: p.variantId, branchId: p.branchId, quantity: 0 })))
      .onDuplicateKeyUpdate({
        set: { variantId: sql`${branchStock.variantId}` },
      });
  }
}

/** يهيّئ صفوف رصيد صفرية لمتغيّرات مخزنية عبر كل الفروع منعاً لتصادم الإدراج الأوّل في Active-Active. */
export async function ensureBranchStockRowsForAllBranches(
  tx: Tx,
  variantIds: number[],
): Promise<void> {
  const ordered = Array.from(new Set(variantIds)).sort((a, b) => a - b);
  if (!ordered.length) return;
  const branchRows = await tx
    .select({ id: branches.id })
    .from(branches)
    .orderBy(asc(branches.id));
  if (!branchRows.length) return;
  const pairs: Array<{ variantId: number; branchId: number }> = [];
  for (const variantId of ordered) {
    for (const branch of branchRows) {
      pairs.push({ variantId, branchId: Number(branch.id) });
    }
  }
  await insertZeroBranchStockPairs(tx, pairs);
}

/** يهيّئ صفوف رصيد صفرية لكل المتغيّرات المخزنية القائمة عند إنشاء فرع جديد. */
export async function ensureBranchStockRowsForBranch(
  tx: Tx,
  branchId: number,
): Promise<void> {
  const variantRows = await tx
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(eq(products.isService, false), eq(products.isBundle, false)))
    .orderBy(asc(productVariants.id));
  if (!variantRows.length) return;
  await insertZeroBranchStockPairs(
    tx,
    variantRows.map((v) => ({ variantId: Number(v.id), branchId })),
  );
}

/** mutex الصنف الحاكم لكل تغيّر كمية/تكلفة، بترتيب variantId تصاعدي. */
export async function lockInventoryVariants(
  tx: Tx,
  variantIds: number[],
): Promise<number[]> {
  const ordered = Array.from(new Set(variantIds)).sort((a, b) => a - b);
  if (!ordered.length) return ordered;
  variantLocks.add(tx);
  // Exact existing PK point reads give deterministic order independent of the optimizer.
  for (const id of ordered) {
    await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.id, id))
      .for("update");
  }
  return ordered;
}

/** يقفل variant أولاً، ثم يضمن ويقفل رصيد الفرع. */
export async function ensureAndLockBranchStockRows(
  tx: Tx,
  variantIds: number[],
  branchId: number,
): Promise<number[]> {
  const ordered = await lockInventoryVariants(tx, variantIds);
  await ensureBranchStockRows(tx, ordered, branchId);
  if (!ordered.length) return ordered;
  await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(
      and(
        eq(branchStock.branchId, branchId),
        inArray(branchStock.variantId, ordered),
      ),
    )
    .orderBy(asc(branchStock.variantId))
    .for("update");
  return ordered;
}

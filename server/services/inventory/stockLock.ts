import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { branchStock, productVariants } from "../../../drizzle/schema";
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

// قراءة قائمة سندات الهدايا (بعزل الفرع) — الصادرة والواردة معاً مع اسم الطرف.
import { and, desc, eq, like, or } from "drizzle-orm";
import { customers, giftVouchers, suppliers } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import type { GiftDirection, GiftStatus } from "./helpers";

export interface GiftListScope {
  scopedBranchId: number | null;
}
export interface GiftListFilter {
  direction?: GiftDirection;
  status?: GiftStatus;
  branchId?: number;
  q?: string;
  limit?: number;
  redactCost?: boolean; // true ⇒ حجب totalCost من الحمولة (لمن لا يرى التكلفة — تدقيق Codex P1)
}

export async function listGifts(scope: GiftListScope, filter: GiftListFilter = {}) {
  const db = requireDb();
  const conds = [];
  // عزل الفرع: غير المرتفع يرى فرعه فقط؛ المرتفع يفلتر بـ filter.branchId اختيارياً.
  const branch = scope.scopedBranchId ?? filter.branchId;
  if (branch != null) conds.push(eq(giftVouchers.branchId, branch));
  if (filter.direction) conds.push(eq(giftVouchers.direction, filter.direction));
  if (filter.status) conds.push(eq(giftVouchers.status, filter.status));
  if (filter.q) {
    const q = `%${filter.q}%`;
    conds.push(or(like(giftVouchers.giftNumber, q), like(giftVouchers.reason, q), like(giftVouchers.supplierRef, q)));
  }
  const rows = await db
    .select({
      id: giftVouchers.id,
      giftNumber: giftVouchers.giftNumber,
      direction: giftVouchers.direction,
      branchId: giftVouchers.branchId,
      status: giftVouchers.status,
      giftType: giftVouchers.giftType,
      reason: giftVouchers.reason,
      sellable: giftVouchers.sellable,
      supplierId: giftVouchers.supplierId,
      supplierName: suppliers.name,
      customerId: giftVouchers.customerId,
      customerName: customers.name,
      supplierRef: giftVouchers.supplierRef,
      estimatedValue: giftVouchers.estimatedValue,
      totalCost: giftVouchers.totalCost,
      createdAt: giftVouchers.createdAt,
    })
    .from(giftVouchers)
    .leftJoin(suppliers, eq(giftVouchers.supplierId, suppliers.id))
    .leftJoin(customers, eq(giftVouchers.customerId, customers.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(giftVouchers.id))
    .limit(Math.min(filter.limit ?? 100, 200));
  // حجب التكلفة (تدقيق Codex P1): من لا يرى التكلفة لا يتلقّى totalCost في حمولة الشبكة (وإن أخفته الشاشة).
  return filter.redactCost ? rows.map((r) => ({ ...r, totalCost: null as string | null })) : rows;
}

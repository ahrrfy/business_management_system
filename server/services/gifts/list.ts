// قراءة قائمة سندات الهدايا (بعزل الفرع) — الصادرة والواردة معاً مع اسم الطرف.
import { and, desc, eq, like, or } from "drizzle-orm";
import { customers, giftVoucherLines, giftVouchers, productUnits, productVariants, products, suppliers } from "../../../drizzle/schema";
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

/**
 * تفاصيل سند هدية للطباعة (G-م٣): الرأس + اسم الطرف (مورّد/عميل حسب الاتجاه) + الأسطر بأسماء المنتجات.
 * **بلا حقول تكلفة** — سند الهدية لا يعرض الكلفة (هدية مجانية). عزل الفرع: غير المرتفع (scopedBranchId
 * مضبوط) لا يرى سند فرعٍ آخر ⇒ null (الراوتر يترجمها NOT_FOUND كي لا يكشف وجوده).
 */
export async function getGiftVoucher(scope: GiftListScope, giftId: number) {
  const db = requireDb();
  const gv = (
    await db
      .select({
        id: giftVouchers.id,
        giftNumber: giftVouchers.giftNumber,
        direction: giftVouchers.direction,
        branchId: giftVouchers.branchId,
        giftType: giftVouchers.giftType,
        reason: giftVouchers.reason,
        status: giftVouchers.status,
        sellable: giftVouchers.sellable,
        createdAt: giftVouchers.createdAt,
        supplierName: suppliers.name,
        customerName: customers.name,
      })
      .from(giftVouchers)
      .leftJoin(suppliers, eq(giftVouchers.supplierId, suppliers.id))
      .leftJoin(customers, eq(giftVouchers.customerId, customers.id))
      .where(eq(giftVouchers.id, giftId))
      .limit(1)
  )[0];
  if (!gv) return null;
  if (scope.scopedBranchId != null && Number(gv.branchId) !== scope.scopedBranchId) return null; // عزل الفرع
  const lines = await db
    .select({
      productName: products.name,
      sku: productVariants.sku,
      unitName: productUnits.unitName,
      quantity: giftVoucherLines.quantity,
      baseQuantity: giftVoucherLines.baseQuantity,
    })
    .from(giftVoucherLines)
    .innerJoin(productVariants, eq(productVariants.id, giftVoucherLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(productUnits, eq(productUnits.id, giftVoucherLines.productUnitId))
    .where(eq(giftVoucherLines.giftVoucherId, giftId));
  return { ...gv, partyName: gv.direction === "IN" ? gv.supplierName : gv.customerName, lines };
}

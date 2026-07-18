// اعتماد تسويات المخزون المُعلَّقة (فصل مهام #٦، الشريحة ٢).
//
// التسوية المباشرة للمخزون (`inventory.adjust`) عمليةٌ حسّاسة (قد تُخفي عجزاً/سرقة) ⇒ قرار المالك ١٨/٧:
// اعتماد ثنائيّ بلا عتبة. لا آلية اعتماد للمخزون (بخلاف السندات النقدية) ⇒ آلية جديدة: يُنشئ الطلبُ صفّاً
// معلَّقاً في `stockAdjustmentRequests` **بلا تغيير مخزون**، ويعتمده مديرٌ آخر (SOD-04: المُعتمِد ≠ المُنشئ
// إلا admin) فيُطبَّق `setStock` + قيد ADJUST (نفس منطق المسار المباشر السابق). الرفض بلا أثر.
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  branchStock,
  products,
  productVariants,
  stockAdjustmentRequests,
  users,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { setStock } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { requireDb } from "../tx";
import { type Actor, withTx } from "../tx";

export interface RequestAdjustmentInput {
  variantId: number;
  branchId: number;
  targetQuantity: number;
  notes?: string | null;
}

/** يُنشئ طلب تسوية مخزونٍ معلَّقاً — **بلا تغيير مخزون** حتى الاعتماد. */
export async function requestStockAdjustment(input: RequestAdjustmentInput, actor: Actor): Promise<{ requestId: number }> {
  return withTx(async (tx) => {
    if (!Number.isInteger(input.targetQuantity) || input.targetQuantity < 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الرصيد المستهدف يجب أن يكون صحيحاً غير سالب" });
    }
    const v = (
      await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, input.variantId)).limit(1)
    )[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
    const res = await tx.insert(stockAdjustmentRequests).values({
      variantId: input.variantId,
      branchId: input.branchId,
      targetQuantity: input.targetQuantity,
      notes: input.notes?.trim() || null,
      status: "PENDING_APPROVAL",
      createdBy: actor.userId,
    });
    return { requestId: extractInsertId(res) };
  });
}

/** يفرض SOD-04 (المُعتمِد ≠ المُنشئ إلا admin) + عزل الفرع (غير admin يعتمد فرعه فقط). */
function assertApprover(r: { createdBy: number | null; branchId: number }, actor: Actor, verb: string): void {
  if (actor.role !== "admin" && r.createdBy != null && Number(r.createdBy) === actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: `لا يجوز ${verb} تسويةٍ طلبتها بنفسك — يلزم مدير آخر (فصل المهام).` });
  }
  if (actor.role !== "admin" && actor.branchId != null && Number(r.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `لا يمكن ${verb} تسوية فرعٍ آخر` });
  }
}

/** يعتمد طلب تسوية معلَّق: SOD-04 ⇒ يطبّق `setStock` + قيد ADJUST بقيمة الفرق × التكلفة. */
export async function approveStockAdjustment(
  id: number,
  actor: Actor,
): Promise<{ movementId: number; newQuantity: number; delta: number }> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(stockAdjustmentRequests).where(eq(stockAdjustmentRequests.id, id)).for("update").limit(1)
    )[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التسوية غير موجود" });
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب التسوية ليس في انتظار الموافقة" });
    }
    assertApprover({ createdBy: r.createdBy != null ? Number(r.createdBy) : null, branchId: Number(r.branchId) }, actor, "اعتماد");

    const branchId = Number(r.branchId);
    // يطبّق المخزون الآن (لحظة الاعتماد) — setStock يفرض حراس الخدمة/البكج. قد يرمي ⇒ يُلغى الاعتماد كلّه.
    const stockRes = await setStock(tx, {
      variantId: Number(r.variantId),
      branchId,
      targetQuantity: r.targetQuantity,
      createdBy: actor.userId,
    });
    // قيد ADJUST بقيمة الفرق × التكلفة (نقص ⇒ cost موجب/profit سالب؛ زيادة ⇒ العكس). نفس منطق المسار السابق.
    if (stockRes.delta && stockRes.delta !== 0) {
      const v = (
        await tx.select({ costPrice: productVariants.costPrice }).from(productVariants).where(eq(productVariants.id, Number(r.variantId))).limit(1)
      )[0];
      const adjustValue = money(v?.costPrice ?? "0").times(stockRes.delta);
      if (!adjustValue.isZero()) {
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId,
          cost: adjustValue.neg(),
          profit: adjustValue,
          amount: money(0),
          dedupeKey: `INV_ADJUST:${stockRes.movementId}`,
          notes: `تسوية مخزون معتمَدة (طلب #${id})${r.notes ? ` — ${r.notes}` : ""}`,
        });
      }
    }
    await tx.update(stockAdjustmentRequests).set({
      status: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      appliedMovementId: stockRes.movementId,
    }).where(eq(stockAdjustmentRequests.id, id));
    return { movementId: stockRes.movementId, newQuantity: stockRes.newQuantity, delta: stockRes.delta ?? 0 };
  });
}

/** يرفض طلب تسوية معلَّق — بلا أثر مخزون. نفس قاعدة SOD-04. */
export async function rejectStockAdjustment(id: number, actor: Actor, reason: string): Promise<void> {
  return withTx(async (tx) => {
    const r = (
      await tx.select().from(stockAdjustmentRequests).where(eq(stockAdjustmentRequests.id, id)).for("update").limit(1)
    )[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التسوية غير موجود" });
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب التسوية ليس في انتظار الموافقة" });
    }
    assertApprover({ createdBy: r.createdBy != null ? Number(r.createdBy) : null, branchId: Number(r.branchId) }, actor, "رفض");
    const trimmed = reason.trim().slice(0, 500);
    if (!trimmed) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض مطلوب (للسجل التدقيقي)" });
    await tx.update(stockAdjustmentRequests).set({
      status: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      rejectionReason: trimmed,
    }).where(eq(stockAdjustmentRequests.id, id));
  });
}

/** قائمة طلبات التسوية (اسم الصنف + المُنشئ + الرصيد الحاليّ) — معزولةٌ بالفرع، مرتَّبة بالأحدث. */
export async function listStockAdjustmentRequests(scope: {
  branchId?: number | null;
  status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
}) {
  const db = requireDb();
  const creator = users;
  const conds = [];
  if (scope.branchId != null) conds.push(eq(stockAdjustmentRequests.branchId, scope.branchId));
  if (scope.status) conds.push(eq(stockAdjustmentRequests.status, scope.status));
  return db
    .select({
      id: stockAdjustmentRequests.id,
      variantId: stockAdjustmentRequests.variantId,
      branchId: stockAdjustmentRequests.branchId,
      targetQuantity: stockAdjustmentRequests.targetQuantity,
      currentQuantity: branchStock.quantity,
      notes: stockAdjustmentRequests.notes,
      status: stockAdjustmentRequests.status,
      createdBy: stockAdjustmentRequests.createdBy,
      createdByName: creator.name,
      createdAt: stockAdjustmentRequests.createdAt,
      approvedBy: stockAdjustmentRequests.approvedBy,
      approvedAt: stockAdjustmentRequests.approvedAt,
      rejectionReason: stockAdjustmentRequests.rejectionReason,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
    })
    .from(stockAdjustmentRequests)
    .leftJoin(productVariants, eq(stockAdjustmentRequests.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(creator, eq(stockAdjustmentRequests.createdBy, creator.id))
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, stockAdjustmentRequests.variantId), eq(branchStock.branchId, stockAdjustmentRequests.branchId)),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(stockAdjustmentRequests.id))
    .limit(500);
}

// G-م١: استلام بضاعة مجّانية من مورّد (هدية واردة). صفر تكلفة ⇒ **تخفيف WAVG** (نمط purchaseService:
// المتوسّط الجديد = القيمة الدفترية القديمة ÷ الكمية بعد الإضافة، لأنّ المجّاني يضيف قيمةً صفراً)، **بلا قيد
// PURCHASE ولا دين للمورّد**. الوحدة تُحوَّل لوحدة الأساس؛ يُرفَض البكج/الخدميّ (لا مخزون ذاتيّ). ذرّيّ تحت قفل.
import { TRPCError } from "@trpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { branches, branchStock, giftVoucherLines, giftVouchers, productVariants, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement, convertToBaseQuantity, isBundleVariant, isServiceVariant } from "../inventoryService";
import { money, round2 } from "../money";
import { withTx, type Actor } from "../tx";
import { nextGiftNumber } from "./helpers";

export interface InboundGiftLineInput {
  variantId: number;
  productUnitId: number;
  quantity: number; // بالوحدة المختارة (قطعة/درزن/كرتون) — يُحوَّل لوحدة الأساس خادمياً
  refSalePrice?: string | null; // سعر بيع مرجعيّ (عرضيّ فقط)
}
export interface ReceiveInboundGiftInput {
  branchId: number;
  supplierId?: number | null;
  giftType?: string | null;
  reason?: string | null;
  supplierRef?: string | null;
  estimatedValue?: string | null;
  notes?: string | null;
  lines: InboundGiftLineInput[];
}
export interface ReceiveInboundGiftResult {
  giftVoucherId: number;
  giftNumber: string;
}

export async function receiveInboundGift(input: ReceiveInboundGiftInput, actor: Actor): Promise<ReceiveInboundGiftResult> {
  if (!input.lines?.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أضف صنفاً واحداً على الأقل للهدية الواردة" });
  for (const ln of input.lines) {
    if (!(ln.quantity > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الهدية يجب أن تكون موجبة" });
  }

  return withTx(async (tx) => {
    const b = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
    if (input.supplierId != null) {
      const s = (await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1))[0];
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    }

    // حوّل كل سطر لوحدة الأساس + امنع البكج/الخدميّ (لا رصيد branchStock ذاتيّ لهما).
    const converted: Array<{ variantId: number; productUnitId: number; quantity: string; baseQuantity: number; refSalePrice: string | null }> = [];
    for (const ln of input.lines) {
      if (await isBundleVariant(tx, ln.variantId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُستلَم هدية لمنتج بكج (مركّب) — استلم مكوّناته المخزونية." });
      }
      if (await isServiceVariant(tx, ln.variantId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُستلَم هدية لمنتج خدميّ (بلا مخزون)." });
      }
      const conv = await convertToBaseQuantity(tx, ln.productUnitId, ln.quantity, ln.variantId);
      converted.push({
        variantId: ln.variantId,
        productUnitId: ln.productUnitId,
        quantity: money(ln.quantity).toFixed(4),
        baseQuantity: conv.baseQuantity,
        refSalePrice: ln.refSalePrice ?? null,
      });
    }

    const variantIds = Array.from(new Set(converted.map((c) => c.variantId))).sort((a, b) => a - b);

    // قفل صفوف الرصيد للمتغيّرات المعنيّة قبل قراءة الـSUM (يتسلسل مع أي بيع/شراء متزامن — نمط purchaseService).
    await tx.select({ id: branchStock.id }).from(branchStock).where(inArray(branchStock.variantId, variantIds)).for("update");
    // إجمالي المخزون لكل صنف عبر كل الفروع (WAVG صفة عالمية للصنف ⇒ الوزن بالإجمالي).
    const stockRows = await tx
      .select({ variantId: branchStock.variantId, totalQty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)` })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .groupBy(branchStock.variantId);
    const stockMap = new Map<number, string>(stockRows.map((r) => [Number(r.variantId), String(r.totalQty)]));
    // قفل صفوف المتغيّرات وقراءة تكلفتها (ترتيب تصاعديّ حتميّ).
    const variantRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .for("update");
    const costMap = new Map<number, string>(variantRows.map((v) => [Number(v.id), String(v.cost ?? "0")]));

    // رأس السند (الوارد مُستلَم فوراً بلا اعتماد — status=DELIVERED؛ totalCost=0 دائماً).
    const giftNumber = await nextGiftNumber(tx, input.branchId);
    const insHead = await tx.insert(giftVouchers).values({
      giftNumber,
      direction: "IN",
      branchId: input.branchId,
      supplierId: input.supplierId ?? null,
      giftType: input.giftType?.trim() || null,
      reason: input.reason?.trim() || null,
      sellable: true, // G-م١: القابل للبيع فقط (الاستخدام الداخلي/العيّنة sellable=false مؤجَّل — G-م١ب)
      supplierRef: input.supplierRef?.trim() || null,
      estimatedValue: input.estimatedValue ? round2(money(input.estimatedValue)).toFixed(2) : null,
      status: "DELIVERED",
      totalCost: "0",
      notes: input.notes?.trim() || null,
      createdBy: actor.userId,
    });
    const giftVoucherId = extractInsertId(insHead);

    // كمية كل صنف (قد تتكرّر عبر أسطر بوحدات مختلفة) لحساب المتوسّط المخفَّف مرّة واحدة.
    const qtyByVariant = new Map<number, number>();
    for (const c of converted) qtyByVariant.set(c.variantId, (qtyByVariant.get(c.variantId) ?? 0) + c.baseQuantity);

    for (const variantId of variantIds) {
      const freeQty = qtyByVariant.get(variantId)!;
      const existingRaw = money(stockMap.get(variantId) ?? "0");
      const existingQty = existingRaw.lt(0) ? money(0) : existingRaw; // الرصيد السالب (وضع الافتتاح) لا يرفع المتوسّط
      const oldCost = money(costMap.get(variantId) ?? "0");
      const denom = existingQty.plus(freeQty);
      // تخفيف WAVG: المجّاني يضيف قيمةً صفراً ⇒ المتوسّط الجديد = القيمة القديمة ÷ الكمية بعد الإضافة.
      // لا مخزون قائم أو تكلفة قديمة صفر ⇒ يبقى صفراً (كل المخزون مجّانيّ الآن).
      const newCost = denom.lte(0) || oldCost.lte(0) ? round2(money(0)) : round2(existingQty.times(oldCost).dividedBy(denom));
      await applyMovement(tx, {
        variantId,
        branchId: input.branchId,
        baseQuantity: freeQty,
        movementType: "IN",
        referenceType: "GIFT_IN",
        referenceId: giftVoucherId,
        createdBy: actor.userId,
      });
      await tx.update(productVariants).set({ costPrice: newCost.toFixed(2) }).where(eq(productVariants.id, variantId));
    }

    // أسطر السند (لقطة تكلفة صفر — الوارد المجّاني بلا تكلفة).
    for (const c of converted) {
      await tx.insert(giftVoucherLines).values({
        giftVoucherId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitCostSnapshot: "0",
        lineCost: "0",
        refSalePrice: c.refSalePrice,
      });
    }

    return { giftVoucherId, giftNumber };
  });
}

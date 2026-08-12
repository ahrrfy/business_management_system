// G-م٦: توسعة «اشترِ واحصل» — تسجيل الكمية المجّانية المرافقة لأمر شراء كسند هدية وارد منفصل.
// تصميماً: الكمية المجّانية لا تمرّ عبر receivePurchase (حارسه يرفض تجاوز المطلوب) ⇒ تُوجَّه هنا عبر
// receiveInboundGift (صفر تكلفة، تخفّف WAVG، بلا دين). يُستدعى بعد نجاح الاستلام العاديّ (تنسيق تسلسليّ
// idempotent — نمط convertQuotation؛ الخدمتان معاملتان مستقلّتان لا تُلفّان معاً). المورّد/الفرع من الأمر نفسه.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { productUnits, purchaseOrders } from "../../../drizzle/schema";
import { requireDb, type Actor } from "../tx";
import { receiveInboundGift } from "./inbound";

export interface PurchaseBonusLine {
  variantId: number;
  freeBaseQuantity: number; // بوحدة الأساس (كالاستلام العاديّ)
}
export interface RecordPurchaseBonusInput {
  purchaseOrderId: number;
  bonusLines: PurchaseBonusLine[];
  clientRequestId?: string | null;
}

/** يسجّل الكميات المجّانية المرافقة للأمر كسند هدية وارد واحد للمورّد نفسه. يعيد null إن لا بونص. */
export async function recordPurchaseBonusGift(input: RecordPurchaseBonusInput, actor: Actor): Promise<{ giftNumber: string } | null> {
  const bonus = (input.bonusLines ?? []).filter((b) => Number.isInteger(b.freeBaseQuantity) && b.freeBaseQuantity > 0);
  if (!bonus.length) return null;

  const db = requireDb();
  const po = (
    await db
      .select({ supplierId: purchaseOrders.supplierId, branchId: purchaseOrders.branchId })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .limit(1)
  )[0];
  if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  // عزل مدير الفرع (قرار المالك ١٢/٨): بونص الشراء يُقيَّد بفرع الفاعل — المالك/الأدمن وحدهما يعبُران.
  if (actor.role !== "admin" && Number(po.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "أمر الشراء يخصّ فرعاً آخر" });
  }

  // حلّ وحدة الأساس لكل متغيّر (الكمية بوحدة الأساس ⇒ نمرّر وحدة الأساس بمعاملٍ 1 لـ receiveInboundGift).
  const variantIds = Array.from(new Set(bonus.map((b) => b.variantId)));
  const baseUnits = await db
    .select({ variantId: productUnits.variantId, id: productUnits.id })
    .from(productUnits)
    .where(and(inArray(productUnits.variantId, variantIds), eq(productUnits.isBaseUnit, true)));
  const baseUnitByVariant = new Map<number, number>(baseUnits.map((u) => [Number(u.variantId), Number(u.id)]));

  const lines = bonus.map((b) => {
    const productUnitId = baseUnitByVariant.get(b.variantId);
    if (!productUnitId) throw new TRPCError({ code: "BAD_REQUEST", message: `لا وحدة أساس للمتغيّر ${b.variantId}` });
    return { variantId: b.variantId, productUnitId, quantity: b.freeBaseQuantity };
  });

  const g = await receiveInboundGift(
    {
      branchId: Number(po.branchId),
      supplierId: Number(po.supplierId),
      giftType: "بونص شراء",
      reason: `بونص مرافق لأمر الشراء #${input.purchaseOrderId} (اشترِ واحصل)`,
      lines,
      clientRequestId: input.clientRequestId,
    },
    actor,
  );
  return { giftNumber: g.giftNumber };
}

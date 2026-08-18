import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { auditLogs, branchStock, productVariants, products } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money } from "./money";

/**
 * Manual catalog cost edits are not a documented inventory-revaluation source.
 *
 * - Receipt/WAVG changes are accounted for by the purchase-receipt path.
 * - Approved stocktake changes are accounted for by the stocktake path.
 * - Consignment share edits and edits with no owned stock are audit-only.
 * - An owned item with non-zero stock fails closed here: free `reason` text is not an
 *   accounting purpose and must never manufacture generic revenue or loss. The governed
 *   path is `inventory/costRevaluationRequest.ts` — an explicit document (purpose +
 *   counter-account + second approver) that posts `Δcost × qty` per branch, and therefore
 *   inherits the period lock through `postEntry`.
 *
 * The caller invokes this inside the same transaction as the catalog update, so a
 * rejection rolls back both the attempted cost change and this audit event.
 */
export async function postCostRevaluation(
  tx: Tx,
  variantId: number,
  oldCost: string | number | Decimal | null | undefined,
  newCost: string | number | Decimal | null | undefined,
  actor: { userId: number; branchId?: number | null },
  reason?: string | null,
): Promise<void> {
  const delta = money(newCost ?? 0).minus(money(oldCost ?? 0));
  if (delta.isZero()) return;

  // تدقيق ٢٧/٧ (تكملة H3/H4 تحت WAVG): أثرٌ **مُدقَّقٌ مُهيكَل** لتغيير التكلفة اليدويّ (قبل/بعد) على
  // حقلٍ ماليٍّ حسّاس. يُكتَب **داخل المعاملة** فيرتدّ التعديلُ إن فشل
  // السجلّ (ضابطٌ حاكمٌ لا يجوز نجاحه بلا أثر)، ويسبق فحص الأمانة كي يُدقَّق تعديلُ «حصّة المودِع» أيضاً
  // (وإن استُثني من قيد إعادة التقييم). الاستدعاء محصورٌ بمساري التعديل اليدويّ لا بتحديث WAVG الآليّ.
  //  • branchId: فرعُ الفاعل — كي تظهر هذه السجلّات تحت فلتر الفرع في auditRouter.list (Codex).
  //  • reason: سبب تغيير التكلفة الإلزاميّ للتغيّرات الكبيرة (assertCostChangeReasonOrThrow) — يُلتقَط
  //    هنا كي يكون السجلّ مكتفياً بذاته (لا يلزم تقاطعُه مع سجلّ product.update).
  await tx.insert(auditLogs).values({
    userId: actor.userId,
    branchId: actor.branchId ?? null,
    action: "product.costChange",
    entityType: "productVariant",
    entityId: String(variantId),
    oldValue: { costPrice: money(oldCost ?? 0).toFixed(2) },
    newValue: { costPrice: money(newCost ?? 0).toFixed(2), reason: reason?.trim() || null },
  });

  // بضاعة الأمانة مستثناةٌ من أصل المخزون في الميزانية (isConsignment=false) — ليست ملك المكتبة،
  // فتعديل «حصّة المودِع» ليس إعادة تقييمٍ لأصلٍ لدينا ⇒ لا قيد (وإلّا سطرُ ربح/خسارةٍ بلا أصلٍ مقابل).
  const pv = (
    await tx
      .select({ isConsignment: products.isConsignment })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, variantId))
      .limit(1)
  )[0];
  if (!pv || pv.isConsignment) return;

  // وجود أي رصيد غير صفري يعني أن تعديل التكلفة سيغيّر أصل المخزون بلا مستند محاسبي مصنّف.
  const rows = await tx
    .select({ id: branchStock.id })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, variantId), ne(branchStock.quantity, 0)));

  if (rows.length > 0) {
    // `reason` is free audit text, not an accounting purpose or a controlled
    // counter-account. Treating every upward edit as revenue and every downward
    // edit as loss manufactures P&L without source evidence. Receipt/WAVG and
    // stocktake approval retain their own documented posting paths; the manual editor
    // stays fail-closed — and now names the governed alternative instead of dead-ending
    // (there was previously no way at all to correct a wrong cost on a stocked item).
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "لا تُعدَّل تكلفة صنفٍ مملوك له رصيد من هنا: تغييرها يحرّك أصل المخزون بلا قيدٍ مقابل. استعمل «إعادة تقييم التكلفة» من شاشة المخزون (غرضٌ محاسبيّ + سببٌ مكتوب + اعتماد مديرٍ ثانٍ)، أو استلامَ شراءٍ إن كانت التكلفة تتغيّر بشراءٍ فعليّ.",
    });
  }
}

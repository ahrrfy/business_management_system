import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { branchStock, inventoryMovements, productUnits } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * حارس تبديل وحدة الأساس (تدقيق ١١/٨ — بعد مراجعة Codex العدائية).
 *
 * الأرصدة (`branchStock.quantity`) **والحركات التاريخية** (`inventoryMovements.quantity`) مخزَّنة كلّها
 * بالوحدة الأساس بلا معرّف وحدة؛ فتبديل **هويّة** وحدة الأساس لمتغيّرٍ سبق تحرُّكه يعيد تفسير كل تلك
 * القيم صامتاً (١٤٤ قطعة تصير ١٤٤ درزناً). لذا لا يكفي الرصيد الصفريّ الحاليّ — نمنع التبديل إن وُجد
 * رصيدٌ **أو أيّ حركة سابقة**. ونقفل صفوف `branchStock` للمتغيّر أوّلاً ليتسلسل الفحص مع
 * `applyMovement` (الذي يقفلها قبل كتابة الحركة) ⇒ لا سباق TOCTOU (حركةٌ تلتزم بين الفحص والتبديل).
 *
 * يُستدعى من **كلا** مساري التعديل (`productEditService.updateProductWithVariants`
 * و`catalog/productUpdate.updateProduct`) كي لا يتسرّب التبديل عبر المسار القديم.
 */
export async function assertBaseUnitSwapSafe(tx: Tx, variantId: number, newBaseUnitName: string): Promise<void> {
  const vid = Number(variantId);
  if (!Number.isInteger(vid) || vid <= 0) return;
  const want = (newBaseUnitName ?? "").trim();

  // (١) قفل صفوف الرصيد أوّلاً — يتسلسل مع applyMovement (يقفل branchStock قبل الحركة). لا TOCTOU.
  await tx.select({ id: branchStock.id }).from(branchStock).where(eq(branchStock.variantId, vid)).for("update");

  // (٢) وحدة الأساس **النشطة** الحالية فقط — الوحدة القديمة المُعطَّلة تبقى isBaseUnit=true فلا تُحتسَب
  //     (وإلّا رُفض كلّ تعديلٍ لاحق زوراً — مراجعة Codex).
  const curBase = await tx
    .select({ name: productUnits.unitName })
    .from(productUnits)
    .where(and(eq(productUnits.variantId, vid), eq(productUnits.isBaseUnit, true), eq(productUnits.isActive, true)));
  const baseChanged = curBase.length > 0 && curBase.every((r) => (r.name ?? "").trim() !== want);
  if (!baseChanged) return; // لا تبديل لهويّة الأساس ⇒ آمن (إعادة تسمية بنفس الاسم أو صنفٌ جديد).

  // (٣) رصيدٌ حاليّ (مقروءٌ تحت القفل) أو أيّ حركة تاريخية ⇒ التبديل يُفسد المعنى ⇒ مُنِع.
  const stock = await tx.select({ q: branchStock.quantity }).from(branchStock).where(eq(branchStock.variantId, vid));
  const anyStock = stock.some((r) => (r.q ?? 0) !== 0);
  const [mv] = anyStock
    ? [{ id: 1 }]
    : await tx.select({ id: inventoryMovements.id }).from(inventoryMovements).where(eq(inventoryMovements.variantId, vid)).limit(1);
  if (anyStock || mv) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "لا يمكن تبديل وحدة الأساس لصنفٍ له رصيدٌ أو حركاتٌ سابقة — الأرصدة والحركات مخزَّنة بالوحدة الأساس، فالتبديل يعيد تفسيرها. أنشئ متغيّراً جديداً بالوحدة الجديدة بدل التبديل.",
    });
  }
}

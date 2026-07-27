import Decimal from "decimal.js";
import { and, eq, ne } from "drizzle-orm";
import { branchStock, productVariants, products } from "../../drizzle/schema";
import type { Tx } from "../db";
import { postEntry } from "./ledgerService";
import { money } from "./money";

/**
 * قيد إعادة تقييم المخزون عند تعديل التكلفة يدوياً لصنفٍ له رصيد (تدقيق ٢٧/٧ — H3).
 *
 * **المشكلة:** أصل المخزون في الميزانية = SUM(quantity × costPrice) يُقرأ **حيّاً**، وحقوق الملكية
 * مشتقّة (أصول − خصوم). فتعديل التكلفة يدوياً يُحرّك حقوق الملكية بمقدار Δتكلفة×كمية **بلا سطرٍ
 * يفسّره في قائمة الدخل** ⇒ ينكسر ثابت المحاسبة «تغيّر حقوق الملكية = صافي الدخل»، وتتحرّك الحقوق
 * بصمتٍ بلا أثرٍ ولا قيد.
 *
 * **الحل:** لكل فرعٍ له رصيدٌ غير صفريّ لهذا الصنف، أصدر قيد `ADJUST` بمفتاح `REVAL:%` وبمقدار
 * الفرق في حقل `profit` (موجب = التكلفة ارتفعت = مكسب إعادة تقييم، سالب = انخفضت = خسارة). فيَظهر
 * أثرُه في قائمة الدخل (سطر «إعادة تقييم المخزون» عبر بوّابة P&L في reportsFinancialService)، ويمرّ
 * على `assertPeriodOpen` داخل `postEntry` (حارس الفترة تلقائياً)، ويُترَك أثرٌ دائمٌ قابل للتدقيق.
 *
 * **idempotent طبيعياً:** الفرق يُحسب من التكلفة المخزَّنة الحاليّة المُمرَّرة (oldCost)؛ فبعد الالتزام
 * تصبح التكلفة الجديدة هي المخزَّنة، وإعادة تشغيلٍ بنفس القيمة ترى Δ=0 ⇒ لا قيد مزدوج.
 *
 * **النطاق:** يُستدعى فقط من مساري التعديل اليدويّ للمنتج — لا من تحديث WAVG الآليّ عند استلام الشراء
 * (ذاك يقيّد PURCHASE بذاته). يجب استدعاؤه **داخل نفس المعاملة** (Tx) لضمان الذرّية.
 */
export async function postCostRevaluation(
  tx: Tx,
  variantId: number,
  oldCost: string | number | Decimal | null | undefined,
  newCost: string | number | Decimal | null | undefined,
  actor: { userId: number },
): Promise<void> {
  const delta = money(newCost ?? 0).minus(money(oldCost ?? 0));
  if (delta.isZero()) return;

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

  // رصيد كل فرعٍ لهذا الصنف (غير الصفريّ فقط) — أثر إعادة التقييم على الفرع = Δ × كميته.
  const rows = await tx
    .select({ branchId: branchStock.branchId, qty: branchStock.quantity })
    .from(branchStock)
    .where(and(eq(branchStock.variantId, variantId), ne(branchStock.quantity, 0)));

  for (const r of rows) {
    const qty = new Decimal(Number(r.qty));
    if (qty.isZero()) continue;
    const gain = delta.times(qty); // موجب = مكسب إعادة تقييم (التكلفة ارتفعت)
    await postEntry(tx, {
      entryType: "ADJUST",
      branchId: Number(r.branchId),
      profit: gain,
      notes: `إعادة تقييم مخزون (تعديل تكلفة يدويّ): صنف #${variantId}، فرع ${r.branchId}، Δ=${delta.toFixed(2)}×${qty.toFixed(0)} — بواسطة #${actor.userId}`,
      // مفتاح فريد يحمل بادئة REVAL: (لبوّابة P&L) — الفرادة تُرضي قيد uq_entry_dedupe فتُتاح
      // إعاداتُ تقييمٍ متعدّدة للصنف نفسه؛ الحماية من الازدواج مصدرُها منطق Δ لا هذا المفتاح.
      dedupeKey: `REVAL:${variantId}:${r.branchId}:${Date.now()}`,
    });
  }
}

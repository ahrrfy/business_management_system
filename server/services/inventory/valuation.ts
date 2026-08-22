/**
 * قيمة المخزون — القراءة الحيّة نفسها التي تبني بها الميزانيةُ أصلَ المخزون، معزولةً في دالّة.
 *
 * ## لماذا تلزم لقطة
 *
 * أصل المخزون في الميزانية يُقرأ **حيّاً**: `SUM(quantity × costPrice)` بلا تاريخٍ مرجعيّ. وما دام
 * الرصيد كمّيةً حيّة لا سلسلةً مؤرَّخة، فإنّ **ميزانية أيّ تاريخٍ سابق تُحسب من مخزون اليوم** —
 * أي أنّ حركةً واحدة بعد إقفال السنة تُغيّر رقم السنة المقفلة بأثرٍ رجعيّ، فينحرف عن الأرباح
 * المحتجزة المُرحَّلة، ولا يبقى للميزانية المُقفلة أصلٌ يُعاد إنتاجه (تدقيق ٢٧/٧، H5).
 *
 * الحارس في `inventoryService` يمنع الحركة **داخل** الفترة المقفلة. وهذه اللقطة تُغلق النصف
 * الثاني: تُخزَّن القيمة لحظة الإقفال، فيصير الانحراف — إن وقع بمسارٍ لم نتوقّعه — **قابلاً
 * للقياس والعرض** بدل أن يكون صامتاً.
 *
 * ⚠️ بضاعة الأمانة مستبعَدة بنفس شرط الميزانية (`isConsignment = false`) — ليست ملك المكتبة.
 * أيّ انحرافٍ عن استعلام `reportsFinancialService` هنا يجعل اللقطة تقيس شيئاً آخر غير الأصل.
 */
import { and, eq, sql } from "drizzle-orm";
import { branchStock, productVariants, products } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";

export interface BranchInventoryValue {
  branchId: number;
  value: string;
}

export interface InventoryValuation {
  /** إجمالي قيمة المخزون المملوك (بلا الأمانة) — نصّاً بمنزلتين. */
  total: string;
  /** التفصيل لكل فرعٍ له قيمة — الميزانية تُقرأ لكل فرعٍ على حدة أيضاً. */
  branches: BranchInventoryValue[];
}

/** يقرأ قيمة المخزون المملوك مجمَّعةً لكل فرع (نفس شرط الميزانية حرفياً). */
export async function readInventoryValuation(tx: Tx): Promise<InventoryValuation> {
  const rows = await tx
    .select({
      branchId: branchStock.branchId,
      value: sql<string>`CAST(COALESCE(SUM(${branchStock.quantity} * ${productVariants.costPrice}), 0) AS CHAR)`,
    })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(products.isConsignment, false)))
    .groupBy(branchStock.branchId);

  let total = money(0);
  const branches: BranchInventoryValue[] = [];
  for (const r of rows) {
    const v = round2(money(r.value ?? 0));
    total = total.plus(v);
    // الفرع بقيمةٍ صفرية لا يُدرَج: صفّ الرصيد يبقى قائماً بعد نفاد الصنف، فإدراجه يُضخّم اللقطة
    // بصفوفٍ لا تحمل معلومة. والسالب يبقى (رصيدٌ سالبٌ مسموحٌ في وضع الافتتاح، وقيمتُه حقيقية).
    if (!v.isZero()) branches.push({ branchId: Number(r.branchId), value: toDbMoney(v) });
  }
  branches.sort((a, b) => a.branchId - b.branchId);
  return { total: toDbMoney(round2(total)), branches };
}

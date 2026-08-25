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
 *
 * ## المخزون بالطريق (P1-#1، ٢٥/٨)
 *
 * التحويلُ بين الفروع يخصم من المصدر عند الإرسال (TRANSFER_OUT فوراً) ولا يُضاف إلى الوجهة إلّا
 * عند الاستلام (TRANSFER_IN). النافذةُ بينهما — «بالطريق» — كانت **لا تظهر في قيمة الأصل**
 * لأنّ `branchStock` وحده يُقرأ، فينخفض الأصل بمقدار السند طوال فترة النقل ثمّ يعود عند الاستلام.
 * الحملُ الآن يُدرَج ضمن الأصل، منسوباً إلى الفرع **المصدر** (البضاعة كانت في عهدته حتى تسلَّمها
 * الوجهة؛ نمطُ قيد «عجز النقل» في `transferService.ts` يُثبت نفس النسبة). الفروع تظلّ مستقلّةَ
 * القيمة، والمجموع يعكس الحقيقة الاقتصادية بلا تذبذبٍ يوميّ.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  branchStock,
  productVariants,
  products,
  stockTransferLines,
  stockTransfers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";

export interface BranchInventoryValue {
  branchId: number;
  /** قيمةُ المخزون المستقرّ في `branchStock` لهذا الفرع (نصّاً بمنزلتين). */
  value: string;
  /**
   * قيمةُ المخزون بالطريق **الصادرِ من هذا الفرع** — قد تكون "0.00" إن لم يكن للفرع سنداتٌ
   * قائمة. تدخل في `total` أعلاه. اختيارياً موجودة كي لا تكسر مستهلكاً قديماً لا يتوقّعها.
   */
  inTransitValue?: string;
}

export interface InventoryValuation {
  /**
   * إجمالي قيمة المخزون المملوك = المستقرّ + بالطريق (بلا الأمانة) — نصّاً بمنزلتين. هذا هو
   * الرقمُ الذي يدخل ميزانيةَ الشركة (ولقطةَ إقفال السنة). قبل ٢٥/٨ كان يستثني «بالطريق».
   */
  total: string;
  /** التفصيل لكل فرعٍ له قيمة (يشمل الحمل الصادر بالطريق). */
  branches: BranchInventoryValue[];
  /**
   * الحملُ الكلّيّ بالطريق عبر كل السندات القائمة — يُساوي مجموع `inTransitValue` أعلاه، ويُعرَض
   * سطراً مستقلّاً في الميزانية/الشاشة كي يرى المدير حجمَه (سندات معلَّقة طويلاً = ضجيج في الأصل).
   */
  inTransitTotal: string;
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

  // ⭐ P1-#1: الحمل بالطريق مجمَّعاً بفرعِ المصدر — نفس شرط الأمانة (isConsignment=false) كي يبقى
  // التعريف موحَّداً مع الأصل المستقرّ. الكميّةُ = quantitySent − COALESCE(quantityReceived,0):
  // ما دام السند IN_TRANSIT، quantityReceived تكون NULL فتصير القيمة = المرسَل كاملاً؛ الحالات
  // RECEIVED/CANCELLED تخرج بشرط status صراحةً كي لا نحتسب سنداً مقفولاً. التكلفةُ = WAVG الحالي
  // (نفس ما يُطبَّق على branchStock) — الاتّساقُ أهمّ من دقّة اللقطة التاريخيّة في المرحلة ١؛
  // لقطةٌ تاريخيّة مؤرَّشة كاملةٌ هي البند P1-#2 في تقرير المراجعة.
  const inTransitRows = await tx
    .select({
      fromBranchId: stockTransfers.fromBranchId,
      value: sql<string>`CAST(COALESCE(SUM((${stockTransferLines.quantitySent} - COALESCE(${stockTransferLines.quantityReceived}, 0)) * ${productVariants.costPrice}), 0) AS CHAR)`,
    })
    .from(stockTransfers)
    .innerJoin(stockTransferLines, eq(stockTransferLines.transferId, stockTransfers.id))
    .innerJoin(productVariants, eq(productVariants.id, stockTransferLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(stockTransfers.status, "IN_TRANSIT"), eq(products.isConsignment, false)))
    .groupBy(stockTransfers.fromBranchId);
  const inTransitByBranch = new Map<number, ReturnType<typeof money>>();
  let inTransitTotal = money(0);
  for (const r of inTransitRows) {
    const v = round2(money(r.value ?? 0));
    if (v.isZero()) continue;
    inTransitByBranch.set(Number(r.fromBranchId), v);
    inTransitTotal = inTransitTotal.plus(v);
  }

  let total = money(0);
  const branches: BranchInventoryValue[] = [];
  const seenBranches = new Set<number>();
  for (const r of rows) {
    const v = round2(money(r.value ?? 0));
    total = total.plus(v);
    const branchId = Number(r.branchId);
    seenBranches.add(branchId);
    const inTransit = inTransitByBranch.get(branchId);
    // الفرع بقيمةٍ صفرية لا يُدرَج **إلّا** إن كان له حمل بالطريق — بذلك لا يختفي فرعٌ مصدر أصولُه
    // كلّها بالطريق. والسالب يبقى (رصيدٌ سالبٌ مسموحٌ في وضع الافتتاح، وقيمتُه حقيقية).
    if (!v.isZero() || (inTransit && !inTransit.isZero())) {
      branches.push({
        branchId,
        value: toDbMoney(v),
        ...(inTransit && !inTransit.isZero() ? { inTransitValue: toDbMoney(round2(inTransit)) } : {}),
      });
    }
  }
  // فرعٌ ليس له `branchStock` قائم لكنّه أرسل سنداً — يُدرَج كذلك (قيمةُ المستقرّ صفر، والحملُ حقيقيّ).
  Array.from(inTransitByBranch.entries()).forEach(([branchId, inTransit]) => {
    if (seenBranches.has(branchId)) return;
    branches.push({ branchId, value: "0.00", inTransitValue: toDbMoney(round2(inTransit)) });
  });
  total = total.plus(inTransitTotal);
  branches.sort((a, b) => a.branchId - b.branchId);
  return {
    total: toDbMoney(round2(total)),
    branches,
    inTransitTotal: toDbMoney(round2(inTransitTotal)),
  };
}

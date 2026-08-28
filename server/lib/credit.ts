import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customers } from "../../drizzle/schema";
import { money, type DecimalInput } from "../services/money";

/** يَتحقّق من حدّ الائتمان للعميل قبل بيع آجل/زيادة على الذمم.
 *
 *  دلالة creditLimit (إصلاح H4):
 *  - `null` ⇒ بلا حدّ مفروض (سماح كامل بالبيع الآجل).
 *  - `'0'` أو 0 ⇒ حظر كامل للبيع الآجل (لا ائتمان لهذا العميل).
 *  - موجب (> 0) ⇒ يُفحص: `currentBalance + addAmount ≤ creditLimit`.
 *
 *  paymentMode (٢٨/٨/٢٦، هجرة 0276):
 *  - `'COD'` (Cash on Delivery) ⇒ **يُتجاوز الفحص كلّياً**. المال يأتي مع المندوب لحظة
 *    التسليم — لا يُترك ديناً على العميل، فلا مبرِّرَ لفحص السقف. كان هذا الفحصُ يمنع
 *    زبونَ الاتّصال الجديد من طلب توصيلٍ COD (بلاغ المالك): `creditLimit='0'` الافتراضيّ
 *    كان يحظر كلَّ ما ليس مدفوعاً لحظياً، بينما COD **ليس ائتماناً** — هو تأجيلٌ لساعات.
 *  - `'PREPAID'` / `'CREDIT'` / غير مُمرَّر ⇒ الفحص الكامل (نمط ما قبل الهجرة).
 *
 *  يَقرأ صفّ العميل بـ`.for("update")` لتسلسل البيوع المتزامنة.
 *  يَرمي TRPCError code='FORBIDDEN' عند تجاوز الحدّ أو حظر الائتمان.
 *
 *  ملاحظة: `branchId` مُمرَّر للسجلّ والمراقبة (auditService) لكنه لا يُغيّر القرار
 *  حالياً — حدّ الائتمان عالمي عبر الفروع (الرصيد مُجمَّع على العميل).
 */
export type CreditPaymentMode = "PREPAID" | "COD" | "CREDIT";

export async function assertCreditLimit(
  tx: any,
  customerId: number,
  addAmount: DecimalInput,
  _branchId: number,
  paymentMode?: CreditPaymentMode,
): Promise<void> {
  const add = money(addAmount);
  if (add.lte(0)) return; // لا زيادة على الذمم ⇒ لا فحص (نقدي بحت أو دفعة).
  // COD: المال يأتي مع المندوب لا يبقى ديناً — لا مبرِّرَ لفحص السقف الائتمانيّ.
  // ⛔ لا يمرّ COD بلا حماية: مسار workOrder.deliver يفرض التحصيل الكامل عند التسليم بشكل
  // منفصل (assertNoUnpaidRemainderOnCOD)، فحماية «لا دينار صامت» مضمونةٌ هناك لا هنا.
  if (paymentMode === "COD") return;

  const rows = await tx
    .select({
      creditLimit: customers.creditLimit,
      currentBalance: customers.currentBalance,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .for("update")
    .limit(1);

  if (!rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
  }

  const rawLimit = rows[0].creditLimit;

  // null ⇒ بلا حدّ مفروض (سماح كامل).
  if (rawLimit === null || rawLimit === undefined) return;

  const limit = money(rawLimit);

  // 0 صريح ⇒ حظر كامل للبيع الآجل لهذا العميل.
  // ١٩/٨ (بلاغ حيّ من المالك): كانت الرسالة «تجاوز حدّ الائتمان» — وهي **خاطئة دلالياً**
  // في هذه الحالة: لا تجاوزَ هنا، بل العميل غير مصرَّحٍ له بالآجل أصلاً (وهذا هو الافتراضي
  // لكل عميلٍ جديد بقرار المالك). فيقف الموظّف أمام رفضٍ لا يفهم سببه ولا مخرجه.
  if (limit.isZero()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر) — حصّل كامل المبلغ، أو اطلب من المدير رفع حدّه من ملف العميل",
    });
  }

  // موجب ⇒ فحص الإسقاط.
  const balance = money(rows[0].currentBalance ?? "0");
  const projected = balance.plus(add);
  if (projected.gt(limit)) {
    // الرسالة تحمل الأرقام الثلاثة: ما عليه الآن، وما يضيفه هذا البيع، وسقفه — فيقرّر
    // الموظّف فوراً (يحصّل الفرق أم يستأذن المدير) بدل رفضٍ صامت يعيد المحاولة نفسها.
    const available = limit.minus(balance);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `تجاوز حدّ الائتمان: على العميل ${balance.toFixed(2)} وهذا البيع يضيف ${add.toFixed(2)}، وسقفه ${limit.toFixed(2)} — المتاح ${available.lte(0) ? "0.00" : available.toFixed(2)}. حصّل الفرق أو ارفع الحدّ من ملف العميل`,
    });
  }
}

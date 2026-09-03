/**
 * تخصيص سند العميل لفاتورةٍ بعينها — **المنفذ الوحيد** الذي يُحرّك `invoices.paidAmount`
 * من مسار السندات (إنشاءً واعتماداً وإلغاءً).
 *
 * ## العلّة التي يُغلقها
 *
 * `createVoucher` كان يخزّن `receipts.invoiceId` ويُرحّل القيد ويُنقص رصيد العميل — ولا يمسّ
 * الفاتورة إطلاقاً (وُصف الربط في `cancel.ts` بأنه «توثيقيّ بحت»). فينشأ تناقضٌ على **شاشةٍ
 * واحدة**: `sales.get` يُرجع كلّ إيصالات الفاتورة في «سجلّ الدفعات» — ومنها إيصال السند —
 * فيرى الموظّف قبضاً بـ١٠٠٬٠٠٠ مسجَّلاً، وفوقه «المدفوع: ٠» و«المتبقّي: الإجمالي» وشارة
 * «غير مدفوعة».
 *
 * والأخطر أنّ `sales.pay` يشتقّ المتبقّي من `paidAmount` وحده ⇒ **لا شيء يمنع تحصيل المبلغ
 * نفسه مرّتين**: الأولى بسندٍ مربوط، والثانية من زرّ الدفع على الفاتورة. رصيد العميل ينقلب
 * دائناً بالفرق (مالٌ قابلٌ للاسترداد، لكنّه قُبض مرّتين بلا حارس).
 *
 * ## القاعدة
 *
 * ربطُ السند بفاتورة **قرارُ تخصيصٍ ماليّ لا حاشية توثيقية**: الشاشة تُرشّح للمحاسب فواتير
 * العميل المستحقّة ويختار واحدة، فالنيّة صريحة. لذا يُعامَل القبض المربوط معاملة `sales.pay`
 * حرفياً — نفس الحرّاس، ونفس تحديث الحالة، ونفس الاشتقاق.
 *
 * ## لماذا يُرفَض الفائض بدل تقصيصه
 *
 * السقف يُرفَض صراحةً (لا يُخصَّص جزءٌ ويُترك الباقي رصيداً) كي يبقى **الإلغاء عكساً تامّاً**:
 * لا عمود يحفظ «كم خُصِّص فعلاً» من الإيصال، فالتقصيص يجعل عكس الإلغاء تخميناً. والمحاسب
 * الذي يقبض مبلغاً يغطّي عدّة فواتير يترك الربط فارغاً (اختياريّ) أو يقسّمه — والرسالة تقول له ذلك.
 */
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { invoices } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { computeInvoiceStatus } from "../ledgerService";
import { money, toDbMoney } from "../money";

export interface VoucherInvoiceAllocationInput {
  invoiceId: number;
  /** مبلغ السند (موجب دائماً). */
  amount: Decimal;
  /** IN = قبضٌ يزيد المدفوع · OUT = ردٌّ للعميل ينقصه. */
  direction: "IN" | "OUT";
  /** طريقة السند — تُكتب على الفاتورة فقط إن كانت فارغة (لا تدهس عربوناً سابقاً). */
  paymentMethod?: string | null;
}

/**
 * يُطبّق (أو يعكس) تخصيص سندٍ على فاتورة تحت قفل الصفّ. يُستدعى **داخل** معاملة السند
 * القائمة فيبقى الأثر ذرّياً مع الإيصال والقيد ورصيد العميل.
 */
export async function allocateVoucherToInvoiceTx(
  tx: Tx,
  input: VoucherInvoiceAllocationInput,
): Promise<{ paidAmount: string; status: string }> {
  const inv = (
    await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1)
  )[0];
  if (!inv) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة المرتبطة غير موجودة" });
  }

  // اتجاه الأثر: القبض يزيد المدفوع، والردّ/الإلغاء ينقصه.
  const isCredit = input.direction === "IN";
  const paid = money(inv.paidAmount);
  const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));

  // الحالة النهائية تُفحص عند التخصيص لا عند الإنشاء وحده: بين طلبِ سندٍ واعتماده قد تُلغى
  // الفاتورة أو تُصحَّح، فيصير تخصيصُ المال لها نسبةً لمستندٍ ميت.
  // ⚠️ **الإنقاص مُستثنى دائماً**: هو ردٌّ أو عكسُ سندٍ مُلغى، ويجب أن يبقى ممكناً مهما صارت
  // حالة الفاتورة — وإلّا احتُجز مالٌ مخصَّصٌ لفاتورةٍ ماتت بلا أيّ مخرج (نقضٌ للمبدأ الحاكم:
  // كل مالٍ محتجَز يلزمه مسار خروجٍ ممكنٌ دائماً).
  if (isCredit && isDeadInvoiceStatus(inv.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن تخصيص السند لفاتورة ملغاة أو مرتجعة أو مستبدَلة بمصحّحة",
    });
  }

  if (isCredit) {
    const remaining = net.minus(paid);
    if (input.amount.gt(remaining)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `مبلغ السند (${input.amount.toFixed(2)}) يتجاوز المتبقّي على الفاتورة ` +
          `(${remaining.gt(0) ? remaining.toFixed(2) : "0.00"}). اترك الربط بالفاتورة فارغاً ` +
          `لقيده على حساب العميل، أو قسّمه على فواتيره.`,
      });
    }
  } else {
    // الإنقاص لا يُنزل المدفوع تحت الصفر (دفاعٌ متعمّق ضدّ عكسٍ مزدوج).
    if (input.amount.gt(paid)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `المبلغ (${input.amount.toFixed(2)}) يتجاوز المدفوع على الفاتورة (${paid.toFixed(2)}).`,
      });
    }
  }

  const newPaid = isCredit ? paid.plus(input.amount) : paid.minus(input.amount);
  /**
   * ⭐ **المستند الميت يبقى ميتاً** (تدقيق ١/٩/٢٦).
   * `computeInvoiceStatus` تُنتج PENDING/PARTIALLY_PAID/PAID **حصراً** — لا تعرف RETURNED ولا
   * CANCELLED ولا SUPERSEDED. وبما أنّ الإنقاص (`direction="OUT"`) مُستثنى عمداً من حارس
   * المستند الميت أعلاه (ولمالٍ محتجَزٍ مسارُ خروجٍ دائماً)، كان عكسُ سندٍ على فاتورةٍ
   * **مُرتجَعةٍ بالكامل** يكتب عليها PAID فيُحييها: تعود «مدفوعة» في كل شاشةٍ وتقريرٍ
   * وطباعةٍ ورسالة واتساب، **وتنطفئ معها كلّ حرّاس `isDeadInvoiceStatus`** فيصير ممكناً
   * فتحُ طلب إلغاءٍ أو تصحيحٍ أو استبدالٍ عليها وربطُ سندٍ جديدٍ بها.
   * الحالة النهائية ملكُ مسارها الذي أنشأها (`returnService`/`cancel`/`correct`) لا مسار السداد.
   */
  const status = isDeadInvoiceStatus(inv.status)
    ? inv.status
    : computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0");

  await tx
    .update(invoices)
    .set({
      paidAmount: toDbMoney(newPaid),
      status,
      ...(isCredit
        ? {
            paymentDate: new Date(),
            // COALESCE لا OVERWRITE: فاتورةٌ عربونها بطاقة ثمّ سُدّدت بسندٍ نقديّ تبقى «بطاقة»
            // بدل أن تدهسها آخر دفعة — نفس اصطلاح مسارات تحصيل التوصيل.
            ...(input.paymentMethod
              ? { paymentMethod: sql`COALESCE(${invoices.paymentMethod}, ${input.paymentMethod})` }
              : {}),
          }
        : {}),
    })
    .where(eq(invoices.id, input.invoiceId));

  return { paidAmount: toDbMoney(newPaid), status };
}

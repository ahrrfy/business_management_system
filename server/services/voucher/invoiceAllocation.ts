import { activeDeliveryInvoiceIdsTx } from "../delivery/guards";
/** Locked single-invoice allocation kernel. Generic receipts use the persisted
 * FIFO portions in customerReceiptSettlement.ts; explicitly selected invoices
 * retain their strict remaining-amount guard. No cash, GL or AR is posted here.
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { eq, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { invoices } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { isDeadInvoice } from "@shared/predicates";
import { computeInvoiceStatus } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { mixedAwarePaymentMethod } from "../sale/payment";

export interface VoucherInvoiceAllocationInput {
  invoiceId: number;
  /** مبلغ السند (موجب دائماً). */
  amount: Decimal;
  /** IN = قبضٌ يزيد المدفوع · OUT = ردٌّ للعميل ينقصه. */
  direction: "IN" | "OUT";
  /** طريقة السند — تُكتب على الفاتورة فقط إن كانت فارغة (لا تدهس عربوناً سابقاً). */
  paymentMethod?: string | null;
  /** معرف الفرع التابع له السند — لمنع سداد فواتير الفروع الأخرى بدون مقاصة معتمدة (VULN-FIN-02). */
  voucherBranchId?: number | null;
  /** إذن تجاوز صريح للمقاصة بين الفروع عبر بروتوكول نظامي معتمد. */
  allowInterBranchClearing?: boolean;
  /**
   * وضع الاعتماد المرن (EDGE-FIN-01):
   * إذا كانت الفاتورة مسددة مسبقاً أو ملغاة أو لا تكفي لاستيعاب كامل المبلغ،
   * لا يرمي خطأً يعطل الاعتماد بل يعيد { allocated: false } لفك ربط الفاتورة وقيد المبلغ على حساب العميل.
   */
  gracefulSettledInvoice?: boolean;
  /** Trusted inverse of an actual OUT; restores paid even on a terminal invoice. */
  restoreReversedRefund?: boolean;
}

export interface VoucherInvoiceAllocationResult {
  paidAmount: string;
  status: string;
  allocated: boolean;
  unallocatedReason?: "DEAD_INVOICE" | "ALREADY_SETTLED" | "EXCEEDS_REMAINING" | "EXCEEDS_PAID" | "DELIVERY_ACTIVE";
}

/**
 * يُطبّق (أو يعكس) تخصيص سندٍ على فاتورة تحت قفل الصفّ. يُستدعى **داخل** معاملة السند
 * القائمة فيبقى الأثر ذرّياً مع الإيصال والقيد ورصيد العميل.
 */
export async function allocateVoucherToInvoiceTx(
  tx: Tx,
  input: VoucherInvoiceAllocationInput,
): Promise<VoucherInvoiceAllocationResult> {
  const inv = (
    await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1)
  )[0];
  if (!inv) {
    throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة المرتبطة غير موجودة" });
  }

  // تحقق مطابقة الفرع (VULN-FIN-02): منع سداد فاتورة فرع آخر بسند قبض محلي
  // يُستثنى الإنقاص (عكس/إلغاء سند قائم) أو عند طلب مقاصة صريحة معتمدة
  if (
    input.voucherBranchId != null &&
    Number(inv.branchId) !== Number(input.voucherBranchId) &&
    input.direction === "IN" &&
    !input.allowInterBranchClearing
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لا يمكن سداد فاتورة فرع آخر بسند قبض محلي",
        why: `الفاتورة #${inv.id} تتبع الفرع (${inv.branchId}) ولا يمكن سدادها بسند صادر من الفرع (${input.voucherBranchId})`,
        doThis: "سدّد الفاتورة من فرعها الأصلي أو استخدم مقاصة تسوية بين الفروع المعتمدة",
      }),
    });
  }

  // اتجاه الأثر: القبض يزيد المدفوع، والردّ/الإلغاء ينقصه.
  const isCredit = input.direction === "IN";
  if ((await activeDeliveryInvoiceIdsTx(tx, [inv.id])).has(inv.id)) {
    if (isCredit && input.gracefulSettledInvoice) return { paidAmount: inv.paidAmount, status: inv.status, allocated: false, unallocatedReason: "DELIVERY_ACTIVE" };
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: "تعذر تخصيص سند عام لفاتورة توصيل نشطة",
      why: "للإرسالية عهدة تحصيل وتوريد مستقلة، حتى عند ثبوت وصول الطرد",
      doThis: "استخدم تحصيل الإرسالية أو أكمل إلغاء إسنادها من مسار التوصيل؛ السند العام يسدد الفواتير المؤهلة فقط",
    }) });
  }
  const paid = money(inv.paidAmount);
  const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));

  // الحالة النهائية تُفحص عند التخصيص لا عند الإنشاء وحده: بين طلبِ سندٍ واعتماده قد تُلغى
  // الفاتورة أو تُصحَّح، فيصير تخصيصُ المال لها نسبةً لمستندٍ ميت.
  // ⚠️ **الإنقاص مُستثنى دائماً**: هو ردٌّ أو عكسُ سندٍ مُلغى، ويجب أن يبقى ممكناً مهما صارت
  // حالة الفاتورة — وإلّا احتُجز مالٌ مخصَّصٌ لفاتورةٍ ماتت بلا أيّ مخرج (نقضٌ للمبدأ الحاكم:
  // كل مالٍ محتجَز يلزمه مسار خروجٍ ممكنٌ دائماً).
  if (isCredit && isDeadInvoice(inv) && !input.restoreReversedRefund) {
    if (input.gracefulSettledInvoice) {
      return {
        paidAmount: inv.paidAmount,
        status: inv.status,
        allocated: false,
        unallocatedReason: "DEAD_INVOICE",
      };
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن تخصيص السند لفاتورة ملغاة أو مرتجعة أو مستبدَلة بمصحّحة",
    });
  }

  if (isCredit && !input.restoreReversedRefund) {
    const remaining = net.minus(paid);
    if (input.amount.gt(remaining)) {
      if (input.gracefulSettledInvoice) {
        return {
          paidAmount: inv.paidAmount,
          status: inv.status,
          allocated: false,
          unallocatedReason: remaining.lte(0) ? "ALREADY_SETTLED" : "EXCEEDS_REMAINING",
        };
      }
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `مبلغ السند (${input.amount.toFixed(2)}) يتجاوز المتبقّي على الفاتورة ` +
          `(${remaining.gt(0) ? remaining.toFixed(2) : "0.00"}). اترك الربط بالفاتورة فارغاً ` +
          `لقيده على حساب العميل، أو قسّمه على فواتيره.`,
      });
    }
  } else if (!isCredit) {
    // الإنقاص لا يُنزل المدفوع تحت الصفر (دفاعٌ متعمّق ضدّ عكسٍ مزدوج).
    if (input.amount.gt(paid)) {
      if (input.gracefulSettledInvoice) {
        return {
          paidAmount: inv.paidAmount,
          status: inv.status,
          allocated: false,
          unallocatedReason: "EXCEEDS_PAID",
        };
      }
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
  const status = isDeadInvoice(inv)
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
            ...(input.paymentMethod
              ? { paymentMethod: mixedAwarePaymentMethod(inv.paymentMethod, input.paymentMethod) }
              : {}),
          }
        : {}),
    })
    .where(eq(invoices.id, input.invoiceId));

  return { paidAmount: toDbMoney(newPaid), status, allocated: true };
}

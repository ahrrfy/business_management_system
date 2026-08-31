// تصحيح فاتورة بيع مُثبَّتة (0168) — «عكسٌ كامل + إعادة إصدار» ذرّياً.
//
// الوثيقة الحاكمة: docs/invoice-correction-design-2026-08-10.md (مُعتمَدةٌ بقرارات المالك §١٠).
// المبدأ: الفاتورة المُثبَّتة لا تُعدَّل حرّاً (تحرّك الدفتر/المخزون/الذمم). «تصحيحها» =
//   ① عكسها كاملاً بمنطق المرتجع المُختبَر (returnSaleInTx، بلا ردٍّ نقديّ) ⇒ يُعكَس
//      الدفتر/COGS/المخزون/الأمانة/تقريب IQD، وترجع الذمّة كاملةً (−الإجمالي).
//   ② تصحيح الذمّة: نُعيد المدفوع (+paid) لأنّه لا يُردّ بل يُنقَل للفاتورة الجديدة ⇒ صافي عكس
//      الذمّة = −(الإجمالي − المدفوع)، مطابقٌ لإزالة مساهمة الأصل في AR.
//   ③ فصل إيصالات القبض عن الأصل (invoiceId ← NULL) ثم إعادة ختمها بالفاتورة الجديدة عبر
//      preCollected.receiptIds (append-only، لا إيصالٌ ثانٍ ولا نقدٌ جديد يدخل الدرج).
//   ④ إعادة الترحيل بالبيانات المصحّحة عبر createSaleInTx (كل حرّاسه: تسعير/ائتمان/تحت التكلفة/
//      مخزون) ⇒ فاتورةٌ جديدة، والأصل يصير SUPERSEDED مربوطاً بها.
//   ⑤ الفرق الزائد (overpay: المصحّح < المقبوض) هجينٌ بقرار الموظّف: رصيد دائن للعميل، أو استرداد
//      نقديّ من الدرج (قرار المالك §١٠). النقص (المصحّح > المقبوض) يُحصَّل الآن بـadditionalPayment.
//
// العمولة/التقارير تُشتقّ من الدفتر لا من حالة الفاتورة (commissions/base.ts:17-18) ⇒ تتعافى
// ذاتياً: قيود RETURN تعكس استحقاق الأصل، وقيد SALE الجديد يثبّت المصحّح.
//
// v1 (مؤجَّلٌ صريحاً، يُرفَض بأمان): المُرتجَعة (كلياً/جزئياً)، منشأ WORKORDER، الرقمية، التوصيل النشط.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  accountingEntries,
  digitalSaleDetails,
  externalPaymentAttempts,
  invoiceItems,
  invoices,
  products,
  productVariants,
  receipts,
} from "../../../drizzle/schema";
import { createPostingIntent, creditLine, debitLine,
} from "../accounting/postingEngine";
import { assertCashOutAvailable, lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { returnSaleInTx } from "../returnService";
import { resolveBranchCashShiftTx } from "../shiftService";
import { withTx, type Actor } from "../tx";
import { extractInsertId } from "../../lib/insertId";
import { createSaleInTx } from "./create";
import type { PriceTier } from "../pricing";
import type { SaleLineInput } from "./types";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { assertInvoiceReversalDeliverySafeTx } from "./invoiceCancellationGuard";
import {
  assertExternalPaymentReplay,
  consumeConfirmedExternalPaymentAttemptTx,
  lockConfirmedExternalPaymentAttempt,
  type LockedExternalPaymentAttempt,
} from "../posExternalPayment";
import { assertNoActiveInstallmentPlanAfterInvoiceLockTx } from "../installment/guards";
import { assertPeriodOpen } from "../periodLockService";
import type { Tx } from "../../db";
import { assertLockedInvoiceControlSnapshotTx, type InvoiceControlSnapshot } from "./controlSnapshot";

type CorrectionPayMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface CorrectSaleInput {
  originalInvoiceId: number;
  // ── البيانات المصحّحة (نفس عقد البيع، الحقول القابلة للتصحيح فقط) ──
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: PriceTier | null;
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  deliveryFee?: string | null;
  taxRatePercent?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  /** دفعةٌ إضافية تُحصَّل الآن حين يزيد المصحّح على المقبوض سلفاً (نقص). */
  additionalPayment?: { amount: string; method: CorrectionPayMethod; reference?: string | null;
    externalPaymentAttemptId?: number | null;
    externalPaymentDeviceId?: string | null;
  } | null;
  /** معالجة الفرق الزائد (المصحّح < المقبوض) — قرار الموظّف الهجين (§١٠). */
  overpayHandling?: "CREDIT" | "CASH_REFUND";
  /** درج الاسترداد النقديّ للفرق الزائد عند تعدّد الدرج المفتوح. */
  overpayRefundShiftId?: number | null;
  /** تجاوز حدّ الائتمان إن أنشأ التصحيح تعرّضاً آجلاً (يمرّره الراوتر بعد التحقّق). */
  creditApproved?: boolean;
  creditApprovalId?: number;
  managerOverrideByUserId?: number;
  /** موافقة على بيعٍ تحت التكلفة في السطور المصحّحة (يضبطها الراوتر). */
  priceOverrideApproved?: boolean;
  clientRequestId?: string | null;
  /** لقطة طلب التحكم؛ لا تُقبل من الراوتر العام وتُطابَق بعد قفل الأصل. */
  controlExpectedSnapshot?: InvoiceControlSnapshot | null;
}

export interface CorrectSaleResult {
  originalInvoiceId: number;
  correctedInvoiceId: number;
  correctedInvoiceNumber: string;
  total: string;
  /** الفرق الزائد المُعالَج (رصيد/استرداد) — صفر إن لم يكن. */
  overpay: string;
  overpayHandled?: "CREDIT" | "CASH_REFUND";
  idempotentReplay?: boolean;
}

export async function correctSale(input: CorrectSaleInput, actor: Actor & { role?: string },
): Promise<CorrectSaleResult> {
  return withTx((tx) => correctSaleInTx(tx, input, actor));
}

/** جسم إعادة الإصدار/الاستبدال داخل معاملة قائمة لضمان ذرية الاعتماد مع سجل التحكم. */
export async function correctSaleInTx(
  tx: Tx,
  input: CorrectSaleInput,
  actor: Actor & { role?: string },
): Promise<CorrectSaleResult> {
  if (input.additionalPayment) {
    assertPosPaymentMethodEnabled(input.additionalPayment.method);
    if (input.additionalPayment.method === "CASH") {
      if (
        input.additionalPayment.externalPaymentAttemptId != null ||
        input.additionalPayment.externalPaymentDeviceId?.trim()
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الدفع النقدي لا يحمل محاولة دفع خارجية",
        });
      }
    } else if (
      !input.additionalPayment.externalPaymentAttemptId ||
      !input.additionalPayment.externalPaymentDeviceId?.trim()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أكّد الدفع الخارجي قبل تحصيل فرق التصحيح",
      });
    }
  }

    // ── ٠) idempotency: إعادة التشغيل بنفس المفتاح تُعيد التصحيح الأوّل (refId = الفاتورة الجديدة) ──
    if (input.clientRequestId) {
      const existingNewId = await findIdempotentRefId(tx, "sale.correct", input.clientRequestId,
      );
      if (existingNewId != null) {
        const nrow = (await tx
          .select({ id: invoices.id, number: invoices.invoiceNumber, total: invoices.total,
              branchId: invoices.branchId,
              correctionOf: invoices.correctionOfInvoiceId,
            })
          .from(invoices).where(eq(invoices.id, Number(existingNewId))).limit(1))[0];
        if (!nrow) throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: تصحيحٌ مُسجَّلٌ بلا فاتورة",
          });
        if (Number(nrow.correctionOf) !== Number(input.originalInvoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح يخص تصحيح فاتورة أخرى",
          });
        }
        const linkedExternalAttempt = (
          await tx
            .select({ id: externalPaymentAttempts.id })
            .from(externalPaymentAttempts)
            .where(
              and(
                eq(externalPaymentAttempts.invoiceId, Number(nrow.id)),
                eq(externalPaymentAttempts.channel, "SALES_COLLECTION"),
              ),
            )
            .limit(1)
        )[0];
        if (
          linkedExternalAttempt &&
          (!input.additionalPayment ||
            input.additionalPayment.method === "CASH")
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "تعارض idempotency: التصحيح الأصلي قبض فرقاً غير نقدي بمحاولة مؤكدة",
          });
        }
        if (
          input.additionalPayment &&
          input.additionalPayment.method !== "CASH"
        ) {
          await assertExternalPaymentReplay(
            tx,
            Number(nrow.id),
            {
              branchId: Number(nrow.branchId),
              channel: "SALES_COLLECTION",
              method: input.additionalPayment.method,
              amount: input.additionalPayment.amount,
              attemptId: input.additionalPayment.externalPaymentAttemptId,
              deviceId: input.additionalPayment.externalPaymentDeviceId,
            },
            actor,
          );
        }
        return {
          originalInvoiceId: Number(nrow.correctionOf ?? input.originalInvoiceId,
          ),
          correctedInvoiceId: Number(nrow.id),
          correctedInvoiceNumber: nrow.number,
          total: nrow.total,
          overpay: "0.00",
          idempotentReplay: true,
        };
      }
    }

    // ── ٠.٥) قفل درج الاسترداد **قبل** قفل الفاتورة ──
    //    ترتيب القفل الحاكم في كل مسارات المال: المصدر (الدرج) ← الطرف ← المستند. `returnSaleInTx`
    //    يقفل الدرج أولاً؛ فلو أخّرناه هنا إلى ما بعد قفل الفاتورة لتعاكس المسارانِ على نفس الدرج
    //    والفاتورة ⇒ deadlock. ولمّا كان الفرق الزائد غير معلومٍ إلا بعد إعادة الترحيل (خطوة ⑦)،
    //    نقفل مسبقاً بحسب **المدخلات وحدها** (حتميّ): إمّا طلبٌ صريح باسترداد نقديّ، أو فاتورةٌ
    //    مقبوضةٌ بلا عميلٍ مسجَّل (الزبون العابر لا يحمل رصيداً دائناً ⇒ النقد مخرجه الوحيد).
    const invPreview = (
      await tx.select({ branchId: invoices.branchId, paidAmount: invoices.paidAmount, customerId: invoices.customerId,
        })
        .from(invoices).where(eq(invoices.id, input.originalInvoiceId)).limit(1)
    )[0];
    if (!invPreview) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة",
      });
    if (
      actor.role !== "admin" &&
      Number(invPreview.branchId) !== Number(actor.branchId)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "الفاتورة لا تخصّ فرعك",
      });
    }
    const previewPaid = round2(money(invPreview.paidAmount ?? "0"));
    const targetCustomerPreview = input.customerId === undefined
      ? invPreview.customerId != null ? Number(invPreview.customerId) : null
        : input.customerId != null ? Number(input.customerId) : null;
    const mayNeedCashRefund =
      previewPaid.gt(0) &&
      (input.overpayHandling === "CASH_REFUND" || targetCustomerPreview == null);
    let prelockedOverpayShift: { shiftId: number } | null = null;
    if (mayNeedCashRefund) {
      prelockedOverpayShift = await resolveBranchCashShiftTx(
        tx,
        Number(invPreview.branchId),
        input.overpayRefundShiftId ?? null,
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(invPreview.branchId),
        cashBucket: "DRAWER",
        shiftId: prelockedOverpayShift.shiftId,
      });
    }

    // محاولة القبض غير النقدي مصدرٌ ماليّ أيضاً؛ تُقفل قبل الفاتورة/التوصيل كي لا ينفّذ
    // التصحيح كلّه ثم يكتشف أن المحاولة استهلكها كاتب آخر. الربط النهائي يبقى بعد إنشاء
    // الإيصال وفي المعاملة نفسها عبر consumeConfirmedExternalPaymentAttemptTx.
    let lockedAdditionalAttempt: LockedExternalPaymentAttempt | null = null;
    if (input.additionalPayment && input.additionalPayment.method !== "CASH") {
      lockedAdditionalAttempt = await lockConfirmedExternalPaymentAttempt(
        tx,
        {
          branchId: Number(invPreview.branchId),
          channel: "SALES_COLLECTION",
          method: input.additionalPayment.method,
          amount: input.additionalPayment.amount,
          attemptId: input.additionalPayment.externalPaymentAttemptId,
          deviceId: input.additionalPayment.externalPaymentDeviceId,
        },
        actor,
      );
    }

    // بعد مصدر النقد، اقفل جهة التوصيل→الإرسالية/طلب المتجر قبل الفاتورة. التصحيح عكسٌ كامل
    // مثل الإلغاء؛ لذلك لا يكفي غياب DISPATCHED/PARTIAL: DELIVERED+SETTLED وWRITTEN_OFF
    // يحملان حقيقةً تشغيلية/مالية نهائية لا يجوز محوها بإعادة الإصدار. السماح للحالة الملغاة
    // الثلاثية الآمنة فقط، تحت نفس gap/row locks، يغلق أيضاً سباق الإسناد مع التصحيح.
    await assertInvoiceReversalDeliverySafeTx(tx, {
      invoiceId: input.originalInvoiceId,
      expectedBranchId: Number(invPreview.branchId),
      mode: "CORRECT",
    });

    // ── ١) تحميل الأصل تحت قفل الصفّ + الحرّاس ──
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.originalInvoiceId)).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة",
      });
    if (Number(inv.branchId) !== Number(invPreview.branchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر فرع الفاتورة أثناء التصحيح؛ أعد المحاولة",
      });
    }
    await assertLockedInvoiceControlSnapshotTx(tx, inv, input.controlExpectedSnapshot);
    // دفاعٌ إضافي قبل أي نقل للإيصالات أو وسم SUPERSEDED؛ returnSaleInTx يعيد
    // الفحص أيضاً كي تبقى كل مسارات المرتجع محمية من تعديل شهر مقفل.
    await assertPeriodOpen(tx, inv.invoiceDate);
    await assertNoActiveInstallmentPlanAfterInvoiceLockTx(tx, {
      invoiceId: input.originalInvoiceId,
      operationLabel: "تصحيح الفاتورة وإعادة إصدارها",
    });
    if (
      inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُصحَّح فاتورة ملغاة/مرتجعة/مُستبدَلة سلفاً",
      });
    }
    // عزل الفرع (مرآة returnService): مدير فرعٍ لا يصحّح فاتورة فرعٍ آخر (يمسّ دفتره/درجه).
    if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة لا تخصّ فرعك",
      });
    }
    if (inv.sourceType === "WORKORDER") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فاتورة أمر الشغل تُصحَّح من تدفّق أمر الشغل، لا من هنا (المتغيّر الأساس لم يدخل المخزون فعلاً)",
      });
    }
    if (round2(money(inv.returnedTotal ?? "0")).gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُصحَّح فاتورةٌ عليها مرتجعٌ سابق — عالِجها عبر المرتجعات",
      });
    }
    // البطاقات الرقمية: عكسها بقرارٍ إداريّ عبر digitalCards.reversal (الكرت صدر من جهاز المزوّد).
    const digital = await tx.select({ id: digitalSaleDetails.id }).from(digitalSaleDetails).where(eq(digitalSaleDetails.invoiceId, input.originalInvoiceId)).limit(1);
    if (digital.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُصحَّح فاتورةٌ فيها كروتٌ رقمية — استعمل «عكس بيع الكروت»",
      });
    }

    const originalPaid = round2(money(inv.paidAmount));
    // ⭐ قرار المالك (١٧/٨/٢٦): **المقبوض يُنتقل للفاتورة المصحّحة كما هو**.
    //
    // كان هنا حظرٌ شاملٌ لأي فاتورةٍ عليها مقبوضات، بحجّة أنّ «نقل سند قبضٍ مكتمل يعيد كتابة
    // الحقيقة التاريخية للدرج/وسيلة الدفع». وهو حظرٌ أوسع ممّا يبرّره التنفيذ فعلاً: خطوة ④ لا
    // تمسّ الإيصال إلّا في مؤشّره (`invoiceId ← NULL` ثمّ ختمه بالجديدة عبر `preCollected.receiptIds`،
    // و`createSaleInTx` يكتب `.set({ invoiceId })` **وحده** تحت شرط `invoiceId IS NULL`). فالدرج
    // والطريقة والتاريخ والمبلغ تبقى كما هي حرفياً — وهو عين ما قرّره المالك.
    // والخطر الحقيقيّ الذي خشيه الكاتب (تمويلُ `paidAmount` من عربونٍ غير مختومٍ بهذه الفاتورة)
    // يحرسه **حارس النقل الماليّ** أدناه (`detachedSum === originalPaid`) رفضاً نظيفاً قبل أي كتابة.
    //
    // أثرُ الحظر عملياً: **كل** فاتورة استقبالٍ عليها عربون ⇒ لا تُعدَّل أبداً (بلاغ المالك:
    // «لا يمكن التحكم فيها والتعديل عليها»). والفرق الزائد الناتج يُعالَج في خطوة ⑨ أدناه.
    const originalCustomerId = inv.customerId != null ? Number(inv.customerId) : null;

    // ── حارس النقل الماليّ (ذكاءٌ حاكمٌ يمنع الخطأ بالبناء) ──
    //    التصحيح ينقل المقبوض للفاتورة الجديدة عبر إيصالات القبض القابلة للفصل (IN مكتمل، عدا
    //    أمانة أجرة التوصيل). لكن `paidAmount` قد يُموَّل من عربونٍ (orderPayments) إيصالُ أمّه
    //    غير مختومٍ بهذه الفاتورة (عربونٌ متعدّد الأهداف/على أمر شغل/مرتجَع جزئياً — راجع
    //    reception/deposits.ts + returnService.ts). حينها detachedSum < paidAmount، فيُعيد
    //    الترحيلُ تحميلَ الفرق ذمّةً وهميّةً على العميل. الحلّ: لا نُصحّح إن اختلّ المجموع — بل
    //    نوجّه لإلغاءٍ كامل ثمّ إعادة بيع. (المجموع محسوبٌ قبل أيّ تعديل ⇒ رفضٌ فاشلٌ نظيف.)
    const payRcpts = await tx.select({ id: receipts.id, amount: receipts.amount }).from(receipts).where(and(
      eq(receipts.invoiceId, input.originalInvoiceId),
      eq(receipts.direction, "IN"),
      eq(receipts.status, "COMPLETED"),
      sql`NOT EXISTS (SELECT 1 FROM accountingEntries ae WHERE ae.receiptId = ${receipts.id} AND ae.entryType = 'DELIVERY_FEE_HELD')`,
    ),
      );
    const detachedIds = payRcpts.map((r) => Number(r.id));
    const detachedSum = round2(payRcpts.reduce((s, r) => s.plus(money(r.amount)), new Decimal(0)),
    );
    if (!detachedSum.equals(originalPaid)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `تعذّر التصحيح: المدفوع المسجَّل (${originalPaid.toFixed(2)}) لا يطابق إيصالات القبض القابلة للنقل (${detachedSum.toFixed(2)}) — قد يكون بعضه من عربونٍ مرتبطٍ بغير هذه الفاتورة. عالِجها بإلغاءٍ كامل ثمّ إعادة بيع.`,
      });
    }
    // منع تغيير العميل عند وجود مدفوعات: المقبوض يخصّ العميل الأصليّ؛ نقله لعميلٍ آخر يُشوّه الذمم
    //    (يُعيد للأصل ويُرصّد الجديد بلا إيصالٍ للأصل). لتغيير العميل: إلغاءٌ كامل ثمّ إعادة بيع.
    // ⚠️ `undefined` = «الحقل لم يُرسَل ⇒ بلا تغيير»، بخلاف `null` = «أزِل العميل صراحةً».
    //    كان الاشتقاق يخلط بينهما (`!= null` وحده) — وهو كودٌ ميّتٌ ما دام أيّ مقبوضٍ محظوراً،
    //    لكنّه يصير حيّاً بمجرّد رفع الحظر: تصحيحُ فاتورةٍ مقبوضةٍ بلا مسّ العميل كان سيُرفَض
    //    زوراً بـ«لا يُغيَّر العميل». نُطابق الاشتقاق حرفياً لما تمرّره خطوة ⑦ لإعادة الترحيل.
    const targetCustomerId = input.customerId === undefined
      ? originalCustomerId
      : input.customerId != null ? Number(input.customerId) : null;
    if (originalPaid.gt(0) && Number(targetCustomerId ?? 0) !== Number(originalCustomerId ?? 0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يُغيَّر العميل في تصحيحٍ عليه مدفوعات — المقبوض يخصّ العميل الأصليّ. لتغييره: ألغِ الفاتورة وأعِد البيع.",
      });
    }

    // ── ٢) العكس الكامل عبر منطق المرتجع المُختبَر (كل البنود، بلا ردٍّ نقديّ, مع إعادة للمخزون) ──
    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.originalInvoiceId));
    if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة بلا بنودٍ لتصحيحها",
      });
    // ١٨/٨ — رُفع حارسُ «لا تُعكس فاتورة خدمة»: علّته زالت من جذرها. كان يُرفَض لأنّ العكس
    // يكتب حركة مخزونٍ لصنفٍ بلا رصيد (مخزونٌ وهميّ)؛ والآن `returnSaleInTx` يتخطّى
    // `applyMovement` لأصناف الخدمة صراحةً فالعكس ماليٌّ بحت. أثرُ الرفع: **فواتير خدمات
    // الطباعة صارت قابلةً للتصحيح** — وهي نصف سلّة الاستقبال وكانت بلا أيّ مسار تصحيحٍ رغم
    // أنّ الواجهة تُعلن حاجز WORKORDER وحده (بلاغ المالك: «شاشة التصحيح بدائية ولا تعمل»).
    // returnedTotal=0 مضمونٌ أعلاه ⇒ المتبقّي القابل للعكس = كامل الكمية الأساس.
    const reverseLines = items.map((it) => ({ invoiceItemId: Number(it.id), baseQuantity: Number(it.baseQuantity),
    }));
    await returnSaleInTx(tx, { invoiceId: input.originalInvoiceId, lines: reverseLines, refund: null, restock: true, clientRequestId: null, internalCorrectionReversal: true,
      }, actor,
    );

    // ── ٣) تصحيح الذمّة: العكس خصم −الإجمالي من AR (كأنّ المدفوع يُردّ رصيداً)؛ لكنّه لا يُردّ بل
    //    يُنقَل للجديدة ⇒ نعيده (+المدفوع) فيصير صافي عكس الأصل = −(الإجمالي − المدفوع). ──
    if (originalCustomerId != null && originalPaid.gt(0)) {
      await adjustCustomerBalance(tx, originalCustomerId, originalPaid);
    }

    // ── ٤) فصل إيصالات القبض عن الأصل (المجموع مُتحقَّقٌ = المدفوع أعلاه؛ تُعاد ختمها عبر preCollected) ──
    if (detachedIds.length) {
      await tx.update(receipts).set({ invoiceId: null }).where(inArray(receipts.id, detachedIds));
    }

    // ── ٥) وسم الأصل SUPERSEDED وتصفيره (لم يُرتجَع، بل استُبدِل) ──
    await tx.update(invoices).set({ status: "SUPERSEDED", paidAmount: "0", returnedTotal: "0" }).where(eq(invoices.id, input.originalInvoiceId));

    // ── ٦) درج الدفعة الإضافية (نقص: المصحّح > المقبوض) — يلزمه درجٌ حين نقدية ──
    let addPayShiftId: number | null = null;
    if (input.additionalPayment && input.additionalPayment.method === "CASH") {
      const resolved = await resolveBranchCashShiftTx(tx, Number(inv.branchId), null,
      );
      addPayShiftId = resolved.shiftId;
    }

    // ── ٧) إعادة الترحيل بالبيانات المصحّحة (المدفوع مُرحَّلٌ سلفاً؛ الفائض يُقصَر بـallowPreCollectedOverpay) ──
    const correctionReqId = input.clientRequestId ? `${input.clientRequestId}:corr` : null;
    const repost = await createSaleInTx(tx, {
      branchId: Number(inv.branchId),
      shiftId: addPayShiftId,
      sourceType: inv.sourceType as "POS" | "ONLINE" | "ORDER",
      customerId: input.customerId === undefined ? originalCustomerId : input.customerId,
      contactName: input.contactName === undefined ? (inv.contactName ?? null) : input.contactName,
      contactPhone: input.contactPhone === undefined ? (inv.contactPhone ?? null) : input.contactPhone,
      priceTier: input.priceTier ?? null,
      lines: input.lines,
      invoiceDiscount: input.invoiceDiscount ?? null,
      deliveryFee: input.deliveryFee ?? null,
      taxRatePercent: input.taxRatePercent ?? null,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      payment: input.additionalPayment
          ? {
              amount: input.additionalPayment.amount,
              method: input.additionalPayment.method,
              reference:
                lockedAdditionalAttempt?.externalReference ??
                input.additionalPayment.reference ??
                null,
            }
          : null,
        preCollected: detachedSum.gt(0) ? { amount: detachedSum.toFixed(2), receiptIds: detachedIds } : null,
      allowPreCollectedOverpay: true,
      // نسبةُ البيع تبقى للبائع الأصليّ لا للمدير المصحِّح: وعاء العمولة يُجمَّع بـ
      // `invoices.createdBy` (commissions/base.ts) وقيدُ RETURN العكسيّ يُخصَم من الأصليّ ⇒
      // بلا هذا السطر كان تصحيحُ سطرٍ واحد ينقل بيعاً كاملاً من وعاء الكاشير إلى وعاء المدير.
      // هويّة المصحِّح محفوظةٌ في auditLogs (`sale.correctReissue`) — وهي موضعها الصحيح.
      attributeToUserId: inv.createdBy ?? null,
      creditApproved: input.creditApproved,
      creditApprovalId: input.creditApprovalId,
      managerOverrideByUserId: input.managerOverrideByUserId,
      priceOverrideApproved: input.priceOverrideApproved,
      clientRequestId: correctionReqId,
    }, actor,
    );
    const newId = repost.invoiceId;
    const newTotal = round2(money(repost.total));

    // حارس: الدفعة الإضافية لا تتجاوز الفرق المستحقّ (النقص) — الزائد لن يُردّ (createSaleInTx يقصر
    //    المدفوع بالإجمالي فيُبتَلع الفائض بلا استرداد). حصِّل الفرق فقط. (الرفض هنا يُرجِع الترحيل ذرّياً.)
    if (input.additionalPayment) {
      const addAmt = round2(money(input.additionalPayment.amount));
      const shortfall = round2(Decimal.max(new Decimal(0), newTotal.minus(detachedSum)),
      );
      if (addAmt.gt(shortfall)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الدفعة الإضافية (${addAmt.toFixed(2)}) تتجاوز الفرق المستحقّ (${shortfall.toFixed(2)}) — حصِّل الفرق فقط.`,
        });
      }
    }

    if (input.additionalPayment && input.additionalPayment.method !== "CASH") {
      const receipt = (
        await tx
          .select({
            id: receipts.id,
            amount: receipts.amount,
            paymentMethod: receipts.paymentMethod,
            referenceNumber: receipts.referenceNumber,
          })
          .from(receipts)
          .where(
            and(
              eq(receipts.invoiceId, newId),
              eq(receipts.direction, "IN"),
              eq(receipts.paymentMethod, input.additionalPayment.method),
            ),
          )
          .orderBy(desc(receipts.id))
          .limit(1)
      )[0];
      if (
        !receipt ||
        !money(receipt.amount).eq(money(input.additionalPayment.amount)) ||
        (receipt.referenceNumber?.trim() || null) !==
          lockedAdditionalAttempt?.externalReference.trim()
      ) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "لم يُنشأ إيصال مطابق لمحاولة دفع فرق التصحيح — تراجع التصحيح بالكامل",
        });
      }
      await consumeConfirmedExternalPaymentAttemptTx(
        tx,
        {
          branchId: Number(inv.branchId),
          channel: "SALES_COLLECTION",
          method: input.additionalPayment.method,
          amount: input.additionalPayment.amount,
          attemptId: input.additionalPayment.externalPaymentAttemptId,
          deviceId: input.additionalPayment.externalPaymentDeviceId,
        },
        actor,
        async (attempt) => {
          if (Number(attempt.id) !== Number(lockedAdditionalAttempt?.id)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تغيّرت محاولة دفع فرق التصحيح",
            });
          }
          return {
            invoiceId: newId,
            receiptId: Number(receipt.id),
            value: undefined,
          };
        },
      );
    }

    // ── ٨) ربط الفاتورتين (نسب التصحيح ثنائية الاتجاه) ──
    await tx.update(invoices).set({ correctionOfInvoiceId: input.originalInvoiceId }).where(eq(invoices.id, newId));
    await tx.update(invoices).set({ correctedByInvoiceId: newId }).where(eq(invoices.id, input.originalInvoiceId));

    // ── ٩) الفرق الزائد (overpay): المقبوض سلفاً > مستحقّ المصحّح ⇒ يُردّ نقداً أو يُرصَّد ──
    //    `createSaleInTx` يقصُر `paidNow` على الإجمالي الجديد (allowPreCollectedOverpay) فيبقى
    //    الفرقُ **مالاً دفعه الزبون بلا مقابل** — ولا يجوز أن «يُبتلَع» بصمت. المبدأ المالي الحاكم:
    //    «لا دينار يضيع بصمت… ومالٌ محتجَز يلزمه مسار خروجٍ ممكنٌ دائماً».
    const overpay = round2(Decimal.max(new Decimal(0), detachedSum.minus(newTotal)),
    );
    let overpayHandled: "CREDIT" | "CASH_REFUND" | undefined = undefined;
    if (overpay.gt(0)) {
      // الزبون العابر لا يحمل رصيداً دائناً ⇒ النقد مخرجه الوحيد. ومع عميلٍ مسجَّل الافتراضُ
      // رصيدٌ دائن (لا نُخرج نقداً من الدرج بلا طلبٍ صريح).
      const handling: "CREDIT" | "CASH_REFUND" =
        input.overpayHandling ?? (targetCustomerId != null ? "CREDIT" : "CASH_REFUND");

      if (handling === "CREDIT") {
        if (targetCustomerId == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "لا يمكن ترصيد الفرق الزائد لزبونٍ عابر بلا حساب — اختر الاسترداد النقديّ أو اربط الفاتورة بعميل",
          });
        }
        // رصيدٌ دائن: الرصيد سالبٌ = له عندنا. لا نقد يتحرّك، والأثر ظاهرٌ في كشف حسابه.
        await adjustCustomerBalance(tx, targetCustomerId, overpay.neg());
        overpayHandled = "CREDIT";
      } else {
        // استردادٌ نقديّ من الدرج المُقفَل سلفاً (خطوة ٠.٥) — الترتيب المصدر←المستند محفوظ.
        if (!prelockedOverpayShift) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "الاسترداد النقديّ للفرق الزائد يتطلّب تحديده قبل الحفظ (لم يُقفل درجٌ لهذه العملية) — أعد المحاولة باختيار «استرداد نقديّ».",
          });
        }
        // حدّ الدرج: لا يُسحَب أكثر ممّا فيه **الآن** (نمط cashDropService/returnService) — كي لا
        // يُطلَب من الكاشير تسليم نقدٍ لا يملكه فيُكتشَف العجز عند الإغلاق فقط.
        await assertCashOutAvailable(tx, {
          branchId: Number(inv.branchId),
          cashBucket: "DRAWER",
          shiftId: prelockedOverpayShift.shiftId,
          amount: overpay,
          operation: "ردّ الفرق الزائد عند تصحيح الفاتورة",
        });
        const refundRes = await tx.insert(receipts).values({
          invoiceId: newId,
          branchId: Number(inv.branchId),
          shiftId: prelockedOverpayShift.shiftId,
          cashBucket: "DRAWER", // يخرج من الدرج ⇒ يظهر في Z-report وتسوية النقد
          direction: "OUT",
          amount: toDbMoney(overpay),
          paymentMethod: "CASH",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          description: `ردّ فرقٍ زائد بتصحيح الفاتورة ${inv.invoiceNumber} ← ${repost.invoiceNumber}`,
          partyType: targetCustomerId ? "CUSTOMER" : "OTHER",
          partyId: targetCustomerId,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(refundRes);
        const refundSource = { roleDebits: { AR: overpay }, roleCredits: { CASH: overpay },
        };
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: Number(inv.branchId),
          invoiceId: newId,
          receiptId: refundReceiptId,
          customerId: targetCustomerId,
          amount: overpay,
          notes: `ردّ فرق تصحيح الفاتورة ${inv.invoiceNumber}`,
          postingIntent: createPostingIntent(
            "PAYMENT_OUT_CUSTOMER_REFUND",
            "PAYMENT_OUT",
            [debitLine("AR", overpay), creditLine("CASH", overpay)],
            refundSource,
          ),
          postingSourceComponents: refundSource,
        });
        // لا `adjustCustomerBalance` هنا: المال خرج فعلاً فلا يبقى له رصيدٌ دائن (وإلّا استفاد مرّتين).
        overpayHandled = "CASH_REFUND";
      }
    }

    // ── ١٠) تسجيل مفتاح idempotency (refId = الفاتورة الجديدة) ──
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "sale.correct", input.clientRequestId, newId,
      );
    }

    return {
      originalInvoiceId: input.originalInvoiceId,
      correctedInvoiceId: newId,
      correctedInvoiceNumber: repost.invoiceNumber,
      total: repost.total,
      overpay: overpay.toFixed(2),
      overpayHandled,
    };
}

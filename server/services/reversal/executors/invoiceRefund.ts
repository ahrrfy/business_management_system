/**
 * منفّذ ردّ المال (`PAID_AMOUNT`) لفاتورة البيع — الخطوة ٨ من `sale/cancel.ts` سابقاً، ومسار
 * الردّ في `returnService.ts` للمرتجع الكامل.
 *
 * الأثرُ المتبقّي = ما يُردّ فعلاً: Σ المقبوض المتجسِّد على الفاتورة (إيصالات IN + حصص العربون
 * المطبَّقة من مسوّدة الاستقبال) − Σ ما استُرِدّ سلفاً. الرافدُ **قرارٌ بشريّ** يصل في
 * `decisions.refund` ولا يُخمَّن:
 *  · نقدٌ ⇒ فوريّ من المصدر المقفول سلفاً (درجٌ أو خزينة — الخزينةُ استثناءٌ مصنَّف مغلق).
 *  · بطاقةٌ ⇒ فوريّ بمرجع الجهاز الإلزاميّ (إثباتٌ لا إقفال)، لا يمسّ درجاً.
 *  · تحويل/صك/محفظة ⇒ سندُ صرفٍ **معلَّق** باعتماد مالك: لا يخرج مال الآن ⇒ الأثر يُترك
 *    مفتوحاً بقصدٍ معلن (`LEFT_OPEN`)، **ويُبقى المبلغُ رصيداً دائناً للعميل** بأثرٍ مفتوحٍ
 *    مُسجَّل (`scope = "refund-pending"`) حتى يُصرَف السند — نفسُ ما كان `arDrop = remaining − refund`
 *    يفعله ضمنياً، لكن الآن بدينارٍ مُسمّى لا يضيع بصمت.
 *  · `NONE` أو مبلغٌ أقلُّ من المتبقّي ⇒ ما لم يُردّ يبقى **رصيداً دائناً** للعميل المسجَّل
 *    (`scope = "credit"`) — معنى `refund: null` في المرتجع التاريخيّ. الزبونُ العابر لا ذمّةَ له
 *    فيُرفض (الخدمةُ تفرض عليه ردّاً كاملاً قبل الوصول هنا).
 *
 * ⛔ لا `Number` على مال، ولا مصدرَ نقدٍ يُقفل هنا — الخدمةُ تقفله أوّلاً (ترتيبُ الأقفال قرارُها).
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";

import { appErrorMessage } from "@shared/errors";

import { invoices, receipts } from "../../../../drizzle/schema";
import type { Tx } from "../../../db";
import { extractInsertId } from "../../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../../accounting/postingEngine";
import {
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  assertTreasuryOutException,
} from "../../cash/cashAvailability";
import { adjustCustomerBalance, postEntry } from "../../ledgerService";
import { round2, toDbMoney } from "../../money";
import { isSurfacedRefundMethod } from "../../returns/refundCaps";
import { paymentAssetRole } from "../../sale/paymentPosting";
import { nextVoucherNumber } from "../../voucher/helpers";
import { recordEffect } from "../effectLedger";
import type { EffectExecutor, ExecutionOutcome, ReversalRun } from "../types";
import { invoiceContext } from "./invoiceState";
import { writeRefundState } from "./refundState";

/** يُبقي جزءاً من المقبوض ديناً علينا للعميل ويسجّله أثراً مفتوحاً — لا دينارَ بلا اسم. */
async function keepAsCustomerCredit(
  tx: Tx,
  run: ReversalRun,
  args: { customerId: number | null; amount: Decimal; scope: "credit" | "refund-pending"; receiptId: number | null; method: string; voucherNumber: string | null; branchId: number; invoiceNumber: string },
): Promise<void> {
  if (args.amount.lte(0)) return;
  if (args.customerId == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `تعذّر إبقاء ${args.amount.toFixed(2)} د.ع من مقبوض الفاتورة ${args.invoiceNumber} رصيداً دائناً`,
        why: "الفاتورة بلا عميلٍ مسجَّل، والزبون العابر لا ذمّةَ له تحمل رصيداً — فما لا يُردّ له الآن يبقى مالاً بلا صاحب",
        doThis: "ردّ للزبون المبلغَ كاملاً نقداً أو على بطاقته، أو سجّله عميلاً على الفاتورة ثمّ أعد العمليّة",
      }),
    });
  }
  await adjustCustomerBalance(tx, args.customerId, args.amount.negated());
  await recordEffect(
    tx,
    {
      documentType: run.documentType,
      documentId: run.documentId,
      effectKind: "CUSTOMER_BALANCE",
      effectTable: args.receiptId != null ? "receipts" : "customers",
      effectRowId: args.receiptId ?? args.customerId,
      signedAmount: args.amount.negated(),
      branchId: args.branchId,
      reason: run.reason,
      scope: args.scope,
      payloadJson: { customerId: args.customerId, amount: args.amount.toFixed(2), method: args.method, voucherNumber: args.voucherNumber },
    },
    run.actor,
  );
}

export const invoiceRefundExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const inv = ctx.invoice;
  const flavor = run.decisions.flavor ?? "CANCEL";
  const branchId = Number(inv.branchId);
  const customerId = inv.customerId == null ? null : Number(inv.customerId);
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const refundable = round2(effect.outstandingAmount);
    if (refundable.lte(0)) {
      outcomes.push({ status: "REVERSED", signedAmount: new Decimal(0), payloadJson: { nothingToRefund: true } });
      writeRefundState(run, { materialized: new Decimal(0), deferred: null, refundReceiptId: null, pendingVoucherNumber: null });
      continue;
    }
    const decision = run.decisions.refund;
    if (!decision) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر ردّ ${refundable.toFixed(2)} د.ع المقبوضة على الفاتورة ${inv.invoiceNumber}`,
          why: "لم يصل قرارُ رافد الردّ (نقد/بطاقة/سند/رصيد دائن) — ولا يُخمّن النظام من أين يخرج المال",
          doThis: "اختر رافد الردّ من منتقي الروافد ثمّ أعد المحاولة",
        }),
      });
    }

    // ═══ لا ردَّ الآن: المقبوضُ كلُّه يبقى رصيداً دائناً للعميل ═══
    if (decision.method === "NONE") {
      await keepAsCustomerCredit(tx, run, { customerId, amount: refundable, scope: "credit", receiptId: null, method: "NONE", voucherNumber: null, branchId, invoiceNumber: inv.invoiceNumber });
      writeRefundState(run, { materialized: new Decimal(0), deferred: null, refundReceiptId: null, pendingVoucherNumber: null });
      outcomes.push({
        status: "LEFT_OPEN",
        why: `لم يُطلب ردٌّ نقديّ — ${refundable.toFixed(2)} د.ع تبقى رصيداً دائناً للعميل على الفاتورة ${inv.invoiceNumber}`,
        payloadJson: { keptAsCredit: refundable.toFixed(2) },
      });
      continue;
    }

    const requested = decision.amount != null ? round2(decision.amount) : refundable;
    if (requested.lt(0) || requested.gt(refundable)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر ردّ ${requested.toFixed(2)} د.ع على الفاتورة ${inv.invoiceNumber}`,
          why: `المبلغ المطلوب يتجاوز ما يُردّ فعلاً (${refundable.toFixed(2)} د.ع) أو سالب`,
          doThis: `أنقص مبلغ الردّ إلى ${refundable.toFixed(2)} د.ع أو أقلّ`,
        }),
      });
    }
    const remainderAsCredit = round2(refundable.minus(requested));
    if (requested.lte(0)) {
      await keepAsCustomerCredit(tx, run, { customerId, amount: remainderAsCredit, scope: "credit", receiptId: null, method: decision.method, voucherNumber: null, branchId, invoiceNumber: inv.invoiceNumber });
      writeRefundState(run, { materialized: new Decimal(0), deferred: null, refundReceiptId: null, pendingVoucherNumber: null });
      outcomes.push({ status: "LEFT_OPEN", why: `لم يُردّ شيءٌ الآن — ${remainderAsCredit.toFixed(2)} د.ع رصيدٌ دائن للعميل`, payloadJson: { keptAsCredit: remainderAsCredit.toFixed(2) } });
      continue;
    }

    const isImmediateRefundRail = isSurfacedRefundMethod(decision.method);
    let shiftId: number | null = null;
    let cashBucket: "DRAWER" | "TREASURY" | null = null;
    let cardReference: string | null = null;
    let pendingRefundVoucherNumber: string | null = null;
    if (decision.method === "CASH") {
      const g = decision.cashSource;
      if (!g) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: flavor === "CANCEL"
            ? "لم يُقفل مصدر استرداد الإلغاء النقدي"
            : appErrorMessage({
                what: "تعذّر صرف استرداد المرتجع نقداً",
                why: "لم يُحجَز مصدر النقد (درجٌ أو خزينة) في بداية العملية رغم أنّ الردّ نقديّ — خللٌ داخليّ في تسلسل التنفيذ لا في مدخلاتك",
                doThis: "لم يخرج أيّ مبلغ ولم تتغيّر الفاتورة؛ أعِد المحاولة مرّةً واحدة، وإن تكرّر فأبلِغ مسؤول النظام برقم الفاتورة ولا تُسلّم الزبون نقداً خارج النظام",
              }),
        });
      }
      shiftId = g.shiftId;
      cashBucket = g.cashBucket;
      if (cashBucket === "TREASURY") {
        // مفتاحان حرفيّان لا ثلاثيٌّ واحد: حارسُ `cashNonnegativeCore` يطابق نصَّ الاستدعاء
        // بمفتاحه، فيبقى كلُّ استثناءٍ مقروءاً في مكانه (نظيرُ `sale/cancel.ts` قبل المحرّك).
        if (flavor === "CANCEL") assertTreasuryOutException("SALE_CANCELLATION_COMPENSATION");
        else assertTreasuryOutException("SALE_RETURN_COMPENSATION");
      }
      await assertCashOutAvailable(tx, {
        branchId,
        cashBucket,
        shiftId,
        amount: requested,
        operation: flavor === "CANCEL" ? "استرداد إلغاء الفاتورة" : "استرداد مرتجع البيع نقداً",
      });
    } else if (isImmediateRefundRail) {
      cardReference = decision.reference?.trim() || null;
      if (!cardReference) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: flavor === "CANCEL" ? "تعذّر تسجيل استرداد إلغاء الفاتورة على البطاقة" : "تعذّر تسجيل استرداد المرتجع على البطاقة",
            why: flavor === "CANCEL"
              ? `مرجع عملية الاسترداد من جهاز الدفع لم يصل، وهو الأثر الوحيد الذي يربط ${requested.toFixed(2)} د.ع خرجت من حسابنا البنكيّ بمستندها`
              : `مرجع العملية من جهاز الدفع لم يصل، وهو الأثر الوحيد الذي يربط ${requested.toFixed(2)} د.ع خرجت من حسابنا البنكيّ بمستندها`,
            doThis: "نفّذ الاسترداد على جهاز الدفع أوّلاً، ثمّ أدخِل رقم العملية أو كود الموافقة المطبوع على قسيمة الجهاز في حقل المرجع",
          }),
        });
      }
      // لا يمسّ درجاً (cashBucket=NULL) ⇒ لا أثر على expectedCash ولا Z-report. البطاقة نفسها هي الطرف.
      assertNonPhysicalOutReceipt({
        classification: "NON_CASH_METHOD",
        paymentMethod: decision.method,
        cashBucket: null,
        approvalStatus: "APPROVED",
        operation: flavor === "CANCEL" ? "استرداد إلغاء فاتورة على البطاقة" : "استرداد مرتجع بيع على البطاقة",
      });
    } else {
      if (customerId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: flavor === "CANCEL"
            ? "الاسترداد غير النقدي يحتاج عميلاً مرتبطاً بالفاتورة كي يمرّ بسند صرف واعتماد مالك"
            : appErrorMessage({
                what: "تعذّر تسجيل استرداد المرتجع",
                why: `الردّ بـ${decision.method} لا يخرج فوراً بل يمرّ بسند صرفٍ يعتمده المالك، والسند يلزمه طرفٌ يُنسَب إليه — وهذه الفاتورة بلا عميلٍ مسجَّل`,
                doThis: "ردّ للزبون نقداً أو على بطاقته (رافدا الردّ الفوريّان)، أو سجّله عميلاً على الفاتورة ثمّ أعِد المرتجع بهذه الطريقة",
              }),
        });
      }
      assertNonPhysicalOutReceipt({
        classification: "DEFERRED_APPROVAL",
        paymentMethod: decision.method,
        cashBucket: null,
        approvalStatus: "PENDING_APPROVAL",
        operation: flavor === "CANCEL" ? "طلب استرداد إلغاء فاتورة غير نقدي" : "طلب استرداد مرتجع بيع غير نقدي",
      });
      pendingRefundVoucherNumber = await nextVoucherNumber(tx, "PAYMENT", branchId);
    }

    const fingerprint = decision.requestFingerprint?.slice(0, 12) ?? "LEGACY";
    const pendingReference = flavor === "CANCEL"
      ? `SALE-CANCEL-PENDING-${run.documentId}-${fingerprint}`
      : `SALE-RETURN-PENDING-${run.documentId}-${fingerprint}`;
    const descriptionNote = (decision.descriptionNote ?? "").trim();
    // غير النقد يحمل voucherNumber فيظهر بطابور السندات ويتجسّد حصراً عبر voucher.approve من
    // مالكٍ آخر. النقد والبطاقة الفوريّان يبقيان إيصالَ مرتجعٍ بلا voucherNumber.
    const rRes = await tx.insert(receipts).values({
      invoiceId: run.documentId,
      branchId,
      shiftId,
      cashBucket,
      direction: "OUT",
      amount: toDbMoney(requested),
      paymentMethod: decision.method,
      status: isImmediateRefundRail ? "COMPLETED" : "PENDING",
      description: flavor === "CANCEL"
        ? `استرداد إلغاء فاتورة ${inv.invoiceNumber}`
        : decision.method === "CASH"
          ? `استرداد مرتجع فاتورة ${inv.invoiceNumber}${descriptionNote ? ` — ${descriptionNote}` : ""}`
          : isImmediateRefundRail
            ? `استرداد مرتجع فاتورة ${inv.invoiceNumber} على البطاقة — مرجع الجهاز ${cardReference}`
            : `طلب استرداد غير نقدي معلّق لفاتورة ${inv.invoiceNumber} — بلا أثر حتى الاعتماد والتنفيذ`,
      approvalStatus: isImmediateRefundRail ? "APPROVED" : "PENDING_APPROVAL",
      referenceNumber: decision.method === "CASH"
        ? null
        : isImmediateRefundRail
          ? cardReference
          : pendingReference,
      voucherNumber: pendingRefundVoucherNumber,
      partyType: customerId != null ? "CUSTOMER" : "OTHER",
      partyId: customerId,
      internalNote: pendingRefundVoucherNumber
        ? (flavor === "CANCEL" ? `SALE_CUSTOMER_REFUND:CANCEL:${run.documentId}` : `SALE_CUSTOMER_REFUND:RETURN:${run.documentId}`)
        : null,
      createdBy: run.actor.userId,
    });
    const receiptId = extractInsertId(rRes);

    if (isImmediateRefundRail) {
      const refundAssetRole = paymentAssetRole(decision.method, cashBucket, "OUT");
      const refundPostingSource = {
        roleDebits: { AR: requested },
        roleCredits: { [refundAssetRole]: requested },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId,
        invoiceId: run.documentId,
        receiptId,
        customerId,
        amount: requested,
        postingIntent: createPostingIntent("PAYMENT_OUT_CUSTOMER_REFUND", "PAYMENT_OUT", [debitLine("AR", requested), creditLine(refundAssetRole, requested)], refundPostingSource),
        postingSourceComponents: refundPostingSource,
      });
      // المدفوعُ على الفاتورة ينقص بما خرج فعلاً (ولا يهبط تحت الصفر).
      await tx
        .update(invoices)
        .set({ paidAmount: sql`GREATEST(${invoices.paidAmount} - ${toDbMoney(requested)}, 0)` })
        .where(eq(invoices.id, run.documentId));
      // ما لم يُردّ من الوعاء يبقى رصيداً دائناً للعميل المسجَّل.
      await keepAsCustomerCredit(tx, run, { customerId, amount: remainderAsCredit, scope: "credit", receiptId: null, method: decision.method, voucherNumber: null, branchId, invoiceNumber: inv.invoiceNumber });
      writeRefundState(run, { materialized: requested, deferred: null, refundReceiptId: receiptId, pendingVoucherNumber: null });
      const payload = { method: decision.method, cashBucket, shiftId, reference: cardReference, keptAsCredit: remainderAsCredit.toFixed(2) };
      outcomes.push(
        remainderAsCredit.gt(0)
          ? { status: "PARTIAL", why: `رُدّ ${requested.toFixed(2)} د.ع و${remainderAsCredit.toFixed(2)} د.ع بقيت رصيداً دائناً للعميل`, signedAmount: requested.neg(), effectTable: "receipts", effectRowId: receiptId, payloadJson: payload }
          : { status: "REVERSED", signedAmount: requested.neg(), effectTable: "receipts", effectRowId: receiptId, payloadJson: payload },
      );
    } else {
      // المالُ لم يغادر الحساب بعد ⇒ يبقى ديناً علينا للعميل (رصيدٌ دائن) حتى يُصرَف السند المعلَّق،
      // ويُسجَّل أثراً مفتوحاً مستقلاً يُغلقه اعتمادُ السند لا هذه المعاملة.
      await keepAsCustomerCredit(tx, run, { customerId, amount: requested, scope: "refund-pending", receiptId, method: decision.method, voucherNumber: pendingRefundVoucherNumber, branchId, invoiceNumber: inv.invoiceNumber });
      await keepAsCustomerCredit(tx, run, { customerId, amount: remainderAsCredit, scope: "credit", receiptId: null, method: decision.method, voucherNumber: null, branchId, invoiceNumber: inv.invoiceNumber });
      writeRefundState(run, {
        materialized: new Decimal(0),
        deferred: { amount: requested, receiptId, method: decision.method },
        refundReceiptId: receiptId,
        pendingVoucherNumber: pendingRefundVoucherNumber,
      });
      outcomes.push({
        status: "LEFT_OPEN",
        why: `الردّ بـ${decision.method} سندُ صرفٍ معلَّق (${pendingRefundVoucherNumber}) لا يخرج به مالٌ حتى يعتمده المالك — يبقى ${requested.toFixed(2)} د.ع رصيداً دائناً للعميل حتى الصرف`,
        payloadJson: { pendingReceiptId: receiptId, voucherNumber: pendingRefundVoucherNumber, keptAsCredit: remainderAsCredit.toFixed(2) },
      });
    }
  }
  return outcomes;
};

/**
 * منفّذ ردّ المال (`PAID_AMOUNT`) لفاتورة البيع — الخطوة ٨ من `sale/cancel.ts` سابقاً.
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
 *
 * ⛔ لا `Number` على مال، ولا مصدرَ نقدٍ يُقفل هنا — الخدمةُ تقفله أوّلاً (ترتيبُ الأقفال قرارُها).
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";

import { appErrorMessage } from "@shared/errors";

import { invoices, receipts } from "../../../../drizzle/schema";
import { extractInsertId } from "../../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../../accounting/postingEngine";
import {
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  assertTreasuryOutException,
} from "../../cash/cashAvailability";
import { adjustCustomerBalance, postEntry } from "../../ledgerService";
import { money, round2, toDbMoney } from "../../money";
import { isSurfacedRefundMethod } from "../../returns/refundCaps";
import { paymentAssetRole } from "../../sale/paymentPosting";
import { nextVoucherNumber } from "../../voucher/helpers";
import { recordEffect } from "../effectLedger";
import type { EffectExecutor, ExecutionOutcome } from "../types";
import { invoiceContext } from "./invoiceState";
import { writeRefundState } from "./refundState";

export const invoiceRefundExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const inv = ctx.invoice;
  const flavor = run.decisions.flavor ?? "CANCEL";
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
          why: "لم يصل قرارُ رافد الردّ (نقد/بطاقة/سند) — ولا يُخمّن النظام من أين يخرج المال",
          doThis: "اختر رافد الردّ من منتقي الروافد ثمّ أعد المحاولة",
        }),
      });
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
        assertTreasuryOutException(flavor === "CANCEL" ? "SALE_CANCELLATION_COMPENSATION" : "SALE_RETURN_COMPENSATION");
      }
      await assertCashOutAvailable(tx, {
        branchId: Number(inv.branchId),
        cashBucket,
        shiftId,
        amount: refundable,
        operation: flavor === "CANCEL" ? "استرداد إلغاء الفاتورة" : "استرداد مرتجع البيع نقداً",
      });
    } else if (isImmediateRefundRail) {
      cardReference = decision.reference?.trim() || null;
      if (!cardReference) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: flavor === "CANCEL" ? "تعذّر تسجيل استرداد إلغاء الفاتورة على البطاقة" : "تعذّر تسجيل استرداد المرتجع على البطاقة",
            why: `مرجع عملية الاسترداد من جهاز الدفع لم يصل، وهو الأثر الوحيد الذي يربط ${refundable.toFixed(2)} د.ع خرجت من حسابنا البنكيّ بمستندها`,
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
      if (inv.customerId == null) {
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
      pendingRefundVoucherNumber = await nextVoucherNumber(tx, "PAYMENT", Number(inv.branchId));
    }

    const fingerprint = decision.requestFingerprint?.slice(0, 12) ?? "LEGACY";
    const pendingReference = flavor === "CANCEL"
      ? `SALE-CANCEL-PENDING-${run.documentId}-${fingerprint}`
      : `SALE-RETURN-PENDING-${run.documentId}-${fingerprint}`;
    // غير النقد يحمل voucherNumber فيظهر بطابور السندات ويتجسّد حصراً عبر voucher.approve من
    // مالكٍ آخر. النقد والبطاقة الفوريّان يبقيان إيصالَ مرتجعٍ بلا voucherNumber.
    const rRes = await tx.insert(receipts).values({
      invoiceId: run.documentId,
      branchId: Number(inv.branchId),
      shiftId,
      cashBucket,
      direction: "OUT",
      amount: toDbMoney(refundable),
      paymentMethod: decision.method,
      status: isImmediateRefundRail ? "COMPLETED" : "PENDING",
      description: flavor === "CANCEL"
        ? `استرداد إلغاء فاتورة ${inv.invoiceNumber}`
        : decision.method === "CASH"
          ? `استرداد مرتجع فاتورة ${inv.invoiceNumber}${run.decisions.reasonNote ? ` — ${run.decisions.reasonNote.trim()}` : ""}`
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
      partyType: inv.customerId ? "CUSTOMER" : "OTHER",
      partyId: inv.customerId ?? null,
      internalNote: pendingRefundVoucherNumber
        ? (flavor === "CANCEL" ? `SALE_CUSTOMER_REFUND:CANCEL:${run.documentId}` : `SALE_CUSTOMER_REFUND:RETURN:${run.documentId}`)
        : null,
      createdBy: run.actor.userId,
    });
    const receiptId = extractInsertId(rRes);

    if (isImmediateRefundRail) {
      const refundAssetRole = paymentAssetRole(decision.method, cashBucket, "OUT");
      const refundPostingSource = {
        roleDebits: { AR: refundable },
        roleCredits: { [refundAssetRole]: refundable },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(inv.branchId),
        invoiceId: run.documentId,
        receiptId,
        customerId: inv.customerId,
        amount: refundable,
        postingIntent: createPostingIntent("PAYMENT_OUT_CUSTOMER_REFUND", "PAYMENT_OUT", [debitLine("AR", refundable), creditLine(refundAssetRole, refundable)], refundPostingSource),
        postingSourceComponents: refundPostingSource,
      });
      // المدفوعُ على الفاتورة ينقص بما خرج فعلاً (ولا يهبط تحت الصفر).
      await tx
        .update(invoices)
        .set({ paidAmount: sql`GREATEST(${invoices.paidAmount} - ${toDbMoney(refundable)}, 0)` })
        .where(eq(invoices.id, run.documentId));
      writeRefundState(run, { materialized: refundable, deferred: null, refundReceiptId: receiptId, pendingVoucherNumber: null });
      outcomes.push({
        status: "REVERSED",
        signedAmount: refundable.neg(),
        effectTable: "receipts",
        effectRowId: receiptId,
        payloadJson: { method: decision.method, cashBucket, shiftId, reference: cardReference },
      });
    } else {
      // المالُ لم يغادر الحساب بعد ⇒ يبقى ديناً علينا للعميل (رصيدٌ دائن) حتى يُصرَف السند المعلَّق،
      // ويُسجَّل أثراً مفتوحاً مستقلاً يُغلقه اعتمادُ السند لا هذه المعاملة.
      const customerId = Number(inv.customerId);
      await adjustCustomerBalance(tx, customerId, refundable.negated());
      await recordEffect(
        tx,
        {
          documentType: run.documentType,
          documentId: run.documentId,
          effectKind: "CUSTOMER_BALANCE",
          effectTable: "receipts",
          effectRowId: receiptId,
          signedAmount: refundable.negated(),
          branchId: Number(inv.branchId),
          reason: run.reason,
          scope: "refund-pending",
          payloadJson: { customerId, pendingRefund: refundable.toFixed(2), method: decision.method, voucherNumber: pendingRefundVoucherNumber },
        },
        run.actor,
      );
      writeRefundState(run, {
        materialized: new Decimal(0),
        deferred: { amount: refundable, receiptId, method: decision.method },
        refundReceiptId: receiptId,
        pendingVoucherNumber: pendingRefundVoucherNumber,
      });
      outcomes.push({
        status: "LEFT_OPEN",
        why: `الردّ بـ${decision.method} سندُ صرفٍ معلَّق (${pendingRefundVoucherNumber}) لا يخرج به مالٌ حتى يعتمده المالك — يبقى ${refundable.toFixed(2)} د.ع رصيداً دائناً للعميل حتى الصرف`,
        payloadJson: { pendingReceiptId: receiptId, voucherNumber: pendingRefundVoucherNumber },
      });
    }
  }
  void money;
  return outcomes;
};

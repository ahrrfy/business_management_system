/**
 * منفّذو **عكس تسليم أمر الشغل** — قيدُ البيع الخدميّ وردُّ المقبوضات مصدراً مصدراً.
 *
 * نُقل المنطقُ حرفياً من `workOrder/reverseDelivery.ts` ليمرّ بمحرّك العكس (ق٧، م٢): الخدمةُ
 * تُبقي حرّاسَها (النسخة · SOD · الإرسالية المستقرّة · الفترة · تطابقُ الخطّة) وأقفالَها وحالةَ
 * المستند (فاتورة/أمر/إرسالية/أحداث/تدقيق)، وتُفوّض **الأثرَ الماليّ** إلى هنا:
 *
 *  · `LEDGER_ENTRY` — قيدُ SALE الخدميّ (SALES_FLEX + WIP/COGS + إغلاقُ العربون) يُعكَس بقيد RETURN
 *    `RETURN_SALE_FLEX_WORKORDER` بمفتاحٍ ثابت `WO-REVERSE:<wo>:<inv>`، ومع الإقفال (لا إعادة
 *    فتح) تُهدَر الخامةُ من WIP إلى LOSSES بقيد ADJUST `WO-REVERSE-WASTE:…` — لا حركةَ مخزون
 *    (المادّة استُهلكت عند البدء، وإعادتها تُنشئ مخزوناً وهمياً).
 *  · `PAID_AMOUNT` — لكلّ **مصدر قبضٍ** أثرٌ مستقلّ (إيصالُ IN بهويّته)، وردُّه بحسب خطّته:
 *    نقدٌ فوريّ من درج استقبالٍ مقفول، وغيرُ النقد سندٌ معلَّق باعتماد المالك (`LEFT_OPEN` بإعلان).
 *  · `CUSTOMER_BALANCE` — المنفّذُ العامّ (إسقاطُ غير المسدَّد من ذمّة العميل).
 *
 * ⛔ لا `Number` على مال، ولا قفلَ درجٍ هنا — الخدمةُ تقفله أوّلاً (ترتيبُ الأقفال قرارُها).
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";

import { appErrorMessage } from "@shared/errors";

import { invoices, receipts, workOrders } from "../../../../drizzle/schema";
import { extractInsertId } from "../../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../../accounting/postingEngine";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt } from "../../cash/cashAvailability";
import { postEntry } from "../../ledgerService";
import { money, round2, toDbMoney } from "../../money";
import { paymentAssetRole } from "../../sale/paymentPosting";
import type { WorkOrderRefundSourcePlan } from "../../workOrder/reverseDelivery";
import type { EffectExecutor, ExecutionOutcome, ReversalRun } from "../types";

export type WorkOrderRow = typeof workOrders.$inferSelect;
export type WorkOrderInvoiceRow = typeof invoices.$inferSelect;

/** سياقُ تشغيلة عكس التسليم — تكتبه الخدمةُ قبل `reverse()` ويقرأه المنفّذون. */
export interface WorkOrderDeliveryContext {
  wo: WorkOrderRow;
  inv: WorkOrderInvoiceRow;
  /** صافي المقبوض بعد الردود المنفَّذة، والردودُ المنفَّذة سلفاً — من أدلّة IN/OUT لا من رأس الفاتورة. */
  netPaid: Decimal;
  completedOut: Decimal;
  /** خطّةُ الردّ المطابِقة للمقبوضات (مُطبَّعة ومرتّبة). */
  plans: readonly WorkOrderRefundSourcePlan[];
  /** درجُ الاستقبال المقفول للردود النقديّة — `null` حين لا ردَّ نقديّاً. */
  cashShiftId: number | null;
  approvedControlRequestId: number;
  reopen: boolean;
  reason: string;
}

export interface WorkOrderRefundRunState {
  immediateCashRefund: Decimal;
  pendingRefundReceiptIds: number[];
}

const CONTEXT_KEY = "workOrderDelivery";
const REFUND_KEY = "workOrderRefund";

export function writeWorkOrderDeliveryContext(run: ReversalRun, ctx: WorkOrderDeliveryContext): void {
  run.state.set(CONTEXT_KEY, ctx);
}

export function readWorkOrderDeliveryContext(run: ReversalRun): WorkOrderDeliveryContext {
  const ctx = run.state.get(CONTEXT_KEY) as WorkOrderDeliveryContext | undefined;
  if (!ctx) throw new Error("reversal: سياقُ عكس تسليم أمر الشغل غائبٌ عن التشغيلة");
  return ctx;
}

export function readWorkOrderRefundState(run: ReversalRun): WorkOrderRefundRunState {
  return (run.state.get(REFUND_KEY) as WorkOrderRefundRunState | undefined) ?? { immediateCashRefund: new Decimal(0), pendingRefundReceiptIds: [] };
}

/** الأرقامُ الحاكمة لقيد العكس — مشتقّةٌ من السياق مرّةً واحدة (تشاركها الخدمةُ في حالة المستند). */
export function workOrderDeliveryFigures(ctx: WorkOrderDeliveryContext) {
  const total = round2(money(ctx.inv.total));
  const materialsCost = round2(money(ctx.wo.materialsCost ?? "0"));
  const rawDeposit = money(ctx.wo.deposit ?? "0");
  const depositClosed = round2(rawDeposit.lt(total) ? rawDeposit : total);
  // رصيد العميل المخزّن يعكس أصل المقبوض قبل ردوده، لا paidAmount الصافي بعدها. طرحُ
  // `total - netPaid` كان يطرح OUT السابق مرّةً ثانية ويقلب الرصيد سالباً عند رد جزئي سابق.
  const grossPaidBeforeRefunds = round2(ctx.netPaid.plus(ctx.completedOut));
  const unpaid = round2(total.minus(grossPaidBeforeRefunds));
  const safeUnpaid = unpaid.lt(0) ? money(0) : unpaid;
  return { total, materialsCost, depositClosed, safeUnpaid };
}

/** قيدُ البيع الخدميّ: RETURN بمفتاحٍ ثابت + هدرُ الخامة عند الإقفال. */
export const workOrderDeliveryLedgerExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = readWorkOrderDeliveryContext(run);
  const { total, materialsCost, depositClosed } = workOrderDeliveryFigures(ctx);
  const workOrderId = Number(ctx.wo.id);
  const invoiceId = Number(ctx.inv.id);
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const reverseLines = [debitLine("SALES_FLEX", total), creditLine("AR", total)];
    const roleDebits: Record<string, Decimal> = { SALES_FLEX: total };
    const roleCredits: Record<string, Decimal> = { AR: total };
    if (materialsCost.gt(0)) {
      reverseLines.push(debitLine("WORK_IN_PROGRESS", materialsCost), creditLine("COGS", materialsCost));
      roleDebits.WORK_IN_PROGRESS = materialsCost;
      roleCredits.COGS = materialsCost;
    }
    if (depositClosed.gt(0)) {
      reverseLines.push(debitLine("AR", depositClosed), creditLine("OTHER_LIABILITY", depositClosed));
      roleDebits.AR = depositClosed;
      roleCredits.OTHER_LIABILITY = depositClosed;
    }
    const reverseSource = { roleDebits, roleCredits };
    await postEntry(tx, {
      entryType: "RETURN",
      dedupeKey: `WO-REVERSE:${workOrderId}:${invoiceId}`,
      branchId: Number(ctx.wo.branchId), invoiceId, customerId: ctx.wo.customerId ?? null,
      revenue: total.neg(), cost: materialsCost.neg(),
      profit: round2(total.minus(materialsCost)).neg(), amount: total.neg(),
      notes: `عكس تسليم أمر الشغل ${ctx.wo.orderNumber} — ${ctx.reason}`,
      postingIntent: createPostingIntent("RETURN_SALE_FLEX_WORKORDER", "RETURN", reverseLines, reverseSource),
      postingSourceComponents: reverseSource,
    });
    if (!ctx.reopen && materialsCost.gt(0)) {
      const wasteSource = { roleDebits: { LOSSES: materialsCost }, roleCredits: { WORK_IN_PROGRESS: materialsCost } };
      await postEntry(tx, {
        entryType: "ADJUST", dedupeKey: `WO-REVERSE-WASTE:${workOrderId}:${invoiceId}`,
        branchId: Number(ctx.wo.branchId), invoiceId, cost: materialsCost, amount: materialsCost,
        notes: `هدر خامة أمر الشغل المسترجَع ${ctx.wo.orderNumber} — ${ctx.reason}`,
        postingIntent: createPostingIntent("ADJUST_WIP_WASTE", "ADJUST", [debitLine("LOSSES", materialsCost), creditLine("WORK_IN_PROGRESS", materialsCost)], wasteSource),
        postingSourceComponents: wasteSource,
      });
    }
    outcomes.push({
      status: "REVERSED",
      signedAmount: effect.outstandingAmount.negated(),
      payloadJson: { entryType: "RETURN", dedupeKey: `WO-REVERSE:${workOrderId}:${invoiceId}`, wasted: !ctx.reopen ? materialsCost.toFixed(2) : "0.00", total: total.toFixed(2) },
    });
  }
  return outcomes;
};

/** ردُّ المقبوضات مصدراً مصدراً بحسب خطّته — نقدٌ فوريّ أو سندٌ معلَّق. */
export const workOrderDeliveryRefundExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = readWorkOrderDeliveryContext(run);
  const workOrderId = Number(ctx.wo.id);
  const invoiceId = Number(ctx.inv.id);
  const state = readWorkOrderRefundState(run);
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const sourceReceiptId = Number(effect.effectRowId ?? 0);
    const plans = ctx.plans.filter((plan) => plan.sourceReceiptId === sourceReceiptId);
    if (!plans.length) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر ردّ مقبوض أمر الشغل ${ctx.wo.orderNumber}`,
          why: `إيصال القبض رقم ${sourceReceiptId} له متبقٍّ يُردّ (${effect.outstandingAmount.toFixed(2)} د.ع) ولا خطّةَ ردٍّ له في الطلب المعتمَد — تغيّرت المقبوضات بعد الطلب`,
          doThis: "افتح طلب عكس تسليمٍ جديداً ليُعاد بناء خطّة الردّ على المقبوضات الحاليّة",
        }),
      });
    }
    let reversedAmount = new Decimal(0);
    let firstReceiptId: number | null = null;
    let leftOpenWhy: string | null = null;
    for (const plan of plans) {
      const amount = money(plan.amount);
      const cash = plan.refundMethod === "CASH";
      if (cash) {
        if (ctx.cashShiftId == null) throw new TRPCError({ code: "CONFLICT", message: "مصدر درج الرد النقدي غير مقفل" });
        await assertCashOutAvailable(tx, {
          branchId: Number(ctx.wo.branchId), cashBucket: "DRAWER", shiftId: ctx.cashShiftId,
          amount, operation: "رد مقبوضات عكس تسليم أمر شغل",
        });
      } else {
        if (ctx.wo.customerId == null) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الرد غير النقدي يحتاج عميلاً مرتبطاً للاعتماد الخارجي" });
        }
        assertNonPhysicalOutReceipt({
          classification: "DEFERRED_APPROVAL", paymentMethod: plan.refundMethod,
          cashBucket: null, approvalStatus: "PENDING_APPROVAL",
          operation: "طلب رد غير نقدي لعكس تسليم أمر شغل",
        });
      }
      const inserted = await tx.insert(receipts).values({
        branchId: Number(ctx.wo.branchId), shiftId: cash ? ctx.cashShiftId : null,
        workOrderId, invoiceId, direction: "OUT", amount: toDbMoney(amount),
        paymentMethod: plan.refundMethod, cashBucket: cash ? "DRAWER" : null,
        status: cash ? "COMPLETED" : "PENDING",
        approvalStatus: cash ? "APPROVED" : "PENDING_APPROVAL",
        referenceNumber: cash ? `WO-REV-${invoiceId}-${plan.sourceReceiptId}-${plan.counterRole === "AR" ? "A" : "L"}` : null,
        description: cash ? `رد مقبوض — عكس تسليم ${ctx.wo.orderNumber}` : `طلب رد غير نقدي — عكس تسليم ${ctx.wo.orderNumber}`,
        partyType: ctx.wo.customerId != null ? "CUSTOMER" : "OTHER",
        partyId: ctx.wo.customerId ?? null,
        internalNote: `WORK_ORDER_CUSTOMER_REFUND:${plan.counterRole === "AR" ? "REVERSE_AR" : "REVERSE_LIABILITY"}:${workOrderId}:${plan.sourceReceiptId}:${ctx.approvedControlRequestId}`,
        createdBy: run.actor.userId,
      });
      const refundReceiptId = extractInsertId(inserted);
      firstReceiptId ??= refundReceiptId;
      if (!cash) {
        state.pendingRefundReceiptIds.push(refundReceiptId);
        leftOpenWhy = `الردّ بـ${plan.refundMethod} سندُ صرفٍ معلَّق (إيصال ${refundReceiptId}) لا يخرج به مالٌ حتى يعتمده المالك`;
        continue;
      }
      state.immediateCashRefund = state.immediateCashRefund.plus(amount);
      reversedAmount = reversedAmount.plus(amount);
      const assetRole = paymentAssetRole("CASH", "DRAWER", "OUT");
      const profile = plan.counterRole === "AR" ? "PAYMENT_OUT_CUSTOMER_REFUND" : "PAYMENT_OUT_OTHER";
      const source = { roleDebits: { [plan.counterRole]: amount }, roleCredits: { [assetRole]: amount } };
      await postEntry(tx, {
        entryType: "PAYMENT_OUT", dedupeKey: `WO-REVERSE-REFUND:${invoiceId}:${refundReceiptId}`,
        branchId: Number(ctx.wo.branchId), invoiceId, receiptId: refundReceiptId,
        customerId: ctx.wo.customerId ?? null, amount, paymentMethod: "CASH",
        notes: `رد عكس تسليم ${ctx.wo.orderNumber} — ${plan.counterRole === "AR" ? "حصّة دفعة التسليم" : "حصّة العربون"}`,
        postingIntent: createPostingIntent(profile, "PAYMENT_OUT", [debitLine(plan.counterRole, amount), creditLine(assetRole, amount)], source),
        postingSourceComponents: source,
      });
    }
    run.state.set(REFUND_KEY, state);
    if (leftOpenWhy != null) {
      outcomes.push({ status: "LEFT_OPEN", why: leftOpenWhy, payloadJson: { pendingRefundReceiptIds: state.pendingRefundReceiptIds, sourceReceiptId } });
    } else {
      outcomes.push({
        status: "REVERSED",
        signedAmount: reversedAmount.neg(),
        effectTable: "receipts",
        effectRowId: firstReceiptId,
        payloadJson: { sourceReceiptId, plans: plans.map((p) => ({ amount: p.amount, counterRole: p.counterRole, method: p.refundMethod })) },
      });
    }
  }
  return outcomes;
};

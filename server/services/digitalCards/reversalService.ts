/**
 * عكس بيع الكروت (ش١٢) — المسار **الوحيد** لإرجاع كرتٍ رقميّ.
 *
 * لماذا لا يكفي المرتجع العادي: الكرت خرج من جهاز المزوّد وقد يكون الزبون استهلكه.
 * إعادته ليست إعادةَ بضاعةٍ إلى الرفّ بل قرارٌ ماليّ من حالتين:
 *
 *   • **عكس مؤكَّد** (`approveReversal`): المزوّد أكّد إلغاء الكرت وأعاد الحصة.
 *     ⇒ قيد `RETURN` بقيمٍ سالبة يعكس البيع بالكامل + استرداد للزبون + إعادة الحصة
 *       (رصيد المحفظة للمسبق، أو خفض ذمّة المزوّد للآجل).
 *     **معيار خروج ش١٢:** الصافي يعود صفراً — revenue وcost وprofit كلها تتلاشى.
 *
 *   • **ردّ خسارة** (`lossRefund`): المزوّد **لم** يُعِد الحصة، لكن قرار الإدارة ردّ المال للزبون.
 *     ⇒ الإيراد يُعكَس والزبون يُسترَدّ، لكن **الحصة تبقى تكلفةً على المكتبة**
 *       (لا رصيد يعود ولا ذمّة تنخفض) ⇒ الصافي = خسارةٌ بمقدار حصة المزوّد. هذا مقصود:
 *       الدفاتر يجب أن تُظهر الخسارة لا أن تُخفيها.
 *
 * كلتاهما مديريّة وتُسجَّل في التدقيق، وكلتاهما ذرّية: إمّا الكلّ أو لا شيء.
 */
import { TRPCError } from "@trpc/server";
import { assertServiceOperationTx, loadOperationUserTx, type ServiceOperationActor, type StoredOperationSnapshot } from "../authorization/operationAuthority";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  accountingEntries,
  auditLogs,
  digitalProviders,
  digitalSaleDetails,
  digitalWalletTransactions,
  digitalWallets,
  invoices,
  invoiceItems,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { adjustCustomerBalance, adjustSupplierBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { createPostingIntent, creditLine, debitLine, signedPostingLines } from "../accounting/postingEngine";
import { money, sumMoney, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";
import { cancelContractsByInvoiceItems } from "./subscriptionService";
import type { DigitalCardRefundControl, DigitalRefundTender } from "../../../shared/digitalPaymentSettlement";
import { completeDigitalReturnItems, controlDigitalCardRefund, digitalRefundReplay, executeDigitalRefund, invoiceDigitalRefundContext, type DigitalRefundContext } from "./refundPayments";
import { digitalRefundItems, digitalRefundPayments } from "../../../drizzle/digitalSettlementSchema";

export type ReversalOutcome = "REVERSED" | "LOSS_REFUND";

async function markDigitalInvoiceItemsReturned(tx: Tx, details: Array<{ invoiceItemId: number }>) {
  // Financial completion only: no stock-return command or inventory movement for a code.
  await tx.update(invoiceItems).set({ returnedBaseQuantity: sql`${invoiceItems.baseQuantity}` })
    .where(inArray(invoiceItems.id, details.map((d) => Number(d.invoiceItemId))));
}

/** A separate committed stage preserves manual bank success across a later financial rollback. */
export async function controlRefund(tx: Tx, input: {
  invoiceId: number; detailIds: number[]; reason?: string;
}, control: DigitalCardRefundControl, kind: ReversalOutcome, actor: Actor & ServiceOperationActor) {
  await assertServiceOperationTx(tx, actor, kind === "REVERSED" ? "digitalCards.reversal.approve" : "digitalCards.reversal.lossRefund");
  const context = await invoiceDigitalRefundContext(tx, { ...input, kind, reason: input.reason ?? "رد خسارة كروت" }, actor);
  if (kind === "LOSS_REFUND") {
    const authority = await loadOperationUserTx(tx, actor.userId);
    const details = await tx.select({ requestedBy: digitalSaleDetails.lossRefundRequestedBy }).from(digitalSaleDetails)
      .where(inArray(digitalSaleDetails.id, input.detailIds));
    if (details.some((d) => Number(d.requestedBy) === actor.userId) && !authority.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({"what":"تعذّر اعتماد رد الخسارة","why":"لا يعتمد ردّ الخسارة من طلبه — يلزم مديرٌ آخر","doThis":"اطلب من مدير مستقل مراجعة الطلب واعتماد مصير حصة المزوّد"}) });
    }
  }
  return controlDigitalCardRefund(tx, context, control, actor);
}

export async function evidenceForRefund(tx: Tx, input: { invoiceId: number; detailIds: number[]; reason?: string; refund: DigitalRefundTender }, kind: ReversalOutcome, actor: Actor & ServiceOperationActor) {
  return controlRefund(tx, input, { stage: "EVIDENCE", tender: input.refund }, kind, actor);
}

async function auditLog(tx: Tx, actor: Actor, action: string, entityId: number, details: unknown): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalSaleDetail",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort
  }
}
async function prelockCashReversal(
  tx: Tx,
  input: { invoiceId: number; detailIds: number[]; refund?: DigitalRefundTender },
  actor: Actor,
  lockPrepaidWallets: boolean,
): Promise<{ branchId: number; customerId: number | null; walletIds: Set<number> }> {
  const [previewInvoice] = await tx
    .select({ branchId: invoices.branchId, customerId: invoices.customerId })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .limit(1);
  if (!previewInvoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  const branchId = Number(previewInvoice.branchId);
  if (actor.role !== "admin" && branchId !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخصّ فرعاً آخر" });
  }

  let walletIds = new Set<number>();
  if (lockPrepaidWallets) {
    const previews = await tx
      .select({ walletTransactionId: digitalSaleDetails.walletTransactionId })
      .from(digitalSaleDetails)
      .where(and(eq(digitalSaleDetails.invoiceId, input.invoiceId), inArray(digitalSaleDetails.id, input.detailIds)));
    if (previews.length !== input.detailIds.length) {
      throw new TRPCError({ code: "NOT_FOUND", message: "بعض بنود الكروت غير موجودة في هذه الفاتورة" });
    }
    const transactionIds = previews.flatMap((row) =>
      row.walletTransactionId == null ? [] : [Number(row.walletTransactionId)],
    );
    if (transactionIds.length > 0) {
      const originals = await tx
        .select({ walletId: digitalWalletTransactions.walletId })
        .from(digitalWalletTransactions)
        .where(inArray(digitalWalletTransactions.id, transactionIds));
      walletIds = new Set(originals.map((row) => Number(row.walletId)));
    }
  }

  if ((input.refund?.method ?? "CASH") === "CASH") await lockCashSourceForUpdate(tx, { branchId, cashBucket: "TREASURY" });
  for (const walletId of Array.from(walletIds).sort((a, b) => a - b)) {
    const [wallet] = await tx
      .select({ id: digitalWallets.id })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update")
      .limit(1);
    if (!wallet) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
  }
  return {
    branchId,
    customerId: previewInvoice.customerId != null ? Number(previewInvoice.customerId) : null,
    walletIds,
  };
}

/**
 * يقفل بنود التفاصيل المطلوبة ويتحقّق أنها في الحالة المتوقَّعة.
 * `expect` افتراضه `ISSUED` (نقطة البدء لكل مسار)؛ ويصير `LOSS_REFUND_PENDING` عند
 * اعتماد/رفض ردّ الخسارة — فلا يُعتمَد بندٌ لم يُطلَب ردُّه.
 */
async function lockDetails(
  tx: Tx,
  invoiceId: number,
  detailIds: number[],
  expect: "ISSUED" | "LOSS_REFUND_PENDING" = "ISSUED",
) {
  const rows = await tx
    .select()
    .from(digitalSaleDetails)
    .where(and(eq(digitalSaleDetails.invoiceId, invoiceId), inArray(digitalSaleDetails.id, detailIds)))
    .orderBy(asc(digitalSaleDetails.id))
    .for("update");
  if (rows.length !== detailIds.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "بعض بنود الكروت غير موجودة في هذه الفاتورة" });
  }
  const wrong = rows.filter((r) => r.fulfillmentStatus !== expect);
  if (wrong.length) {
    throw new TRPCError({
      code: "CONFLICT",
      message: expect === "ISSUED"
        ? `${wrong.length} كرت عولِج مسبقاً أو ينتظر اعتماداً — لا يُعكس مرّتين`
        : `${wrong.length} كرت ليس عليه طلب ردّ خسارةٍ معلّق`,
    });
  }
  return rows;
}

/** Non-financial decisions use the same invoice → details order as execution. */
async function lockLossRefundInvoice(
  tx: Tx,
  invoiceId: number,
  authority: StoredOperationSnapshot,
): Promise<void> {
  const [invoice] = await tx.select({ branchId: invoices.branchId })
    .from(invoices).where(eq(invoices.id, invoiceId)).for("update").limit(1);
  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  if (authority.role !== "admin" && Number(invoice.branchId) !== Number(authority.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
      what: "تعذّر البتّ في ردّ الخسارة",
      why: "الفاتورة تخصّ فرعاً آخر",
      doThis: "اطلب المعالجة من إدارة فرع الفاتورة أو الإدارة المركزية",
    }) });
  }
}

type LockedInvoiceHeader = {
  id: number;
  branchId: number;
  customerId: number | null;
  total: string;
  paidAmount: string;
  returnedTotal: string;
  status: string;
};

/**
 * يشتق رأس الفاتورة بعد استردادٍ رقمي تحت قفل صفّ الفاتورة.
 *
 * هذا الحارس متعمّد الصرامة: ردّ الكرت يخرج نقداً فوراً، لذلك لا يجوز أن يزيد عن المقبوض
 * الفعلي، ولا أن يرفع المرتجعات فوق إجمالي الفاتورة. أيّ رأسٍ تاريخيّ منحرف يتوقّف قبل
 * إنشاء إيصال/قيد، بدل أن نُخفي الانحراف بـ clamp ونصرف مالاً غير مُغطّى.
 */
function invoiceHeaderAfterDigitalRefund(
  inv: LockedInvoiceHeader,
  sell: ReturnType<typeof money>,
  cashRefund: ReturnType<typeof money>,
  fullyReturned: boolean,
) {
  const total = money(inv.total);
  const paid = money(inv.paidAmount);
  const returned = money(inv.returnedTotal ?? "0");
  const remainingReturnable = total.minus(returned);

  if (["CANCELLED", "RETURNED", "SUPERSEDED"].includes(inv.status)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استرداد البطاقة الرقمية",
        why: `حالة الفاتورة ${inv.status} نهائية ولا تقبل استرداداً جديداً`,
        doThis: "راجع سجل الفاتورة وحدّد المعالجة السابقة قبل إعادة المحاولة",
      }),
    });
  }
  // Customer-account returns may legitimately leave paid > net after returns.
  // The physical source cap is validated against receipts by invoiceDigitalRefundContext.
  if (total.lt(0) || paid.lt(0) || returned.lt(0) || returned.gt(total)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استرداد البطاقة الرقمية",
        why: `رأس الفاتورة غير متّسق: الإجمالي ${toDbMoney(total)}، المدفوع ${toDbMoney(paid)}، والمرتجع السابق ${toDbMoney(returned)}`,
        doThis: "راجع الفاتورة وحركات قبضها ومرتجعاتها، ثم صحّح الانحراف قبل إعادة الاسترداد",
      }),
    });
  }
  if (sell.lt(0) || sell.gt(remainingReturnable)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استرداد البطاقة الرقمية",
        why: `قيمة البنود المرتجعة ${toDbMoney(sell)} تتجاوز المتبقي القابل للإرجاع ${toDbMoney(remainingReturnable)}`,
        doThis: "حدّد بنوداً لم تُعكس سابقاً وتأكد من قيمة الفاتورة قبل إعادة المحاولة",
      }),
    });
  }
  if (sell.gt(paid) && inv.customerId == null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استرداد البطاقة الرقمية",
        why: `مبلغ الرد يتجاوز المقبوض الفعلي: قيمة البنود ${toDbMoney(sell)} والمقبوض ${toDbMoney(paid)}، ولا يوجد عميل مسجّل لتحويل الباقي إلى رصيد دائن`,
        doThis: "راجع سندات القبض وربط العميل بالفاتورة قبل إعادة الاسترداد",
      }),
    });
  }
  if (cashRefund.lt(0) || cashRefund.gt(sell) || cashRefund.gt(paid)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر استرداد البطاقة الرقمية",
        why: `مبلغ الاسترداد النقدي ${toDbMoney(cashRefund)} لا تغطيه قيمة البنود ${toDbMoney(sell)} أو المقبوض المتبقي ${toDbMoney(paid)}`,
        doThis: "راجع سندات القبض والصرف على الفاتورة قبل إعادة الاسترداد",
      }),
    });
  }

  const paidAmount = paid.minus(cashRefund);
  const returnedTotal = returned.plus(sell);
  const status = fullyReturned
    ? "RETURNED" as const
    : computeInvoiceStatus(inv.total, toDbMoney(paidAmount), toDbMoney(returnedTotal));
  return { paidAmount, returnedTotal, status };
}

async function persistInvoiceHeaderAfterDigitalRefund(
  tx: Tx,
  inv: LockedInvoiceHeader,
  sell: ReturnType<typeof money>,
  cashRefund: ReturnType<typeof money>,
  fullyReturned: boolean,
): Promise<{ paidAmount: string; returnedTotal: string; status: "PENDING" | "PARTIALLY_PAID" | "PAID" | "RETURNED" }> {
  const next = invoiceHeaderAfterDigitalRefund(inv, sell, cashRefund, fullyReturned);
  const paidAmount = toDbMoney(next.paidAmount);
  const returnedTotal = toDbMoney(next.returnedTotal);
  await tx
    .update(invoices)
    .set({ paidAmount, returnedTotal, status: next.status })
    .where(eq(invoices.id, inv.id));
  return { paidAmount, returnedTotal, status: next.status };
}

/** استرداد نقديّ للزبون + قيد RETURN سالب. مشتركٌ بين المسارين. */
async function refundAndPostReturn(
  tx: Tx,
  opts: {
    invoiceId: number;
    branchId: number;
    customerId: number | null;
    sell: ReturnType<typeof money>;
    cashRefund: ReturnType<typeof money>;
    operationKey: string;
    /** التكلفة المعكوسة: الحصة كاملةً في العكس المؤكَّد، وصفرٌ في ردّ الخسارة. */
    reversedCost: ReturnType<typeof money>;
    kind: ReversalOutcome;
    context: DigitalRefundContext;
    refund: DigitalRefundTender;
  },
  actor: Actor,
): Promise<number | null> {
  const payout = await executeDigitalRefund(tx, opts.context, opts.refund, actor);
  const receiptId = payout?.receiptId ?? null;
  const occurredAt = new Date();

  // RETURN بقيمٍ سالبة (اصطلاح الدفتر). الربح = الإيراد المعكوس − التكلفة المعكوسة:
  //   • مؤكَّد ⇒ −sell + share  = −margin  (يُلاشي ربح البيع تماماً)
  //   • خسارة ⇒ −sell + 0       = −sell    (الإيراد يزول والحصة تبقى تكلفةً محمَّلة)
  const revenue = opts.sell.neg();
  const cost = opts.reversedCost.neg();
  const returnSourceComponents = {
    roleDebits: {
      OTHER_REVENUE: opts.sell,
      INVENTORY: opts.reversedCost,
    },
    roleCredits: {
      AR: opts.sell,
      COGS: opts.reversedCost,
    },
  };
  await postEntry(tx, {
    entryType: "RETURN",
    entryDate: occurredAt,
    branchId: opts.branchId,
    invoiceId: opts.invoiceId,
    customerId: opts.customerId ?? null,
    receiptId,
    amount: opts.sell.neg(),
    revenue,
    cost,
    profit: revenue.minus(cost),
    dedupeKey: `DIGITAL:REV:${opts.invoiceId}:${opts.kind}:${actor.userId}:${receiptId ?? opts.operationKey.slice(-32)}`,
    notes: opts.kind === "REVERSED" ? "عكس بيع كروت" : "ردّ خسارة كروت",
    createdBy: actor.userId,
    postingSourceComponents: returnSourceComponents,
    postingIntent: createPostingIntent(
      "RETURN_SALE_DIGITAL",
      "RETURN",
      [
        debitLine("OTHER_REVENUE", opts.sell),
        creditLine("AR", opts.sell),
        ...(opts.reversedCost.isZero()
          ? []
          : [debitLine("INVENTORY", opts.reversedCost), creditLine("COGS", opts.reversedCost)]),
      ],
      returnSourceComponents,
    ),
  });
  await completeDigitalReturnItems(tx, opts.context, payout?.refundId ?? null, occurredAt);
  const rounding = money(opts.context.roundingAdjustment ?? "0");
  if (!rounding.isZero()) await postEntry(tx, { entryType: "ADJUST", branchId: opts.branchId, invoiceId: opts.invoiceId,
    customerId: opts.customerId, amount: rounding.neg(), revenue: rounding.neg(), profit: rounding.neg(), entryDate: occurredAt,
    dedupeKey: `ADJUST:IQD:DIGITAL_RETURN:${opts.invoiceId}:${opts.context.operationKey.slice(-32)}`, createdBy: actor.userId,
    notes: "عكس حصة تقريب IQD — مرتجع كروت", postingIntent: createPostingIntent("ADJUST_ROUNDING", "ADJUST", signedPostingLines("AR", "ROUNDING_DIFF", rounding.neg())) });
  return receiptId;
}

async function adjustReturnedReceivable(
  tx: Tx,
  opts: {
    customerId: number | null;
    sell: ReturnType<typeof money>;
    cashRefund: ReturnType<typeof money>;
  },
): Promise<void> {
  const receivableReduction = opts.sell.minus(opts.cashRefund);
  if (opts.customerId != null && receivableReduction.gt(0)) {
    await adjustCustomerBalance(tx, opts.customerId, receivableReduction.neg());
  }
}

/* ────────── العكس المؤكَّد ────────── */

/**
 * المزوّد أكّد الإلغاء وأعاد الحصة. يعكس البيع بالكامل ويعيد الحصة إلى مصدرها.
 * عكسٌ كاملٌ لكل بنود الفاتورة ⇒ **صافي صفريّ** (معيار خروج ش١٢).
 */
export async function approveReversal(
  tx: Tx,
  input: { invoiceId: number; detailIds: number[]; reason: string; refund?: DigitalRefundTender },
  actor: Actor & ServiceOperationActor,
): Promise<{ invoiceId: number; reversed: number; refunded: string; outcome: ReversalOutcome }> {
  await assertServiceOperationTx(tx, actor, "digitalCards.reversal.approve");
  const reason = input.reason.trim();
  if (!reason) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب العكس مطلوب" });

  const prelocked = await prelockCashReversal(tx, input, actor, true);
  const context = await invoiceDigitalRefundContext(tx, { ...input, kind: "REVERSED" }, actor);
  const replay = await digitalRefundReplay(tx, context.operationKey);
  if (replay || context.replayedZeroReturn) {
    await executeDigitalRefund(tx, context, input.refund ?? { method: "CASH" }, actor);
    return { invoiceId: input.invoiceId, reversed: input.detailIds.length, refunded: replay?.amount ?? "0.00", outcome: "REVERSED" };
  }

  const [inv] = await tx
    .select({
      id: invoices.id,
      branchId: invoices.branchId,
      customerId: invoices.customerId,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      returnedTotal: invoices.returnedTotal,
      status: invoices.status,
    })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .for("update");
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  if (Number(inv.branchId) !== prelocked.branchId) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع الفاتورة أثناء العكس — أعد المحاولة" });
  }
  // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير لا يعكس بيع فرعٍ آخر.
  if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخصّ فرعاً آخر" });
  }

  const details = await lockDetails(tx, input.invoiceId, input.detailIds);
  const sell = sumMoney(details.map((d) => d.sellPriceSnapshot));
  const share = sumMoney(details.map((d) => d.providerShareSnapshot));
  const cashRefund = money(context.amount);
  const returnAmount = money(context.returnAmount ?? sell);
  const invoiceHeader = await persistInvoiceHeaderAfterDigitalRefund(tx, inv, returnAmount, cashRefund, context.fullyReturned === true);

  const receiptId = await refundAndPostReturn(
    tx,
    {
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      customerId: inv.customerId != null ? Number(inv.customerId) : null,
      sell,
      cashRefund,
      operationKey: context.operationKey,
      reversedCost: share,
      kind: "REVERSED",
      context,
      refund: input.refund ?? { method: "CASH" },
    },
    actor,
  );
  await adjustReturnedReceivable(tx, {
    customerId: inv.customerId != null ? Number(inv.customerId) : null,
    sell: returnAmount,
    cashRefund,
  });

  /* إعادة الحصة إلى مصدرها — بترتيب المحفظة/المورّد تصاعدياً (منع deadlock). */
  const prepaidByWallet = new Map<number, ReturnType<typeof money>>();
  const postpaidByProvider = new Map<number, ReturnType<typeof money>>();

  for (const d of details) {
    const amount = money(d.providerShareSnapshot);
    if (d.settlementModeSnapshot === "PREPAID") {
      if (d.walletTransactionId == null) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "بند مسبق الدفع بلا حركة محفظة" });
      }
      const [orig] = await tx
        .select({ walletId: digitalWalletTransactions.walletId })
        .from(digitalWalletTransactions)
        .where(eq(digitalWalletTransactions.id, Number(d.walletTransactionId)))
        .limit(1);
      if (!orig) throw new TRPCError({ code: "NOT_FOUND", message: "حركة المحفظة الأصلية غير موجودة" });
      const wid = Number(orig.walletId);
      if (!prelocked.walletIds.has(wid)) {
        throw new TRPCError({ code: "CONFLICT", message: "تغيّرت محفظة بند الكرت أثناء العكس — أعد المحاولة" });
      }
      prepaidByWallet.set(wid, (prepaidByWallet.get(wid) ?? money(0)).plus(amount));
    } else {
      const pid = Number(d.providerId);
      postpaidByProvider.set(pid, (postpaidByProvider.get(pid) ?? money(0)).plus(amount));
    }
  }

  for (const walletId of Array.from(prepaidByWallet.keys()).sort((a, b) => a - b)) {
    const amount = prepaidByWallet.get(walletId)!;
    const [w] = await tx
      .select({ id: digitalWallets.id, branchId: digitalWallets.branchId, currentBalance: digitalWallets.currentBalance })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update");
    if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
    const next = money(w.currentBalance).plus(amount);

    await tx.insert(digitalWalletTransactions).values({
      walletId,
      branchId: Number(w.branchId),
      type: "SALE_REVERSAL",
      direction: "IN",
      amount: toDbMoney(amount),
      balanceAfter: toDbMoney(next),
      transactionNumber: `DWR-${input.invoiceId}-${walletId}-${receiptId ?? details[0]!.id}`,
      clientRequestId: `REV:${input.invoiceId}:${walletId}:${receiptId ?? details[0]!.id}`,
      invoiceId: input.invoiceId,
      createdBy: actor.userId,
      notes: `عكس بيع كروت — ${reason}`,
    });
    await tx.update(digitalWallets).set({ currentBalance: toDbMoney(next) }).where(eq(digitalWallets.id, walletId));

    // حركة أصل: صفر أثر P&L (§٥.١٢) — الأثر الربحيّ كلّه في قيد RETURN أعلاه.
    await postEntry(tx, {
      entryType: "DIGITAL_WALLET_REVERSAL",
      branchId: Number(w.branchId),
      invoiceId: input.invoiceId,
      digitalWalletId: walletId,
      amount,
      revenue: money(0),
      cost: money(0),
      profit: money(0),
      dedupeKey: `DIGITAL:WREV:${input.invoiceId}:${walletId}:${receiptId ?? details[0]!.id}`,
      notes: "إعادة رصيد محفظة بعكس بيع",
      createdBy: actor.userId,
      postingSourceComponents: {
        roleDebits: { DIGITAL_WALLET: amount },
        roleCredits: { INVENTORY: amount },
      },
      postingIntent: createPostingIntent(
        "DIGITAL_WALLET_REVERSAL_SALE",
        "DIGITAL_WALLET_REVERSAL",
        [debitLine("DIGITAL_WALLET", amount), creditLine("INVENTORY", amount)],
        {
          roleDebits: { DIGITAL_WALLET: amount },
          roleCredits: { INVENTORY: amount },
        },
      ),
    });
  }

  for (const providerId of Array.from(postpaidByProvider.keys()).sort((a, b) => a - b)) {
    const amount = postpaidByProvider.get(providerId)!;
    const [prov] = await tx
      .select({ supplierId: digitalProviders.supplierId })
      .from(digitalProviders)
      .where(eq(digitalProviders.id, providerId))
      .limit(1);
    if (!prov) throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
    const supplierId = Number(prov.supplierId);

    // عكس الاستحقاق: قيد PURCHASE **سالب** يتيم + خفض رصيد المورّد بنفس المقدار.
    await postEntry(tx, {
      entryType: "PURCHASE",
      supplierId,
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      amount: amount.neg(),
      revenue: money(0),
      cost: money(0),
      profit: money(0),
      dedupeKey: `DIGITAL:APREV:${input.invoiceId}:${providerId}:${receiptId ?? details[0]!.id}`,
      notes: "عكس استحقاق مزوّد كروت",
      createdBy: actor.userId,
      postingSourceComponents: {
        roleDebits: { AP: amount },
        roleCredits: { INVENTORY: amount },
      },
      postingIntent: createPostingIntent(
        "PURCHASE_DIGITAL",
        "PURCHASE",
        signedPostingLines("INVENTORY", "AP", amount.neg()),
        {
          roleDebits: { AP: amount },
          roleCredits: { INVENTORY: amount },
        },
      ),
    });
    await adjustSupplierBalance(tx, supplierId, amount.neg());
  }

  await tx
    .update(digitalSaleDetails)
    .set({ fulfillmentStatus: "REVERSED" })
    .where(inArray(digitalSaleDetails.id, details.map((d) => Number(d.id))));
  await cancelContractsByInvoiceItems(tx, details.map((detail) => Number(detail.invoiceItemId)));
  await markDigitalInvoiceItemsReturned(tx, details);

  await auditLog(tx, actor, "digitalCards.reversal.approved", input.invoiceId, {
    details: details.length,
    refunded: toDbMoney(cashRefund),
    receivableReduced: toDbMoney(sell.minus(cashRefund)),
    shareReturned: toDbMoney(share),
    invoiceHeader,
    reason,
  });

  return { invoiceId: input.invoiceId, reversed: details.length, refunded: toDbMoney(cashRefund), outcome: "REVERSED" };
}

/* ────────── ردّ الخسارة — باعتمادٍ ثانٍ (SOD، قرار المالك ٣٠/٧/٢٦) ────────── */

/**
 * ① **طلب** ردّ الخسارة — بلا أيّ أثرٍ ماليّ.
 *
 * لماذا صار باعتمادٍ ثانٍ بينما `approveReversal` لم يَصِر: هذا يعترف **بخسارة** (الإيراد
 * يزول والحصة تبقى تكلفةً على المكتبة) فهو ماديّاً من جنس شطب النيّة العالقة. أمّا العكس
 * المؤكَّد فصافيه صفر — لا خسارة تُعتمَد، والزبون واقفٌ ينتظر استرداده.
 */
export async function requestLossRefund(
  tx: Tx,
  input: { invoiceId: number; detailIds: number[]; reason: string },
  actor: Actor & ServiceOperationActor,
): Promise<{ invoiceId: number; requested: number; refund: string; loss: string }> {
  await assertServiceOperationTx(tx, actor, "digitalCards.reversal.requestLossRefund");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب سبباً واضحاً لردّ الخسارة" });

  const authority = await loadOperationUserTx(tx, actor.userId);
  await lockLossRefundInvoice(tx, input.invoiceId, authority);
  const details = await lockDetails(tx, input.invoiceId, input.detailIds);
  const claimedRefund = await tx.select({ id: digitalRefundItems.id }).from(digitalRefundItems)
    .where(inArray(digitalRefundItems.detailId, input.detailIds)).limit(1);
  if (claimedRefund.length) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّر تبديل مصير الكروت","why":"حجز أو إثبات رد محفوظ لهذه البنود؛ أكمل قرار الرد الأصلي","doThis":"افتح حجز الرد القائم وطابق سجل الجهاز قبل تنفيذ أي إجراء مالي"}) });
  const sell = sumMoney(details.map((d) => d.sellPriceSnapshot));
  const share = sumMoney(details.map((d) => d.providerShareSnapshot));

  await tx
    .update(digitalSaleDetails)
    .set({
      fulfillmentStatus: "LOSS_REFUND_PENDING",
      lossRefundRequestedBy: actor.userId,
      lossRefundRequestedAt: new Date(),
      lossRefundReason: reason,
    })
    .where(inArray(digitalSaleDetails.id, details.map((d) => Number(d.id))));

  await auditLog(tx, actor, "digitalCards.reversal.lossRefundRequested", input.invoiceId, {
    details: details.length, refund: toDbMoney(sell), loss: toDbMoney(share), reason,
  });

  return {
    invoiceId: input.invoiceId,
    requested: details.length,
    refund: toDbMoney(sell),
    loss: toDbMoney(share),
  };
}

/** ③ **رفض** الطلب — يُعيد البنود إلى `ISSUED` بلا أثرٍ ماليّ ويمسح أثر الطلب. */
export async function rejectLossRefund(
  tx: Tx,
  input: { invoiceId: number; detailIds: number[]; reason?: string | null },
  actor: Actor & ServiceOperationActor,
): Promise<{ invoiceId: number; rejected: number }> {
  await assertServiceOperationTx(tx, actor, "digitalCards.reversal.rejectLossRefund");
  const authority = await loadOperationUserTx(tx, actor.userId);
  await lockLossRefundInvoice(tx, input.invoiceId, authority);
  const details = await lockDetails(tx, input.invoiceId, input.detailIds, "LOSS_REFUND_PENDING");
  const evidenced = await tx.select({ id: digitalRefundItems.id }).from(digitalRefundItems)
    .where(inArray(digitalRefundItems.detailId, input.detailIds)).limit(1);
  if (evidenced.length) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({"what":"تعذّر تبديل مصير الكروت","why":"يوجد حجز أو إثبات رد محفوظ لهذه البنود؛ أكمل اعتماده قبل تغيير القرار","doThis":"افتح حجز الرد القائم وطابق سجل الجهاز قبل تنفيذ أي إجراء مالي"}) });
  const requesters = new Set(details.map((d) => Number(d.lossRefundRequestedBy)));
  if (requesters.has(actor.userId) && !authority.isOwner) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يبتّ في الطلب من قدّمه — يلزم مديرٌ آخر" });
  }

  await tx
    .update(digitalSaleDetails)
    .set({
      fulfillmentStatus: "ISSUED",
      lossRefundRequestedBy: null,
      lossRefundRequestedAt: null,
      lossRefundReason: null,
    })
    .where(inArray(digitalSaleDetails.id, details.map((d) => Number(d.id))));

  await auditLog(tx, actor, "digitalCards.reversal.lossRefundRejected", input.invoiceId, {
    details: details.length,
    requestedBy: Array.from(requesters),
    rejectReason: input.reason ?? null,
  });

  return { invoiceId: input.invoiceId, rejected: details.length };
}

/**
 * ② **اعتماد** ردّ الخسارة — هنا وحده يتحرّك المال، وداخل معاملة واحدة.
 *
 * المزوّد لم يُعِد الحصة، والإدارة قرّرت ردّ المال للزبون: الإيراد يُعكَس والزبون يُسترَدّ،
 * و**الحصة تبقى تكلفةً على المكتبة** ⇒ خسارةٌ ظاهرة في الدفاتر. لا رصيد محفظةٍ يعود ولا
 * ذمّة مزوّدٍ تنخفض — لأن المزوّد فعلاً لم يُعِد شيئاً.
 */
export async function lossRefund(
  tx: Tx,
  input: { invoiceId: number; detailIds: number[]; refund?: DigitalRefundTender },
  actor: Actor & ServiceOperationActor,
): Promise<{ invoiceId: number; reversed: number; refunded: string; loss: string; outcome: ReversalOutcome }> {
  await assertServiceOperationTx(tx, actor, "digitalCards.reversal.lossRefund");
  const authority = await loadOperationUserTx(tx, actor.userId);

  const prelocked = await prelockCashReversal(tx, input, actor, false);
  const context = await invoiceDigitalRefundContext(tx, { ...input, kind: "LOSS_REFUND", reason: "اعتماد رد خسارة كروت" }, actor);
  const replay = await digitalRefundReplay(tx, context.operationKey);
  if (replay || context.replayedZeroReturn) {
    await executeDigitalRefund(tx, context, input.refund ?? { method: "CASH" }, actor);
    const details = await tx.select({ share: digitalSaleDetails.providerShareSnapshot }).from(digitalSaleDetails)
      .where(inArray(digitalSaleDetails.id, input.detailIds));
    return { invoiceId: input.invoiceId, reversed: input.detailIds.length, refunded: replay?.amount ?? "0.00",
      loss: toDbMoney(sumMoney(details.map((d) => d.share))), outcome: "LOSS_REFUND" };
  }

  const [inv] = await tx
    .select({
      id: invoices.id,
      branchId: invoices.branchId,
      customerId: invoices.customerId,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      returnedTotal: invoices.returnedTotal,
      status: invoices.status,
    })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .for("update");
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  if (Number(inv.branchId) !== prelocked.branchId) {
    throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع الفاتورة أثناء ردّ الخسارة — أعد المحاولة" });
  }
  // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير لا يعكس بيع فرعٍ آخر.
  if (actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخصّ فرعاً آخر" });
  }

  // البنود يجب أن تكون **معلّقة بطلبٍ سابق** — لا يُعتمَد ردٌّ لم يُطلَب.
  const details = await lockDetails(tx, input.invoiceId, input.detailIds, "LOSS_REFUND_PENDING");
  // فصل المهام: المُعتمِد ≠ الطالب. مالك النظام وحده مستثنى بصفته المرجع النهائي.
  const requesters = new Set(details.map((d) => Number(d.lossRefundRequestedBy)));
  if (requesters.has(actor.userId) && !authority.isOwner) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يعتمد ردّ الخسارة من طلبه — يلزم مديرٌ آخر" });
  }
  const reason = details[0]?.lossRefundReason ?? "";
  const sell = sumMoney(details.map((d) => d.sellPriceSnapshot));
  const share = sumMoney(details.map((d) => d.providerShareSnapshot));
  const cashRefund = money(context.amount);
  const returnAmount = money(context.returnAmount ?? sell);
  const invoiceHeader = await persistInvoiceHeaderAfterDigitalRefund(tx, inv, returnAmount, cashRefund, context.fullyReturned === true);

  await refundAndPostReturn(
    tx,
    {
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      customerId: inv.customerId != null ? Number(inv.customerId) : null,
      sell,
      cashRefund,
      operationKey: context.operationKey,
      // **صفر**: الحصة لم تُستردّ ⇒ تبقى تكلفةً محمَّلة على المكتبة.
      reversedCost: money(0),
      kind: "LOSS_REFUND",
      context,
      refund: input.refund ?? { method: "CASH" },
    },
    actor,
  );
  await adjustReturnedReceivable(tx, {
    customerId: inv.customerId != null ? Number(inv.customerId) : null,
    sell: returnAmount,
    cashRefund,
  });

  await tx
    .update(digitalSaleDetails)
    .set({
      fulfillmentStatus: "LOSS_REFUND",
      lossRefundApprovedBy: actor.userId,
      lossRefundApprovedAt: new Date(),
    })
    .where(inArray(digitalSaleDetails.id, details.map((d) => Number(d.id))));
  await cancelContractsByInvoiceItems(tx, details.map((detail) => Number(detail.invoiceItemId)));
  await markDigitalInvoiceItemsReturned(tx, details);

  await auditLog(tx, actor, "digitalCards.reversal.lossRefund", input.invoiceId, {
    details: details.length,
    refunded: toDbMoney(cashRefund),
    receivableReduced: toDbMoney(sell.minus(cashRefund)),
    loss: toDbMoney(share),
    invoiceHeader,
    requestedBy: Array.from(requesters),
    reason,
  });

  return {
    invoiceId: input.invoiceId,
    reversed: details.length,
    refunded: toDbMoney(cashRefund),
    loss: toDbMoney(share),
    outcome: "LOSS_REFUND",
  };
}

/* ────────── قراءات ────────── */

/** بنود فاتورةٍ قابلة للعكس (ISSUED فقط) — تُغذّي شاشة القرار. */
export async function reversibleDetails(db: DB, invoiceId: number, branchId?: number | null,
  quote?: { detailIds: number[]; kind: ReversalOutcome; actor: Actor }) {
  if (branchId != null) {
    const [invoice] = await db
      .select({ branchId: invoices.branchId })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (Number(invoice.branchId) !== branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخص فرعاً آخر" });
    }
  }
  const rows = await db
    .select({
      id: digitalSaleDetails.id,
      invoiceItemId: digitalSaleDetails.invoiceItemId,
      settlementMode: digitalSaleDetails.settlementModeSnapshot,
      sellPrice: digitalSaleDetails.sellPriceSnapshot,
      providerReference: digitalSaleDetails.providerReference,
      studentName: digitalSaleDetails.studentNameSnapshot,
      fulfillmentStatus: digitalSaleDetails.fulfillmentStatus,
      lossRefundRequestedBy: digitalSaleDetails.lossRefundRequestedBy,
      lossRefundReason: digitalSaleDetails.lossRefundReason,
      originalPaymentMethod: invoices.paymentMethod,
    })
    .from(digitalSaleDetails)
    .innerJoin(invoices, eq(digitalSaleDetails.invoiceId, invoices.id))
    .where(and(
      eq(digitalSaleDetails.invoiceId, invoiceId),
      ...(branchId == null ? [] : [eq(invoices.branchId, branchId)]),
    ))
    .orderBy(asc(digitalSaleDetails.id));
  const refundQuote = quote?.detailIds.length ? await db.transaction(async (tx) => {
    const context = await invoiceDigitalRefundContext(tx, { invoiceId, detailIds: quote.detailIds, kind: quote.kind, reason: "استعلام تسوية الرد" }, quote.actor, "PREVIEW");
    const [evidence] = await tx.select({ refundId: digitalRefundPayments.id, method: digitalRefundPayments.method, reference: digitalRefundPayments.normalizedReference,
      status: digitalRefundPayments.status, reservationExpiresAt: digitalRefundPayments.reservationExpiresAt }).from(digitalRefundPayments).where(eq(digitalRefundPayments.operationKey, context.operationKey)).limit(1);
    return { amount: context.amount, originalMethod: context.originalMethod, detailIds: context.detailIds, kind: quote.kind, evidence: evidence ?? null };
  }) : null;
  const pendingRefunds = await db.select({ status: digitalRefundPayments.status, detailIds: digitalRefundPayments.detailIds, method: digitalRefundPayments.method,
    reference: digitalRefundPayments.normalizedReference, amount: digitalRefundPayments.amount, reason: digitalRefundPayments.reason }).from(digitalRefundPayments)
    .where(and(eq(digitalRefundPayments.invoiceId, invoiceId), inArray(digitalRefundPayments.status, ["RESERVED", "EVIDENCED"])));
  return rows.map((row) => ({ ...row, refundQuote, pendingRefund: pendingRefunds.find((refund) => refund.detailIds.includes(Number(row.id))) ?? null }));
}

/**
 * ثابت معيار خروج ش١٢: بعد عكسٍ كاملٍ مؤكَّد، صافي الدفتر لهذه الفاتورة = صفر
 * في الإيراد والتكلفة والربح معاً.
 */
export async function netForInvoice(db: DB, invoiceId: number): Promise<{ revenue: string; cost: string; profit: string }> {
  const entries = await db
    .select({
      revenue: accountingEntries.revenue,
      cost: accountingEntries.cost,
      profit: accountingEntries.profit,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.invoiceId, invoiceId));
  return {
    revenue: toDbMoney(sumMoney(entries.map((e) => e.revenue))),
    cost: toDbMoney(sumMoney(entries.map((e) => e.cost))),
    profit: toDbMoney(sumMoney(entries.map((e) => e.profit))),
  };
}

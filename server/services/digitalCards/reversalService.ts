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
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  accountingEntries,
  auditLogs,
  digitalProviders,
  digitalSaleDetails,
  digitalWalletTransactions,
  digitalWallets,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, sumMoney, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

export type ReversalOutcome = "REVERSED" | "LOSS_REFUND";

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

function assertManager(actor: Actor): void {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "عكس بيع الكروت قرارٌ مديريّ" });
  }
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

/** استرداد نقديّ للزبون + قيد RETURN سالب. مشتركٌ بين المسارين. */
async function refundAndPostReturn(
  tx: Tx,
  opts: {
    invoiceId: number;
    branchId: number;
    customerId: number | null;
    sell: ReturnType<typeof money>;
    /** التكلفة المعكوسة: الحصة كاملةً في العكس المؤكَّد، وصفرٌ في ردّ الخسارة. */
    reversedCost: ReturnType<typeof money>;
    kind: ReversalOutcome;
  },
  actor: Actor,
): Promise<number> {
  const receiptRes = await tx.insert(receipts).values({
    invoiceId: opts.invoiceId,
    branchId: opts.branchId,
    shiftId: null,
    direction: "OUT",
    amount: toDbMoney(opts.sell),
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    partyType: opts.customerId != null ? "CUSTOMER" : "OTHER",
    partyId: opts.customerId ?? null,
    description:
      opts.kind === "REVERSED"
        ? "استرداد عكس بيع كروت رقمية"
        : "ردّ خسارة — كروت رقمية لم يُعِد المزوّد حصتها",
    createdBy: actor.userId,
  });
  const receiptId = extractInsertId(receiptRes);

  // RETURN بقيمٍ سالبة (اصطلاح الدفتر). الربح = الإيراد المعكوس − التكلفة المعكوسة:
  //   • مؤكَّد ⇒ −sell + share  = −margin  (يُلاشي ربح البيع تماماً)
  //   • خسارة ⇒ −sell + 0       = −sell    (الإيراد يزول والحصة تبقى تكلفةً محمَّلة)
  const revenue = opts.sell.neg();
  const cost = opts.reversedCost.neg();
  await postEntry(tx, {
    entryType: "RETURN",
    branchId: opts.branchId,
    invoiceId: opts.invoiceId,
    customerId: opts.customerId ?? null,
    receiptId,
    amount: opts.sell.neg(),
    revenue,
    cost,
    profit: revenue.minus(cost),
    dedupeKey: `DIGITAL:REV:${opts.invoiceId}:${opts.kind}:${actor.userId}:${receiptId}`,
    notes: opts.kind === "REVERSED" ? "عكس بيع كروت" : "ردّ خسارة كروت",
    createdBy: actor.userId,
  });
  return receiptId;
}

/* ────────── العكس المؤكَّد ────────── */

/**
 * المزوّد أكّد الإلغاء وأعاد الحصة. يعكس البيع بالكامل ويعيد الحصة إلى مصدرها.
 * عكسٌ كاملٌ لكل بنود الفاتورة ⇒ **صافي صفريّ** (معيار خروج ش١٢).
 */
export async function approveReversal(
  tx: Tx,
  input: { invoiceId: number; detailIds: number[]; reason: string },
  actor: Actor,
): Promise<{ invoiceId: number; reversed: number; refunded: string; outcome: ReversalOutcome }> {
  assertManager(actor);
  const reason = input.reason.trim();
  if (!reason) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب العكس مطلوب" });

  const [inv] = await tx
    .select({ id: invoices.id, branchId: invoices.branchId, customerId: invoices.customerId })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .for("update");
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });

  const details = await lockDetails(tx, input.invoiceId, input.detailIds);
  const sell = sumMoney(details.map((d) => d.sellPriceSnapshot));
  const share = sumMoney(details.map((d) => d.providerShareSnapshot));

  const receiptId = await refundAndPostReturn(
    tx,
    {
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      customerId: inv.customerId != null ? Number(inv.customerId) : null,
      sell,
      reversedCost: share,
      kind: "REVERSED",
    },
    actor,
  );

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
      transactionNumber: `DWR-${input.invoiceId}-${walletId}-${receiptId}`,
      clientRequestId: `REV:${input.invoiceId}:${walletId}:${receiptId}`,
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
      dedupeKey: `DIGITAL:WREV:${input.invoiceId}:${walletId}:${receiptId}`,
      notes: "إعادة رصيد محفظة بعكس بيع",
      createdBy: actor.userId,
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
      dedupeKey: `DIGITAL:APREV:${input.invoiceId}:${providerId}:${receiptId}`,
      notes: "عكس استحقاق مزوّد كروت",
      createdBy: actor.userId,
    });
    await adjustSupplierBalance(tx, supplierId, amount.neg());
  }

  await tx
    .update(digitalSaleDetails)
    .set({ fulfillmentStatus: "REVERSED" })
    .where(inArray(digitalSaleDetails.id, details.map((d) => Number(d.id))));

  await auditLog(tx, actor, "digitalCards.reversal.approved", input.invoiceId, {
    details: details.length,
    refunded: toDbMoney(sell),
    shareReturned: toDbMoney(share),
    reason,
  });

  return { invoiceId: input.invoiceId, reversed: details.length, refunded: toDbMoney(sell), outcome: "REVERSED" };
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
  actor: Actor,
): Promise<{ invoiceId: number; requested: number; refund: string; loss: string }> {
  assertManager(actor);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب سبباً واضحاً لردّ الخسارة" });

  const details = await lockDetails(tx, input.invoiceId, input.detailIds);
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
  actor: Actor,
): Promise<{ invoiceId: number; rejected: number }> {
  assertManager(actor);
  const details = await lockDetails(tx, input.invoiceId, input.detailIds, "LOSS_REFUND_PENDING");
  const requesters = new Set(details.map((d) => Number(d.lossRefundRequestedBy)));
  if (requesters.size === 1 && requesters.has(actor.userId) && actor.role !== "admin") {
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
  input: { invoiceId: number; detailIds: number[] },
  actor: Actor,
): Promise<{ invoiceId: number; reversed: number; refunded: string; loss: string; outcome: ReversalOutcome }> {
  assertManager(actor);

  const [inv] = await tx
    .select({ id: invoices.id, branchId: invoices.branchId, customerId: invoices.customerId })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .for("update");
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });

  // البنود يجب أن تكون **معلّقة بطلبٍ سابق** — لا يُعتمَد ردٌّ لم يُطلَب.
  const details = await lockDetails(tx, input.invoiceId, input.detailIds, "LOSS_REFUND_PENDING");
  // فصل المهام: المُعتمِد ≠ الطالب. admin مُستثنى للتصحيح الإداريّ (اصطلاح الوحدة).
  const requesters = new Set(details.map((d) => Number(d.lossRefundRequestedBy)));
  if (requesters.size === 1 && requesters.has(actor.userId) && actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يعتمد ردّ الخسارة من طلبه — يلزم مديرٌ آخر" });
  }
  const reason = details[0]?.lossRefundReason ?? "";
  const sell = sumMoney(details.map((d) => d.sellPriceSnapshot));
  const share = sumMoney(details.map((d) => d.providerShareSnapshot));

  await refundAndPostReturn(
    tx,
    {
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      customerId: inv.customerId != null ? Number(inv.customerId) : null,
      sell,
      // **صفر**: الحصة لم تُستردّ ⇒ تبقى تكلفةً محمَّلة على المكتبة.
      reversedCost: money(0),
      kind: "LOSS_REFUND",
    },
    actor,
  );

  await tx
    .update(digitalSaleDetails)
    .set({
      fulfillmentStatus: "LOSS_REFUND",
      lossRefundApprovedBy: actor.userId,
      lossRefundApprovedAt: new Date(),
    })
    .where(inArray(digitalSaleDetails.id, details.map((d) => Number(d.id))));

  await auditLog(tx, actor, "digitalCards.reversal.lossRefund", input.invoiceId, {
    details: details.length,
    refunded: toDbMoney(sell),
    loss: toDbMoney(share),
    requestedBy: Array.from(requesters),
    reason,
  });

  return {
    invoiceId: input.invoiceId,
    reversed: details.length,
    refunded: toDbMoney(sell),
    loss: toDbMoney(share),
    outcome: "LOSS_REFUND",
  };
}

/* ────────── قراءات ────────── */

/** بنود فاتورةٍ قابلة للعكس (ISSUED فقط) — تُغذّي شاشة القرار. */
export async function reversibleDetails(db: DB, invoiceId: number) {
  return db
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
    })
    .from(digitalSaleDetails)
    .where(eq(digitalSaleDetails.invoiceId, invoiceId))
    .orderBy(asc(digitalSaleDetails.id));
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

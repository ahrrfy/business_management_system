/**
 * منفّذو قيود فاتورة البيع — الأمانة · قيد البيع · الهدايا · التقريب.
 *
 * نُقل المنطقُ حرفياً من `sale/cancel.ts` (الخطوات ٥–٧) ليصير **المصدرَ الواحد** الذي يستدعيه
 * الإلغاءُ والمرتجعُ الكامل بدل نسختين تنجرفان (القانون ق٧). النكهةُ (`decisions.flavor`)
 * تقرّر النصوصَ ومفاتيحَ التكرار وحدها — لا الحساب.
 *
 * الترتيبُ الذي يفرضه المحرّك: المخزون قبل هذه الأربعة (كلفةُ ما عاد تُقرأ من `run.state`).
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

import { accountingEntries } from "../../../../drizzle/schema";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  type AccountRole,
  type PostingProfile,
} from "../../accounting/postingEngine";
import { postEntry } from "../../ledgerService";
import { money, round2, toDbMoney } from "../../money";
import { classifyGiftPosting } from "../../sale/giftPosting";
import { userNameSnapshot } from "../../userSnapshot";
import type { EffectExecutor, ExecutionOutcome, PendingEffect, ReversalRun } from "../types";
import { invoiceContext, readInventoryState, writeLedgerState, type InvoiceContext } from "./invoiceState";

/** حصّةُ كلّ مودِعٍ (مدفوع/هدية) من البنود المعكوسة الآن — كلفةً لا سعراً. */
function consignorShares(ctx: InvoiceContext, run: ReversalRun): Map<number, { paid: Decimal; gift: Decimal }> {
  const byConsignor = new Map<number, { paid: Decimal; gift: Decimal }>();
  for (const line of readInventoryState(run).lines) {
    const cId = ctx.consignByVariant.get(line.variantId);
    if (cId == null) continue;
    const share = round2(line.unitCost.times(line.quantity));
    const split = byConsignor.get(cId) ?? { paid: new Decimal(0), gift: new Decimal(0) };
    if (line.isGift) split.gift = split.gift.plus(share);
    else split.paid = split.paid.plus(share);
    byConsignor.set(cId, split);
  }
  return byConsignor;
}

/**
 * الأمانة: عكسُ استحقاق المودِع بقيدٍ PURCHASE سالبٍ **بنفس invoiceId** ⇒ يدخل فلتر خصم
 * العمولة فيستردّ حصّةَ البائع. رصيدُه (AP) يعكسه منفّذُ `SUPPLIER_BALANCE` العامّ.
 */
export const invoiceConsignmentExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const shares = consignorShares(ctx, run);
  const flavor = run.decisions.flavor ?? "CANCEL";
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const supplierId = Number((effect.payloadJson as { supplierId?: number } | null)?.supplierId ?? 0);
    const split = shares.get(supplierId) ?? { paid: new Decimal(0), gift: new Decimal(0) };
    const paidShare = round2(split.paid);
    const giftShare = round2(split.gift);
    const share = round2(paidShare.plus(giftShare));
    if (share.lte(0)) {
      outcomes.push({ status: "REVERSED", signedAmount: new Decimal(0), payloadJson: { supplierId, nothingToReverse: true } });
      continue;
    }
    await postEntry(tx, {
      entryType: "PURCHASE",
      supplierId,
      invoiceId: run.documentId,
      branchId: Number(ctx.invoice.branchId),
      amount: share.neg(),
      cost: paidShare.neg(),
      profit: paidShare,
      notes: flavor === "CANCEL"
        ? `عكس استحقاق أمانة — إلغاء فاتورة؛ COGS مبسّط=${toDbMoney(paidShare.neg())}`
        : `عكس استحقاق أمانة — مرتجع؛ COGS مبسّط=${toDbMoney(paidShare.neg())}`,
      postingIntent: createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [...signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", paidShare.neg()), ...signedPostingLines("GIFTS_PROMO", "CONSIGNMENT_PAYABLE", giftShare.neg())], { roleDebits: { CONSIGNMENT_PAYABLE: share }, roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare } }),
      postingSourceComponents: { roleDebits: { CONSIGNMENT_PAYABLE: share }, roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare } },
    });
    outcomes.push({ status: "REVERSED", signedAmount: share.neg(), payloadJson: { supplierId, paidShare: paidShare.toFixed(2), giftShare: giftShare.toFixed(2) } });
  }
  return outcomes;
};

/** كلفُ ما عاد فعلاً — مصنَّفةً كما يصنّفها الدفتر (مملوك · خدمة · أمانة · هدية). */
function reversedCosts(ctx: InvoiceContext, run: ReversalRun) {
  const state = readInventoryState(run);
  let restockedCost = new Decimal(0);
  let restockedGiftCost = new Decimal(0);
  let serviceRestockedCost = new Decimal(0);
  let serviceRestockedGiftCost = new Decimal(0);
  for (const line of state.lines) {
    const lineCost = round2(line.unitCost.times(line.quantity));
    if (line.isGift) {
      restockedGiftCost = restockedGiftCost.plus(lineCost);
      if (line.kind === "SERVICE") serviceRestockedGiftCost = serviceRestockedGiftCost.plus(lineCost);
    } else {
      restockedCost = restockedCost.plus(lineCost);
      if (line.kind === "SERVICE") serviceRestockedCost = serviceRestockedCost.plus(lineCost);
    }
  }
  const shares = consignorShares(ctx, run);
  let consignmentRestockedCost = new Decimal(0);
  let consignmentRestockedGiftCost = new Decimal(0);
  for (const split of Array.from(shares.values())) {
    consignmentRestockedCost = consignmentRestockedCost.plus(round2(split.paid));
    consignmentRestockedGiftCost = consignmentRestockedGiftCost.plus(round2(split.gift));
  }
  restockedCost = round2(restockedCost);
  restockedGiftCost = round2(restockedGiftCost);
  // تالفٌ (لا يعود للرفّ) ⇒ لا تُعكَس الكلفة: خسارةٌ فعليّة على المكتبة (سياسة «التلف مصروفٌ بالكلفة»).
  const reversedCost = state.restock ? restockedCost : new Decimal(0);
  const reversedGiftCost = state.restock ? restockedGiftCost : new Decimal(0);
  const ownedRestockedCost = state.restock
    ? round2(Decimal.max(new Decimal(0), reversedCost.minus(consignmentRestockedCost).minus(serviceRestockedCost)))
    : new Decimal(0);
  const ownedRestockedGiftCost = state.restock
    ? round2(Decimal.max(new Decimal(0), reversedGiftCost.minus(consignmentRestockedGiftCost).minus(serviceRestockedGiftCost)))
    : new Decimal(0);
  const financiallyRestockedGiftCost = state.restock
    ? round2(Decimal.max(new Decimal(0), reversedGiftCost.minus(serviceRestockedGiftCost)))
    : new Decimal(0);
  return {
    restockedCost,
    ownedRestockedCost,
    ownedRestockedGiftCost,
    financiallyRestockedGiftCost,
    serviceRestockedCost,
    consignmentRestockedCost,
  };
}

/**
 * قيدُ البيع: يُعكَس بقيد RETURN سالبٍ يزنُ **ما تبقّى غيرَ مُرتجَع** — المتبقّي في سجلّ الأثر
 * هو نفسُه `SALE.amount − Σ RETURN.amount` (يُجسّده المُجسِّد من الحقيقة قبل العكس).
 *
 * الإيرادُ والضريبةُ يُقرآن من الحقيقة نفسها (قيد SALE وأخوات RETURN) لا من عمود `total`: قيدُ
 * SALE يحمل الإجماليَّ الخامَّ قبل تقريب IQD، وقيدُ ADJUST يحمل فارقَ التقريب ويُعكَس وحده (Codex
 * P2 ١٢/٨) — أساسٌ من `inv.total` كان يترك Σ(amount) = فارقَ التقريب لا صفراً.
 */
export const invoiceSaleLedgerExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const inv = ctx.invoice;
  const flavor = run.decisions.flavor ?? "CANCEL";
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const remaining = await remainingSaleVector(tx, run, effect);
    const { remainingRevenue, remainingTax, remainingAmount } = remaining;
    const costs = reversedCosts(ctx, run);
    const cancelOperatorName = await userNameSnapshot(tx, run.actor.userId);
    const deliveryRevenueReversal = round2(money(inv.deliveryFee ?? "0"));
    const sectorRevenueReversal = round2(remainingRevenue.minus(deliveryRevenueReversal));
    const returnAccountingAmount = round2(remainingRevenue.plus(remainingTax));
    const invoiceMerchandiseRevenue = round2(money(inv.subtotal).minus(money(inv.discountAmount)));
    const revenueItems = ctx.items.filter((item) => !item.isGift && money(item.total).gt(0)).sort((a, b) => Number(a.id) - Number(b.id));
    const itemRevenueBasis = revenueItems.reduce((sum, item) => sum.plus(money(item.total)), money(0));
    const netRevenueByItem = new Map<number, Decimal>();
    let allocatedInvoiceRevenue = money(0);
    for (let index = 0; index < revenueItems.length; index++) {
      const item = revenueItems[index]!;
      const lineRevenue = index === revenueItems.length - 1
        ? round2(invoiceMerchandiseRevenue.minus(allocatedInvoiceRevenue))
        : round2(invoiceMerchandiseRevenue.times(money(item.total)).div(itemRevenueBasis));
      allocatedInvoiceRevenue = allocatedInvoiceRevenue.plus(lineRevenue);
      netRevenueByItem.set(Number(item.id), lineRevenue);
    }
    const returnRevenueByRole = new Map<AccountRole, Decimal>();
    const returnClasses = new Set<"DIGITAL" | "SERVICE" | "CONSIGNMENT" | "INVENTORY">();
    let allocatedReturnRevenue = money(0);
    let balancingRole: AccountRole | null = null;
    const itemById = new Map(ctx.items.map((i) => [Number(i.id), i]));
    for (const line of readInventoryState(run).lines) {
      const item = itemById.get(line.itemId);
      if (!item) continue;
      const lineRevenue = netRevenueByItem.get(line.itemId) ?? money(0);
      if (lineRevenue.isZero()) continue;
      const kind = line.kind;
      const isDigital = ctx.digitalVariants.has(line.variantId);
      const returnClass = isDigital ? "DIGITAL" : kind === "SERVICE" ? "SERVICE" : ctx.consignByVariant.has(line.variantId) ? "CONSIGNMENT" : "INVENTORY";
      returnClasses.add(returnClass);
      const role: AccountRole = inv.sourceType === "WORKORDER"
        ? "SALES_FLEX"
        : isDigital ? "OTHER_REVENUE" : kind === "SERVICE" ? "SALES_PRINT" : "SALES_STATIONERY";
      const currentRevenue = line.quantity >= item.baseQuantity
        ? lineRevenue
        : round2(lineRevenue.times(line.quantity).div(item.baseQuantity));
      allocatedReturnRevenue = allocatedReturnRevenue.plus(currentRevenue);
      returnRevenueByRole.set(role, round2((returnRevenueByRole.get(role) ?? money(0)).plus(currentRevenue)));
      balancingRole = role;
    }
    const sectorDelta = round2(sectorRevenueReversal.minus(allocatedReturnRevenue));
    if (!sectorDelta.isZero() && balancingRole) {
      returnRevenueByRole.set(balancingRole, round2((returnRevenueByRole.get(balancingRole) ?? money(0)).plus(sectorDelta)));
    }
    const returnProfile: PostingProfile = inv.sourceType === "WORKORDER"
      ? "RETURN_SALE_FLEX"
      : returnClasses.size > 1
        ? "RETURN_SALE_MIXED"
        : returnClasses.has("DIGITAL")
          ? "RETURN_SALE_DIGITAL"
          : returnClasses.has("SERVICE")
            ? "RETURN_SALE_SERVICE"
            : returnClasses.has("CONSIGNMENT")
              ? "RETURN_SALE_CONSIGNMENT"
              : "RETURN_SALE_INVENTORY";
    const ownedRestockedCost = costs.ownedRestockedCost;
    const returnPostingLines = [
      ...Array.from(returnRevenueByRole.entries())
        .filter(([, amount]) => !amount.isZero())
        .map(([role, amount]) => debitLine(role, amount)),
      ...(deliveryRevenueReversal.isZero() ? [] : [debitLine("DELIVERY_REVENUE", deliveryRevenueReversal)]),
      ...(remainingTax.isZero() ? [] : [debitLine("TAX_PAYABLE", remainingTax)]),
      ...(returnAccountingAmount.isZero() ? [] : [creditLine("AR", returnAccountingAmount)]),
      ...(ownedRestockedCost.isZero() ? [] : [debitLine("INVENTORY", ownedRestockedCost), creditLine("COGS", ownedRestockedCost)]),
    ];
    const returnPostingSource = {
      roleDebits: {
        SALES_STATIONERY: returnRevenueByRole.get("SALES_STATIONERY") ?? money(0),
        SALES_PRINT: returnRevenueByRole.get("SALES_PRINT") ?? money(0),
        SALES_FLEX: returnRevenueByRole.get("SALES_FLEX") ?? money(0),
        OTHER_REVENUE: returnRevenueByRole.get("OTHER_REVENUE") ?? money(0),
        DELIVERY_REVENUE: deliveryRevenueReversal,
        TAX_PAYABLE: remainingTax,
        INVENTORY: ownedRestockedCost,
      },
      roleCredits: { AR: returnAccountingAmount, COGS: ownedRestockedCost },
    };
    const returnPostingIntent = returnPostingLines.length ? createPostingIntent(returnProfile, "RETURN", returnPostingLines, returnPostingSource) : null;
    const reasonNote = (run.decisions.reasonNote ?? "").trim();
    // إلغاء فاتورة هدايا صِرفة لا يعكس SALE/AR؛ عكس GIFT_OUT هو أثره المالي.
    if (returnPostingIntent) {
      await postEntry(tx, {
        entryType: "RETURN",
        branchId: Number(inv.branchId),
        invoiceId: run.documentId,
        customerId: inv.customerId,
        revenue: remainingRevenue.neg(),
        // `cost` مصدرٌ قانونيّ: يساوي COGS المملوكة المعكوسة بالضبط — الخدمةُ استُهلكت والأمانةُ ليست مخزوننا.
        cost: ownedRestockedCost.neg(),
        profit: remainingRevenue.minus(ownedRestockedCost).neg(),
        taxAmount: remainingTax.neg(),
        amount: remainingAmount.neg(),
        createdBy: run.actor.userId,
        createdByNameSnapshot: cancelOperatorName,
        notes: flavor === "CANCEL"
          ? `${reasonNote ? `إلغاء فاتورة — ${reasonNote.slice(0, 200)}؛ ` : "إلغاء فاتورة؛ "}عكس كلفة تحليلية=${toDbMoney(costs.restockedCost)}؛ عكس COGS مملوك=${toDbMoney(ownedRestockedCost)}؛ خدمة غير معادة=${toDbMoney(costs.serviceRestockedCost)}؛ أمانة مستقلة=${toDbMoney(costs.consignmentRestockedCost)}`
          : `عكس كلفة تحليلية=${toDbMoney(costs.restockedCost)}؛ عكس COGS مملوك=${toDbMoney(ownedRestockedCost)}؛ خدمة غير معادة=${toDbMoney(costs.serviceRestockedCost)}؛ أمانة مستقلة=${toDbMoney(costs.consignmentRestockedCost)}${reasonNote ? `؛ سبب المرتجع=${reasonNote}؛ مصير البضاعة=${readInventoryState(run).restock ? "إعادة للرف" : "تالف"}` : ""}`,
        postingIntent: returnPostingIntent,
        postingSourceComponents: returnPostingSource,
      });
    }
    writeLedgerState(run, { remainingAmount, remainingRevenue, remainingTax });
    outcomes.push({
      status: "REVERSED",
      signedAmount: remainingAmount.neg(),
      payloadJson: {
        entryType: "RETURN",
        revenue: remainingRevenue.neg().toFixed(2),
        taxAmount: remainingTax.neg().toFixed(2),
        cost: ownedRestockedCost.neg().toFixed(2),
        profile: returnPostingIntent ? returnProfile : null,
      },
    });
  }
  return outcomes;
};

/** ما تبقّى من قيد البيع بعد المرتجعات السابقة — من الحقيقة (SALE − Σ RETURN). */
async function remainingSaleVector(
  tx: Parameters<EffectExecutor>[0],
  run: ReversalRun,
  effect: PendingEffect,
) {
  const ctx = await invoiceContext(tx, run);
  const inv = ctx.invoice;
  const saleRevenue = money(inv.subtotal).minus(money(inv.discountAmount)).plus(money(inv.deliveryFee ?? "0"));
  const priorRet = (
    await tx
      .select({
        rev: sql<string>`COALESCE(SUM(${accountingEntries.revenue}), 0)`,
        tax: sql<string>`COALESCE(SUM(${accountingEntries.taxAmount}), 0)`,
      })
      .from(accountingEntries)
      .where(and(eq(accountingEntries.invoiceId, run.documentId), eq(accountingEntries.entryType, "RETURN")))
  )[0];
  const priorRevenue = money(priorRet?.rev ?? "0").neg();
  const priorTax = money(priorRet?.tax ?? "0").neg();
  return {
    remainingRevenue: round2(saleRevenue.minus(priorRevenue)),
    remainingTax: round2(money(inv.taxAmount).minus(priorTax)),
    // المتبقّي الماليّ = ما في سجلّ الأثر بالضبط (SALE.amount + Σ RETURN.amount بعد التجسيد).
    remainingAmount: round2(effect.outstandingAmount),
  };
}

/** الهدايا: عكسُ مصروف ما عاد للرفّ من الهدايا وحده (الخدمة المُهداة استُهلكت). */
export const invoiceGiftExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const inv = ctx.invoice;
  const flavor = run.decisions.flavor ?? "CANCEL";
  const costs = reversedCosts(ctx, run);
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const reversible = costs.financiallyRestockedGiftCost;
    if (reversible.lte(0)) {
      outcomes.push({
        status: "LEFT_OPEN",
        why: readInventoryState(run).restock
          ? "مصروف الهدية يخصّ خدمةً استُهلكت أو بنداً لم يعد للرفّ — يبقى مصروفاً بحكم السياسة"
          : "البضاعة تالفة لا تعود للرفّ — مصروف الهدية يبقى خسارةً على المكتبة",
      });
      continue;
    }
    const giftPosting = classifyGiftPosting(reversible, costs.ownedRestockedGiftCost, -1);
    const operatorName = await userNameSnapshot(tx, run.actor.userId);
    await postEntry(tx, {
      entryType: "GIFT_OUT",
      branchId: Number(inv.branchId),
      invoiceId: run.documentId,
      customerId: inv.customerId,
      revenue: money(0),
      cost: reversible.neg(),
      profit: reversible,
      amount: reversible.neg(),
      createdBy: run.actor.userId,
      createdByNameSnapshot: operatorName,
      notes: flavor === "CANCEL"
        ? `عكس هدايا ضمن إلغاء فاتورة بيع؛ consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`
        : `عكس هدايا ضمن مرتجع بيع؛ consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
      postingIntent: giftPosting.intent,
      postingSourceComponents: giftPosting.sourceComponents,
    });
    const full = reversible.eq(effect.outstandingAmount);
    outcomes.push(
      full
        ? { status: "REVERSED", signedAmount: reversible.neg(), payloadJson: { entryType: "GIFT_OUT" } }
        : {
            status: "PARTIAL",
            why: "جزءٌ من مصروف الهدايا يخصّ خدمةً استُهلكت أو أمانةً — لا يُعكَس بحكم السياسة",
            signedAmount: reversible.neg(),
            payloadJson: { entryType: "GIFT_OUT", reversed: reversible.toFixed(2), outstanding: effect.outstandingAmount.toFixed(2) },
          },
    );
  }
  return outcomes;
};

/** التقريب النقديّ IQD: يُعكَس بقيد ADJUST سالبٍ بمفتاح تكرارٍ يخصّ النكهة. */
export const invoiceRoundingExecutor: EffectExecutor = async (tx, effects, run) => {
  const ctx = await invoiceContext(tx, run);
  const inv = ctx.invoice;
  const flavor = run.decisions.flavor ?? "CANCEL";
  const outcomes: ExecutionOutcome[] = [];
  for (const effect of effects) {
    const amount = round2(effect.outstandingAmount);
    if (amount.isZero()) {
      outcomes.push({ status: "REVERSED", signedAmount: new Decimal(0) });
      continue;
    }
    await postEntry(tx, {
      entryType: "ADJUST",
      dedupeKey: flavor === "CANCEL" ? `ADJUST:IQD:CANCEL:${run.documentId}` : `ADJUST:IQD:RETURN:${run.documentId}`,
      branchId: Number(inv.branchId),
      invoiceId: run.documentId,
      customerId: inv.customerId,
      revenue: amount.neg(),
      profit: amount.neg(),
      amount: amount.neg(),
      notes: flavor === "CANCEL" ? "عكس تقريب نقدي IQD — إلغاء فاتورة" : "عكس تقريب نقدي IQD — مرتجع كامل",
      postingIntent: createPostingIntent("ADJUST_ROUNDING", "ADJUST", signedPostingLines("AR", "ROUNDING_DIFF", amount.neg())),
    });
    outcomes.push({ status: "REVERSED", signedAmount: amount.neg(), payloadJson: { entryType: "ADJUST" } });
  }
  return outcomes;
};

/**
 * ═══ تجسيدُ آثار فاتورة البيع من الحقيقة — المُصالِح ═══
 *
 * لماذا تجسيدٌ لا تسجيلٌ عند الكتابة الأصليّة فقط: (١) كلُّ فاتورةٍ قائمة اليوم كُتبت قبل
 * محرّك العكس فلا صفوفَ لها؛ (٢) كتّابُ البيع (`sale/create.ts` · `printSaleService` ·
 * `workOrder/deliver.ts` · الأوفلاين) متعدّدون ويملكهم غيرُ هذه الشريحة؛ (٣) وحتى لو سجّلوا،
 * فالمرتجعُ الجزئيّ اليدويّ (`returnService`) لا يمرّ بالمحرّك بعد. ⇒ **قبل كلّ عكسٍ يُصالَح
 * السجلُّ مع الحقيقة**: صفُّ APPLY لكلّ أثرٍ حقيقيّ إن غاب، وابنُ REVERSE **بالفرق** حين يخالف
 * المتبقّي في السجلّ ما تقوله القاعدة (مرتجعٌ سابق، ردٌّ سابق، كوبونٌ حُرّر بمسارٍ آخر).
 *
 * المصالحةُ **دلتا لا نسخ**: تعمل على فاتورةٍ سُجّلت أصلاً أو لم تُسجَّل، ولا تكرّر صفّاً.
 *
 * ⭐ **وحدةُ التجسيد لكلّ نوع — قرارٌ ماليّ لا تقنيّ:**
 *  · `INVENTORY` على **بند الفاتورة** لا حركة المخزون: المتبقّي = `baseQuantity − returnedBaseQuantity`،
 *    فالتالفُ الذي لم يعد للرفّ لا يُعاد ثانيةً (Codex P2 ١٢/٨).
 *  · `LEDGER_ENTRY` = قيد SALE، ومتبقّيه `SALE.amount + Σ RETURN.amount`.
 *  · `GIFT` = قيد GIFT_OUT الموجب، `ROUNDING` = قيد ADJUST التقريب، `CONSIGNMENT` +
 *    `SUPPLIER_BALANCE` = استحقاقُ كلّ مودِع (قيدُ PURCHASE برقم الفاتورة) ورصيدُه.
 *  · `PAID_AMOUNT` على **الفاتورة**: Σ المقبوض المتجسِّد (إيصالات IN + حصص العربون المطبَّقة)
 *    − Σ المستردّ — نفسُ حسبة `cancelSaleInTx` السابقة حرفاً بحرف (Codex P1 ١٢/٨: السند
 *    الخارجيّ المرتبط بالفاتورة يدخل الوعاء).
 *  · `CUSTOMER_BALANCE` = مساهمةُ الفاتورة الحاليّة في ذمّة العميل: المتبقّي الدفتريّ − ما يُردّ.
 *  · `COUPON` = صفُّ الاسترداد إن وُجد.
 *
 * ⛔ الاستهلاكُ الماديّ لموادّ الخدمة (حركاتُ OUT على متغيّراتٍ ليست بنوداً) **ليس أثراً يُعكَس**
 * بالإلغاء — المادّةُ استُهلكت في الطباعة؛ لذلك لا يُجسَّد (وهو سلوكُ الإلغاء القائم).
 */
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DocumentEffectKind } from "@shared/documentEffects";

import { accountingEntries, couponRedemptions, receipts } from "../../../../drizzle/schema";
import type { Tx } from "../../../db";
import { MATERIALIZED_RECEIPT_STATUSES } from "../../cash/cashAvailability";
import { money, round2 } from "../../money";
import { loadApplyEffects, recordEffect, recordReverseRow } from "../effectLedger";
import { invoiceContext } from "../executors/invoiceState";
import type { PendingEffect, ReversalRun } from "../types";

export const INVOICE_SALE_SCOPE = "sale";
const MATERIALIZE_REASON = "تجسيدٌ من الحقيقة قبل العكس";

type EffectKey = string;
function keyOf(kind: DocumentEffectKind, table: string, rowId: number): EffectKey {
  return `${kind}|${table}|${rowId}`;
}

interface TruthEffect {
  kind: DocumentEffectKind;
  table: string;
  rowId: number;
  /** قيمةُ APPLY حين يُنشأ الصفُّ لأوّل مرّة. */
  applyAmount: Decimal;
  applyQuantity: number;
  /** ما يجب أن يكون متبقّياً الآن بحسب الحقيقة. */
  targetAmount: Decimal;
  targetQuantity: number;
  payload: unknown;
}

/** يُصالح أثراً واحداً: يُنشئ APPLY إن غاب، ثمّ ابنَ فرقٍ إن خالف المتبقّي الحقيقةَ. */
async function reconcile(
  tx: Tx,
  run: ReversalRun,
  existing: Map<EffectKey, PendingEffect>,
  truth: TruthEffect,
): Promise<void> {
  const key = keyOf(truth.kind, truth.table, truth.rowId);
  let current = existing.get(key);
  const branchId = Number((await invoiceContext(tx, run)).invoice.branchId);
  // أثرٌ صفريٌّ بلا صفٍّ سابق (مثل مساهمةٍ صفريّة في الذمّة لفاتورةٍ مسدَّدة) لا يُمثَّل: صفٌّ بلا معنى.
  if (!current && truth.applyAmount.isZero() && truth.applyQuantity === 0 && truth.targetAmount.isZero() && truth.targetQuantity === 0) return;
  if (!current) {
    const id = await recordEffect(
      tx,
      {
        documentType: "INVOICE",
        documentId: run.documentId,
        effectKind: truth.kind,
        effectTable: truth.table,
        effectRowId: truth.rowId,
        signedAmount: truth.applyAmount,
        signedQuantity: truth.applyQuantity,
        branchId,
        reason: MATERIALIZE_REASON,
        scope: INVOICE_SALE_SCOPE,
        payloadJson: truth.payload,
      },
      run.actor,
    );
    current = {
      id,
      documentType: "INVOICE",
      documentId: run.documentId,
      effectKind: truth.kind,
      effectTable: truth.table,
      effectRowId: truth.rowId,
      branchId,
      scope: INVOICE_SALE_SCOPE,
      payloadJson: truth.payload,
      signedAmount: truth.applyAmount,
      signedQuantity: truth.applyQuantity,
      outstandingAmount: truth.applyAmount,
      outstandingQuantity: truth.applyQuantity,
    };
    existing.set(key, current);
  }
  const deltaAmount = truth.targetAmount.minus(current.outstandingAmount);
  const deltaQuantity = truth.targetQuantity - current.outstandingQuantity;
  if (deltaAmount.isZero() && deltaQuantity === 0) return;
  await recordReverseRow(
    tx,
    current,
    {
      signedAmount: deltaAmount,
      signedQuantity: deltaQuantity,
      reason: MATERIALIZE_REASON,
      payloadJson: { reconciled: true, from: current.outstandingAmount.toFixed(4), to: truth.targetAmount.toFixed(4), fromQty: current.outstandingQuantity, toQty: truth.targetQuantity },
    },
    run.actor,
  );
  current.outstandingAmount = truth.targetAmount;
  current.outstandingQuantity = truth.targetQuantity;
}

/** المقبوضُ والمستردّ المتجسِّدان على الفاتورة — تحت قفل (current read بعد انتظار المصدر). */
export async function invoicePaidPool(tx: Tx, invoiceId: number): Promise<{ totalIn: Decimal; outPrior: Decimal; directIn: Decimal; appliedIn: Decimal }> {
  const materialReceipts = await tx
    .select({ direction: receipts.direction, amount: receipts.amount })
    .from(receipts)
    .where(and(
      eq(receipts.invoiceId, invoiceId),
      inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
      eq(receipts.approvalStatus, "APPROVED"),
    ))
    .for("update");
  const directIn = materialReceipts.reduce(
    (sum, receipt) => (receipt.direction === "IN" ? sum.plus(money(receipt.amount)) : sum),
    money(0),
  );
  const outPrior = materialReceipts.reduce(
    (sum, receipt) => (receipt.direction === "OUT" ? sum.plus(money(receipt.amount)) : sum),
    money(0),
  );
  // حصصُ عربون مسوّدة الاستقبال المطبَّقة على هذه الفاتورة بلا ختم إيصالها بها (Codex على #988):
  // نفسُ استعلام `returns/refundCaps.ts` الخطوة ②، مقتصراً على appliedKind='INVOICE'، مع استثناء
  // الهدف الوحيد المختوم (حصّتُه إيصالٌ مباشر مُحتسَبٌ في directIn سلفاً).
  const appliedPoolRows = await tx.execute(sql`
    SELECT CAST(COALESCE(SUM(app.amount), 0) AS CHAR) AS amount
    FROM orderPayments app
    JOIN orderPayments coll ON coll.id = app.parentPaymentId
    LEFT JOIN receipts pr ON pr.id = coll.receiptId
    WHERE app.orderPayKind = 'APPLICATION'
      AND app.orderPayAppliedKind = 'INVOICE'
      AND app.appliedId = ${invoiceId}
      AND (pr.id IS NULL OR pr.invoiceId IS NULL OR pr.invoiceId <> ${invoiceId})
    FOR UPDATE
  `);
  const appliedPoolData = (appliedPoolRows as unknown as [Array<{ amount: string }>])[0] ?? appliedPoolRows;
  const appliedPoolRow = Array.isArray(appliedPoolData) ? appliedPoolData[0] : undefined;
  const appliedIn = money(appliedPoolRow?.amount ?? "0");
  return { totalIn: round2(directIn.plus(appliedIn)), outPrior: round2(outPrior), directIn: round2(directIn), appliedIn: round2(appliedIn) };
}

/**
 * يُصالح سجلَّ آثار الفاتورة (نطاق `sale`) مع الحقيقة داخل المعاملة الحاليّة. idempotent.
 */
export async function materializeInvoiceEffects(tx: Tx, run: ReversalRun): Promise<void> {
  const ctx = await invoiceContext(tx, run);
  const invoiceId = run.documentId;
  const existing = new Map<EffectKey, PendingEffect>();
  for (const row of await loadApplyEffects(tx, "INVOICE", invoiceId, { kind: "ALL", operationScopes: [INVOICE_SALE_SCOPE] }, { onlyOutstanding: false })) {
    if (row.effectTable && row.effectRowId != null) existing.set(keyOf(row.effectKind, row.effectTable, row.effectRowId), row);
  }

  // ═══ INVENTORY — بنداً بند ═══
  for (const item of ctx.items) {
    const remaining = Math.max(0, (item.baseQuantity ?? 0) - (item.returnedBaseQuantity ?? 0));
    await reconcile(tx, run, existing, {
      kind: "INVENTORY",
      table: "invoiceItems",
      rowId: Number(item.id),
      applyAmount: new Decimal(0),
      applyQuantity: -(item.baseQuantity ?? 0),
      targetAmount: new Decimal(0),
      targetQuantity: -remaining,
      payload: {
        variantId: Number(item.variantId),
        kind: ctx.kindByVariant.get(Number(item.variantId)) ?? "STOCKED",
        isGift: !!item.isGift,
        unitCost: String(item.unitCost),
      },
    });
  }

  // ═══ القيود — SALE · RETURN · GIFT_OUT · ADJUST(IQD) · PURCHASE(أمانة) ═══
  const entries = await tx
    .select({
      id: accountingEntries.id,
      entryType: accountingEntries.entryType,
      dedupeKey: accountingEntries.dedupeKey,
      supplierId: accountingEntries.supplierId,
      amount: accountingEntries.amount,
      revenue: accountingEntries.revenue,
      cost: accountingEntries.cost,
      taxAmount: accountingEntries.taxAmount,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.invoiceId, invoiceId));

  const saleEntry = entries.find((e) => e.entryType === "SALE");
  const returnSum = entries.filter((e) => e.entryType === "RETURN").reduce((s, e) => s.plus(money(e.amount)), money(0));
  const remainingAmount = saleEntry ? round2(money(saleEntry.amount).plus(returnSum)) : new Decimal(0);
  if (saleEntry) {
    await reconcile(tx, run, existing, {
      kind: "LEDGER_ENTRY",
      table: "accountingEntries",
      rowId: Number(saleEntry.id),
      applyAmount: money(saleEntry.amount),
      applyQuantity: 0,
      targetAmount: remainingAmount,
      targetQuantity: 0,
      payload: { entryType: "SALE", revenue: String(saleEntry.revenue), cost: String(saleEntry.cost), taxAmount: String(saleEntry.taxAmount) },
    });
  }

  const giftEntries = entries.filter((e) => e.entryType === "GIFT_OUT");
  const giftApply = giftEntries.filter((e) => money(e.amount).gt(0));
  if (giftApply.length) {
    await reconcile(tx, run, existing, {
      kind: "GIFT",
      table: "accountingEntries",
      rowId: Number(giftApply[0]!.id),
      applyAmount: round2(giftApply.reduce((s, e) => s.plus(money(e.amount)), money(0))),
      applyQuantity: 0,
      targetAmount: round2(giftEntries.reduce((s, e) => s.plus(money(e.amount)), money(0))),
      targetQuantity: 0,
      payload: { entryType: "GIFT_OUT" },
    });
  }

  const roundingEntries = entries.filter((e) => e.entryType === "ADJUST" && (e.dedupeKey ?? "").startsWith("ADJUST:IQD:"));
  const roundingApply = roundingEntries.find((e) => e.dedupeKey === `ADJUST:IQD:${invoiceId}`);
  if (roundingApply) {
    await reconcile(tx, run, existing, {
      kind: "ROUNDING",
      table: "accountingEntries",
      rowId: Number(roundingApply.id),
      applyAmount: money(roundingApply.amount),
      applyQuantity: 0,
      targetAmount: round2(roundingEntries.reduce((s, e) => s.plus(money(e.amount)), money(0))),
      targetQuantity: 0,
      payload: { entryType: "ADJUST", dedupeKey: roundingApply.dedupeKey },
    });
  }

  const consignmentEntries = entries.filter((e) => e.entryType === "PURCHASE" && e.supplierId != null);
  const consignorIds = Array.from(new Set(consignmentEntries.map((e) => Number(e.supplierId)))).sort((a, b) => a - b);
  for (const supplierId of consignorIds) {
    const mine = consignmentEntries.filter((e) => Number(e.supplierId) === supplierId);
    const positives = mine.filter((e) => money(e.amount).gt(0));
    if (!positives.length) continue;
    const applyAmount = round2(positives.reduce((s, e) => s.plus(money(e.amount)), money(0)));
    const targetAmount = round2(mine.reduce((s, e) => s.plus(money(e.amount)), money(0)));
    await reconcile(tx, run, existing, {
      kind: "CONSIGNMENT",
      table: "accountingEntries",
      rowId: Number(positives[0]!.id),
      applyAmount,
      applyQuantity: 0,
      targetAmount,
      targetQuantity: 0,
      payload: { supplierId, entryType: "PURCHASE" },
    });
    await reconcile(tx, run, existing, {
      kind: "SUPPLIER_BALANCE",
      table: "suppliers",
      rowId: supplierId,
      applyAmount,
      applyQuantity: 0,
      targetAmount,
      targetQuantity: 0,
      payload: { supplierId },
    });
  }

  // ═══ المدفوع — وعاءُ الردّ ═══
  const pool = await invoicePaidPool(tx, invoiceId);
  const refundable = round2(pool.totalIn.minus(pool.outPrior));
  await reconcile(tx, run, existing, {
    kind: "PAID_AMOUNT",
    table: "invoices",
    rowId: invoiceId,
    applyAmount: pool.totalIn,
    applyQuantity: 0,
    targetAmount: refundable,
    targetQuantity: 0,
    payload: { directIn: pool.directIn.toFixed(2), appliedIn: pool.appliedIn.toFixed(2), outPrior: pool.outPrior.toFixed(2) },
  });

  // ═══ ذمّة العميل — مساهمةُ الفاتورة الحاليّة ═══
  if (ctx.invoice.customerId != null) {
    const contribution = round2(remainingAmount.minus(refundable));
    await reconcile(tx, run, existing, {
      kind: "CUSTOMER_BALANCE",
      table: "customers",
      rowId: Number(ctx.invoice.customerId),
      applyAmount: contribution,
      applyQuantity: 0,
      targetAmount: contribution,
      targetQuantity: 0,
      payload: { customerId: Number(ctx.invoice.customerId), remainingAmount: remainingAmount.toFixed(2), refundable: refundable.toFixed(2) },
    });
  }

  // ═══ الكوبون ═══
  const redemption = (
    await tx
      .select({ id: couponRedemptions.id, couponId: couponRedemptions.couponId, programId: couponRedemptions.programId, discountAmount: couponRedemptions.discountAmount })
      .from(couponRedemptions)
      .where(eq(couponRedemptions.invoiceId, invoiceId))
      .limit(1)
  )[0];
  if (redemption) {
    await reconcile(tx, run, existing, {
      kind: "COUPON",
      table: "couponRedemptions",
      rowId: Number(redemption.id),
      applyAmount: money(redemption.discountAmount),
      applyQuantity: 0,
      targetAmount: money(redemption.discountAmount),
      targetQuantity: 0,
      payload: { couponId: Number(redemption.couponId), programId: Number(redemption.programId) },
    });
  } else {
    // حُرّر بمسارٍ آخر: أثرٌ قائمٌ بلا صفٍّ حقيقيّ ⇒ يُغلَق بالفرق.
    for (const row of Array.from(existing.values())) {
      if (row.effectKind === "COUPON" && !row.outstandingAmount.isZero()) {
        await reconcile(tx, run, existing, {
          kind: "COUPON",
          table: row.effectTable ?? "couponRedemptions",
          rowId: Number(row.effectRowId ?? 0),
          applyAmount: row.signedAmount,
          applyQuantity: 0,
          targetAmount: new Decimal(0),
          targetQuantity: 0,
          payload: row.payloadJson,
        });
      }
    }
  }
}

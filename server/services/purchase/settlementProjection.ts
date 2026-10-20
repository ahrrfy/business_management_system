import { loadSupplierBookInvoiceTotals, supplierBookSourceClaimedSql } from "./supplierBookProjection";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { alias } from "drizzle-orm/mysql-core";
import type { PurchaseSettlementEvidence } from "@shared/purchaseSettlement";
import { PAYMENT_EVIDENCE_CASE_CODES } from "@shared/purchaseSettlement";
import {
  accountingEntries,
  goodsReceiptItems,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseReturnReversals,
  purchaseReturns,
  purchaseIntegrityCases,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPayments,
  supplierPaymentRefunds,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP } from "../ledger/supplierApEffect";
import { usdReturnAmountWithFinalResidual } from "./returnGovernance";

export type PurchaseSettlementProjection = PurchaseSettlementEvidence & { bookPaidAmountIqd?: string };

export async function loadPurchasePaymentEvidenceCases(
  db: DB | Tx,
  orderIds: readonly number[],
  invoiceIds: readonly number[],
  currentRead = false,
) {
  if (!orderIds.length && !invoiceIds.length) return [];
  const query = db
    .select({
      caseNumber: purchaseIntegrityCases.caseNumber,
      poId: purchaseIntegrityCases.purchaseOrderId,
      invoiceId: purchaseIntegrityCases.supplierInvoiceId,
    })
    .from(purchaseIntegrityCases)
    .where(
      and(
        inArray(purchaseIntegrityCases.code, [...PAYMENT_EVIDENCE_CASE_CODES]),
        inArray(purchaseIntegrityCases.status, [
          "OPEN",
          "IN_REVIEW",
          "PENDING_RESOLUTION",
        ]),
        or(
          orderIds.length
            ? inArray(purchaseIntegrityCases.purchaseOrderId, [...orderIds])
            : undefined,
          invoiceIds.length
            ? inArray(purchaseIntegrityCases.supplierInvoiceId, [...invoiceIds])
            : undefined,
        ),
      ),
    )
    .orderBy(asc(purchaseIntegrityCases.id));
  return currentRead ? query.for("share") : query;
}

export interface PurchaseSettlementOrder {
  id: number;
  total: string;
  paidAmount: string;
  agreedCurrency?: string | null;
  usdTotal?: string | null;
  paidUsd?: string | null;
  returnedUsd?: string | null;
  agreedRate?: string | null;
  supplierId?: number;
  branchId?: number;
  status?: string;
}

function nonNegative(value: Decimal): Decimal {
  return Decimal.max(value, 0);
}

function project(
  total: Decimal,
  paid: Decimal,
  credited: Decimal,
  currencyTotal: Decimal,
  currencyPaid: Decimal,
  currencyCredited: Decimal,
  evidenceReason?: string,
): PurchaseSettlementProjection {
  const remaining = nonNegative(total.minus(credited).minus(paid));
  const currencyRemaining = nonNegative(
    currencyTotal.minus(currencyCredited).minus(currencyPaid),
  );
  const status =
    remaining.isZero() && total.gt(0)
      ? credited.gt(0)
        ? "CREDITED"
        : "PAID"
      : paid.gt(0)
        ? "PARTIAL"
        : "UNPAID";
  return {
    paidAmountIqd: toDbMoney(paid),
    returnedAmountIqd: toDbMoney(credited),
    remainingAmountIqd: toDbMoney(remaining),
    paidAmountCurrency: toDbMoney(currencyPaid),
    returnedAmountCurrency: toDbMoney(currencyCredited),
    remainingAmountCurrency: toDbMoney(currencyRemaining),
    status,
    requiresReview: evidenceReason != null,
    ...(evidenceReason ? { evidenceReason } : {}),
  };
}

/** Read-only, batched evidence resolver shared by purchase list/detail and supplier statement. */
export async function loadPurchaseSettlements(
  db: DB | Tx,
  orders: readonly PurchaseSettlementOrder[],
  options: { currentRead?: boolean } = {},
): Promise<Map<number, PurchaseSettlementProjection>> {
  const result = new Map<number, PurchaseSettlementProjection>();
  if (!orders.length) return result;
  const ids = orders.map((order) => Number(order.id));
  const invoiceQuery = db
    .select()
    .from(supplierInvoices)
    .where(
      or(
        inArray(supplierInvoices.legacyPurchaseOrderId, ids),
        sql`EXISTS (SELECT 1 FROM supplierInvoiceLines sil
      INNER JOIN purchaseOrderRevisionItems pori ON pori.id = sil.purchaseOrderRevisionItemId
      INNER JOIN purchaseOrderRevisions por ON por.id = pori.revisionId
      WHERE sil.supplierInvoiceId = ${supplierInvoices.id} AND por.purchaseOrderId IN ${ids})`,
        sql`EXISTS (SELECT 1 FROM supplierInvoiceMatchRuns simr
      INNER JOIN supplierInvoiceMatchAllocations sima ON sima.matchRunId = simr.id
      INNER JOIN goodsReceiptItems gri ON gri.id = sima.goodsReceiptItemId
      INNER JOIN purchaseOrderItems poi ON poi.id = gri.purchaseOrderItemId
      WHERE simr.supplierInvoiceId = ${supplierInvoices.id} AND poi.purchaseOrderId IN ${ids})`,
      ),
    );
  const invoices = await (options.currentRead
    ? invoiceQuery.for("share")
    : invoiceQuery);
  const invoiceIds = invoices.map((invoice) => Number(invoice.id));
  const book = await loadSupplierBookInvoiceTotals(db, invoiceIds, options);
  const allocationQuery = db
    .select({
      invoiceId: supplierPaymentAllocations.supplierInvoiceId,
      amount: sql<string>`${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount}`,
      currencyAmount: sql<string>`${supplierPaymentAllocations.allocatedCurrencyAmount} - ${supplierPaymentAllocations.refundedCurrencyAmount}`,
    })
    .from(supplierPaymentAllocations)
    .where(
      inArray(
        supplierPaymentAllocations.supplierInvoiceId,
        invoiceIds.length ? invoiceIds : [-1],
      ),
    );
  const returnQuery = db
    .select({
      id: purchaseReturns.id,
      invoiceId: purchaseReturns.supplierInvoiceId,
      poId: purchaseReturns.purchaseOrderId,
      settlement: purchaseReturns.settlement,
      credit: purchaseReturns.creditOffsetAmount,
    })
    .from(purchaseReturns)
    .where(
      or(
        inArray(purchaseReturns.purchaseOrderId, ids),
        invoiceIds.length
          ? inArray(purchaseReturns.supplierInvoiceId, invoiceIds)
          : undefined,
      ),
    );
  const reversalQuery = db
    .select({
      returnId: purchaseReturnReversals.purchaseReturnId,
      amount: purchaseReturnReversals.totalAmount,
    })
    .from(purchaseReturnReversals)
    .innerJoin(
      purchaseReturns,
      eq(purchaseReturns.id, purchaseReturnReversals.purchaseReturnId),
    )
    .where(
      and(
        eq(purchaseReturns.settlement, "CREDIT"),
        or(
          inArray(purchaseReturns.purchaseOrderId, ids),
          invoiceIds.length
            ? inArray(purchaseReturns.supplierInvoiceId, invoiceIds)
            : undefined,
        ),
      ),
    );
  // Do not filter these links to requested PO ids: that would hide a shared invoice's other POs.
  const refundEntry = alias(accountingEntries, "purchaseSettlementRefundEntry");
  const [
    lineLinks,
    matchLinks,
    allocations,
    returns,
    reversals,
    ledger,
    orphanRefunds,
    paymentEvidenceCases,
  ] = await Promise.all([
    invoiceIds.length
      ? db
          .select({
            invoiceId: supplierInvoiceLines.supplierInvoiceId,
            poId: purchaseOrderRevisions.purchaseOrderId,
          })
          .from(supplierInvoiceLines)
          .innerJoin(
            purchaseOrderRevisionItems,
            eq(
              purchaseOrderRevisionItems.id,
              supplierInvoiceLines.purchaseOrderRevisionItemId,
            ),
          )
          .innerJoin(
            purchaseOrderRevisions,
            eq(
              purchaseOrderRevisions.id,
              purchaseOrderRevisionItems.revisionId,
            ),
          )
          .where(inArray(supplierInvoiceLines.supplierInvoiceId, invoiceIds))
      : Promise.resolve([]),
    invoiceIds.length
      ? db
          .select({
            invoiceId: supplierInvoiceMatchRuns.supplierInvoiceId,
            poId: purchaseOrderItems.purchaseOrderId,
          })
          .from(supplierInvoiceMatchAllocations)
          .innerJoin(
            supplierInvoiceMatchRuns,
            eq(
              supplierInvoiceMatchRuns.id,
              supplierInvoiceMatchAllocations.matchRunId,
            ),
          )
          .innerJoin(
            goodsReceiptItems,
            eq(
              goodsReceiptItems.id,
              supplierInvoiceMatchAllocations.goodsReceiptItemId,
            ),
          )
          .innerJoin(
            purchaseOrderItems,
            eq(purchaseOrderItems.id, goodsReceiptItems.purchaseOrderItemId),
          )
          .where(
            inArray(supplierInvoiceMatchRuns.supplierInvoiceId, invoiceIds),
          )
      : Promise.resolve([]),
    invoiceIds.length
      ? options.currentRead
        ? allocationQuery.for("share")
        : allocationQuery
      : Promise.resolve([]),
    options.currentRead ? returnQuery.for("share") : returnQuery,
    options.currentRead ? reversalQuery.for("share") : reversalQuery,
    (() => {
      const query = db
        .select({
          poId: accountingEntries.purchaseOrderId,
          recognized: sql<string>`COALESCE(SUM(CASE WHEN ${accountingEntries.entryType} = 'PURCHASE' OR (${accountingEntries.entryType} = 'ADJUST' AND ${accountingEntries.dedupeKey} REGEXP ${GRNI_SUPPLIER_INVOICE_FORWARD_REGEXP}) THEN ${accountingEntries.amount} ELSE 0 END),0)`,
          paid: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} IN ('PAYMENT_OUT','EXCHANGE_SETTLE') AND COALESCE(${accountingEntries.dedupeKey},'') NOT LIKE 'PURCHASE_RETURN_REVERSAL_PAYMENT:%' AND NOT ${supplierBookSourceClaimedSql(accountingEntries.id)} THEN ${accountingEntries.amount}
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN' AND COALESCE(${accountingEntries.dedupeKey},'') NOT LIKE 'PURCHASE_RETURN_REFUND:%' AND NOT ${supplierBookSourceClaimedSql(accountingEntries.id)} THEN -${accountingEntries.amount}
        ELSE 0 END),0)`,
          credited: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'RETURN' THEN -${accountingEntries.amount}
        WHEN ${accountingEntries.entryType} = 'PAYMENT_IN' AND ${accountingEntries.dedupeKey} LIKE 'PURCHASE_RETURN_REFUND:%' THEN -${accountingEntries.amount}
        WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' AND ${accountingEntries.dedupeKey} LIKE 'PURCHASE_RETURN_REVERSAL_PAYMENT:%' THEN ${accountingEntries.amount}
        ELSE 0 END),0)`,
        })
        .from(accountingEntries)
        .where(
          and(
            inArray(accountingEntries.purchaseOrderId, ids),
            sql`${accountingEntries.supplierId} IS NOT NULL`,
            isNull(accountingEntries.deliveryPartyId),
            sql`COALESCE(${accountingEntries.postingProfile},'') NOT LIKE '%SHIPPING%'`,
          ),
        )
        .groupBy(accountingEntries.purchaseOrderId);
      return options.currentRead ? query.for("share") : query;
    })(),
    (() => {
      const query = db
        .select({
          poId: accountingEntries.purchaseOrderId,
          amount: sql<string>`COALESCE(SUM(${supplierPaymentRefunds.amount}),0)`,
        })
        .from(supplierPaymentRefunds)
        .innerJoin(
          supplierPayments,
          eq(supplierPayments.id, supplierPaymentRefunds.supplierPaymentId),
        )
        .innerJoin(
          accountingEntries,
          eq(accountingEntries.id, supplierPayments.accountingEntryId),
        )
        .innerJoin(
          refundEntry,
          eq(refundEntry.id, supplierPaymentRefunds.accountingEntryId),
        )
        .where(
          and(
            inArray(accountingEntries.purchaseOrderId, ids),
            isNull(refundEntry.purchaseOrderId),
          ),
        )
        .groupBy(accountingEntries.purchaseOrderId);
      return options.currentRead ? query.for("share") : query;
    })(),
    loadPurchasePaymentEvidenceCases(db, ids, invoiceIds, options.currentRead),
  ]);
  const links = new Map<number, Set<number>>();
  const link = (invoiceId: number, poId: number) => {
    const poIds = links.get(invoiceId) ?? new Set<number>();
    poIds.add(poId);
    links.set(invoiceId, poIds);
  };
  for (const invoice of invoices)
    if (invoice.legacyPurchaseOrderId != null)
      link(Number(invoice.id), Number(invoice.legacyPurchaseOrderId));
  for (const row of [...lineLinks, ...matchLinks])
    link(Number(row.invoiceId), Number(row.poId));
  const paidByInvoice = new Map<
    number,
    { amount: Decimal; currencyAmount: Decimal }
  >();
  for (const row of allocations) {
    const previous = paidByInvoice.get(Number(row.invoiceId));
    paidByInvoice.set(Number(row.invoiceId), {
      amount: (previous?.amount ?? money(0)).plus(row.amount),
      currencyAmount: (previous?.currencyAmount ?? money(0)).plus(
        row.currencyAmount,
      ),
    });
  }
  for (const [id, totals] of Array.from(book)) {
    const native = paidByInvoice.get(id);
    paidByInvoice.set(id, { amount: money(native?.amount).plus(totals.paidAmount), currencyAmount: money(native?.currencyAmount).plus(totals.paidCurrencyAmount) });
  }
  const reversedByReturn = new Map<number, Decimal>();
  for (const row of reversals)
    reversedByReturn.set(
      Number(row.returnId),
      (reversedByReturn.get(Number(row.returnId)) ?? money(0)).plus(row.amount),
    );
  const creditByInvoice = new Map<number, Decimal>();
  const creditByPo = new Map<number, Decimal>();
  for (const row of returns) {
    const credit = nonNegative(
      money(row.credit).minus(reversedByReturn.get(Number(row.id)) ?? 0),
    );
    creditByPo.set(
      Number(row.poId),
      (creditByPo.get(Number(row.poId)) ?? money(0)).plus(credit),
    );
    if (row.invoiceId != null)
      creditByInvoice.set(
        Number(row.invoiceId),
        (creditByInvoice.get(Number(row.invoiceId)) ?? money(0)).plus(credit),
      );
  }
  const ledgerByPo = new Map(ledger.map((row) => [Number(row.poId), row]));
  for (const refund of orphanRefunds) {
    const gl = ledgerByPo.get(Number(refund.poId));
    if (gl) gl.paid = toDbMoney(money(gl.paid).minus(refund.amount));
  }
  for (const order of orders) {
    const relatedDocuments = invoices.filter((invoice) =>
      links.get(Number(invoice.id))?.has(Number(order.id)),
    );
    const related = relatedDocuments.filter(
      (invoice) =>
        invoice.status === "POSTED" && invoice.draftState !== "VOIDED",
    );
    const paymentEvidenceCase = paymentEvidenceCases.find(
      (row) =>
        Number(row.poId) === Number(order.id) ||
        related.some((invoice) => Number(invoice.id) === Number(row.invoiceId)),
    );
    const paymentReviewReason = paymentEvidenceCase
      ? `السداد السابق غير محسوم في قضية ${paymentEvidenceCase.caseNumber}؛ أكمل المطابقة قبل أي صرف جديد`
      : undefined;
    const native = relatedDocuments.some(
      (invoice) => invoice.origin === "NATIVE" && (invoice.status === "POSTED" || invoice.status === "REVERSED"),
    );
    const total = money(order.total);
    const currencyTotal =
      order.agreedCurrency === "USD" ? money(order.usdTotal) : total;
    if (
      related.some((invoice) => (links.get(Number(invoice.id))?.size ?? 0) > 1)
    ) {
      result.set(
        Number(order.id),
        project(
          total,
          money(0),
          money(0),
          currencyTotal,
          money(0),
          money(0),
          "فاتورة المورد مرتبطة بعدة أوامر شراء؛ تخصيص السداد لكل أمر يحتاج مراجعة موثقة",
        ),
      );
      continue;
    }
    if (native || related.some(invoice => book.has(Number(invoice.id)))) {
      let paid = money(0),
        currencyPaid = money(0),
        credited = money(0),
        currencyCredited = money(0);
      let recognized = money(0),
        currencyRecognized = money(0);
      let reason: string | undefined = paymentReviewReason;
      for (const invoice of related) {
        const allocated = paidByInvoice.get(Number(invoice.id));
        const legacy = invoice.legacySettlementEvidenceHash
          ? money(invoice.legacySettledAmount)
          : money(0);
        if (money(invoice.legacySettledAmount).gt(legacy))
          reason ??= "تسوية إرثية بلا دليل مثبت";
        const netPaid = nonNegative(money(allocated?.amount));
        const formalCredit = creditByInvoice.get(Number(invoice.id)) ?? money(0);
        const bookCredit = book.get(Number(invoice.id));
        const netCredit = formalCredit.plus(bookCredit?.creditedAmount ?? 0);
        const rate = money(invoice.agreedRate);
        const dollars = invoice.currency === "USD";
        recognized = recognized.plus(invoice.totalAmount);
        currencyRecognized = currencyRecognized.plus(
          dollars ? money(invoice.usdTotal) : money(invoice.totalAmount),
        );
        paid = paid.plus(legacy).plus(netPaid);
        credited = credited.plus(netCredit);
        currencyPaid = currencyPaid.plus(
          dollars
            ? nonNegative(money(allocated?.currencyAmount)).plus(
                rate.gt(0) ? round2(legacy.div(rate)) : 0,
              )
            : legacy.plus(netPaid),
        );
        currencyCredited = currencyCredited.plus(
          dollars
            ? rate.gt(0)
              ? usdReturnAmountWithFinalResidual(
                  invoice.usdTotal,
                  invoice.totalAmount,
                  toDbMoney(formalCredit),
                  0,
                )
              : money(0)
            : formalCredit,
        );
        currencyCredited = currencyCredited.plus(dollars ? (bookCredit?.creditedCurrencyAmount ?? 0) : (bookCredit?.creditedAmount ?? 0));
        if (dollars && !rate.gt(0)) reason ??= "سعر صرف فاتورة المورد غير صالح";
        if (
          (order.supplierId != null &&
            Number(invoice.supplierId) !== Number(order.supplierId)) ||
          (order.branchId != null &&
            Number(invoice.branchId) !== Number(order.branchId))
        )
          reason ??= "هوية المورد أو الفرع لا تطابق أمر الشراء";
      }
      if (money(order.paidAmount).gt(paid) && !related.some(invoice => book.has(Number(invoice.id))))
        reason ??=
          "المدفوع المحفوظ على الأمر يتجاوز تخصيصات السداد المثبتة؛ يلزم تدقيق السجل التاريخي";
      if (money(ledgerByPo.get(Number(order.id))?.paid).gt(paid))
        reason ??=
          "قيود دفع مرتبطة بالأمر تتجاوز تخصيصات الفاتورة؛ يلزم مطابقة السداد التاريخي قبل دفع جديد";
      result.set(Number(order.id), {
        ...project(
          recognized,
          paid,
          credited,
          currencyRecognized,
          currencyPaid,
          currencyCredited,
          reason,
        ),
        bookPaidAmountIqd: toDbMoney(related.reduce((sum, invoice) => sum.plus(book.get(Number(invoice.id))?.paidAmount ?? 0), money(0))),
        recognizedAmountIqd: toDbMoney(recognized),
        recognizedAmountCurrency: toDbMoney(currencyRecognized),
      });
    } else {
      const gl = ledgerByPo.get(Number(order.id));
      const recognized = money(gl?.recognized);
      const recognizedTotal = recognized.gt(0) ? recognized : total;
      const provenPaid = nonNegative(money(gl?.paid));
      // Keep the existing legacy FIFO declaration, but expose its lack of deterministic allocation evidence.
      const paid = Decimal.max(provenPaid, money(order.paidAmount));
      const credited =
        creditByPo.get(Number(order.id)) ?? nonNegative(money(gl?.credited));
      const reason =
        paymentReviewReason ??
        (paid.gt(provenPaid)
          ? "تخصيص إرثي محفوظ على الأمر بلا ربط دفع حتمي؛ راجع مستندات التسوية قبل سداد جديد"
          : related.some(
                (invoice) => invoice.liabilityClass === "LEGACY_UNKNOWN",
              )
            ? "تصنيف الالتزام الإرثي يحتاج مراجعة"
            : !recognized.gt(0) && total.gt(0) && order.status === "RECEIVED"
              ? "لا يوجد قيد شراء مثبت للاستلام؛ راجع الالتزام قبل السداد"
              : undefined);
      const rate = money(order.agreedRate);
      const dollars = order.agreedCurrency === "USD";
      result.set(Number(order.id), {
        ...project(
          recognizedTotal,
          paid,
          credited,
          dollars && rate.gt(0)
            ? round2(recognizedTotal.div(rate))
            : recognizedTotal,
          dollars
            ? money(order.paidUsd).gt(0)
              ? money(order.paidUsd)
              : rate.gt(0)
                ? round2(paid.div(rate))
                : money(0)
            : paid,
          dollars
            ? rate.gt(0)
              ? round2(credited.div(rate))
              : money(0)
            : credited,
          reason,
        ),
        ...(recognized.gt(0)
          ? {
              recognizedAmountIqd: toDbMoney(recognized),
              recognizedAmountCurrency: toDbMoney(
                dollars && rate.gt(0)
                  ? round2(recognized.div(rate))
                  : recognized,
              ),
            }
          : {}),
      });
    }
  }
  return result;
}

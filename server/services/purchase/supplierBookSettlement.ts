import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  auditLogs,
  exchangeTransactions,
  goodsReceiptItems,
  legacySupplierInvoiceSettlements,
  purchaseOrderControlRequests,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  purchaseIntegrityCases,
  purchaseReturnRequests,
  purchaseReturnReversals,
  purchaseReturns,
  receipts,
  supplierBookSettlementAllocations as allocations,
  supplierBookSettlementSources as sources,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRefundRequests,
  supplierPaymentRequests,
  supplierPayments,
  suppliers,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { enqueueFinancialRefresh } from "../../realtime/financialRefresh";
import { appErrorMessage } from "@shared/errors";
import { logAuditTx } from "../auditService";
import { supplierApEffectSql } from "../ledger/supplierApEffect";
import { adjustSupplierBalanceUsd } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withGovernanceTx, withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { loadPurchaseSettlements } from "./settlementProjection";
import { loadSupplierBookInvoiceTotals } from "./supplierBookProjection";
import {
  requestPurchaseIntegrityResolutionInTx,
  decidePurchaseIntegrityResolutionInTx,
} from "./integrityCases";

const ACTION = "supplier.bookSettlement.adopt";
const LIMIT = 100_000;
const canonical = (value: unknown) =>
  stableCanonical(JSON.parse(JSON.stringify(value)));
const hash = (value: unknown) => sha256(canonical(value));
const day = (value: Date | string) =>
  (value instanceof Date ? value.toISOString() : value).slice(0, 10);
function fail(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذرت التسوية الدفترية للمورد",
      why,
      doThis: "راجع دليل المصدر ثم أعد المعاينة؛ لم تُسجل حركة مالية جديدة",
    }),
  });
}
function checkedScope(input: { supplierId: number; branchId: number }) {
  if (
    ![input.supplierId, input.branchId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    fail("نطاق المورد أو الفرع غير صالح");
}
function bounded<T>(rows: T[]): T[] {
  if (rows.length >= LIMIT) fail("تجاوز نطاق الدليل حد المعالجة الآمنة");
  return rows;
}
type Invoice = typeof supplierInvoices.$inferSelect;
export type BookTarget = {
  supplierInvoiceId: number | null;
  openingEntryId: number | null;
  date: string;
  order: number;
  amount: string;
  currencyTotal: string;
  currencyUsed: string;
  total: string;
  snapshot: unknown;
};
export type BookSource = {
  entryId: number;
  receiptId: number | null;
  exchangeId: number | null;
  kind: "PAYMENT" | "CREDIT";
  date: string;
  amount: string;
  snapshot: unknown;
};
export type BookAllocation = {
  supplierInvoiceId: number | null;
  openingEntryId: number | null;
  amount: string;
  currencyAmount: string;
  targetSnapshot: string;
  targetHash: string;
};
type PlannedSource = BookSource & { allocations: BookAllocation[] };

/** Present-day FIFO of carrying value; never a claim about historical tender or returned goods. */
export function buildSupplierBookFifo(
  targets: BookTarget[],
  sourceRows: BookSource[],
) {
  const state = targets
    .map((t) => ({
      ...t,
      remaining: money(t.amount),
      used: money(t.currencyUsed),
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(a.openingEntryId == null) - Number(b.openingEntryId == null) ||
        a.order - b.order,
    );
  const planned: PlannedSource[] = [];
  for (const source of [...sourceRows].sort(
    (a, b) => a.date.localeCompare(b.date) || a.entryId - b.entryId,
  )) {
    let left = money(source.amount);
    const assigned: BookAllocation[] = [];
    if (!left.gt(0)) fail("مبلغ مصدر التسوية غير موجب");
    for (const target of state) {
      if (left.isZero()) break;
      if (target.date > source.date || !target.remaining.gt(0)) continue;
      const amount = Decimal.min(left, target.remaining);
      // Cumulative original-book proportion assigns the exact final rounded residual.
      const usedBefore = money(target.total).minus(target.remaining);
      const after = usedBefore.plus(amount).eq(target.total)
        ? money(target.currencyTotal)
        : round2(
            money(target.currencyTotal)
              .mul(usedBefore.plus(amount))
              .div(target.total),
          );
      const currencyAmount = after.minus(target.used);
      if (currencyAmount.lt(0))
        fail("تعارض كمية عملة الفاتورة الدفترية مع تخصيص قائم");
      const snapshot = canonical(target.snapshot);
      assigned.push({
        supplierInvoiceId: target.supplierInvoiceId,
        openingEntryId: target.openingEntryId,
        amount: toDbMoney(amount),
        currencyAmount: toDbMoney(currencyAmount),
        targetSnapshot: snapshot,
        targetHash: sha256(snapshot),
      });
      target.remaining = target.remaining.minus(amount);
      target.used = after;
      left = left.minus(amount);
    }
    if (!left.isZero())
      fail(
        `المصدر ${source.entryId} يضم رصيداً غير قابل للتخصيص بالكامل؛ لا يجوز اختلاق فاتورة له`,
      );
    planned.push({ ...source, allocations: assigned });
  }
  return {
    sources: planned,
    remaining: toDbMoney(
      state.reduce((sum, t) => sum.plus(t.remaining), money(0)),
    ),
  };
}

async function invoiceOrders(tx: Tx, invoices: Invoice[]) {
  const ids = invoices.map((i) => i.id);
  const map = new Map<number, Set<number>>(
    invoices.map((i) => [
      i.id,
      new Set(i.legacyPurchaseOrderId ? [i.legacyPurchaseOrderId] : []),
    ]),
  );
  if (!ids.length) return map;
  const lineLinks = await tx
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
      eq(purchaseOrderRevisions.id, purchaseOrderRevisionItems.revisionId),
    )
    .where(inArray(supplierInvoiceLines.supplierInvoiceId, ids));
  const matchLinks = await tx
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
    .where(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, ids));
  for (const row of [...lineLinks, ...matchLinks])
    map.get(row.invoiceId)!.add(row.poId);
  return map;
}

async function loadContext(
  tx: Tx,
  input: { supplierId: number; branchId: number },
) {
  checkedScope(input);
  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId));
  if (!supplier || supplier.supplierKind !== "REGULAR")
    fail("المورد غير مؤهل لذمة تجارية عادية");
  const entries = bounded(
    await tx
      .select()
      .from(accountingEntries)
      .where(eq(accountingEntries.supplierId, input.supplierId))
      .orderBy(asc(accountingEntries.id))
      .limit(LIMIT),
  );
  const invoices = bounded(
    await tx
      .select()
      .from(supplierInvoices)
      .where(eq(supplierInvoices.supplierId, input.supplierId))
      .orderBy(asc(supplierInvoices.id))
      .limit(LIMIT),
  );
  const orders = bounded(
    await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.supplierId, input.supplierId))
      .orderBy(asc(purchaseOrders.id))
      .limit(LIMIT),
  );
  const originalReceipts = bounded(
    await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.partyType, "SUPPLIER"),
          eq(receipts.partyId, input.supplierId),
        ),
      )
      .orderBy(asc(receipts.id))
      .limit(LIMIT),
  );
  const pendingCancellations = originalReceipts.length
    ? await tx
        .select({ reference: receipts.referenceNumber })
        .from(receipts)
        .where(
          and(
            inArray(
              receipts.referenceNumber,
              originalReceipts.map((r) => `CANCEL-VCH-${r.id}`),
            ),
            eq(receipts.approvalStatus, "PENDING_APPROVAL"),
          ),
        )
    : [];
  const exchanges = bounded(
    await tx
      .select()
      .from(exchangeTransactions)
      .where(eq(exchangeTransactions.supplierId, input.supplierId))
      .orderBy(asc(exchangeTransactions.id))
      .limit(LIMIT),
  );
  const payments = await tx
    .select()
    .from(supplierPayments)
    .where(eq(supplierPayments.supplierId, input.supplierId));
  const ids = invoices.map((i) => i.id);
  const native = ids.length
    ? await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(inArray(supplierPaymentAllocations.supplierInvoiceId, ids))
    : [];
  const legacy = ids.length
    ? await tx
        .select()
        .from(legacySupplierInvoiceSettlements)
        .where(inArray(legacySupplierInvoiceSettlements.supplierInvoiceId, ids))
    : [];
  const bookSources = await tx
    .select()
    .from(sources)
    .where(eq(sources.supplierId, input.supplierId));
  const book = await loadSupplierBookInvoiceTotals(tx, ids);
  const formal = await tx
    .select()
    .from(purchaseReturns)
    .where(eq(purchaseReturns.supplierId, input.supplierId));
  const returnIds = formal.map((r) => r.id);
  const reversed = returnIds.length
    ? await tx
        .select()
        .from(purchaseReturnReversals)
        .where(inArray(purchaseReturnReversals.purchaseReturnId, returnIds))
    : [];
  const poIds = orders.map((p) => p.id);
  const pending = [
    ...(await tx
      .select({ id: supplierPaymentRequests.id })
      .from(supplierPaymentRequests)
      .where(
        and(
          eq(supplierPaymentRequests.supplierId, input.supplierId),
          eq(supplierPaymentRequests.status, "PENDING"),
        ),
      )),
    ...(await tx
      .select({ id: supplierPaymentRefundRequests.id })
      .from(supplierPaymentRefundRequests)
      .innerJoin(
        supplierPayments,
        eq(
          supplierPayments.id,
          supplierPaymentRefundRequests.supplierPaymentId,
        ),
      )
      .where(
        and(
          eq(supplierPayments.supplierId, input.supplierId),
          eq(supplierPaymentRefundRequests.status, "PENDING"),
        ),
      )),
    ...(poIds.length
      ? await tx
          .select({ id: purchaseOrderControlRequests.id })
          .from(purchaseOrderControlRequests)
          .where(
            and(
              inArray(purchaseOrderControlRequests.purchaseOrderId, poIds),
              eq(purchaseOrderControlRequests.status, "PENDING"),
            ),
          )
      : []),
    ...(await tx
      .select({ id: purchaseReturnRequests.id })
      .from(purchaseReturnRequests)
      .where(
        and(
          eq(purchaseReturnRequests.supplierId, input.supplierId),
          eq(purchaseReturnRequests.status, "PENDING"),
        ),
      )),
  ];
  if (pending.length)
    fail("يوجد طلب مالي معلق للمورد؛ احسمه قبل قبول روابط تاريخية");
  const [ledger] = await tx
    .select({
      amount: sql<string>`COALESCE(SUM(${supplierApEffectSql({ entryType: accountingEntries.entryType, amount: accountingEntries.amount, liabilityAccount: accountingEntries.purchaseLiabilityAccount, dedupeKey: accountingEntries.dedupeKey })}),0)`,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.supplierId, input.supplierId));
  if (!money(ledger.amount).eq(supplier.currentBalance))
    fail("رصيد AP لا يطابق الدفتر الحاكم");
  const branchIds = new Set([
    ...invoices.map((i) => i.branchId),
    ...entries.filter((e) => e.branchId != null).map((e) => e.branchId!),
  ]);
  if (branchIds.size !== 1 || !branchIds.has(input.branchId))
    fail("لا يمكن إسناد افتتاحي بلا فرع داخل مورد متعدد الفروع تلقائياً");
  const links = await invoiceOrders(tx, invoices);
  const targets: BookTarget[] = [];
  const classify: Invoice[] = [];
  for (const invoice of invoices) {
    if (
      invoice.status !== "POSTED" ||
      invoice.liabilityClass === "LEGACY_CASH_CLEARING"
    )
      continue;
    const linked = Array.from(links.get(invoice.id) ?? []);
    if (linked.length !== 1)
      fail(`الفاتورة ${invoice.id} لا تملك أمر شراء واحداً مثبتاً`);
    const order = orders.find((p) => p.id === linked[0]);
    if (
      !order ||
      order.branchId !== input.branchId ||
      order.settlementType !== "CREDIT" ||
      !["CONFIRMED", "RECEIVED"].includes(order.status)
    ) {
      // Fully paid CASH documents keep their original independently proven settlement.
      if (order?.settlementType === "CASH") continue;
      fail(`حالة أمر شراء الفاتورة ${invoice.id} غير مؤهلة`);
    }
    if (invoice.liabilityClass === "LEGACY_UNKNOWN") {
      const recognized = entries.filter(
        (e) =>
          e.purchaseOrderId === order.id &&
          e.entryType === "PURCHASE" &&
          e.purchaseLiabilityAccount !== "CASH_CLEARING",
      );
      if (
        invoice.origin !== "LEGACY" ||
        recognized.length !== 1 ||
        !money(recognized[0].amount).eq(invoice.totalAmount) ||
        !money(order.total).eq(invoice.totalAmount) ||
        recognized[0].branchId !== input.branchId
      )
        fail(`تعذر إثبات أصل الذمة الإرثية ${invoice.id}`);
      classify.push(invoice);
    } else if (!["NATIVE_AP", "LEGACY_AP"].includes(invoice.liabilityClass))
      fail(`تصنيف ذمة غير مدعوم للفـاتورة ${invoice.id}`);
    const paidNative = native
      .filter((a) => a.supplierInvoiceId === invoice.id)
      .reduce(
        (s, a) => s.plus(a.allocatedAmount).minus(a.refundedAmount),
        money(0),
      );
    const paidNativeCurrency = native
      .filter((a) => a.supplierInvoiceId === invoice.id)
      .reduce(
        (s, a) =>
          s.plus(a.allocatedCurrencyAmount).minus(a.refundedCurrencyAmount),
        money(0),
      );
    let credit = money(0);
    for (const row of formal.filter(
      (r) =>
        r.supplierInvoiceId === invoice.id ||
        (r.supplierInvoiceId == null && r.purchaseOrderId === order.id),
    )) {
      const reverse = reversed
        .filter((r) => r.purchaseReturnId === row.id)
        .reduce((s, r) => s.plus(r.totalAmount), money(0));
      credit = credit.plus(
        Decimal.max(money(row.creditOffsetAmount).minus(reverse), 0),
      );
    }
    const booked = book.get(invoice.id);
    const used = paidNative
      .plus(invoice.legacySettledAmount)
      .plus(credit)
      .plus(booked?.paidAmount ?? 0)
      .plus(booked?.creditedAmount ?? 0);
    if (used.gt(invoice.totalAmount))
      fail(`تجاوزت تسويات الفاتورة ${invoice.id} قيمتها`);
    const currencyTotal =
      invoice.currency === "USD"
        ? money(invoice.usdTotal ?? 0)
        : money(invoice.totalAmount);
    const creditCurrency =
      invoice.currency === "USD"
        ? round2(currencyTotal.mul(credit).div(invoice.totalAmount))
        : credit;
    const legacyCurrency =
      invoice.currency === "USD"
        ? round2(
            currencyTotal
              .mul(invoice.legacySettledAmount)
              .div(invoice.totalAmount),
          )
        : money(invoice.legacySettledAmount);
    const currencyUsed = paidNativeCurrency
      .plus(creditCurrency)
      .plus(legacyCurrency)
      .plus(booked?.paidCurrencyAmount ?? 0)
      .plus(booked?.creditedCurrencyAmount ?? 0);
    targets.push({
      supplierInvoiceId: invoice.id,
      openingEntryId: null,
      date: invoice.invoiceDate,
      order: invoice.id,
      amount: toDbMoney(money(invoice.totalAmount).minus(used)),
      total: invoice.totalAmount,
      currencyTotal: toDbMoney(currencyTotal),
      currencyUsed: toDbMoney(currencyUsed),
      snapshot: { invoice, orderId: order.id },
    });
  }
  const openingIds = entries
    .filter((e) => e.entryType === "OPENING" && money(e.amount).gt(0))
    .map((e) => e.id);
  const openingAlloc = openingIds.length
    ? await tx
        .select()
        .from(allocations)
        .where(inArray(allocations.openingEntryId, openingIds))
    : [];
  for (const entry of entries.filter((e) => openingIds.includes(e.id))) {
    const used = openingAlloc
      .filter((a) => a.openingEntryId === entry.id)
      .reduce(
        (s, a) => s.plus(a.allocatedAmount).minus(a.reversedAmount),
        money(0),
      );
    targets.push({
      supplierInvoiceId: null,
      openingEntryId: entry.id,
      date: day(entry.entryDate),
      order: entry.id,
      amount: toDbMoney(money(entry.amount).minus(used)),
      total: entry.amount,
      currencyTotal: entry.amount,
      currencyUsed: toDbMoney(used),
      snapshot: { openingEntry: entry },
    });
  }
  const candidate: BookSource[] = [];
  for (const entry of entries) {
    if (
      entry.purchaseOrderId != null ||
      entry.branchId !== input.branchId ||
      entry.purchaseLiabilityAccount === "CASH_CLEARING"
    )
      continue;
    if (
      payments.some(
        (p) =>
          p.accountingEntryId === entry.id ||
          (entry.receiptId != null && p.receiptId === entry.receiptId),
      ) ||
      legacy.some(
        (l) =>
          l.sourceAccountingEntryId === entry.id ||
          (entry.receiptId != null && l.sourceReceiptId === entry.receiptId),
      ) ||
      bookSources.some(
        (b) =>
          b.sourceAccountingEntryId === entry.id ||
          (entry.receiptId != null && b.sourceReceiptId === entry.receiptId),
      )
    )
      continue;
    if (
      entry.entryType === "RETURN" &&
      money(entry.amount).lt(0) &&
      entry.receiptId == null &&
      !formal.some((r) => r.accountingEntryId === entry.id)
    ) {
      candidate.push({
        entryId: entry.id,
        receiptId: null,
        exchangeId: null,
        kind: "CREDIT",
        date: day(entry.entryDate),
        amount: toDbMoney(money(entry.amount).abs()),
        snapshot: { entry, receipt: null, exchange: null },
      });
      continue;
    }
    if (
      !["PAYMENT_OUT", "EXCHANGE_SETTLE"].includes(entry.entryType) ||
      !money(entry.amount).gt(0) ||
      entry.receiptId == null
    )
      continue;
    if (
      entry.postingProfile?.includes("SHIPPING") ||
      entry.dedupeKey?.startsWith("PURCHASE_CHARGE_")
    )
      continue;
    const receipt = originalReceipts.find((r) => r.id === entry.receiptId);
    if (
      !receipt ||
      receipt.status !== "COMPLETED" ||
      receipt.approvalStatus !== "APPROVED" ||
      receipt.direction !== "OUT" ||
      receipt.branchId !== input.branchId ||
      !money(receipt.amount).eq(entry.amount)
    )
      continue;
    if (
      pendingCancellations.some(
        (c) => c.reference === `CANCEL-VCH-${receipt.id}`,
      )
    )
      fail(`إيصال ${receipt.id} له طلب إلغاء معلق`);
    if (
      entries.filter(
        (e) =>
          e.receiptId === receipt.id &&
          ["PAYMENT_OUT", "EXCHANGE_SETTLE"].includes(e.entryType),
      ).length !== 1
    )
      fail(`إيصال ${receipt.id} يملك أكثر من أصل سداد`);
    const exchange = exchanges.filter((e) => e.receiptId === receipt.id);
    if (entry.entryType === "EXCHANGE_SETTLE") {
      if (
        exchange.length !== 1 ||
        exchange[0].status !== "ACTIVE" ||
        exchange[0].type !== "SETTLE" ||
        exchange[0].purchaseOrderId != null ||
        exchange[0].branchId !== input.branchId ||
        exchange[0].currency !== "IQD" ||
        !money(exchange[0].settledUsd).isZero() ||
        !money(exchange[0].settledIqd).eq(entry.amount)
      )
        fail(`مصدر الصرافة ${receipt.id} لا يمثل تسديد IQD دفترياً مثبتاً`);
    } else if (exchange.length)
      fail(`ملكية إيصال ${receipt.id} تتعارض مع الصرافة`);
    candidate.push({
      entryId: entry.id,
      receiptId: receipt.id,
      exchangeId: exchange[0]?.id ?? null,
      kind: "PAYMENT",
      date: day(entry.entryDate),
      amount: entry.amount,
      snapshot: { entry, receipt, exchange: exchange[0] ?? null },
    });
  }
  const plan = buildSupplierBookFifo(targets, candidate);
  if (
    plan.sources.length > 100 ||
    plan.sources.reduce((n, s) => n + s.allocations.length, 0) > 2000 ||
    new Set(
      plan.sources.flatMap((s) =>
        s.allocations.flatMap((a) =>
          a.supplierInvoiceId ? [a.supplierInvoiceId] : [],
        ),
      ),
    ).size > 200
  )
    fail("التوزيع أكبر من حد الاعتماد الذري؛ قسم نطاق المراجعة");
  if (!money(plan.remaining).eq(supplier.currentBalance))
    fail(
      `تخصيص المصادر لا يطابق صافي AP: المتبقي ${plan.remaining} والدفتر ${supplier.currentBalance}`,
    );
  const usdIds = new Set(
    invoices.filter((i) => i.currency === "USD").map((i) => i.id),
  );
  const usdBefore = targets
    .filter(
      (t) => t.supplierInvoiceId != null && usdIds.has(t.supplierInvoiceId),
    )
    .reduce(
      (sum, t) => sum.plus(t.currencyTotal).minus(t.currencyUsed),
      money(0),
    );
  if (!usdBefore.eq(supplier.currentBalanceUsd))
    fail(
      "رصيد الدولار المشتق لا يطابق مستندات المورد قبل الربط؛ يلزم تدقيقه قبل الاعتماد",
    );
  const usdDelta = plan.sources.reduce(
    (sum, s) =>
      sum.plus(
        s.allocations
          .filter(
            (a) =>
              a.supplierInvoiceId != null && usdIds.has(a.supplierInvoiceId),
          )
          .reduce((sub, a) => sub.plus(a.currencyAmount), money(0)),
      ),
    money(0),
  );
  const usdAfter = usdBefore.minus(usdDelta);
  if (usdAfter.lt(0)) fail("تجاوز التخصيص رصيد عملة مستندات المورد");
  const financial = {
    supplier,
    entries,
    receipts: originalReceipts,
    exchanges,
    formal,
    reversed,
  };
  const planHash = hash({
    basis: "BOOK_FIFO_V1",
    scope: input,
    financial,
    invoices,
    orders,
    native,
    legacy,
    bookSources,
    plan,
    classify: classify.map((i) => i.id),
  });
  return {
    planHash,
    ...plan,
    financial,
    invoices,
    orders,
    links,
    classify,
    usdBefore: toDbMoney(usdBefore),
    usdAfter: toDbMoney(usdAfter),
    usdDelta: toDbMoney(usdDelta),
  };
}

export async function previewSupplierBookSettlement(input: {
  supplierId: number;
  branchId: number;
}) {
  return withTx(async (tx) => {
    const c = await loadContext(tx, input);
    return {
      planHash: c.planHash,
      supplierId: input.supplierId,
      branchId: input.branchId,
      sources: c.sources,
      remaining: c.remaining,
      usdBefore: c.usdBefore,
      usdAfter: c.usdAfter,
      usdDelta: c.usdDelta,
      classifyInvoiceIds: c.classify.map((i) => i.id),
    };
  });
}

/** Rebuild derived invoice gates and PO caches; source money/AP is changed only by its original service. */
async function refreshTargets(tx: Tx, invoiceIds: number[]) {
  if (!invoiceIds.length) return;
  const invoices = await tx
    .select()
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, invoiceIds));
  const links = await invoiceOrders(tx, invoices);
  const poIds = Array.from(
    new Set(Array.from(links.values()).flatMap((v) => Array.from(v))),
  );
  const orders = poIds.length
    ? await tx
        .select()
        .from(purchaseOrders)
        .where(inArray(purchaseOrders.id, poIds))
    : [];
  const projections = await loadPurchaseSettlements(tx, orders, {
    currentRead: true,
  });
  for (const order of orders) {
    const projection = projections.get(order.id);
    if (!projection) fail("فقد إسقاط التسوية أثناء تحديث المخبأ");
    await tx
      .update(purchaseOrders)
      .set({
        paidAmount: projection.paidAmountIqd,
        ...(order.agreedCurrency === "USD"
          ? {
              paidUsd: projection.paidAmountCurrency,
              returnedUsd: projection.returnedAmountCurrency,
            }
          : {}),
      })
      .where(eq(purchaseOrders.id, order.id));
  }
  const book = await loadSupplierBookInvoiceTotals(tx, invoiceIds, {
    currentRead: true,
  });
  const native = await tx
    .select()
    .from(supplierPaymentAllocations)
    .where(inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds))
    .for("share");
  const formal = await tx
    .select()
    .from(purchaseReturns)
    .where(
      and(
        inArray(
          purchaseReturns.supplierId,
          Array.from(new Set(invoices.map((i) => i.supplierId))),
        ),
        sql`(${purchaseReturns.supplierInvoiceId} IN ${invoiceIds} OR ${purchaseReturns.purchaseOrderId} IN ${poIds.length ? poIds : [-1]})`,
      ),
    )
    .for("share");
  const returnIds = formal.map((r) => r.id);
  const reversals = returnIds.length
    ? await tx
        .select()
        .from(purchaseReturnReversals)
        .where(inArray(purchaseReturnReversals.purchaseReturnId, returnIds))
        .for("share")
    : [];
  for (const invoice of invoices) {
    if (!["NATIVE_AP", "LEGACY_AP"].includes(invoice.liabilityClass))
      fail("تصنيف الفاتورة لا يسمح بتحديث بوابة التسوية");
    const po = Array.from(links.get(invoice.id) ?? []);
    if (po.length !== 1) fail("تعذر تحديث بوابة فاتورة مشتركة بين أوامر شراء");
    const ownPaid = native
      .filter((a) => a.supplierInvoiceId === invoice.id)
      .reduce(
        (sum, a) => sum.plus(a.allocatedAmount).minus(a.refundedAmount),
        money(invoice.legacySettledAmount),
      )
      .plus(book.get(invoice.id)?.paidAmount ?? 0);
    const ownCredit = formal
      .filter(
        (r) =>
          r.supplierInvoiceId === invoice.id ||
          (r.supplierInvoiceId == null &&
            invoice.legacyPurchaseOrderId != null &&
            r.purchaseOrderId === invoice.legacyPurchaseOrderId),
      )
      .reduce(
        (sum, r) =>
          sum.plus(
            Decimal.max(
              money(r.creditOffsetAmount).minus(
                reversals
                  .filter((v) => v.purchaseReturnId === r.id)
                  .reduce((sub, v) => sub.plus(v.totalAmount), money(0)),
              ),
              0,
            ),
          ),
        money(book.get(invoice.id)?.creditedAmount ?? 0),
      );
    if (ownPaid.plus(ownCredit).gt(invoice.totalAmount))
      fail("تجاوزت التسوية قيمة فاتورة المورد");
    const settled = ownPaid.plus(ownCredit).eq(invoice.totalAmount);
    await tx
      .update(supplierInvoices)
      .set({
        version: invoice.version + 1,
        paymentGate: settled ? "SETTLED" : "OPEN",
        paymentGateReason: settled
          ? "تسوية دفترية من مصادر أصلية قائمة؛ لا صرف جديد"
          : null,
      })
      .where(eq(supplierInvoices.id, invoice.id));
  }
}

type AdoptionInput = {
  supplierId: number;
  branchId: number;
  requestKey: string;
  expectedPlanHash: string;
};
type AdoptionResult = {
  planHash: string;
  sourceIds: number[];
  invoiceIds: number[];
  usdBefore: string;
  usdAfter: string;
  usdDelta: string;
  replayed: boolean;
  resolvedCaseIds: number[];
};
export async function adoptSupplierBookSettlement(
  input: AdoptionInput,
  actor: Actor,
) {
  return withGovernanceTx((tx) =>
    adoptSupplierBookSettlementInTx(tx, input, actor),
  );
}
async function adoptSupplierBookSettlementInTx(
  tx: Tx,
  input: AdoptionInput,
  actor: Actor,
): Promise<AdoptionResult> {
  checkedScope(input);
  if (
    !/^[A-Za-z0-9:_-]{8,80}$/.test(input.requestKey) ||
    !/^[a-f0-9]{64}$/.test(input.expectedPlanHash)
  )
    fail("مفتاح الاعتماد أو البصمة غير صالح");
  const [owner] = await tx
    .select()
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("update");
  if (!owner?.isOwner || !owner.isActive)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذر اعتماد الروابط الدفترية",
        why: "يلزم مالك نشط مثبت في قاعدة البيانات",
        doThis: "نفذ القرار بحساب مالك مخول",
      }),
    });
  const entityId = `${input.supplierId}:${input.branchId}:${input.requestKey}`;
  const prior = await tx
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, ACTION),
        eq(auditLogs.entityId, entityId),
        eq(auditLogs.entityType, "supplierBookSettlement"),
      ),
    );
  if (prior.length) {
    const saved = prior[0].newValue as AdoptionResult;
    if (
      prior.length !== 1 ||
      saved?.planHash !== input.expectedPlanHash ||
      !Array.isArray(saved.sourceIds) ||
      !Array.isArray(saved.invoiceIds)
    )
      fail("أعيد مفتاح الاعتماد بمضمون مختلف");
    return { ...saved, replayed: true };
  }
  const c = await loadContext(tx, {
    supplierId: input.supplierId,
    branchId: input.branchId,
  });
  if (c.planHash !== input.expectedPlanHash)
    fail("تغير دليل المصدر أو التخصيص منذ المعاينة");
  if (!c.sources.length) fail("لا توجد مصادر جديدة كاملة قابلة للربط");
  for (const invoice of c.classify) {
    const oldHash = invoice.legacySettlementEvidenceHash;
    await tx
      .update(supplierInvoices)
      .set({
        liabilityClass: "LEGACY_AP",
        paymentGate: "OPEN",
        paymentGateReason: "إثبات أصل CREDIT بقيد شراء وأمر مطابقين",
        legacySettlementEvidenceHash: hash({
          oldHash,
          planHash: c.planHash,
          invoiceId: invoice.id,
        }),
        version: invoice.version + 1,
      })
      .where(eq(supplierInvoices.id, invoice.id));
    await logAuditTx(tx, actor, {
      action: "supplier.bookSettlement.classify",
      entityType: "supplierInvoice",
      entityId: String(invoice.id),
      oldValue: invoice,
      newValue: { liabilityClass: "LEGACY_AP", planHash: c.planHash },
    });
  }
  const sourceIds: number[] = [];
  const touched = new Set<number>();
  for (const source of c.sources) {
    const snapshot = canonical(source.snapshot);
    const sourceId = extractInsertId(
      await tx.insert(sources).values({
        supplierId: input.supplierId,
        branchId: input.branchId,
        sourceAccountingEntryId: source.entryId,
        sourceReceiptId: source.receiptId,
        sourceExchangeTransactionId: source.exchangeId,
        kind: source.kind,
        amount: source.amount,
        sourceSnapshot: snapshot,
        sourceHash: sha256(snapshot),
        planHash: c.planHash,
        adoptionKey: `${input.requestKey}:${source.entryId}`,
        adoptedBy: owner.id,
        reversalHistory: "[]",
      }),
    );
    sourceIds.push(sourceId);
    await tx.insert(allocations).values(
      source.allocations.map((a) => {
        if (a.supplierInvoiceId) touched.add(a.supplierInvoiceId);
        return {
          sourceId,
          supplierInvoiceId: a.supplierInvoiceId,
          openingEntryId: a.openingEntryId,
          allocatedAmount: a.amount,
          allocatedCurrencyAmount: a.currencyAmount,
          targetSnapshot: a.targetSnapshot,
          targetHash: a.targetHash,
        };
      }),
    );
  }
  for (const invoice of c.classify) touched.add(invoice.id);
  await refreshTargets(tx, Array.from(touched));
  const resolvedCaseIds: number[] = [];
  const issues = await tx
    .select()
    .from(purchaseIntegrityCases)
    .where(
      and(
        eq(purchaseIntegrityCases.supplierId, input.supplierId),
        eq(purchaseIntegrityCases.branchId, input.branchId),
        inArray(purchaseIntegrityCases.supplierInvoiceId, Array.from(touched)),
        inArray(purchaseIntegrityCases.code, [
          "LEGACY_AP_CLASSIFICATION",
          "LEGACY_PAYMENT_ALLOCATION_AMBIGUOUS",
        ]),
        inArray(purchaseIntegrityCases.status, [
          "OPEN",
          "IN_REVIEW",
          "PENDING_RESOLUTION",
        ]),
      ),
    )
    .orderBy(asc(purchaseIntegrityCases.id))
    .for("update");
  for (const issue of issues) {
    if (issue.status === "PENDING_RESOLUTION")
      fail(`قضية ${issue.id} لها قرار حل معلق؛ لا يجوز استبداله ضمن التصحيح`);
    const linked = Array.from(c.links.get(issue.supplierInvoiceId!) ?? []);
    if (linked.length !== 1 || linked[0] !== issue.purchaseOrderId)
      fail("هوية قضية النزاهة لا تطابق هدف التسوية");
    const reason =
      "ثبت أصل ذمة CREDIT وروابط مصادر التسوية الدفترية كاملة بالقيمة الحاكمة مع حفظ الإيصالات والقيود الأصلية؛ أزيل غموض التصنيف والتوزيع دون صرف جديد.";
    await requestPurchaseIntegrityResolutionInTx(
      tx,
      {
        caseId: issue.id,
        requestKey: `BOOK-RESOLVE:${c.planHash.slice(0, 40)}:${issue.id}`,
        reason,
        evidenceReference: `BOOK_FIFO_V1:${c.planHash}:INVOICE:${issue.supplierInvoiceId}:SOURCES:${sourceIds.join(",")}`,
      },
      actor,
    );
    await decidePurchaseIntegrityResolutionInTx(
      tx,
      {
        caseId: issue.id,
        decisionKey: `BOOK-DECIDE:${c.planHash.slice(0, 40)}:${issue.id}`,
        decision: "APPROVE_RESOLVED",
        reason,
      },
      actor,
    );
    resolvedCaseIds.push(issue.id);
  }
  await adjustSupplierBalanceUsd(
    tx,
    input.supplierId,
    money(c.usdDelta).negated(),
  );
  const after = await loadFinancialIdentity(tx, input.supplierId);
  const immutable = (state: typeof after) => ({
    ...state,
    supplier: {
      ...state.supplier,
      currentBalanceUsd: undefined,
      updatedAt: undefined,
    },
  });
  if (
    !money(after.supplier.currentBalanceUsd).eq(c.usdAfter) ||
    hash(immutable(c.financial)) !== hash(immutable(after))
  )
    fail("تغير أصل نقد أو ذمة أثناء اعتماد الروابط؛ ألغيت المعاملة");
  const result = {
    planHash: c.planHash,
    sourceIds,
    invoiceIds: Array.from(touched),
    usdBefore: c.usdBefore,
    usdAfter: c.usdAfter,
    usdDelta: c.usdDelta,
    replayed: false,
    resolvedCaseIds,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 6500)
    fail("سجل اعتماد التوزيع أكبر من حد التدقيق الآمن");
  await logAuditTx(tx, actor, {
    action: ACTION,
    entityType: "supplierBookSettlement",
    entityId,
    oldValue: { financialHash: hash(c.financial) },
    newValue: result,
  });
  enqueueFinancialRefresh(tx, input.branchId);
  return result;
}

/** All requested supplier scopes commit together; failure in the last scope rolls back the first. */
export async function adoptSupplierBookSettlementBatch(
  input: {
    requestKey: string;
    plans: Array<{
      supplierId: number;
      branchId: number;
      expectedPlanHash: string;
    }>;
  },
  actor: Actor,
) {
  if (
    !/^[A-Za-z0-9:_-]{8,60}$/.test(input.requestKey) ||
    !input.plans.length ||
    input.plans.length > 10 ||
    new Set(input.plans.map((p) => `${p.supplierId}:${p.branchId}`)).size !==
      input.plans.length
  )
    fail("نطاق دفعة اعتماد الروابط غير صالح");
  const sorted = [...input.plans].sort(
    (a, b) => a.supplierId - b.supplierId || a.branchId - b.branchId,
  );
  const inputHash = hash({ requestKey: input.requestKey, plans: sorted });
  return withGovernanceTx(async (tx) => {
    const entityId = `BSA-BATCH:${input.requestKey}`;
    const prior = await tx
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, `${ACTION}.batch`),
          eq(auditLogs.entityType, "supplierBookSettlement"),
          eq(auditLogs.entityId, entityId),
        ),
      );
    if (
      prior.length !== 0 &&
      (prior.length !== 1 ||
        (prior[0].newValue as { inputHash?: string })?.inputHash !== inputHash)
    )
      fail("مفتاح الدفعة مكرر ببصمة أخرى");
    const results = [];
    for (const plan of sorted)
      results.push({
        ...(await adoptSupplierBookSettlementInTx(
          tx,
          {
            ...plan,
            requestKey: `${input.requestKey}:${plan.supplierId}:${plan.branchId}`,
          },
          actor,
        )),
        supplierId: plan.supplierId,
        branchId: plan.branchId,
      });
    if (prior.length && results.some((r) => !r.replayed))
      fail("سجل الدفعة لا يطابق اعتماد جميع نطاقاتها");
    if (!prior.length)
      await logAuditTx(tx, actor, {
        action: `${ACTION}.batch`,
        entityType: "supplierBookSettlement",
        entityId,
        newValue: {
          inputHash,
          scopeCount: results.length,
          sourceCount: results.reduce((n, r) => n + r.sourceIds.length, 0),
          invoiceCount: results.reduce((n, r) => n + r.invoiceIds.length, 0),
        },
      });
    return { inputHash, results, replayed: prior.length === 1 };
  });
}

async function loadFinancialIdentity(tx: Tx, supplierId: number) {
  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId));
  const entries = await tx
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.supplierId, supplierId))
    .orderBy(asc(accountingEntries.id));
  const originalReceipts = await tx
    .select()
    .from(receipts)
    .where(
      and(eq(receipts.partyType, "SUPPLIER"), eq(receipts.partyId, supplierId)),
    )
    .orderBy(asc(receipts.id));
  const exchanges = await tx
    .select()
    .from(exchangeTransactions)
    .where(eq(exchangeTransactions.supplierId, supplierId))
    .orderBy(asc(exchangeTransactions.id));
  const formal = await tx
    .select()
    .from(purchaseReturns)
    .where(eq(purchaseReturns.supplierId, supplierId));
  const ids = formal.map((r) => r.id);
  const reversed = ids.length
    ? await tx
        .select()
        .from(purchaseReturnReversals)
        .where(inArray(purchaseReturnReversals.purchaseReturnId, ids))
    : [];
  return {
    supplier,
    entries,
    receipts: originalReceipts,
    exchanges,
    formal,
    reversed,
  };
}

/** Internal companion to the ORIGINAL reversal, under the same exclusive governance transaction. */
export async function unapplySupplierBookSettlementSourceTx(
  tx: Tx,
  input: {
    sourceAccountingEntryId?: number;
    sourceReceiptId?: number;
    sourceExchangeTransactionId?: number;
    amount?: string;
    reversalKey: string;
  },
  actor: Actor,
): Promise<void> {
  const identity = [
    input.sourceAccountingEntryId,
    input.sourceReceiptId,
    input.sourceExchangeTransactionId,
  ].filter((n) => n !== undefined);
  if (
    identity.length !== 1 ||
    !Number.isSafeInteger(identity[0]) ||
    identity[0]! <= 0 ||
    !input.reversalKey.trim() ||
    input.reversalKey.length > 160
  )
    fail("هوية مصدر العكس غير صالحة");
  const where =
    input.sourceAccountingEntryId !== undefined
      ? eq(sources.sourceAccountingEntryId, input.sourceAccountingEntryId)
      : input.sourceReceiptId !== undefined
        ? eq(sources.sourceReceiptId, input.sourceReceiptId)
        : eq(
            sources.sourceExchangeTransactionId,
            input.sourceExchangeTransactionId!,
          );
  const [source] = await tx.select().from(sources).where(where).for("update");
  if (!source) return;
  if (sha256(source.sourceSnapshot) !== source.sourceHash)
    fail("تلفت بصمة مصدر الربط الدفتري");
  const history = JSON.parse(source.reversalHistory) as {
    key: string;
    amount: string;
  }[];
  const prior = history.find((h) => h.key === input.reversalKey);
  if (prior) {
    if (input.amount !== undefined && !money(prior.amount).eq(input.amount))
      fail("مفتاح العكس مكرر بمبلغ مختلف");
    return;
  }
  const amount =
    input.amount === undefined
      ? money(source.amount).minus(source.reversedAmount)
      : money(input.amount);
  if (
    !amount.gt(0) ||
    amount.gt(money(source.amount).minus(source.reversedAmount))
  )
    fail("مبلغ العكس يتجاوز الباقي من المصدر");
  const rows = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.sourceId, source.id))
    .orderBy(asc(allocations.id))
    .for("update");
  if (
    !rows
      .reduce((s, a) => s.plus(a.allocatedAmount), money(0))
      .eq(source.amount) ||
    !rows
      .reduce((s, a) => s.plus(a.reversedAmount), money(0))
      .eq(source.reversedAmount) ||
    rows.some((a) => sha256(a.targetSnapshot) !== a.targetHash)
  )
    fail("تعارض مجموع تخصيصات المصدر أو بصماتها");
  let left = amount;
  let usdUndo = money(0);
  const touched = new Set<number>();
  for (const row of [...rows].reverse()) {
    if (left.isZero()) break;
    const available = money(row.allocatedAmount).minus(row.reversedAmount);
    const undo = Decimal.min(left, available);
    if (!undo.gt(0)) continue;
    const totalUndo = money(row.reversedAmount).plus(undo);
    const currency = totalUndo.eq(row.allocatedAmount)
      ? money(row.allocatedCurrencyAmount)
      : round2(
          money(row.allocatedCurrencyAmount)
            .mul(totalUndo)
            .div(row.allocatedAmount),
        );
    const target = JSON.parse(row.targetSnapshot) as {
      invoice?: { currency?: string };
    };
    if (target.invoice?.currency === "USD")
      usdUndo = usdUndo.plus(currency.minus(row.reversedCurrencyAmount));
    await tx
      .update(allocations)
      .set({
        reversedAmount: toDbMoney(totalUndo),
        reversedCurrencyAmount: toDbMoney(currency),
      })
      .where(eq(allocations.id, row.id));
    if (row.supplierInvoiceId) touched.add(row.supplierInvoiceId);
    left = left.minus(undo);
  }
  if (!left.isZero()) fail("لم تغط تخصيصات المصدر مبلغ العكس");
  const totalReversed = money(source.reversedAmount).plus(amount);
  await tx
    .update(sources)
    .set({
      reversedAmount: toDbMoney(totalReversed),
      status: totalReversed.eq(source.amount)
        ? "REVERSED"
        : "PARTIALLY_REVERSED",
      version: source.version + 1,
      reversalHistory: canonical([
        ...history,
        { key: input.reversalKey, amount: toDbMoney(amount) },
      ]),
    })
    .where(eq(sources.id, source.id));
  await refreshTargets(tx, Array.from(touched));
  await adjustSupplierBalanceUsd(tx, source.supplierId, usdUndo);
  await logAuditTx(tx, actor, {
    action: "supplier.bookSettlement.unapply",
    entityType: "supplierBookSettlementSource",
    entityId: String(source.id),
    oldValue: { reversedAmount: source.reversedAmount },
    newValue: {
      reversedAmount: toDbMoney(totalReversed),
      reversalKey: input.reversalKey,
    },
  });
  enqueueFinancialRefresh(tx, source.branchId);
}

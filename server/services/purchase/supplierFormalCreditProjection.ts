import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  and,
  asc,
  Column,
  eq,
  inArray,
  is,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  goodsReceiptItems,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseReturnReversals,
  purchaseReturns,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  supplierPaymentAllocations,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, toDbMoney } from "../money";
import {
  loadSupplierBookInvoiceTotals,
  supplierBookInvoiceTotalsSql,
} from "./supplierBookProjection";
const LIMIT = 20_000;
function fail(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر تحديد رصيد مرتجع المورد",
      why,
      doThis: "راجع ربط المرتجع بفاتورة المورد الوحيدة قبل صرف سداد جديد",
    }),
  });
}
function bounded<T>(rows: T[]) {
  if (rows.length > LIMIT) fail("تجاوز دليل المرتجع حد القراءة الآمن");
  return rows;
}
const fields = {
  id: supplierInvoices.id,
  supplierId: supplierInvoices.supplierId,
  branchId: supplierInvoices.branchId,
  legacyPoId: supplierInvoices.legacyPurchaseOrderId,
  status: supplierInvoices.status,
  draftState: supplierInvoices.draftState,
  liabilityClass: supplierInvoices.liabilityClass,
  totalAmount: supplierInvoices.totalAmount,
  currency: supplierInvoices.currency,
  legacySettledAmount: supplierInvoices.legacySettledAmount,
};

/**
 * A PO-only credit belongs to its PO's active AP invoices when every active AP
 * invoice linked to that PO belongs exclusively to that single PO and matches
 * the return's (supplierId, branchId); it is allocated in canonical id ASC
 * order after direct invoice credits and existing posted settlements.
 */
export async function loadSupplierFormalCreditTotals(
  db: DB | Tx,
  invoiceIds: readonly number[],
  options: { currentRead?: boolean } = {},
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!invoiceIds.length) return result;
  const selectedQuery = db
    .select(fields)
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, Array.from(invoiceIds)))
    .orderBy(asc(supplierInvoices.id))
    .limit(LIMIT + 1);
  const selected = bounded(
    await (options.currentRead ? selectedQuery.for("share") : selectedQuery),
  );
  if (!selected.length) return result;
  const supplierIds = Array.from(
    new Set(selected.map((row) => Number(row.supplierId))),
  );
  const invoiceQuery = db
    .select(fields)
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.supplierId, supplierIds))
    .orderBy(asc(supplierInvoices.id))
    .limit(LIMIT + 1);
  const invoices = bounded(
    await (options.currentRead ? invoiceQuery.for("share") : invoiceQuery),
  );
  const ids = invoices.map((row) => Number(row.id));
  const lineQuery = db
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
    .where(inArray(supplierInvoiceLines.supplierInvoiceId, ids))
    .orderBy(asc(supplierInvoiceLines.id))
    .limit(LIMIT + 1);
  const matchQuery = db
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
    .where(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, ids))
    .orderBy(asc(supplierInvoiceMatchAllocations.id))
    .limit(LIMIT + 1);
  const lines = bounded(
    await (options.currentRead ? lineQuery.for("share") : lineQuery),
  );
  const matches = bounded(
    await (options.currentRead ? matchQuery.for("share") : matchQuery),
  );
  const links = new Map<number, Set<number>>();
  const link = (id: number, poId: number) => {
    const poIds = links.get(id) ?? new Set<number>();
    poIds.add(poId);
    links.set(id, poIds);
  };
  for (const row of invoices)
    if (row.legacyPoId != null) link(Number(row.id), Number(row.legacyPoId));
  for (const row of [...lines, ...matches])
    link(Number(row.invoiceId), Number(row.poId));
  const returnQuery = db
    .select({
      id: purchaseReturns.id,
      invoiceId: purchaseReturns.supplierInvoiceId,
      poId: purchaseReturns.purchaseOrderId,
      supplierId: purchaseReturns.supplierId,
      branchId: purchaseReturns.branchId,
      amount: purchaseReturns.creditOffsetAmount,
    })
    .from(purchaseReturns)
    .where(
      and(
        inArray(purchaseReturns.supplierId, supplierIds),
        eq(purchaseReturns.settlement, "CREDIT"),
        sql`${purchaseReturns.origin} <> 'OWNER_EXCEPTION'`,
      ),
    )
    .orderBy(asc(purchaseReturns.id))
    .limit(LIMIT + 1);
  const returns = bounded(
    await (options.currentRead ? returnQuery.for("share") : returnQuery),
  );
  const reversalQuery = returns.length
    ? db
        .select({
          returnId: purchaseReturnReversals.purchaseReturnId,
          amount: purchaseReturnReversals.totalAmount,
        })
        .from(purchaseReturnReversals)
        .where(
          inArray(
            purchaseReturnReversals.purchaseReturnId,
            returns.map((row) => Number(row.id)),
          ),
        )
        .orderBy(asc(purchaseReturnReversals.id))
        .limit(LIMIT + 1)
    : null;
  const reversals = reversalQuery
    ? bounded(
        await (options.currentRead
          ? reversalQuery.for("share")
          : reversalQuery),
      )
    : [];
  const reversed = new Map<number, ReturnType<typeof money>>();
  for (const row of reversals)
    reversed.set(
      Number(row.returnId),
      money(reversed.get(Number(row.returnId))).plus(row.amount),
    );
  const selectedIds = new Set(invoiceIds.map(Number));
  const selectedPoIds = new Set<number>();
  for (const invoice of selected)
    for (const poId of Array.from(links.get(Number(invoice.id)) ?? []))
      selectedPoIds.add(poId);
  const isActiveAp = (invoice: (typeof invoices)[number]) =>
    invoice.status === "POSTED" &&
    invoice.draftState !== "VOIDED" &&
    ["NATIVE_AP", "LEGACY_AP", "LEGACY_UNKNOWN"].includes(
      invoice.liabilityClass,
    );
  const poCreditPoIds = new Set<number>();
  for (const row of returns) {
    if (row.invoiceId != null) continue;
    const amount = money(row.amount).minus(reversed.get(Number(row.id)) ?? 0);
    if (amount.gt(0) && selectedPoIds.has(Number(row.poId)))
      poCreditPoIds.add(Number(row.poId));
  }
  const relevantIds = new Set<number>(Array.from(selectedIds));
  for (const invoice of invoices)
    if (
      isActiveAp(invoice) &&
      Array.from(links.get(Number(invoice.id)) ?? []).some((poId) =>
        poCreditPoIds.has(poId),
      )
    )
      relevantIds.add(Number(invoice.id));
  // A PO-only credit has no fixed invoice target. Use only capacity still
  // available after posted payments and allocations; direct credits keep their target.
  // Reassigning an unattributed USD credit could change its posted cents
  // across invoices. Only IQD capacity is redistributed without a new ledger event.
  const candidateIds = invoices
    .filter(
      (invoice) =>
        invoice.currency === "IQD" &&
        isActiveAp(invoice) &&
        Array.from(links.get(Number(invoice.id)) ?? []).some((poId) =>
          poCreditPoIds.has(poId),
        ),
    )
    .map((invoice) => Number(invoice.id));
  const consumed = new Map<number, ReturnType<typeof money>>();
  if (candidateIds.length) {
    const nativeQuery = db
      .select({
        invoiceId: supplierPaymentAllocations.supplierInvoiceId,
        amount: supplierPaymentAllocations.allocatedAmount,
        refunded: supplierPaymentAllocations.refundedAmount,
      })
      .from(supplierPaymentAllocations)
      .where(
        inArray(supplierPaymentAllocations.supplierInvoiceId, candidateIds),
      )
      .orderBy(asc(supplierPaymentAllocations.id))
      .limit(LIMIT + 1);
    const native = bounded(
      await (options.currentRead ? nativeQuery.for("share") : nativeQuery),
    );
    for (const row of native)
      consumed.set(
        Number(row.invoiceId),
        money(consumed.get(Number(row.invoiceId)))
          .plus(row.amount)
          .minus(row.refunded),
      );
    const book = await loadSupplierBookInvoiceTotals(db, candidateIds, options);
    for (const [id, row] of Array.from(book))
      consumed.set(
        id,
        money(consumed.get(id)).plus(row.paidAmount).plus(row.creditedAmount),
      );
  }
  const totals = new Map<number, ReturnType<typeof money>>();
  for (const row of returns) {
    if (row.invoiceId == null) continue;
    const amount = money(row.amount).minus(reversed.get(Number(row.id)) ?? 0);
    if (!amount.gt(0)) continue;
    const target = invoices.find(
      (invoice) => Number(invoice.id) === Number(row.invoiceId),
    );
    if (!target || !relevantIds.has(Number(target.id))) continue;
    if (
      target.supplierId !== row.supplierId ||
      target.branchId !== row.branchId
    )
      fail("هوية المورد أو الفرع في المرتجع لا تطابق فاتورة الذمة");
    const total = money(totals.get(Number(target.id))).plus(amount);
    if (total.gt(target.totalAmount))
      fail(`قيمة المرتجعات تتجاوز فاتورة المورد ${target.id}`);
    totals.set(Number(target.id), total);
  }
  for (const row of returns) {
    if (row.invoiceId != null) continue;
    const amount = money(row.amount).minus(reversed.get(Number(row.id)) ?? 0);
    if (!amount.gt(0)) continue;
    if (!selectedPoIds.has(Number(row.poId))) continue;
    const selectedForPo = selected.filter((invoice) =>
      links.get(Number(invoice.id))?.has(Number(row.poId)),
    );
    if (
      selectedForPo.some(
        (invoice) =>
          invoice.supplierId !== row.supplierId ||
          invoice.branchId !== row.branchId,
      )
    )
      fail("هوية المورد أو الفرع في المرتجع لا تطابق فاتورة الذمة");
    if (
      selectedForPo.some((invoice) => links.get(Number(invoice.id))?.size !== 1)
    )
      fail(`مرتجع أمر الشراء ${row.poId} لا يملك فاتورة ذمة وحيدة مثبتة`);
    const allActiveForPo = invoices.filter(
      (invoice) =>
        isActiveAp(invoice) &&
        links.get(Number(invoice.id))?.has(Number(row.poId)),
    );
    const candidates = allActiveForPo.filter(
      (invoice) =>
        invoice.supplierId === row.supplierId &&
        invoice.branchId === row.branchId,
    );
    if (!candidates.length)
      fail(`مرتجع أمر الشراء ${row.poId} لا يملك فاتورة ذمة وحيدة مثبتة`);
    if (candidates.length !== allActiveForPo.length)
      fail("هوية المورد أو الفرع في المرتجع لا تطابق فاتورة الذمة");
    if (
      candidates.some(
        (candidate) => links.get(Number(candidate.id))?.size !== 1,
      )
    )
      fail(`مرتجع أمر الشراء ${row.poId} لا يملك فاتورة ذمة وحيدة مثبتة`);
    let left = amount;
    for (const candidate of candidates) {
      const current = money(totals.get(Number(candidate.id)));
      const cap = money(candidate.totalAmount)
        .minus(candidate.currency === "IQD" ? candidate.legacySettledAmount : 0)
        .minus(consumed.get(Number(candidate.id)) ?? 0)
        .minus(current);
      if (!cap.gt(0)) continue;
      const take = left.lte(cap) ? left : cap;
      if (take.gt(0)) {
        totals.set(Number(candidate.id), current.plus(take));
        left = left.minus(take);
      }
      if (!left.gt(0)) break;
    }
    if (left.gt(0))
      fail(
        `قيمة المرتجعات تتجاوز فاتورة المورد ${candidates[candidates.length - 1].id}`,
      );
  }
  for (const id of Array.from(selectedIds)) {
    const total = totals.get(id);
    if (total?.gt(0)) result.set(id, toDbMoney(total));
  }
  return result;
}

const linksSql = sql`(SELECT id AS invoiceId, legacyPurchaseOrderId AS poId FROM supplierInvoices WHERE legacyPurchaseOrderId IS NOT NULL
  UNION SELECT sil.supplierInvoiceId, por.purchaseOrderId FROM supplierInvoiceLines sil INNER JOIN purchaseOrderRevisionItems pori ON pori.id=sil.purchaseOrderRevisionItemId INNER JOIN purchaseOrderRevisions por ON por.id=pori.revisionId
  UNION SELECT simr.supplierInvoiceId, poi.purchaseOrderId FROM supplierInvoiceMatchAllocations sima INNER JOIN supplierInvoiceMatchRuns simr ON simr.id=sima.matchRunId INNER JOIN goodsReceiptItems gri ON gri.id=sima.goodsReceiptItemId INNER JOIN purchaseOrderItems poi ON poi.id=gri.purchaseOrderItemId)`;
const netReturnSql = (alias: string) =>
  sql`GREATEST(${sql.raw(alias)}.creditOffsetAmount-COALESCE((SELECT SUM(fcr.totalAmount) FROM purchaseReturnReversals fcr WHERE fcr.purchaseReturnId=${sql.raw(alias)}.id),0),0)`;
const directCreditSql = (invId: SQLWrapper) =>
  sql`COALESCE((SELECT SUM(${netReturnSql("fprd")}) FROM purchaseReturns fprd INNER JOIN supplierInvoices fcdir ON fcdir.id=${invId} WHERE fprd.settlement='CREDIT' AND fprd.origin<>'OWNER_EXCEPTION' AND fprd.supplierInvoiceId=${invId} AND fprd.supplierId=fcdir.supplierId AND fprd.branchId=fcdir.branchId),0)`;

// Aliases are internal literals from the projections below.
function poCreditCapacitySql(alias: "fci" | "fcown") {
  const row = sql.raw(alias);
  const id = sql`${row}.id`;
  const book = supplierBookInvoiceTotalsSql(id);
  return sql`GREATEST(${row}.totalAmount-(${directCreditSql(id)})-
    (CASE WHEN ${row}.currency='IQD' THEN ${row}.legacySettledAmount
      +COALESCE((SELECT SUM(fcp.allocatedAmount-fcp.refundedAmount) FROM supplierPaymentAllocations fcp WHERE fcp.supplierInvoiceId=${id}),0)
      +${book.paidAmount}+${book.creditedAmount} ELSE 0 END),0)`;
}

/** A refund can reopen an IQD sibling when a PO-only credit shifts back to the earlier invoice. */
export async function refreshPoCreditSiblingGates(
  tx: Tx,
  input: {
    orderIds: readonly number[];
    supplierId: number;
    updatedInvoiceIds: readonly number[];
  },
) {
  if (!input.orderIds.length) return;
  const credits = await tx
    .select({ poId: purchaseReturns.purchaseOrderId })
    .from(purchaseReturns)
    .where(
      and(
        inArray(purchaseReturns.purchaseOrderId, [...input.orderIds]),
        eq(purchaseReturns.supplierId, input.supplierId),
        eq(purchaseReturns.settlement, "CREDIT"),
        sql`${purchaseReturns.supplierInvoiceId} IS NULL AND ${purchaseReturns.origin}<>'OWNER_EXCEPTION' AND ${purchaseReturns.creditOffsetAmount}>0`,
      ),
    )
    .limit(LIMIT + 1)
    .for("share");
  const orders = new Set(bounded(credits).map((row) => row.poId));
  const ids = Array.from(orders).flatMap((poId) =>
    poId == null ? [] : [sql`${poId}`],
  );
  if (!ids.length) return;
  const rows = bounded(
    await tx
      .select({
        id: supplierInvoices.id,
        total: supplierInvoices.totalAmount,
        legacy: supplierInvoices.legacySettledAmount,
        gate: supplierInvoices.paymentGate,
      })
      .from(supplierInvoices)
      .where(
        and(
          eq(supplierInvoices.supplierId, input.supplierId),
          eq(supplierInvoices.currency, "IQD"),
          eq(supplierInvoices.status, "POSTED"),
          sql`${supplierInvoices.draftState} <> 'VOIDED'`,
          inArray(supplierInvoices.paymentGate, ["OPEN", "SETTLED"]),
          inArray(supplierInvoices.liabilityClass, ["NATIVE_AP", "LEGACY_AP"]),
          sql`EXISTS (SELECT 1 FROM ${linksSql} sibling WHERE sibling.invoiceId=${supplierInvoices.id} AND sibling.poId IN (${sql.join(ids, sql`,`)}))`,
        ),
      )
      .orderBy(asc(supplierInvoices.id))
      .limit(LIMIT + 1)
      .for("share"),
  );
  const updated = new Set(input.updatedInvoiceIds);
  const siblings = rows.filter((row) => !updated.has(row.id));
  if (!siblings.length) return;
  const invoiceIds = siblings.map((row) => row.id);
  const formal = await loadSupplierFormalCreditTotals(tx, invoiceIds, {
    currentRead: true,
  });
  const book = await loadSupplierBookInvoiceTotals(tx, invoiceIds, {
    currentRead: true,
  });
  const native = bounded(
    await tx
      .select({
        id: supplierPaymentAllocations.supplierInvoiceId,
        paid: supplierPaymentAllocations.allocatedAmount,
        refunded: supplierPaymentAllocations.refundedAmount,
      })
      .from(supplierPaymentAllocations)
      .where(inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds))
      .orderBy(asc(supplierPaymentAllocations.id))
      .limit(LIMIT + 1)
      .for("share"),
  );
  const paid = new Map<number, ReturnType<typeof money>>();
  for (const row of native)
    paid.set(
      row.id,
      money(paid.get(row.id)).plus(row.paid).minus(row.refunded),
    );
  for (const row of siblings) {
    const used = money(row.legacy)
      .plus(paid.get(row.id) ?? 0)
      .plus(formal.get(row.id) ?? 0)
      .plus(book.get(row.id)?.paidAmount ?? 0)
      .plus(book.get(row.id)?.creditedAmount ?? 0);
    const gate = used.gte(row.total) ? "SETTLED" : "OPEN";
    if (gate === row.gate) continue;
    await tx
      .update(supplierInvoices)
      .set({
        paymentGate: gate,
        paymentGateReason:
          gate === "SETTLED" ? "سُوّيت بعد توزيع مرتجع أمر الشراء" : null,
        version: sql`${supplierInvoices.version}+1`,
      })
      .where(eq(supplierInvoices.id, row.id));
  }
}

/** Consistent-read counterpart used before source count/filter/pagination. */
export function supplierFormalCreditTotalsSql(invoiceId: SQLWrapper) {
  const id = is(invoiceId, Column)
    ? sql`${invoiceId.table}.${sql.identifier(invoiceId.name)}`
    : invoiceId;
  const linked = sql`EXISTS (SELECT 1 FROM ${linksSql} fcl WHERE fcl.invoiceId=${id} AND fcl.poId=fpr.purchaseOrderId)`;
  const unique = sql`(SELECT COUNT(DISTINCT fci.id) FROM supplierInvoices fci INNER JOIN ${linksSql} fct ON fct.invoiceId=fci.id WHERE fct.poId=fpr.purchaseOrderId AND fci.supplierId=fpr.supplierId AND fci.branchId=fpr.branchId AND fci.status='POSTED' AND fci.draftState<>'VOIDED' AND fci.liabilityClass IN ('NATIVE_AP','LEGACY_AP','LEGACY_UNKNOWN'))>=1
    AND NOT EXISTS (SELECT 1 FROM supplierInvoices fci INNER JOIN ${linksSql} fct ON fct.invoiceId=fci.id WHERE fct.poId=fpr.purchaseOrderId AND fci.status='POSTED' AND fci.draftState<>'VOIDED' AND fci.liabilityClass IN ('NATIVE_AP','LEGACY_AP','LEGACY_UNKNOWN') AND (fci.supplierId<>fpr.supplierId OR fci.branchId<>fpr.branchId OR (SELECT COUNT(DISTINCT fcpo.poId) FROM ${linksSql} fcpo WHERE fcpo.invoiceId=fci.id)<>1 OR (${directCreditSql(sql`fci.id`)})>fci.totalAmount OR EXISTS (SELECT 1 FROM purchaseReturns fprs WHERE fprs.settlement='CREDIT' AND fprs.origin<>'OWNER_EXCEPTION' AND fprs.supplierInvoiceId=fci.id AND ${netReturnSql("fprs")}>0 AND (fprs.supplierId<>fci.supplierId OR fprs.branchId<>fci.branchId))))
    AND (SELECT COUNT(DISTINCT fcpo.poId) FROM ${linksSql} fcpo WHERE fcpo.invoiceId=${id})=1`;
  const net = netReturnSql("fpr");
  const scope = sql`EXISTS (SELECT 1 FROM supplierInvoices fcowner WHERE fcowner.id=${id} AND fcowner.supplierId=fpr.supplierId AND fcowner.branchId=fpr.branchId)`;
  const ownerActiveAp = sql`EXISTS (SELECT 1 FROM supplierInvoices fcowner WHERE fcowner.id=${id} AND fcowner.status='POSTED' AND fcowner.draftState<>'VOIDED' AND fcowner.liabilityClass IN ('NATIVE_AP','LEGACY_AP','LEGACY_UNKNOWN'))`;
  const direct = directCreditSql(id);
  const ownCap = sql`COALESCE((SELECT ${poCreditCapacitySql("fcown")} FROM supplierInvoices fcown WHERE fcown.id=${id}),0)`;
  const priorCap = sql`COALESCE((SELECT SUM(${poCreditCapacitySql("fci")}) FROM supplierInvoices fci INNER JOIN ${linksSql} fct ON fct.invoiceId=fci.id INNER JOIN ${linksSql} fcl ON fcl.poId=fct.poId AND fcl.invoiceId=${id} INNER JOIN supplierInvoices fcown ON fcown.id=${id} WHERE fci.id<${id} AND fci.supplierId=fcown.supplierId AND fci.branchId=fcown.branchId AND fci.status='POSTED' AND fci.draftState<>'VOIDED' AND fci.liabilityClass IN ('NATIVE_AP','LEGACY_AP','LEGACY_UNKNOWN')),0)`;
  const rawPoCredit = sql`COALESCE((SELECT SUM(${net}) FROM purchaseReturns fpr WHERE fpr.settlement='CREDIT' AND fpr.supplierInvoiceId IS NULL AND fpr.origin<>'OWNER_EXCEPTION' AND ${linked} AND ${scope} AND ${unique}),0)`;
  const poAlloc = sql`CASE WHEN ${ownerActiveAp} AND (${rawPoCredit})>0 THEN LEAST(GREATEST((${rawPoCredit})-(${priorCap}),0),${ownCap}) ELSE 0 END`;
  const poCapTotal = sql`COALESCE((SELECT SUM(${poCreditCapacitySql("fci")}) FROM supplierInvoices fci INNER JOIN ${linksSql} fct ON fct.invoiceId=fci.id WHERE fct.poId=fpr.purchaseOrderId AND fci.supplierId=fpr.supplierId AND fci.branchId=fpr.branchId AND fci.status='POSTED' AND fci.draftState<>'VOIDED' AND fci.liabilityClass IN ('NATIVE_AP','LEGACY_AP','LEGACY_UNKNOWN')),0)`;
  const poCreditTotal = sql`COALESCE((SELECT SUM(${netReturnSql("fpr2")}) FROM purchaseReturns fpr2 WHERE fpr2.settlement='CREDIT' AND fpr2.supplierInvoiceId IS NULL AND fpr2.origin<>'OWNER_EXCEPTION' AND fpr2.purchaseOrderId=fpr.purchaseOrderId AND fpr2.supplierId=fpr.supplierId AND fpr2.branchId=fpr.branchId),0)`;
  return {
    amount: sql<string>`(${direct})+(${poAlloc})`,
    eligible: sql<boolean>`NOT EXISTS (SELECT 1 FROM purchaseReturns fpr WHERE fpr.settlement='CREDIT' AND fpr.origin<>'OWNER_EXCEPTION' AND fpr.supplierInvoiceId=${id} AND ${net}>0 AND NOT (${scope}))
      AND (${direct})<=COALESCE((SELECT fcown.totalAmount FROM supplierInvoices fcown WHERE fcown.id=${id}),0)
      AND NOT EXISTS (SELECT 1 FROM purchaseReturns fpr WHERE fpr.settlement='CREDIT' AND fpr.supplierInvoiceId IS NULL AND fpr.origin<>'OWNER_EXCEPTION' AND ${linked} AND ${net}>0 AND (NOT (${unique}) OR NOT (${scope}) OR (${poCreditTotal})>(${poCapTotal})))`,
  };
}

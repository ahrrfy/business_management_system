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
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money, toDbMoney } from "../money";
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
};

/** A PO-only credit belongs to an invoice only when the complete active AP scope proves one target. */
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
  const selectedIds = new Set(invoiceIds);
  for (const row of returns) {
    const amount = money(row.amount).minus(reversed.get(Number(row.id)) ?? 0);
    if (!amount.gt(0)) continue;
    let target =
      row.invoiceId == null
        ? undefined
        : invoices.find((invoice) => invoice.id === row.invoiceId);
    if (row.invoiceId == null) {
      if (
        !selected.some((invoice) =>
          links.get(Number(invoice.id))?.has(Number(row.poId)),
        )
      )
        continue;
      const candidates = invoices.filter(
        (invoice) =>
          invoice.supplierId === row.supplierId &&
          invoice.branchId === row.branchId &&
          invoice.status === "POSTED" &&
          invoice.draftState !== "VOIDED" &&
          ["NATIVE_AP", "LEGACY_AP", "LEGACY_UNKNOWN"].includes(
            invoice.liabilityClass,
          ) &&
          links.get(Number(invoice.id))?.has(Number(row.poId)),
      );
      if (
        candidates.length !== 1 ||
        links.get(Number(candidates[0].id))?.size !== 1
      )
        fail(`مرتجع أمر الشراء ${row.poId} لا يملك فاتورة ذمة وحيدة مثبتة`);
      target = candidates[0];
    }
    if (!target || !selectedIds.has(Number(target.id))) continue;
    if (
      target.supplierId !== row.supplierId ||
      target.branchId !== row.branchId
    )
      fail("هوية المورد أو الفرع في المرتجع لا تطابق فاتورة الذمة");
    const total = money(result.get(Number(target.id))).plus(amount);
    if (total.gt(target.totalAmount))
      fail(`قيمة المرتجعات تتجاوز فاتورة المورد ${target.id}`);
    result.set(Number(target.id), toDbMoney(total));
  }
  return result;
}

const linksSql = sql`(SELECT id AS invoiceId, legacyPurchaseOrderId AS poId FROM supplierInvoices WHERE legacyPurchaseOrderId IS NOT NULL
  UNION SELECT sil.supplierInvoiceId, por.purchaseOrderId FROM supplierInvoiceLines sil INNER JOIN purchaseOrderRevisionItems pori ON pori.id=sil.purchaseOrderRevisionItemId INNER JOIN purchaseOrderRevisions por ON por.id=pori.revisionId
  UNION SELECT simr.supplierInvoiceId, poi.purchaseOrderId FROM supplierInvoiceMatchAllocations sima INNER JOIN supplierInvoiceMatchRuns simr ON simr.id=sima.matchRunId INNER JOIN goodsReceiptItems gri ON gri.id=sima.goodsReceiptItemId INNER JOIN purchaseOrderItems poi ON poi.id=gri.purchaseOrderItemId)`;
/** Consistent-read counterpart used before source count/filter/pagination. */
export function supplierFormalCreditTotalsSql(invoiceId: SQLWrapper) {
  const id = is(invoiceId, Column)
    ? sql`${invoiceId.table}.${sql.identifier(invoiceId.name)}`
    : invoiceId;
  const linked = sql`EXISTS (SELECT 1 FROM ${linksSql} fcl WHERE fcl.invoiceId=${id} AND fcl.poId=fpr.purchaseOrderId)`;
  const unique = sql`(SELECT COUNT(DISTINCT fci.id) FROM supplierInvoices fci INNER JOIN ${linksSql} fct ON fct.invoiceId=fci.id WHERE fct.poId=fpr.purchaseOrderId AND fci.supplierId=fpr.supplierId AND fci.branchId=fpr.branchId AND fci.status='POSTED' AND fci.draftState<>'VOIDED' AND fci.liabilityClass IN ('NATIVE_AP','LEGACY_AP','LEGACY_UNKNOWN'))=1
    AND (SELECT COUNT(DISTINCT fcpo.poId) FROM ${linksSql} fcpo WHERE fcpo.invoiceId=${id})=1`;
  const net = sql`GREATEST(fpr.creditOffsetAmount-COALESCE((SELECT SUM(fcr.totalAmount) FROM purchaseReturnReversals fcr WHERE fcr.purchaseReturnId=fpr.id),0),0)`;
  const scope = sql`EXISTS (SELECT 1 FROM supplierInvoices fcowner WHERE fcowner.id=${id} AND fcowner.supplierId=fpr.supplierId AND fcowner.branchId=fpr.branchId)`;
  return {
    amount: sql<string>`COALESCE((SELECT SUM(${net}) FROM purchaseReturns fpr WHERE fpr.settlement='CREDIT' AND ${scope} AND (fpr.supplierInvoiceId=${id} OR (fpr.supplierInvoiceId IS NULL AND ${linked} AND ${unique}))),0)`,
    eligible: sql<boolean>`NOT EXISTS (SELECT 1 FROM purchaseReturns fpr WHERE fpr.settlement='CREDIT' AND fpr.supplierInvoiceId IS NULL AND ${linked} AND ${net}>0 AND (NOT (${unique}) OR NOT (${scope})))`,
  };
}

import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { assessUsdRateSanity } from "@shared/balanceTrail";
import {
  accountingEntries,
  auditLogs,
  branches,
  customers,
  exchangeTransactions,
  goodsReceiptItems,
  goodsReceipts,
  invoices,
  journalEntries,
  purchaseOrders,
  purchaseReturns,
  receipts,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRefunds,
  supplierPayments,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { getDb, type DB, type Tx } from "../../db";
import { logAuditTx } from "../auditService";
import {
  clearCustomerCreditInterbranchTx,
  computeCustomerBranchScopeTx,
} from "../customerReceiptSettlement";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustSupplierBalanceUsd } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { reconcileCustomerBalances, reconcileSupplierBalances } from "../reconcileService";
import {
  isOwnedSupplierIncoming,
  isOwnedVoucherCancellation,
} from "../purchase/advanceRefundOwnership";
import { ADVANCE_REFUND_ACTION } from "../purchase/advanceRefundEvidence";
import { sha256, stableCanonical } from "../purchase/grniAccounting";
import { usdReturnAmountWithFinalResidual } from "../purchase/returnGovernance";
import { loadSupplierBookInvoiceTotals } from "../purchase/supplierBookProjection";
import { loadSupplierFormalCreditTotals } from "../purchase/supplierFormalCreditProjection";
import { withTx, type Actor } from "../tx";
import { cancelVoucher } from "../voucher/cancel";
import { assertBranchOwnership } from "../voucher/helpers";
import { isElevated } from "../../lib/redact";

export type AccountAnomalyType =
  | "ANOMALOUS_USD_RATE"
  | "SUPPLIER_USD_DRIFT"
  | "UNCLASSIFIED_SUPPLIER_RECEIPT"
  | "CROSS_BRANCH_CUSTOMER_CREDIT"
  | "LEDGER_BALANCE_DRIFT";

export type AccountAnomalySeverity = "critical" | "warning" | "info";

export type AccountAnomalyAction =
  | "ALIGN_SUPPLIER_USD"
  | "RECLASSIFY_RECEIPT"
  | "RECONCILE_CROSS_BRANCH"
  | "REVIEW_PO_RATE"
  | "RECONCILE_LEDGER";

export interface AccountAnomalyItem {
  id: string;
  kind: AccountAnomalyType;
  severity: AccountAnomalySeverity;
  partyType: "SUPPLIER" | "CUSTOMER";
  partyId: number;
  partyName: string;
  branchId: number | null;
  branchName: string | null;
  title: string;
  description: string;
  recommendedAction: AccountAnomalyAction;
  targetHref?: string | null;
  metrics: {
    expectedAmount?: string | null;
    actualAmount?: string | null;
    deltaAmount?: string | null;
    currency?: "IQD" | "USD";
    rate?: string | null;
  };
  metadata: Record<string, string | number | boolean | null>;
}

export interface ScanAccountAnomaliesInput {
  partyType?: "SUPPLIER" | "CUSTOMER";
  supplierId?: number;
  customerId?: number;
  purchaseOrderId?: number;
  branchId?: number;
}

export interface ScanAccountAnomaliesResult {
  anomalies: AccountAnomalyItem[];
  summary: {
    total: number;
    critical: number;
    warning: number;
  };
}

export interface AlignSupplierUsdResult {
  supplierId: number;
  aligned: boolean;
  usdBefore: string;
  usdAfter: string;
  deltaUsd: string;
  openInvoicesUsdTotal: string;
  evidenceHash: string;
}

export interface ReclassifySupplierReceiptResult {
  receiptId: number;
  action: "CONFIRM_CREDIT_OBLIGATION" | "REVERSE_RECEIPT";
  updatedPurpose?: "CREDIT_OBLIGATION";
  cancellationRequestId?: number | null;
  cancelledImmediately?: boolean;
  evidenceHash: string;
}

export interface ReconcileCustomerCrossBranchResult {
  customerId: number;
  settledAmount: string;
  invoiceId: number | null;
  sourceBranchId: number;
  targetBranchId: number;
  journalEntryId: number | null;
  journalNumber: string | null;
  evidenceHash: string;
  balanceBefore: string;
  balanceAfter: string;
}

function legacyUsdSettled(inv: {
  currency: string;
  agreedRate: string | null;
  legacySettledAmount: string;
}): Decimal {
  if (inv.currency !== "USD") return money(0);
  const rate = money(inv.agreedRate ?? "0");
  if (!rate.gt(0)) return money(0);
  return round2(money(inv.legacySettledAmount).div(rate));
}

async function isVerifiedOwnerUser(db: DB | Tx, actor: Actor): Promise<boolean> {
  if (!actor.isOwner) return false;
  const [row] = await db
    .select({ isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  return Boolean(row?.isOwner && row.isActive);
}

async function findAuditNewValueByClientRequestId<T extends object>(
  db: DB | Tx,
  params: {
    action: string;
    entityType: string;
    entityId: string;
    clientRequestId: string;
  },
): Promise<T | null> {
  const rows = await db
    .select({ newValue: auditLogs.newValue })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, params.action),
        eq(auditLogs.entityType, params.entityType),
        eq(auditLogs.entityId, params.entityId),
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(50);
  for (const row of rows) {
    const val = (row.newValue ?? null) as (T & { clientRequestId?: unknown }) | null;
    if (val && val.clientRequestId === params.clientRequestId) {
      return val;
    }
  }
  return null;
}

/**
 * احتساب إجمالي الالتزامات المفتوحة بالدولار لكل مورد (أو لمورد محدد)
 * استناداً إلى فواتير الموردين المرحلة بالدولار وأوامر الشراء الآجلة بالدولار غير المفوترة.
 */
export async function loadOpenSupplierUsdTotals(
  db: DB | Tx,
  supplierIds?: readonly number[],
  branchId?: number,
  lock = false,
): Promise<Map<number, Decimal>> {
  const result = new Map<number, Decimal>();
  if (supplierIds && supplierIds.length === 0) return result;

  // القفل القانوني: purchaseOrders قبل supplierInvoices لمنع عكس الترتيب مع مدفوعات المشتريات.
  const poQuery = db
    .select({
      id: purchaseOrders.id,
      supplierId: purchaseOrders.supplierId,
      total: purchaseOrders.total,
      paidAmount: purchaseOrders.paidAmount,
      usdTotal: purchaseOrders.usdTotal,
      paidUsd: purchaseOrders.paidUsd,
      returnedUsd: purchaseOrders.returnedUsd,
      agreedRate: purchaseOrders.agreedRate,
    })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.agreedCurrency, "USD"),
        inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
        eq(purchaseOrders.settlementType, "CREDIT"),
        supplierIds ? inArray(purchaseOrders.supplierId, Array.from(supplierIds)) : undefined,
        branchId != null ? eq(purchaseOrders.branchId, branchId) : undefined,
      ),
    )
    .orderBy(asc(purchaseOrders.id));
  const usdPos = await (lock ? poQuery.for("share") : poQuery);

  const invQuery = db
    .select({
      id: supplierInvoices.id,
      supplierId: supplierInvoices.supplierId,
      branchId: supplierInvoices.branchId,
      currency: supplierInvoices.currency,
      agreedRate: supplierInvoices.agreedRate,
      totalAmount: supplierInvoices.totalAmount,
      usdTotal: supplierInvoices.usdTotal,
      legacySettledAmount: supplierInvoices.legacySettledAmount,
      legacyPurchaseOrderId: supplierInvoices.legacyPurchaseOrderId,
    })
    .from(supplierInvoices)
    .where(
      and(
        eq(supplierInvoices.status, "POSTED"),
        eq(supplierInvoices.currency, "USD"),
        inArray(supplierInvoices.liabilityClass, ["NATIVE_AP", "LEGACY_AP", "LEGACY_UNKNOWN"]),
        supplierIds ? inArray(supplierInvoices.supplierId, Array.from(supplierIds)) : undefined,
        branchId != null ? eq(supplierInvoices.branchId, branchId) : undefined,
      ),
    )
    .orderBy(asc(supplierInvoices.id));
  const usdInvoices = await (lock ? invQuery.for("share") : invQuery);
  const invIds = usdInvoices.map((inv) => Number(inv.id));

  const linkedPoIds = new Set<number>();
  for (const inv of usdInvoices) {
    if (inv.legacyPurchaseOrderId != null) linkedPoIds.add(Number(inv.legacyPurchaseOrderId));
  }

  if (invIds.length > 0) {
    const [formalCredits, bookTotals, nativeRows, matchPoRows] = await Promise.all([
      loadSupplierFormalCreditTotals(db, invIds, { currentRead: lock }),
      loadSupplierBookInvoiceTotals(db, invIds, { currentRead: lock }),
      (() => {
        const q = db
          .select({
            invoiceId: supplierPaymentAllocations.supplierInvoiceId,
            amount: sql<string>`COALESCE(SUM(CAST(${supplierPaymentAllocations.allocatedAmount} AS DECIMAL(15,2)) - CAST(${supplierPaymentAllocations.refundedAmount} AS DECIMAL(15,2))), 0)`,
            currencyAmount: sql<string>`COALESCE(SUM(CAST(${supplierPaymentAllocations.allocatedCurrencyAmount} AS DECIMAL(15,2)) - CAST(${supplierPaymentAllocations.refundedCurrencyAmount} AS DECIMAL(15,2))), 0)`,
          })
          .from(supplierPaymentAllocations)
          .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.supplierPaymentId))
          .where(
            and(
              inArray(supplierPaymentAllocations.supplierInvoiceId, invIds),
              sql`${supplierPayments.status} <> 'REFUNDED'`,
            ),
          )
          .groupBy(supplierPaymentAllocations.supplierInvoiceId);
        return lock ? q.for("share") : q;
      })(),
      db
        .select({ poId: goodsReceipts.purchaseOrderId })
        .from(supplierInvoiceMatchRuns)
        .innerJoin(
          supplierInvoiceMatchAllocations,
          eq(supplierInvoiceMatchAllocations.matchRunId, supplierInvoiceMatchRuns.id),
        )
        .innerJoin(
          goodsReceiptItems,
          eq(goodsReceiptItems.id, supplierInvoiceMatchAllocations.goodsReceiptItemId),
        )
        .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId))
        .where(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, invIds)),
    ]);

    for (const mp of matchPoRows) {
      if (mp.poId != null) linkedPoIds.add(Number(mp.poId));
    }

    const nativeMap = new Map(
      nativeRows.map((r) => [
        Number(r.invoiceId),
        { amount: money(r.amount), currencyAmount: money(r.currencyAmount) },
      ]),
    );

    for (const inv of usdInvoices) {
      const id = Number(inv.id);
      const supId = Number(inv.supplierId);
      const book = bookTotals.get(id);
      const nat = nativeMap.get(id);
      const formalIqd = money(formalCredits.get(id) ?? "0");
      const rate = money(inv.agreedRate ?? "0");
      const invoiceUsdTotal =
        inv.usdTotal != null
          ? money(inv.usdTotal)
          : rate.gt(0)
            ? round2(money(inv.totalAmount).div(rate))
            : money(0);
      const formalUsd = usdReturnAmountWithFinalResidual(
        toDbMoney(invoiceUsdTotal),
        inv.totalAmount,
        formalIqd,
        0,
      );

      const paidIqd = money(nat?.amount ?? 0).plus(book?.paidAmount ?? 0);
      const credIqd = formalIqd.plus(book?.creditedAmount ?? 0);
      const openIqd = Decimal.max(
        0,
        money(inv.totalAmount).minus(inv.legacySettledAmount).minus(paidIqd).minus(credIqd),
      );
      const paidUsd = money(nat?.currencyAmount ?? 0).plus(book?.paidCurrencyAmount ?? 0);
      const credUsd = formalUsd.plus(book?.creditedCurrencyAmount ?? 0);
      const openUsd = Decimal.max(
        0,
        round2(
          invoiceUsdTotal
            .minus(legacyUsdSettled(inv))
            .minus(paidUsd)
            .minus(credUsd),
        ),
      );
      if (!openUsd.gt(0)) continue;
      if (!openIqd.gt(0) && paidUsd.isZero() && credUsd.isZero()) continue;
      result.set(supId, round2((result.get(supId) ?? money(0)).plus(openUsd)));
    }
  }

  // أوامر شراء USD مسجّلة في المسار القديم (PURCHASE AP) وغير مرتبطة بفاتورة مورد مرحلة:
  // إن سُدّد أصل الأمر بالدينار بالكامل (paidAmount >= total) بلا تتبع USD، يُعد التزامه المفتوح صفراً.
  const unlinkedPos = usdPos.filter((po) => !linkedPoIds.has(Number(po.id)));
  if (unlinkedPos.length > 0) {
    const apEntries = await db
      .select({ poId: accountingEntries.purchaseOrderId })
      .from(accountingEntries)
      .where(
        and(
          inArray(
            accountingEntries.purchaseOrderId,
            unlinkedPos.map((p) => Number(p.id)),
          ),
          eq(accountingEntries.entryType, "PURCHASE"),
          sql`COALESCE(${accountingEntries.purchaseLiabilityAccount}, 'AP') = 'AP'`,
        ),
      );
    const apPoIds = new Set(apEntries.map((r) => Number(r.poId)));
    for (const po of unlinkedPos) {
      const poId = Number(po.id);
      if (!apPoIds.has(poId)) continue;
      const openIqd = Decimal.max(0, money(po.total).minus(po.paidAmount ?? 0));
      const poUsdTotal =
        po.usdTotal != null
          ? money(po.usdTotal)
          : money(po.agreedRate ?? "0").gt(0)
            ? round2(money(po.total).div(po.agreedRate!))
            : money(0);
      const openUsd = Decimal.max(
        0,
        round2(poUsdTotal.minus(po.paidUsd ?? 0).minus(po.returnedUsd ?? 0)),
      );
      if (!openUsd.gt(0)) continue;
      if (
        !openIqd.gt(0) &&
        money(po.paidUsd ?? 0).isZero() &&
        money(po.returnedUsd ?? 0).isZero()
      ) {
        continue;
      }
      const supId = Number(po.supplierId);
      result.set(supId, round2((result.get(supId) ?? money(0)).plus(openUsd)));
    }
  }

  return result;
}

export async function computeOpenSupplierUsdTotal(
  db: DB | Tx,
  supplierId: number,
  options?: { lock?: boolean; branchId?: number },
): Promise<Decimal> {
  const map = await loadOpenSupplierUsdTotals(db, [supplierId], options?.branchId, options?.lock);
  return round2(map.get(supplierId) ?? money(0));
}

async function detectAnomalousUsdRates(
  db: DB,
  filter: ScanAccountAnomaliesInput,
  branchNames: Map<number, string>,
): Promise<AccountAnomalyItem[]> {
  if (
    filter.partyType === "CUSTOMER" ||
    (filter.customerId != null && filter.supplierId == null && filter.purchaseOrderId == null)
  ) {
    return [];
  }
  const usdRows = await db
    .select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      branchId: purchaseOrders.branchId,
      agreedRate: purchaseOrders.agreedRate,
      usdTotal: purchaseOrders.usdTotal,
      total: purchaseOrders.total,
      status: purchaseOrders.status,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(
      and(
        eq(purchaseOrders.agreedCurrency, "USD"),
        sql`${purchaseOrders.status} <> 'CANCELLED'`,
        filter.supplierId != null ? eq(purchaseOrders.supplierId, filter.supplierId) : undefined,
        filter.purchaseOrderId != null ? eq(purchaseOrders.id, filter.purchaseOrderId) : undefined,
        filter.branchId != null ? eq(purchaseOrders.branchId, filter.branchId) : undefined,
      ),
    )
    .orderBy(desc(purchaseOrders.id));

  if (usdRows.length === 0) return [];

  let referenceRate: string | null = null;
  for (const row of usdRows) {
    if (row.agreedRate != null && assessUsdRateSanity(row.agreedRate, null).status === "OK") {
      referenceRate = row.agreedRate;
      break;
    }
  }
  if (!referenceRate) {
    const [latestValid] = await db
      .select({ agreedRate: purchaseOrders.agreedRate })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.agreedCurrency, "USD"),
          sql`${purchaseOrders.status} <> 'CANCELLED'`,
          sql`${purchaseOrders.agreedRate} BETWEEN 1000 AND 2500`,
        ),
      )
      .orderBy(desc(purchaseOrders.id))
      .limit(1);
    referenceRate = latestValid?.agreedRate ?? null;
  }

  const out: AccountAnomalyItem[] = [];
  for (const row of usdRows) {
    const sanity = assessUsdRateSanity(row.agreedRate, referenceRate);
    if (sanity.status === "OK") continue;
    const usdAmt =
      row.usdTotal != null
        ? toDbMoney(money(row.usdTotal))
        : money(row.agreedRate ?? "0").gt(0)
          ? toDbMoney(round2(money(row.total).div(row.agreedRate!)))
          : "0.00";
    const brId = Number(row.branchId);
    out.push({
      id: `ANOMALOUS_USD_RATE:${row.id}`,
      kind: "ANOMALOUS_USD_RATE",
      severity: sanity.status === "ANOMALOUS" ? "critical" : "warning",
      partyType: "SUPPLIER",
      partyId: Number(row.supplierId),
      partyName: row.supplierName,
      branchId: brId,
      branchName: branchNames.get(brId) ?? null,
      title: `سعر صرف شاذ في أمر الشراء ${row.poNumber}`,
      description:
        (sanity.message ??
          `سعر الصرف المسجل (${row.agreedRate ?? "غير محدد"}) يحتاج مراجعة حسابية`) +
        (sanity.suggestedRate ? ` — المقترح: ${sanity.suggestedRate} د.ع/$` : ""),
      recommendedAction: "REVIEW_PO_RATE",
      targetHref: `/purchases/${row.id}`,
      metrics: {
        expectedAmount: sanity.referenceRate,
        actualAmount: usdAmt,
        currency: "USD",
        rate: row.agreedRate,
      },
      metadata: {
        purchaseOrderId: Number(row.id),
        poNumber: row.poNumber,
        agreedRate: row.agreedRate,
        suggestedRate: sanity.suggestedRate,
        referenceRate: sanity.referenceRate,
        usdTotal: usdAmt,
        totalIqd: toDbMoney(money(row.total)),
        status: row.status,
      },
    });
  }
  return out;
}

async function detectSupplierUsdDrift(
  db: DB,
  filter: ScanAccountAnomaliesInput,
  branchNames: Map<number, string>,
): Promise<AccountAnomalyItem[]> {
  if (
    filter.partyType === "CUSTOMER" ||
    (filter.customerId != null && filter.supplierId == null && filter.purchaseOrderId == null)
  ) {
    return [];
  }
  const supplierFilterIds = filter.supplierId != null ? [filter.supplierId] : undefined;
  const supRows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      currentBalanceUsd: suppliers.currentBalanceUsd,
    })
    .from(suppliers)
    .where(
      and(
        filter.supplierId != null ? eq(suppliers.id, filter.supplierId) : undefined,
        filter.supplierId == null ? sql`ABS(${suppliers.currentBalanceUsd}) > 0.01` : undefined,
      ),
    );
  const targetIds = supplierFilterIds ?? supRows.map((s) => Number(s.id));
  // عداد currentBalanceUsd في بطاقة المورد على مستوى الشركة بأكملها لا فرع واحد؛
  // لذا نقارنه دائماً بإجمالي التزامات الدولار المفتوحة عبر جميع الفروع، وبمعرفات شاملة
  // كي لا يُغفل الفحص الشامل مورداً رصيده الدفتري USD صفر بينما يملك فواتير دولارية مفتوحة.
  const openMap = await loadOpenSupplierUsdTotals(db, supplierFilterIds, undefined, false);

  const seenSupIds = new Set<number>(supRows.map((s) => Number(s.id)));
  for (const supId of Array.from(openMap.keys())) {
    seenSupIds.add(supId);
  }
  if (seenSupIds.size === 0) return [];

  const allSups =
    supRows.length === seenSupIds.size
      ? supRows
      : await db
          .select({
            id: suppliers.id,
            name: suppliers.name,
            currentBalanceUsd: suppliers.currentBalanceUsd,
          })
          .from(suppliers)
          .where(inArray(suppliers.id, Array.from(seenSupIds)));

  const out: AccountAnomalyItem[] = [];
  for (const sup of allSups) {
    const supId = Number(sup.id);
    const cachedUsd = round2(money(sup.currentBalanceUsd ?? "0"));
    const openUsd = round2(openMap.get(supId) ?? money(0));
    const delta = round2(openUsd.minus(cachedUsd));
    if (delta.abs().lte("0.01")) continue;
    out.push({
      id: `SUPPLIER_USD_DRIFT:${supId}`,
      kind: "SUPPLIER_USD_DRIFT",
      severity: cachedUsd.lt(0) || openUsd.isZero() ? "critical" : "warning",
      partyType: "SUPPLIER",
      partyId: supId,
      partyName: sup.name,
      branchId: filter.branchId ?? null,
      branchName: filter.branchId != null ? (branchNames.get(filter.branchId) ?? null) : null,
      title: `انحراف رصيد الدولار لدى المورد ${sup.name}`,
      description: `عداد الدولار المسجل (${toDbMoney(cachedUsd)} $) لا يطابق مجموع التزامات الدولار المفتوحة (${toDbMoney(openUsd)} $)`,
      recommendedAction: "ALIGN_SUPPLIER_USD",
      targetHref: `/suppliers-statement?id=${supId}`,
      metrics: {
        expectedAmount: toDbMoney(openUsd),
        actualAmount: toDbMoney(cachedUsd),
        deltaAmount: toDbMoney(delta),
        currency: "USD",
      },
      metadata: {
        supplierId: supId,
        currentBalanceUsd: toDbMoney(cachedUsd),
        openInvoicesUsdTotal: toDbMoney(openUsd),
        deltaUsd: toDbMoney(delta),
      },
    });
  }
  return out;
}

async function detectUnclassifiedSupplierReceipts(
  db: DB,
  filter: ScanAccountAnomaliesInput,
  branchNames: Map<number, string>,
): Promise<AccountAnomalyItem[]> {
  if (
    filter.partyType === "CUSTOMER" ||
    (filter.customerId != null && filter.supplierId == null && filter.purchaseOrderId == null)
  ) {
    return [];
  }
  const rows = await db
    .select({
      id: receipts.id,
      voucherNumber: receipts.voucherNumber,
      partyId: receipts.partyId,
      supplierName: suppliers.name,
      branchId: receipts.branchId,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      referenceNumber: receipts.referenceNumber,
      createdAt: receipts.createdAt,
    })
    .from(receipts)
    .innerJoin(suppliers, eq(suppliers.id, receipts.partyId))
    .where(
      and(
        eq(receipts.partyType, "SUPPLIER"),
        eq(receipts.direction, "IN"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
        filter.supplierId != null ? eq(receipts.partyId, filter.supplierId) : undefined,
        filter.branchId != null ? eq(receipts.branchId, filter.branchId) : undefined,
      ),
    )
    .orderBy(desc(receipts.id));

  if (rows.length === 0) return [];
  const receiptIds = rows.map((r) => Number(r.id));
  const idStrings = receiptIds.map(String);

  const [purposeLogs, refundLinks, returnLinks, exLinks, fullRows] = await Promise.all([
    db
      .select({ entityId: auditLogs.entityId, action: auditLogs.action })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "receipt"),
          inArray(auditLogs.entityId, idStrings),
          inArray(auditLogs.action, ["voucher.supplierReceiptPurpose", ADVANCE_REFUND_ACTION]),
        ),
      ),
    db
      .select({ receiptId: supplierPaymentRefunds.receiptId })
      .from(supplierPaymentRefunds)
      .where(inArray(supplierPaymentRefunds.receiptId, receiptIds)),
    db
      .select({ receiptId: purchaseReturns.cashRefundReceiptId })
      .from(purchaseReturns)
      .where(inArray(purchaseReturns.cashRefundReceiptId, receiptIds)),
    db
      .select({ receiptId: exchangeTransactions.receiptId })
      .from(exchangeTransactions)
      .where(inArray(exchangeTransactions.receiptId, receiptIds)),
    db.select().from(receipts).where(inArray(receipts.id, receiptIds)),
  ]);

  const classifiedIds = new Set(purposeLogs.map((l) => Number(l.entityId)));
  const nativeRefundIds = new Set(refundLinks.map((r) => Number(r.receiptId)));
  const returnRefundIds = new Set(
    returnLinks.filter((r) => r.receiptId != null).map((r) => Number(r.receiptId)),
  );
  const exchangeIds = new Set(
    exLinks.filter((r) => r.receiptId != null).map((r) => Number(r.receiptId)),
  );
  const fullById = new Map(fullRows.map((r) => [Number(r.id), r]));

  const out: AccountAnomalyItem[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (
      classifiedIds.has(id) ||
      nativeRefundIds.has(id) ||
      returnRefundIds.has(id) ||
      exchangeIds.has(id)
    ) {
      continue;
    }
    const full = fullById.get(id);
    if (full && (await isOwnedSupplierIncoming(db, full))) continue;
    if (full && row.referenceNumber?.startsWith("CANCEL-VCH-")) {
      const origId = Number(row.referenceNumber.slice("CANCEL-VCH-".length));
      if (Number.isSafeInteger(origId) && origId > 0) {
        const [orig] = await db.select().from(receipts).where(eq(receipts.id, origId)).limit(1);
        if (orig && (await isOwnedVoucherCancellation(db, orig, full))) continue;
      }
    }

    const voucherLabel = row.voucherNumber ?? `#${id}`;
    const brId = row.branchId != null ? Number(row.branchId) : null;
    const amtStr = toDbMoney(money(row.amount));
    out.push({
      id: `UNCLASSIFIED_SUPPLIER_RECEIPT:${id}`,
      kind: "UNCLASSIFIED_SUPPLIER_RECEIPT",
      severity: "warning",
      partyType: "SUPPLIER",
      partyId: Number(row.partyId),
      partyName: row.supplierName,
      branchId: brId,
      branchName: brId != null ? (branchNames.get(brId) ?? null) : null,
      title: `سند قبض مورد غير مصنف (${voucherLabel})`,
      description: `سند القبض (${voucherLabel}) بمبلغ ${amtStr} د.ع مسجل على حساب ${row.supplierName} دون تحديد غرضه (التزام دائن علينا أم استرداد سلفة أم خطأ إدخال)`,
      recommendedAction: "RECLASSIFY_RECEIPT",
      targetHref: `/vouchers?q=${encodeURIComponent(voucherLabel)}`,
      metrics: {
        actualAmount: amtStr,
        currency: "IQD",
      },
      metadata: {
        receiptId: id,
        voucherNumber: row.voucherNumber ?? null,
        paymentMethod: row.paymentMethod ?? null,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : row.createdAt != null
              ? String(row.createdAt)
              : null,
      },
    });
  }
  return out;
}

async function detectCrossBranchCustomerCredits(
  db: DB,
  filter: ScanAccountAnomaliesInput,
  branchNames: Map<number, string>,
): Promise<AccountAnomalyItem[]> {
  if (filter.partyType === "SUPPLIER") return [];
  if (filter.supplierId != null || filter.purchaseOrderId != null) {
    if (filter.customerId == null) return [];
  }
  const openInvRows = await db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      customerName: customers.name,
      branchId: invoices.branchId,
      branchName: branches.name,
      total: invoices.total,
      returnedTotal: invoices.returnedTotal,
      paidAmount: invoices.paidAmount,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(branches, eq(branches.id, invoices.branchId))
    .where(
      and(
        sql`${invoices.customerId} IS NOT NULL`,
        sql`${invoices.status} IN ('PENDING', 'PARTIALLY_PAID')`,
        filter.customerId != null ? eq(invoices.customerId, filter.customerId) : undefined,
      ),
    );
  if (openInvRows.length === 0) return [];

  const openByCustBranch = new Map<
    number,
    Map<number, { branchName: string; openAmount: Decimal; invoiceIds: number[] }>
  >();
  const customerNames = new Map<number, string>();
  for (const inv of openInvRows) {
    const custId = Number(inv.customerId);
    const brId = Number(inv.branchId);
    const rem = Decimal.max(
      0,
      money(inv.total).minus(inv.returnedTotal ?? 0).minus(inv.paidAmount),
    );
    if (!rem.gt(0)) continue;
    customerNames.set(custId, inv.customerName);
    const byBranch = openByCustBranch.get(custId) ?? new Map();
    const cur = byBranch.get(brId) ?? {
      branchName: inv.branchName ?? branchNames.get(brId) ?? `الفرع ${brId}`,
      openAmount: money(0),
      invoiceIds: [],
    };
    cur.openAmount = cur.openAmount.plus(rem);
    cur.invoiceIds.push(Number(inv.id));
    byBranch.set(brId, cur);
    openByCustBranch.set(custId, byBranch);
  }
  const candidateCustomerIds = Array.from(openByCustBranch.keys());
  if (candidateCustomerIds.length === 0) return [];

  const scopeMap = await computeCustomerBranchScopeTx(db, {
    customerIds: candidateCustomerIds,
  });

  const creditByCustBranch = new Map<number, Map<number, Decimal>>();
  for (const scope of Array.from(scopeMap.values())) {
    if (!scope.totalCrossBranchCredit.gt(0)) continue;
    const byBranch = creditByCustBranch.get(scope.customerId) ?? new Map();
    byBranch.set(scope.branchId, scope.totalCrossBranchCredit);
    creditByCustBranch.set(scope.customerId, byBranch);
  }

  const out: AccountAnomalyItem[] = [];
  for (const [custId, sourceMap] of Array.from(creditByCustBranch.entries())) {
    const targetMap = openByCustBranch.get(custId);
    if (!targetMap) continue;
    const custName = customerNames.get(custId) ?? `العميل #${custId}`;
    for (const [sourceBranchId, sourceCredit] of Array.from(sourceMap.entries())) {
      if (!sourceCredit.gt("0.01")) continue;
      for (const [targetBranchId, targetInfo] of Array.from(targetMap.entries())) {
        if (sourceBranchId === targetBranchId) continue;
        if (
          filter.branchId != null &&
          filter.branchId !== sourceBranchId &&
          filter.branchId !== targetBranchId
        ) {
          continue;
        }
        const matchable = Decimal.min(sourceCredit, targetInfo.openAmount);
        if (!matchable.gt("0.01")) continue;
        const sourceBranchName = branchNames.get(sourceBranchId) ?? `الفرع ${sourceBranchId}`;
        out.push({
          id: `CROSS_BRANCH_CUSTOMER_CREDIT:${custId}:${sourceBranchId}:${targetBranchId}`,
          kind: "CROSS_BRANCH_CUSTOMER_CREDIT",
          severity: "warning",
          partyType: "CUSTOMER",
          partyId: custId,
          partyName: custName,
          branchId: targetBranchId,
          branchName: targetInfo.branchName,
          title: `رصيد دائن للعميل في ${sourceBranchName} وفاتورة مفتوحة في ${targetInfo.branchName}`,
          description: `يمتلك العميل ${custName} رصيداً دائناً (${toDbMoney(sourceCredit)} د.ع) في ${sourceBranchName} مقابل ذمة مفتوحة (${toDbMoney(targetInfo.openAmount)} د.ع) في ${targetInfo.branchName}`,
          recommendedAction: "RECONCILE_CROSS_BRANCH",
          targetHref: `/customers-statement?id=${custId}`,
          metrics: {
            expectedAmount: toDbMoney(targetInfo.openAmount),
            actualAmount: toDbMoney(sourceCredit),
            deltaAmount: toDbMoney(matchable),
            currency: "IQD",
          },
          metadata: {
            customerId: custId,
            sourceBranchId,
            sourceBranchName,
            targetBranchId,
            targetBranchName: targetInfo.branchName,
            invoiceId: targetInfo.invoiceIds[0] ?? null,
          },
        });
      }
    }
  }
  return out;
}

async function detectLedgerBalanceDrift(
  db: DB,
  filter: ScanAccountAnomaliesInput,
): Promise<AccountAnomalyItem[]> {
  const wantSuppliers =
    filter.partyType !== "CUSTOMER" &&
    filter.customerId == null &&
    filter.purchaseOrderId == null;
  const wantCustomers =
    filter.partyType !== "SUPPLIER" &&
    filter.supplierId == null &&
    filter.purchaseOrderId == null;

  const [supDrift, custDrift] = await Promise.all([
    wantSuppliers ? reconcileSupplierBalances() : Promise.resolve([]),
    wantCustomers ? reconcileCustomerBalances() : Promise.resolve([]),
  ]);

  const filteredSup = filter.supplierId != null
    ? supDrift.filter((r) => r.id === filter.supplierId)
    : supDrift;
  const filteredCust = filter.customerId != null
    ? custDrift.filter((r) => r.id === filter.customerId)
    : custDrift;

  const [supNames, custNames] = await Promise.all([
    filteredSup.length
      ? db
          .select({ id: suppliers.id, name: suppliers.name })
          .from(suppliers)
          .where(inArray(suppliers.id, filteredSup.map((r) => r.id)))
      : Promise.resolve([]),
    filteredCust.length
      ? db
          .select({ id: customers.id, name: customers.name })
          .from(customers)
          .where(inArray(customers.id, filteredCust.map((r) => r.id)))
      : Promise.resolve([]),
  ]);

  const supNameMap = new Map(supNames.map((s) => [Number(s.id), s.name]));
  const custNameMap = new Map(custNames.map((c) => [Number(c.id), c.name]));

  const out: AccountAnomalyItem[] = [];
  for (const r of filteredSup) {
    const name = supNameMap.get(r.id) ?? `المورد #${r.id}`;
    out.push({
      id: `LEDGER_BALANCE_DRIFT:SUPPLIER:${r.id}`,
      kind: "LEDGER_BALANCE_DRIFT",
      severity: "critical",
      partyType: "SUPPLIER",
      partyId: r.id,
      partyName: name,
      branchId: null,
      branchName: null,
      title: `انحراف مطابقة دفتر المورد ${name}`,
      description: `الرصيد المخزن (${r.actual} د.ع) يختلف عن المحسوب من الدفتر (${r.expected} د.ع) بفارق ${r.drift} د.ع`,
      recommendedAction: "RECONCILE_LEDGER",
      targetHref: `/suppliers-statement?id=${r.id}`,
      metrics: {
        expectedAmount: r.expected,
        actualAmount: r.actual,
        deltaAmount: r.drift,
        currency: "IQD",
      },
      metadata: {
        partyType: "SUPPLIER",
        partyId: r.id,
        expected: r.expected,
        actual: r.actual,
        drift: r.drift,
      },
    });
  }
  for (const r of filteredCust) {
    const name = custNameMap.get(r.id) ?? `العميل #${r.id}`;
    out.push({
      id: `LEDGER_BALANCE_DRIFT:CUSTOMER:${r.id}`,
      kind: "LEDGER_BALANCE_DRIFT",
      severity: "critical",
      partyType: "CUSTOMER",
      partyId: r.id,
      partyName: name,
      branchId: null,
      branchName: null,
      title: `انحراف مطابقة دفتر العميل ${name}`,
      description: `الرصيد المخزن (${r.actual} د.ع) يختلف عن المحسوب من الدفتر (${r.expected} د.ع) بفارق ${r.drift} د.ع`,
      recommendedAction: "RECONCILE_LEDGER",
      targetHref: `/customers-statement?id=${r.id}`,
      metrics: {
        expectedAmount: r.expected,
        actualAmount: r.actual,
        deltaAmount: r.drift,
        currency: "IQD",
      },
      metadata: {
        partyType: "CUSTOMER",
        partyId: r.id,
        expected: r.expected,
        actual: r.actual,
        drift: r.drift,
      },
    });
  }
  return out;
}

/**
 * ماسح الحالات المحاسبية الشاذة على حسابات الموردين والعملاء وأوامر الشراء:
 * 1) أسعار صرف الدولار الشاذة في أوامر الشراء
 * 2) انحراف عداد الدولار في بطاقة المورد
 * 3) سندات قبض الموردين غير المصنفة
 * 4) تعارض الرصيد الدائن مع فواتير مفتوحة بين الفروع للعملاء
 * 5) انحراف الرصيد المسجل عن قيود الدفتر
 */
export async function scanAccountAnomalies(
  filter: ScanAccountAnomaliesInput = {},
): Promise<ScanAccountAnomaliesResult> {
  const db = getDb();
  if (!db) {
    return { anomalies: [], summary: { total: 0, critical: 0, warning: 0 } };
  }

  const branchRows = await db.select({ id: branches.id, name: branches.name }).from(branches);
  const branchNames = new Map(branchRows.map((b) => [Number(b.id), b.name]));

  const [rates, usdDrift, unclassifiedRv, crossBranch, ledgerDrift] = await Promise.all([
    detectAnomalousUsdRates(db, filter, branchNames),
    detectSupplierUsdDrift(db, filter, branchNames),
    detectUnclassifiedSupplierReceipts(db, filter, branchNames),
    detectCrossBranchCustomerCredits(db, filter, branchNames),
    detectLedgerBalanceDrift(db, filter),
  ]);

  const anomalies = [...rates, ...usdDrift, ...unclassifiedRv, ...crossBranch, ...ledgerDrift].sort(
    (a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      const amtA = money(a.metrics.deltaAmount ?? a.metrics.actualAmount ?? "0").abs();
      const amtB = money(b.metrics.deltaAmount ?? b.metrics.actualAmount ?? "0").abs();
      return amtB.comparedTo(amtA);
    },
  );

  const critical = anomalies.filter((a) => a.severity === "critical").length;
  const warning = anomalies.filter((a) => a.severity === "warning").length;
  return {
    anomalies,
    summary: {
      total: anomalies.length,
      critical,
      warning,
    },
  };
}

/**
 * يحجب الأرقام والتفاصيل المالية عن الأدوار غير المرفوعة عند استدعاء فحص الشذوذ عبر مسارات القراءة.
 */
export function filterAnomaliesForRole(
  res: ScanAccountAnomaliesResult,
  role: string | null | undefined,
): ScanAccountAnomaliesResult {
  if (isElevated(role)) return res;
  return {
    ...res,
    anomalies: res.anomalies.map((item) => ({
      ...item,
      description: "توجد ملاحظة محاسبية تحتاج مراجعة الإدارة",
      metrics: { currency: item.metrics.currency },
      metadata: {},
    })),
  };
}

/**
 * مواءمة عداد الدولار للمورد ذرياً ليطابق مجموع التزامات الدولار المفتوحة فعلاً.
 */
export async function alignSupplierUsdBalance(
  input: { supplierId: number; note?: string; clientRequestId?: string },
  actor: Actor,
): Promise<AlignSupplierUsdResult> {
  return withTx(async (tx) => {
    if (!(await isVerifiedOwnerUser(tx, actor))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرح بمواءمة رصيد الدولار",
          why: "مواءمة عداد الدولار للمورد محصورة بحساب المالك الموثق",
          doThis: "اطلب من المالك اعتماد مواءمة رصيد الدولار",
        }),
      });
    }

    // القفل القانوني الموحد: purchaseOrders -> suppliers -> supplierInvoices (يمنع deadlock).
    await tx
      .select({ id: purchaseOrders.id })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.supplierId, input.supplierId),
          eq(purchaseOrders.agreedCurrency, "USD"),
          inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
        ),
      )
      .orderBy(asc(purchaseOrders.id))
      .for("share");

    const [sup] = await tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.id, input.supplierId))
      .for("update")
      .limit(1);
    if (!sup) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذرت مواءمة رصيد الدولار",
          why: "بطاقة المورد غير موجودة",
          doThis: "تحقق من معرف المورد وأعد المحاولة",
        }),
      });
    }

    const reqPayloadHash = input.clientRequestId
      ? idempotencyHash({ supplierId: input.supplierId, note: input.note ?? null })
      : null;
    if (input.clientRequestId) {
      const existing = await checkIdempotency(
        tx,
        "supplier.usdAlign",
        input.clientRequestId,
        reqPayloadHash,
        { forUpdate: true },
      );
      if (existing != null) {
        const snap = await findAuditNewValueByClientRequestId<Partial<AlignSupplierUsdResult>>(
          tx,
          {
            action: "supplier.usdAlign",
            entityType: "supplier",
            entityId: String(input.supplierId),
            clientRequestId: input.clientRequestId,
          },
        );
        const currentUsd = toDbMoney(money(sup.currentBalanceUsd ?? "0"));
        return {
          supplierId: input.supplierId,
          aligned: Boolean(snap?.aligned ?? false),
          usdBefore: snap?.usdBefore ?? currentUsd,
          usdAfter: snap?.usdAfter ?? currentUsd,
          deltaUsd: snap?.deltaUsd ?? "0.00",
          openInvoicesUsdTotal: snap?.openInvoicesUsdTotal ?? currentUsd,
          evidenceHash:
            snap?.evidenceHash ??
            sha256(
              stableCanonical({
                op: "supplier.usdAlign.replay",
                supplierId: input.supplierId,
                clientRequestId: input.clientRequestId,
              }),
            ),
        };
      }
    }

    const openUsd = await computeOpenSupplierUsdTotal(tx, input.supplierId, { lock: true });
    const usdBefore = round2(money(sup.currentBalanceUsd ?? "0"));
    const usdAfter = round2(openUsd);
    const deltaUsd = round2(usdAfter.minus(usdBefore));
    const aligned = !deltaUsd.isZero();

    if (aligned) {
      await adjustSupplierBalanceUsd(tx, input.supplierId, deltaUsd);
    }

    const evidenceHash = sha256(
      stableCanonical({
        op: "supplier.usdAlign",
        supplierId: input.supplierId,
        usdBefore: toDbMoney(usdBefore),
        usdAfter: toDbMoney(usdAfter),
        deltaUsd: toDbMoney(deltaUsd),
        openInvoicesUsdTotal: toDbMoney(openUsd),
        note: input.note?.trim() ?? null,
      }),
    );

    const res: AlignSupplierUsdResult = {
      supplierId: input.supplierId,
      aligned,
      usdBefore: toDbMoney(usdBefore),
      usdAfter: toDbMoney(usdAfter),
      deltaUsd: toDbMoney(deltaUsd),
      openInvoicesUsdTotal: toDbMoney(openUsd),
      evidenceHash,
    };

    await logAuditTx(tx, actor, {
      action: "supplier.usdAlign",
      entityType: "supplier",
      entityId: input.supplierId,
      oldValue: { currentBalanceUsd: toDbMoney(usdBefore) },
      newValue: { ...res, note: input.note?.trim() ?? null, clientRequestId: input.clientRequestId ?? null },
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(
        tx,
        "supplier.usdAlign",
        input.clientRequestId,
        input.supplierId,
        reqPayloadHash,
      );
    }

    return res;
  });
}

/**
 * إعادة تصنيف سند قبض مورد غير مصنف:
 * - CONFIRM_CREDIT_OBLIGATION: اعتماده كالتزام دائن علينا للمورد.
 * - REVERSE_RECEIPT: إلغاء السند وعكس أثره عبر مسار إلغاء السندات الرسمي.
 */
export async function reclassifySupplierReceipt(
  input: {
    receiptId: number;
    action: "CONFIRM_CREDIT_OBLIGATION" | "REVERSE_RECEIPT";
    reason?: string;
    clientRequestId?: string;
  },
  actor: Actor,
): Promise<ReclassifySupplierReceiptResult> {
  const reqPayloadHash = input.clientRequestId
    ? idempotencyHash({
        receiptId: input.receiptId,
        action: input.action,
        reason: input.reason ?? null,
      })
    : null;

  if (input.action === "REVERSE_RECEIPT") {
    const precheck = await withTx(async (tx) => {
      if (input.clientRequestId) {
        const existing = await checkIdempotency(
          tx,
          "supplier.rvPurpose",
          input.clientRequestId,
          reqPayloadHash,
          { forUpdate: true },
        );
        if (existing != null) {
          const snap =
            await findAuditNewValueByClientRequestId<Partial<ReclassifySupplierReceiptResult>>(tx, {
              action: "supplier.reclassifyReceipt",
              entityType: "receipt",
              entityId: String(input.receiptId),
              clientRequestId: input.clientRequestId,
            });
          return {
            replay: {
              receiptId: input.receiptId,
              action: "REVERSE_RECEIPT" as const,
              cancellationRequestId: snap?.cancellationRequestId ?? null,
              cancelledImmediately: Boolean(snap?.cancelledImmediately ?? false),
              evidenceHash:
                snap?.evidenceHash ??
                sha256(
                  stableCanonical({
                    op: "supplier.reclassifyReceipt.replay",
                    receiptId: input.receiptId,
                    action: "REVERSE_RECEIPT",
                    clientRequestId: input.clientRequestId,
                  }),
                ),
            },
            branchId: 0,
          };
        }
      }
      const [r] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, input.receiptId))
        .limit(1);
      if (!r || r.partyType !== "SUPPLIER" || r.direction !== "IN") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذر عكس السند",
            why: "المستند المحدد ليس سند قبض مورداً",
            doThis: "تحقق من رقم السند وأعد المحاولة",
          }),
        });
      }
      if (Number(r.createdBy) === actor.userId && !(await isVerifiedOwnerUser(tx, actor))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر عكس سند القبض",
            why: "لا يجوز لمنشئ السند اعتماد عكسه بنفسه بموجب فصل الصلاحيات",
            doThis: "اطلب من مستخدم مخول آخر أو المالك تنفيذ العكس",
          }),
        });
      }
      return { replay: null, branchId: Number(r.branchId) };
    });

    if (precheck.replay) return precheck.replay;

    const cancelRes = await cancelVoucher(input.receiptId, actor);
    const evidenceHash = sha256(
      stableCanonical({
        op: "supplier.reclassifyReceipt",
        receiptId: input.receiptId,
        action: "REVERSE_RECEIPT",
        status: cancelRes.status,
        approvalReceiptId: cancelRes.approvalReceiptId ?? null,
        reason: input.reason?.trim() ?? null,
      }),
    );

    const payload: ReclassifySupplierReceiptResult = {
      receiptId: input.receiptId,
      action: "REVERSE_RECEIPT",
      cancellationRequestId: cancelRes.approvalReceiptId ?? null,
      cancelledImmediately: cancelRes.status === "REVERSED",
      evidenceHash,
    };

    await withTx(async (tx) => {
      await logAuditTx(tx, actor, {
        action: "supplier.reclassifyReceipt",
        entityType: "receipt",
        entityId: input.receiptId,
        branchId: precheck.branchId,
        newValue: {
          ...payload,
          reason: input.reason?.trim() ?? null,
          clientRequestId: input.clientRequestId ?? null,
        },
      });
      if (input.clientRequestId) {
        const recorded = await checkIdempotency(
          tx,
          "supplier.rvPurpose",
          input.clientRequestId,
          reqPayloadHash,
          { forUpdate: true },
        );
        if (recorded == null) {
          await recordIdempotencyKey(
            tx,
            "supplier.rvPurpose",
            input.clientRequestId,
            input.receiptId,
            reqPayloadHash,
          );
        }
      }
    });

    return payload;
  }

  return withTx(async (tx) => {
    const [r] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, input.receiptId))
      .for("update")
      .limit(1);
    if (
      !r ||
      r.partyType !== "SUPPLIER" ||
      r.direction !== "IN" ||
      r.status !== "COMPLETED" ||
      r.approvalStatus !== "APPROVED"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر تصنيف السند",
          why: "المستند ليس سند قبض مورداً مكتمل الاعتماد",
          doThis: "راجع حالة السند في سجل السندات قبل التعديل",
        }),
      });
    }

    await assertBranchOwnership(tx, actor, r.branchId, "سند المورد");

    if (input.clientRequestId) {
      const existing = await checkIdempotency(
        tx,
        "supplier.rvPurpose",
        input.clientRequestId,
        reqPayloadHash,
        { forUpdate: true },
      );
      if (existing != null) {
        const evidenceHash = sha256(
          stableCanonical({
            op: "voucher.supplierReceiptPurpose",
            receiptId: input.receiptId,
            purpose: "CREDIT_OBLIGATION",
          }),
        );
        return {
          receiptId: input.receiptId,
          action: "CONFIRM_CREDIT_OBLIGATION",
          updatedPurpose: "CREDIT_OBLIGATION",
          evidenceHash,
        };
      }
    }

    if (Number(r.createdBy) === actor.userId && !(await isVerifiedOwnerUser(tx, actor))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر إعادة تصنيف سند القبض",
          why: "لا يجوز لمنشئ السند اعتماد تصنيفه كالتزام دائن بنفسه بموجب فصل الصلاحيات",
          doThis: "اطلب من مستخدم مخول آخر أو المالك اعتماد التصنيف",
        }),
      });
    }

    const existingLogs = await tx
      .select({ action: auditLogs.action, newValue: auditLogs.newValue })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "receipt"),
          eq(auditLogs.entityId, String(input.receiptId)),
          inArray(auditLogs.action, ["voucher.supplierReceiptPurpose", ADVANCE_REFUND_ACTION]),
        ),
      );
    const hasRefundTag = existingLogs.some((l) => {
      if (l.action === ADVANCE_REFUND_ACTION) return true;
      const val = l.newValue as { purpose?: string } | null;
      return val?.purpose === "ADVANCE_REFUND";
    });
    if (hasRefundTag) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر تغيير تصنيف السند",
          why: "السند موثق مسبقاً كاسترداد سلفة مورد",
          doThis: "استخدم خيار إلغاء السند بدلاً من تحويله إلى التزام دائن",
        }),
      });
    }

    const evidenceHash = sha256(
      stableCanonical({
        op: "voucher.supplierReceiptPurpose",
        receiptId: input.receiptId,
        supplierId: r.partyId,
        purpose: "CREDIT_OBLIGATION",
        amount: toDbMoney(money(r.amount)),
        reason: input.reason?.trim() ?? null,
      }),
    );

    await logAuditTx(tx, actor, {
      action: "voucher.supplierReceiptPurpose",
      entityType: "receipt",
      entityId: input.receiptId,
      branchId: r.branchId,
      newValue: {
        version: 1,
        purpose: "CREDIT_OBLIGATION",
        supplierId: Number(r.partyId),
        branchId: Number(r.branchId),
        reason: input.reason?.trim() ?? null,
        evidenceHash,
        clientRequestId: input.clientRequestId ?? null,
      },
    });
    await logAuditTx(tx, actor, {
      action: "supplier.reclassifyReceipt",
      entityType: "receipt",
      entityId: input.receiptId,
      branchId: r.branchId,
      newValue: {
        action: "CONFIRM_CREDIT_OBLIGATION",
        updatedPurpose: "CREDIT_OBLIGATION",
        reason: input.reason?.trim() ?? null,
        evidenceHash,
        clientRequestId: input.clientRequestId ?? null,
      },
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(
        tx,
        "supplier.rvPurpose",
        input.clientRequestId,
        input.receiptId,
        reqPayloadHash,
      );
    }

    return {
      receiptId: input.receiptId,
      action: "CONFIRM_CREDIT_OBLIGATION",
      updatedPurpose: "CREDIT_OBLIGATION",
      evidenceHash,
    };
  });
}

/**
 * تنفيذ مقاصة رصيد دائن للعميل بين فرعين ذرياً مع بصمة تدقيق وidempotency.
 */
export async function reconcileCustomerCrossBranch(
  input: {
    customerId: number;
    sourceBranchId: number;
    targetBranchId: number;
    invoiceId?: number;
    amount?: string;
    note?: string;
    clientRequestId?: string;
  },
  actor: Actor,
): Promise<ReconcileCustomerCrossBranchResult> {
  return withTx(async (tx) => {
    const reqHash = input.clientRequestId
      ? idempotencyHash({
          customerId: input.customerId,
          sourceBranchId: input.sourceBranchId,
          targetBranchId: input.targetBranchId,
          invoiceId: input.invoiceId ?? null,
          amount: input.amount ?? null,
          note: input.note ?? null,
        })
      : null;
    if (input.clientRequestId) {
      const existing = await checkIdempotency(
        tx,
        "cust.interbranch",
        input.clientRequestId,
        reqHash,
        { forUpdate: true },
      );
      if (existing != null) {
        const snap = await findAuditNewValueByClientRequestId<ReconcileCustomerCrossBranchResult>(
          tx,
          {
            action: "customer.interbranchReconcile",
            entityType: "customer",
            entityId: String(input.customerId),
            clientRequestId: input.clientRequestId,
          },
        );
        if (snap && snap.customerId === input.customerId) {
          return {
            customerId: snap.customerId,
            settledAmount: snap.settledAmount,
            invoiceId: snap.invoiceId,
            sourceBranchId: snap.sourceBranchId,
            targetBranchId: snap.targetBranchId,
            journalEntryId: snap.journalEntryId,
            journalNumber: snap.journalNumber,
            evidenceHash: snap.evidenceHash,
            balanceBefore: snap.balanceBefore,
            balanceAfter: snap.balanceAfter,
          };
        }
      }
    }

    const requestKey = input.clientRequestId ?? `ibc-${Date.now()}-${input.customerId}`;
    const res = await clearCustomerCreditInterbranchTx(
      tx,
      {
        customerId: input.customerId,
        sourceBranchId: input.sourceBranchId,
        targetBranchId: input.targetBranchId,
        invoiceId: input.invoiceId,
        amount: input.amount,
        requestKey,
        note: input.note,
      },
      actor,
    );

    let journalEntryId: number | null = res.entryOutId;
    if (res.entryOutId != null) {
      const [je] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(eq(journalEntries.entryId, res.entryOutId))
        .limit(1);
      if (je) journalEntryId = Number(je.id);
    }
    const journalNumber = res.entryOutId != null ? `IBC-${res.entryOutId}` : null;
    const evidenceHash = sha256(
      stableCanonical({
        op: "customer.interbranchReconcile",
        customerId: input.customerId,
        sourceBranchId: input.sourceBranchId,
        targetBranchId: input.targetBranchId,
        invoiceId: res.invoiceId,
        settledAmount: res.settledAmount,
        entryOutId: res.entryOutId,
        entryInId: res.entryInId,
      }),
    );

    const payload: ReconcileCustomerCrossBranchResult = {
      customerId: input.customerId,
      settledAmount: res.settledAmount,
      invoiceId: res.invoiceId,
      sourceBranchId: input.sourceBranchId,
      targetBranchId: input.targetBranchId,
      journalEntryId,
      journalNumber,
      evidenceHash,
      balanceBefore: res.balanceBefore,
      balanceAfter: res.balanceAfter,
    };

    await logAuditTx(tx, actor, {
      action: "customer.interbranchReconcile",
      entityType: "customer",
      entityId: input.customerId,
      branchId: input.targetBranchId,
      newValue: {
        ...payload,
        clientRequestId: input.clientRequestId ?? null,
      },
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(
        tx,
        "cust.interbranch",
        input.clientRequestId,
        res.entryOutId ?? input.customerId,
        reqHash,
      );
    }

    return payload;
  }, { isolationLevel: "read committed" });
}

import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  auditLogs,
  goodsReceiptItems,
  legacySupplierInvoiceSettlements,
  purchaseOrderItems,
  purchaseOrderControlRequests,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  purchaseReturnRequests,
  purchaseReturns,
  receipts,
  shifts,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
  supplierPayments,
  supplierPaymentRefunds,
  supplierPaymentRefundRequests,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import type { SupplierVoucherAllocation } from "@shared/supplierVoucherSettlement";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { enqueueFinancialRefresh } from "../../realtime/financialRefresh";
import { logAuditTx } from "../auditService";
import { baghdadToday } from "../businessDay";
import {
  computeDrawerCashBalance,
  computeTreasuryCashBalance,
} from "../cash/cashAvailability";
import {
  isSupplierApRecognitionSql,
  supplierApEffectSql,
} from "../ledger/supplierApEffect";
import { money, toDbMoney } from "../money";
import { withGovernanceTx, withTx, type Actor } from "../tx";
import { supplierVoucherRequestKey } from "../voucher/supplierPaymentLink";
import { sha256, stableCanonical } from "./grniAccounting";

const ACTION = "supplier.historicalSettlement.adopt";
const MAX_ROWS = 100_000;
const supplierEvidence = {
  id: suppliers.id,
  supplierKind: suppliers.supplierKind,
  currentBalance: suppliers.currentBalance,
  currentBalanceUsd: suppliers.currentBalanceUsd,
};
const receiptEvidence = {
  id: receipts.id,
  branchId: receipts.branchId,
  shiftId: receipts.shiftId,
  invoiceId: receipts.invoiceId,
  workOrderId: receipts.workOrderId,
  reservationId: receipts.reservationId,
  direction: receipts.direction,
  amount: receipts.amount,
  paymentMethod: receipts.paymentMethod,
  cashBucket: receipts.cashBucket,
  status: receipts.status,
  voucherNumber: receipts.voucherNumber,
  partyType: receipts.partyType,
  partyId: receipts.partyId,
  referenceNumber: receipts.referenceNumber,
  description: receipts.description,
  internalNote: receipts.internalNote,
  signatureHash: receipts.signatureHash,
  createdBy: receipts.createdBy,
  createdAt: receipts.createdAt,
  voucherDate: receipts.voucherDate,
  approvalStatus: receipts.approvalStatus,
  approvedBy: receipts.approvedBy,
  approvedAt: receipts.approvedAt,
  executedBy: receipts.executedBy,
  executedAt: receipts.executedAt,
};
type Invoice = typeof supplierInvoices.$inferSelect;
type Receipt = Pick<typeof receipts.$inferSelect, keyof typeof receiptEvidence>;
type Entry = typeof accountingEntries.$inferSelect;
type HistoricalPayment = {
  receiptId: number;
  entryId: number;
  amount: string;
  allocations: SupplierVoucherAllocation[];
};
export type HistoricalSupplierEpisode = {
  episodeId: string;
  evidenceHash: string;
  supplierId: number;
  branchId: number;
  total: string;
  entryIds: number[];
  invoiceIds: number[];
  receiptIds: number[];
  payments: HistoricalPayment[];
};
export type HistoricalSupplierPreviewInput = {
  supplierId?: number;
  branchId?: number;
  maxEntries?: number;
};
/** An explicit present-day documentary assignment, never proof of the original split. */
export type HistoricalReceiptAssignment = {
  version: 1;
  assignmentKey: string;
  supplierId: number;
  branchId: number;
  receiptId: number;
  assignmentDate: string;
  ownerStatement: string;
  allocations: SupplierVoucherAllocation[];
};
export type HistoricalSupplierPreview = {
  version: 1;
  episodes: HistoricalSupplierEpisode[];
  excluded: {
    episodeId: string;
    supplierId: number;
    branchId: number | null;
    entryIds: number[];
    reasons: string[];
  }[];
  reconciliations: {
    supplierId: number;
    currentBalance: string;
    ledgerBalance: string;
    matches: boolean;
  }[];
};
type AdoptionResult = {
  episodeId: string;
  evidenceHash: string;
  replayed: boolean;
  paymentIds: number[];
  requestIds: number[];
  assignment?: {
    input: HistoricalReceiptAssignment;
    inputHash: string;
    acceptedBy: number;
    acceptedAt: string;
  };
};
function checkedAssignment(input: HistoricalReceiptAssignment) {
  if (
    !input ||
    typeof input !== "object" ||
    input.version !== 1 ||
    typeof input.assignmentKey !== "string" ||
    !/^[A-Za-z0-9:_-]{8,100}$/.test(input.assignmentKey) ||
    ![input.supplierId, input.branchId, input.receiptId].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    typeof input.assignmentDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.assignmentDate) ||
    !Number.isFinite(Date.parse(input.assignmentDate)) ||
    new Date(input.assignmentDate).toISOString().slice(0, 10) !==
      input.assignmentDate ||
    input.assignmentDate > baghdadToday() ||
    typeof input.ownerStatement !== "string" ||
    input.ownerStatement.trim().length < 30 ||
    input.ownerStatement.length > 10000 ||
    !Array.isArray(input.allocations) ||
    !input.allocations.length ||
    input.allocations.length > 500 ||
    input.allocations.some((row) => !row || typeof row !== "object") ||
    new Set(input.allocations.map((row) => row.supplierInvoiceId)).size !==
      input.allocations.length
  )
    fail("خطة التخصيص الصريحة أو إقرار المالك غير صالح", "BAD_REQUEST");
  for (const row of input.allocations)
    if (
      ![row.supplierInvoiceId, row.invoiceVersion].every(
        (id) => Number.isSafeInteger(id) && id > 0,
      ) ||
      typeof row.amount !== "string" ||
      !/^\d{1,13}(\.\d{1,2})?$/.test(row.amount) ||
      !money(row.amount).gt(0)
    )
      fail("مبلغ أو إصدار تخصيص غير صالح", "BAD_REQUEST");
  return {
    ...input,
    ownerStatement: input.ownerStatement.trim(),
    allocations: input.allocations
      .map((row) => ({ ...row, amount: toDbMoney(row.amount) }))
      .sort((a, b) => a.supplierInvoiceId - b.supplierInvoiceId),
  };
}
const assignmentEpisodeId = (input: HistoricalReceiptAssignment) =>
  `HSA:${input.supplierId.toString(36)}:${input.branchId.toString(36)}:${fingerprint(["OWNER_FULL_RECEIPT_ASSIGNMENT", input.assignmentKey]).slice(0, 22)}`;
type Context = {
  episode: HistoricalSupplierEpisode;
  invoices: Invoice[];
  sourceReceipts: Receipt[];
  sourceEntries: Entry[];
  poIds: number[];
  invoicePoMap: Map<number, Set<number>>;
};

// stableCanonical deliberately has no Date handling. Normalize SQL dates before any fingerprint.
const canonical = (value: unknown) =>
  stableCanonical(JSON.parse(JSON.stringify(value)));
const fingerprint = (value: unknown) => sha256(canonical(value));
function fail(
  why: string,
  code: "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN" = "CONFLICT",
): never {
  throw new TRPCError({
    code,
    message: appErrorMessage({
      what: "تعذر اعتماد دليل تسوية المورد التاريخي",
      why,
      doThis:
        "أعد المعاينة وراجع مصادر الدليل دون تعديل الإيصالات أو القيود الأصلية",
    }),
  });
}
function bounded<T>(rows: T[], limit: number, name: string): T[] {
  if (rows.length > limit)
    fail(
      `تجاوز نطاق ${name} حد المعاينة الآمن؛ ضيّق المورد أو حد البيانات`,
      "BAD_REQUEST",
    );
  return rows;
}
function assertInput(input: HistoricalSupplierPreviewInput) {
  for (const id of [input.supplierId, input.branchId])
    if (id != null && (!Number.isSafeInteger(id) || id <= 0))
      fail("معرّف النطاق غير صالح", "BAD_REQUEST");
  const limit = input.maxEntries ?? 20_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS)
    fail("حد المعاينة غير صالح", "BAD_REQUEST");
  return limit;
}

/** A transaction-level snapshot: no gate bootstrap, row locks, cache correction, or writes. */
async function scan(
  tx: Tx,
  input: HistoricalSupplierPreviewInput,
  assignment?: HistoricalReceiptAssignment,
) {
  const limit = assertInput(input);
  const supplierRows = bounded(
    await tx
      .select(supplierEvidence)
      .from(suppliers)
      .where(
        and(
          eq(suppliers.supplierKind, "REGULAR"),
          input.supplierId == null
            ? undefined
            : eq(suppliers.id, input.supplierId),
        ),
      )
      .orderBy(asc(suppliers.id))
      .limit(501),
    500,
    "الموردين",
  );
  const report: HistoricalSupplierPreview = {
    version: 1,
    episodes: [],
    excluded: [],
    reconciliations: [],
  };
  const contexts = new Map<string, Context>();
  if (!supplierRows.length) return { report, contexts };
  const supplierIds = supplierRows.map((row) => row.id);
  const cols = {
    entryType: accountingEntries.entryType,
    amount: accountingEntries.amount,
    liabilityAccount: accountingEntries.purchaseLiabilityAccount,
    dedupeKey: accountingEntries.dedupeKey,
  };
  // Always load every branch for the selected suppliers: supplier.currentBalance is company-wide.
  const ledger = bounded(
    await tx
      .select({
        row: accountingEntries,
        effect: sql<string>`${supplierApEffectSql(cols)}`,
        recognition: sql<number>`${isSupplierApRecognitionSql(cols)}`,
      })
      .from(accountingEntries)
      .where(inArray(accountingEntries.supplierId, supplierIds))
      .orderBy(asc(accountingEntries.id))
      .limit(limit + 1),
    limit,
    "قيود الموردين",
  );
  const invoices = bounded(
    await tx
      .select()
      .from(supplierInvoices)
      .where(inArray(supplierInvoices.supplierId, supplierIds))
      .orderBy(asc(supplierInvoices.id))
      .limit(limit + 1),
    limit,
    "الفواتير",
  );
  const invoiceIds = invoices.map((row) => row.id);
  const receiptIds = Array.from(
    new Set(
      ledger.flatMap(({ row }) =>
        row.receiptId == null ? [] : [row.receiptId],
      ),
    ),
  );
  const sourceReceipts = receiptIds.length
    ? bounded(
        await tx
          .select(receiptEvidence)
          .from(receipts)
          .where(inArray(receipts.id, receiptIds))
          .limit(limit + 1),
        limit,
        "الإيصالات",
      )
    : [];
  const receiptEntries = receiptIds.length
    ? bounded(
        await tx
          .select()
          .from(accountingEntries)
          .where(inArray(accountingEntries.receiptId, receiptIds))
          .limit(limit + 1),
        limit,
        "قيود مصادر الدفع",
      )
    : [];
  const cancellations = receiptIds.length
    ? bounded(
        await tx
          .select(receiptEvidence)
          .from(receipts)
          .where(
            inArray(
              receipts.referenceNumber,
              receiptIds.map((id) => `CANCEL-VCH-${id}`),
            ),
          )
          .limit(limit + 1),
        limit,
        "طلبات الإلغاء",
      )
    : [];
  const requests = receiptIds.length
    ? bounded(
        await tx
          .select()
          .from(supplierPaymentRequests)
          .where(
            inArray(
              supplierPaymentRequests.requestKey,
              receiptIds.map(supplierVoucherRequestKey),
            ),
          )
          .limit(limit + 1),
        limit,
        "روابط السداد",
      )
    : [];
  const claimedPayments = receiptIds.length
    ? bounded(
        await tx
          .select()
          .from(supplierPayments)
          .where(
            or(
              inArray(supplierPayments.receiptId, receiptIds),
              inArray(
                supplierPayments.accountingEntryId,
                ledger.map((row) => row.row.id),
              ),
            ),
          )
          .limit(limit + 1),
        limit,
        "الدفعات المسندة",
      )
    : [];
  const netAllocations = invoiceIds.length
    ? await tx
        .select({
          invoiceId: supplierPaymentAllocations.supplierInvoiceId,
          amount: sql<string>`SUM(${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount})`,
          currencyAmount: sql<string>`SUM(${supplierPaymentAllocations.allocatedCurrencyAmount} - ${supplierPaymentAllocations.refundedCurrencyAmount})`,
        })
        .from(supplierPaymentAllocations)
        .where(
          inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds),
        )
        .groupBy(supplierPaymentAllocations.supplierInvoiceId)
    : [];
  const claimedIds = claimedPayments.map((row) => row.id);
  const knownAllocations = claimedIds.length
    ? bounded(
        await tx
          .select()
          .from(supplierPaymentAllocations)
          .where(
            or(
              inArray(supplierPaymentAllocations.supplierPaymentId, claimedIds),
              inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds),
            ),
          )
          .limit(limit + 1),
        limit,
        "دليل التخصيص الأصلي",
      )
    : [];
  const knownRequests = claimedIds.length
    ? bounded(
        await tx
          .select()
          .from(supplierPaymentRequests)
          .where(
            inArray(
              supplierPaymentRequests.id,
              claimedPayments.map((row) => row.requestId),
            ),
          )
          .limit(limit + 1),
        limit,
        "طلبات الدفع الأصلي",
      )
    : [];
  const knownRefunds = claimedIds.length
    ? bounded(
        await tx
          .select()
          .from(supplierPaymentRefunds)
          .where(inArray(supplierPaymentRefunds.supplierPaymentId, claimedIds))
          .limit(limit + 1),
        limit,
        "استردادات الدفع الأصلي",
      )
    : [];
  const pendingKnownRefunds = claimedIds.length
    ? bounded(
        await tx
          .select()
          .from(supplierPaymentRefundRequests)
          .where(
            and(
              inArray(
                supplierPaymentRefundRequests.supplierPaymentId,
                claimedIds,
              ),
              eq(supplierPaymentRefundRequests.status, "PENDING"),
            ),
          )
          .limit(limit + 1),
        limit,
        "طلبات استرداد الدفع الأصلي",
      )
    : [];
  const reservations = invoiceIds.length
    ? bounded(
        await tx
          .select({
            row: supplierPaymentRequestAllocations,
            status: supplierPaymentRequests.status,
          })
          .from(supplierPaymentRequestAllocations)
          .innerJoin(
            supplierPaymentRequests,
            eq(
              supplierPaymentRequests.id,
              supplierPaymentRequestAllocations.requestId,
            ),
          )
          .where(
            or(
              inArray(
                supplierPaymentRequestAllocations.supplierInvoiceId,
                invoiceIds,
              ),
              inArray(
                supplierPaymentRequestAllocations.requestId,
                claimedPayments.map((row) => row.requestId),
              ),
            ),
          )
          .limit(limit + 1),
        limit,
        "حجوزات الفواتير",
      )
    : [];
  const returns = invoiceIds.length
    ? await tx
        .select({
          id: purchaseReturns.id,
          invoiceId: purchaseReturns.supplierInvoiceId,
          poId: purchaseReturns.purchaseOrderId,
        })
        .from(purchaseReturns)
        .where(inArray(purchaseReturns.supplierId, supplierIds))
        .limit(limit + 1)
    : [];
  bounded(returns, limit, "مرتجعات الفواتير");
  const returnRequests = invoiceIds.length
    ? await tx
        .select({
          id: purchaseReturnRequests.id,
          invoiceId: purchaseReturnRequests.supplierInvoiceId,
          poId: purchaseReturnRequests.purchaseOrderId,
        })
        .from(purchaseReturnRequests)
        .where(
          and(
            inArray(purchaseReturnRequests.supplierId, supplierIds),
            eq(purchaseReturnRequests.status, "PENDING"),
          ),
        )
        .limit(limit + 1)
    : [];
  bounded(returnRequests, limit, "طلبات المرتجع");
  const invoicePoMap = new Map<number, Set<number>>(
    invoices.map((row) => [
      row.id,
      new Set(
        row.legacyPurchaseOrderId == null ? [] : [row.legacyPurchaseOrderId],
      ),
    ]),
  );
  const link = (invoiceId: number, poId: number | null) => {
    if (poId != null) invoicePoMap.get(invoiceId)?.add(poId);
  };
  for (const invoice of invoices)
    link(
      invoice.id,
      ledger.find(({ row }) => row.id === invoice.postingEntryId)?.row
        .purchaseOrderId ?? null,
    );
  if (invoiceIds.length) {
    const declared = bounded(
      await tx
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
        .where(inArray(supplierInvoiceLines.supplierInvoiceId, invoiceIds))
        .limit(limit + 1),
      limit,
      "روابط الفواتير المعلنة",
    );
    const matched = bounded(
      await tx
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
        .where(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, invoiceIds))
        .limit(limit + 1),
      limit,
      "روابط المطابقة",
    );
    for (const row of [...declared, ...matched]) link(row.invoiceId, row.poId);
  }
  const poIds = Array.from(
    new Set(
      Array.from(invoicePoMap.values()).flatMap((ids) => Array.from(ids)),
    ),
  );
  const orders = poIds.length
    ? bounded(
        await tx
          .select()
          .from(purchaseOrders)
          .where(inArray(purchaseOrders.id, poIds))
          .orderBy(asc(purchaseOrders.id))
          .limit(limit + 1),
        limit,
        "أوامر الشراء",
      )
    : [];
  const pendingControls = poIds.length
    ? await tx
        .select()
        .from(purchaseOrderControlRequests)
        .where(
          and(
            inArray(purchaseOrderControlRequests.purchaseOrderId, poIds),
            eq(purchaseOrderControlRequests.status, "PENDING"),
          ),
        )
        .limit(limit + 1)
    : [];
  bounded(pendingControls, limit, "طلبات تغيير أوامر الشراء");
  const shiftIds = Array.from(
    new Set(
      sourceReceipts.flatMap((row) =>
        row.shiftId == null ? [] : [row.shiftId],
      ),
    ),
  );
  const sourceShifts = shiftIds.length
    ? await tx
        .select()
        .from(shifts)
        .where(inArray(shifts.id, shiftIds))
        .orderBy(asc(shifts.id))
        .limit(limit + 1)
    : [];
  bounded(sourceShifts, limit, "الأدراج الأصلية");
  const legacySourceClaims = receiptIds.length
    ? bounded(
        await tx
          .select()
          .from(legacySupplierInvoiceSettlements)
          .where(
            or(
              inArray(
                legacySupplierInvoiceSettlements.sourceReceiptId,
                receiptIds,
              ),
              inArray(
                legacySupplierInvoiceSettlements.sourceAccountingEntryId,
                receiptEntries.map((row) => row.id),
              ),
            ),
          )
          .limit(limit + 1),
        limit,
        "روابط الدفع الإرثية",
      )
    : [];
  for (const supplier of supplierRows) {
    const ledgerBalance = ledger
      .filter(({ row }) => row.supplierId === supplier.id)
      .reduce((sum, row) => sum.plus(row.effect), money(0));
    report.reconciliations.push({
      supplierId: supplier.id,
      currentBalance: toDbMoney(supplier.currentBalance),
      ledgerBalance: toDbMoney(ledgerBalance),
      matches: ledgerBalance.eq(supplier.currentBalance),
    });
  }

  const branches = new Map<string, typeof ledger>();
  let assignmentRows = ledger;
  if (assignment) {
    const source = ledger.filter(
      ({ row }) => row.receiptId === assignment.receiptId,
    );
    const targets = assignment.allocations.map((allocation) =>
      invoices.find((invoice) => invoice.id === allocation.supplierInvoiceId),
    );
    if (
      source.length !== 1 ||
      targets.some((invoice) => !invoice?.postingEntryId)
    )
      fail("مصدر الدفعة أو قيد الاعتراف المستهدف غير محدد");
    const postingIds = targets.map((invoice) => invoice!.postingEntryId!);
    if (new Set(postingIds).size !== postingIds.length)
      fail("قيود الاعتراف في خطة التخصيص غير مستقلة");
    assignmentRows = ledger.filter(
      ({ row }) => row.id === source[0].row.id || postingIds.includes(row.id),
    );
    if (assignmentRows.length !== postingIds.length + 1)
      fail("دليل قيد الاعتراف المستهدف مفقود");
  }
  for (const entry of assignmentRows) {
    if (
      money(entry.effect).isZero() ||
      (input.branchId != null && entry.row.branchId !== input.branchId)
    )
      continue;
    const key = `${entry.row.supplierId}:${entry.row.branchId}`;
    const rows = branches.get(key) ?? [];
    rows.push(entry);
    branches.set(key, rows);
  }
  for (const rows of Array.from(branches.values())) {
    let balance = money(0);
    let episodeRows: typeof ledger = [];
    let negative = false;
    const finish = (closed: boolean) => {
      if (!episodeRows.length) return;
      const supplierId = episodeRows[0].row.supplierId!;
      const branchId = episodeRows[0].row.branchId;
      const episodeId = assignment
        ? assignmentEpisodeId(assignment)
        : `HSA:${supplierId.toString(36)}:${(branchId ?? 0).toString(36)}:${fingerprint([episodeRows[0].row.id, episodeRows.at(-1)!.row.id]).slice(0, 22)}`;
      const reasons = new Set<string>();
      if (!closed && !assignment) reasons.add("OPEN_EPISODE");
      if (negative) reasons.add("NEGATIVE_AP_OR_PREPAYMENT");
      if (branchId == null) reasons.add("UNKNOWN_BRANCH");
      if (
        !report.reconciliations.find((row) => row.supplierId === supplierId)
          ?.matches
      )
        reasons.add("SUPPLIER_AP_LEDGER_MISMATCH");
      const episodeInvoices: Invoice[] = [];
      const paymentPlans: HistoricalPayment[] = [];
      const episodeReceipts: Receipt[] = [];
      const available = new Map<number, ReturnType<typeof money>>();
      // Remove only complete, independently evidenced native pairs. Partial
      // settlements, cross-episode allocations, refunds and unknown sources
      // remain in the ordinary rejection path below.
      const removedIds = new Set<number>();
      const removedInvoiceIds = new Set<number>();
      const removedProof: unknown[] = [];
      if (closed && !negative && branchId != null) {
        for (const payment of claimedPayments) {
          const paymentRow = episodeRows.find(
            ({ row }) => row.id === payment.accountingEntryId,
          );
          const receipt = sourceReceipts.find(
            (row) => row.id === payment.receiptId,
          );
          const request = knownRequests.find(
            (row) => row.id === payment.requestId,
          );
          const allocations = knownAllocations.filter(
            (row) => row.supplierPaymentId === payment.id,
          );
          const shift = sourceShifts.find((row) => row.id === receipt?.shiftId);
          if (
            !paymentRow ||
            !receipt ||
            !request ||
            !allocations.length ||
            payment.status !== "POSTED" ||
            payment.currency !== "IQD" ||
            payment.exchangeRate != null ||
            payment.supplierId !== supplierId ||
            payment.branchId !== branchId ||
            paymentRow.row.entryType !== "PAYMENT_OUT" ||
            paymentRow.row.receiptId !== receipt.id ||
            !money(paymentRow.effect).eq(money(payment.amount).neg()) ||
            !money(paymentRow.row.amount).eq(payment.amount) ||
            !money(payment.currencyAmount).eq(payment.amount) ||
            receipt.direction !== "OUT" ||
            receipt.status !== "COMPLETED" ||
            receipt.approvalStatus !== "APPROVED" ||
            receipt.partyType !== "SUPPLIER" ||
            receipt.partyId !== supplierId ||
            receipt.branchId !== branchId ||
            receipt.createdBy == null ||
            receipt.invoiceId != null ||
            receipt.workOrderId != null ||
            receipt.reservationId != null ||
            receipt.paymentMethod !== payment.paymentMethod ||
            !money(receipt.amount).eq(payment.amount) ||
            receiptEntries.filter((row) => row.receiptId === receipt.id)
              .length !== 1 ||
            request.status !== "APPROVED" ||
            request.supplierId !== supplierId ||
            request.branchId !== branchId ||
            request.currency !== "IQD" ||
            request.exchangeRate != null ||
            request.paymentMethod !== payment.paymentMethod ||
            request.externalReference !== payment.externalReference ||
            request.requestedBy !== receipt.createdBy ||
            request.reviewedBy !== payment.postedBy ||
            receipt.approvedBy !== payment.postedBy ||
            request.appliedAt == null ||
            request.payloadCanonical !== payment.payloadCanonical ||
            request.payloadHash !== payment.payloadHash ||
            sha256(request.payloadCanonical) !== request.payloadHash ||
            reservations.filter(({ row }) => row.requestId === request.id)
              .length !== allocations.length ||
            claimedPayments.filter(
              (row) =>
                row.receiptId === receipt.id ||
                row.accountingEntryId === paymentRow.row.id,
            ).length !== 1 ||
            !money(request.requestedAmount).eq(payment.amount) ||
            !money(request.requestedCurrencyAmount).eq(payment.amount) ||
            knownRefunds.some((row) => row.supplierPaymentId === payment.id) ||
            legacySourceClaims.some(
              (row) =>
                row.sourceReceiptId === receipt.id ||
                row.sourceAccountingEntryId === paymentRow.row.id,
            ) ||
            pendingKnownRefunds.some(
              (row) => row.supplierPaymentId === payment.id,
            ) ||
            cancellations.some(
              (row) =>
                row.referenceNumber === `CANCEL-VCH-${receipt.id}` &&
                ["PENDING", "COMPLETED"].includes(row.status) &&
                row.approvalStatus !== "REJECTED",
            ) ||
            (receipt.paymentMethod === "CASH" &&
              !(
                (receipt.cashBucket === "TREASURY" &&
                  receipt.shiftId == null) ||
                (receipt.cashBucket === "DRAWER" &&
                  shift?.branchId === branchId &&
                  shift.userId === receipt.createdBy)
              )) ||
            !allocations
              .reduce((sum, row) => sum.plus(row.allocatedAmount), money(0))
              .eq(payment.amount)
          )
            continue;
          const pairs = allocations.map((allocation) => {
            const invoice = invoices.find(
              (row) => row.id === allocation.supplierInvoiceId,
            );
            const recognition = episodeRows.find(
              ({ row }) => row.id === invoice?.postingEntryId,
            );
            const requestAllocation = reservations.find(
              ({ row }) => row.id === allocation.requestAllocationId,
            );
            const poLinks = invoicePoMap.get(allocation.supplierInvoiceId);
            const order =
              poLinks?.size === 1
                ? orders.find((row) => poLinks.has(row.id))
                : undefined;
            return {
              allocation,
              invoice,
              recognition,
              requestAllocation,
              poLinks: poLinks ? Array.from(poLinks) : [],
              order,
            };
          });
          if (
            pairs.some(
              ({
                allocation,
                invoice,
                recognition,
                requestAllocation,
                poLinks,
                order,
              }) =>
                !invoice ||
                !recognition ||
                !requestAllocation ||
                !order ||
                poLinks.length !== 1 ||
                invoice.origin !== "NATIVE" ||
                invoice.liabilityClass !== "NATIVE_AP" ||
                invoice.status !== "POSTED" ||
                invoice.paymentGate !== "SETTLED" ||
                invoice.currency !== "IQD" ||
                invoice.supplierId !== supplierId ||
                invoice.branchId !== branchId ||
                order.supplierId !== supplierId ||
                order.branchId !== branchId ||
                order.agreedCurrency !== "IQD" ||
                order.status === "CANCELLED" ||
                pendingControls.some(
                  (row) => row.purchaseOrderId === order.id,
                ) ||
                recognition.recognition !== 1 ||
                recognition.row.id >= paymentRow.row.id ||
                !money(recognition.effect).eq(invoice.totalAmount) ||
                !money(allocation.allocatedAmount).eq(invoice.totalAmount) ||
                !money(allocation.allocatedCurrencyAmount).eq(
                  allocation.allocatedAmount,
                ) ||
                !money(allocation.refundedAmount).isZero() ||
                !money(allocation.refundedCurrencyAmount).isZero() ||
                !money(invoice.legacySettledAmount).isZero() ||
                knownAllocations.filter(
                  (row) => row.supplierInvoiceId === invoice.id,
                ).length !== 1 ||
                requestAllocation.status !== "APPROVED" ||
                requestAllocation.row.requestId !== request.id ||
                requestAllocation.row.supplierInvoiceId !== invoice.id ||
                requestAllocation.row.activeInvoiceGuard != null ||
                requestAllocation.row.invoiceHash !== allocation.invoiceHash ||
                sha256(requestAllocation.row.invoiceSnapshot) !==
                  requestAllocation.row.invoiceHash ||
                !money(requestAllocation.row.requestedAmount).eq(
                  allocation.allocatedAmount,
                ) ||
                !money(requestAllocation.row.requestedCurrencyAmount).eq(
                  allocation.allocatedCurrencyAmount,
                ) ||
                reservations.some(
                  ({ row, status }) =>
                    row.supplierInvoiceId === invoice.id &&
                    (row.activeInvoiceGuard != null || status === "PENDING"),
                ) ||
                // Never remove a known invoice sharing a PO with residual recognition.
                episodeRows.some(
                  ({ row, recognition: isRecognition }) =>
                    isRecognition === 1 &&
                    row.id !== recognition.row.id &&
                    invoices.some(
                      (other) =>
                        other.postingEntryId === row.id &&
                        invoicePoMap.get(other.id)?.has(order.id),
                    ),
                ),
            )
          )
            continue;
          removedIds.add(paymentRow.row.id);
          for (const pair of pairs) {
            removedIds.add(pair.recognition!.row.id);
            removedInvoiceIds.add(pair.invoice!.id);
          }
          removedProof.push({
            payment,
            receipt,
            request,
            pairs,
            shift: shift ?? null,
          });
        }
      }
      const residualRows = episodeRows.filter(
        ({ row }) => !removedIds.has(row.id),
      );
      // Removing complete pairs must preserve the closed episode equation.
      if (
        removedIds.size &&
        !episodeRows
          .filter(({ row }) => removedIds.has(row.id))
          .reduce((sum, row) => sum.plus(row.effect), money(0))
          .isZero()
      )
        reasons.add("KNOWN_NATIVE_PAIRS_DO_NOT_CANCEL");
      for (const { row: entry, effect, recognition } of residualRows) {
        if (
          money(effect).gt(0) &&
          recognition === 1 &&
          money(entry.amount).gt(0)
        ) {
          const candidates = invoices.filter(
            (invoice) =>
              invoice.postingEntryId === entry.id ||
              (invoice.origin === "LEGACY" &&
                invoice.postingEntryId == null &&
                entry.purchaseOrderId != null &&
                invoicePoMap.get(invoice.id)?.has(entry.purchaseOrderId) &&
                money(invoice.totalAmount).eq(effect)),
          );
          if (candidates.length !== 1) {
            reasons.add("AMBIGUOUS_OR_MISSING_POSTED_INVOICE");
            continue;
          }
          const invoice = candidates[0];
          const invoicePos = invoicePoMap.get(invoice.id)!;
          if (episodeInvoices.some((row) => row.id === invoice.id)) {
            reasons.add("DUPLICATE_INVOICE_RECOGNITION");
            continue;
          }
          episodeInvoices.push(invoice);
          available.set(invoice.id, money(invoice.totalAmount));
          if (assignment) {
            const selected = assignment.allocations.find(
              (row) => row.supplierInvoiceId === invoice.id,
            );
            const source = episodeRows.find(
              ({ row }) => row.receiptId === assignment.receiptId,
            )?.row;
            if (
              !selected ||
              selected.invoiceVersion !== invoice.version ||
              invoice.origin !== "NATIVE" ||
              invoice.liabilityClass !== "NATIVE_AP" ||
              !source ||
              entry.id >= source.id ||
              entry.createdAt > source.createdAt ||
              entry.entryDate > source.entryDate ||
              invoice.invoiceDate >
                source.entryDate.toISOString().slice(0, 10) ||
              money(selected.amount).gt(invoice.totalAmount)
            )
              reasons.add("ASSIGNMENT_INVOICE_EVIDENCE_MISMATCH");
          }
          if (
            invoice.supplierId !== supplierId ||
            invoice.branchId !== branchId ||
            invoice.status !== "POSTED" ||
            invoice.paymentGate !== "OPEN" ||
            !["NATIVE_AP", "LEGACY_AP"].includes(invoice.liabilityClass)
          )
            reasons.add("INVOICE_NOT_ELIGIBLE_AP");
          if (
            invoice.liabilityClass === "LEGACY_AP" &&
            !invoice.legacySettlementEvidenceHash
          )
            reasons.add("MISSING_LEGACY_CLASSIFICATION_EVIDENCE");
          if (invoice.currency !== "IQD") reasons.add("UNSUPPORTED_CURRENCY");
          if (
            !money(invoice.totalAmount).eq(effect) ||
            !money(invoice.totalAmount).gt(0)
          )
            reasons.add("INVOICE_POSTING_AMOUNT_MISMATCH");
          if (!money(invoice.legacySettledAmount).isZero())
            reasons.add("EXISTING_LEGACY_SETTLEMENT");
          if (
            invoicePos.size !== 1 ||
            (entry.purchaseOrderId != null &&
              !invoicePos.has(entry.purchaseOrderId))
          )
            reasons.add("AMBIGUOUS_INVOICE_PO_LINK");
          for (const poId of Array.from(invoicePos)) {
            const order = orders.find((row) => row.id === poId);
            if (
              !order ||
              order.supplierId !== supplierId ||
              order.branchId !== branchId ||
              order.agreedCurrency === "USD" ||
              order.status === "CANCELLED"
            )
              reasons.add("PO_SOURCE_MISMATCH");
            if (pendingControls.some((row) => row.purchaseOrderId === poId))
              reasons.add("PENDING_PO_CONTROL");
            if (
              invoices.some(
                (other) =>
                  invoicePoMap.get(other.id)?.has(poId) &&
                  invoicePoMap.get(other.id)!.size !== 1,
              )
            )
              reasons.add("AMBIGUOUS_PO_CACHE_BASIS");
          }
          const net = netAllocations.find(
            (row) => row.invoiceId === invoice.id,
          );
          if (assignment && net)
            reasons.add("ASSIGNMENT_REQUIRES_UNALLOCATED_INVOICE");
          if (
            net &&
            (!money(net.amount).isZero() || !money(net.currencyAmount).isZero())
          )
            reasons.add("EXISTING_NET_ALLOCATION");
          if (
            reservations.some(
              (row) =>
                row.row.supplierInvoiceId === invoice.id &&
                (row.row.activeInvoiceGuard != null ||
                  row.status === "PENDING"),
            )
          )
            reasons.add("ACTIVE_INVOICE_RESERVATION");
          if (
            returns.some(
              (row) => row.invoiceId === invoice.id || invoicePos.has(row.poId),
            ) ||
            returnRequests.some(
              (row) => row.invoiceId === invoice.id || invoicePos.has(row.poId),
            )
          )
            reasons.add("RETURN_OR_RETURN_REQUEST");
        } else if (
          entry.entryType === "PAYMENT_OUT" &&
          money(entry.amount).gt(0) &&
          money(effect).eq(money(entry.amount).neg())
        ) {
          const receipt = sourceReceipts.find(
            (row) => row.id === entry.receiptId,
          );
          if (!receipt) {
            reasons.add("MISSING_PAYMENT_RECEIPT");
            continue;
          }
          episodeReceipts.push(receipt);
          if (
            receipt.direction !== "OUT" ||
            receipt.status !== "COMPLETED" ||
            receipt.approvalStatus !== "APPROVED" ||
            receipt.partyType !== "SUPPLIER" ||
            receipt.partyId !== supplierId ||
            receipt.branchId !== branchId ||
            receipt.createdBy == null ||
            receipt.invoiceId != null ||
            receipt.workOrderId != null ||
            receipt.reservationId != null ||
            !money(receipt.amount).eq(entry.amount)
          )
            reasons.add("RECEIPT_SOURCE_MISMATCH");
          if (
            assignment &&
            (receipt.id !== assignment.receiptId ||
              receipt.paymentMethod !== "CASH" ||
              receipt.cashBucket !== "TREASURY" ||
              receipt.shiftId != null ||
              receipt.approvedBy == null ||
              receipt.approvedAt == null ||
              assignment.supplierId !== supplierId ||
              assignment.branchId !== branchId ||
              !assignment.allocations
                .reduce((sum, row) => sum.plus(row.amount), money(0))
                .eq(entry.amount))
          )
            reasons.add("ASSIGNMENT_FULL_TREASURY_RECEIPT_REQUIRED");
          if (
            !["CASH", "CARD", "TRANSFER", "WALLET"].includes(
              receipt.paymentMethod,
            )
          )
            reasons.add("UNSUPPORTED_PAYMENT_METHOD");
          if (
            receipt.paymentMethod !== "CASH" &&
            !receipt.referenceNumber?.trim()
          )
            reasons.add("MISSING_NONCASH_REFERENCE");
          if (
            receiptEntries.filter((row) => row.receiptId === receipt.id)
              .length !== 1
          )
            reasons.add("AMBIGUOUS_RECEIPT_LEDGER_SOURCE");
          if (
            claimedPayments.some(
              (row) =>
                row.receiptId === receipt.id ||
                row.accountingEntryId === entry.id,
            ) ||
            legacySourceClaims.some(
              (row) =>
                row.sourceReceiptId === receipt.id ||
                row.sourceAccountingEntryId === entry.id,
            ) ||
            requests.some(
              (row) => row.requestKey === supplierVoucherRequestKey(receipt.id),
            )
          )
            reasons.add("PAYMENT_SOURCE_ALREADY_CLAIMED");
          if (
            cancellations.some(
              (row) =>
                row.referenceNumber === `CANCEL-VCH-${receipt.id}` &&
                (row.status === "PENDING" || row.status === "COMPLETED") &&
                row.approvalStatus !== "REJECTED",
            )
          )
            reasons.add("EXISTING_CANCELLATION_REQUEST");
          if (receipt.paymentMethod === "CASH") {
            const shift = sourceShifts.find(
              (row) => row.id === receipt.shiftId,
            );
            if (
              (receipt.cashBucket === "TREASURY" && receipt.shiftId != null) ||
              (receipt.cashBucket === "DRAWER" &&
                (!shift ||
                  shift.branchId !== branchId ||
                  shift.userId !== receipt.createdBy)) ||
              !["TREASURY", "DRAWER"].includes(receipt.cashBucket ?? "")
            )
              reasons.add("UNKNOWN_OR_MISMATCHED_ORIGINAL_CASH_SOURCE");
          }
          let remaining = money(entry.amount);
          const allocations: SupplierVoucherAllocation[] = [];
          // Only recognition entries already encountered are available, regardless of an invoice's backdated date.
          for (const invoice of [...episodeInvoices].sort(
            (a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.id - b.id,
          )) {
            const open = available.get(invoice.id)!;
            if (open.lte(0) || remaining.isZero()) continue;
            const selected = assignment?.allocations.find(
              (row) => row.supplierInvoiceId === invoice.id,
            );
            const applied = assignment
              ? money(selected?.amount ?? 0)
              : open.lt(remaining)
                ? open
                : remaining;
            if (applied.lte(0)) continue;
            if (applied.gt(open) || applied.gt(remaining)) {
              reasons.add("ASSIGNMENT_EXCEEDS_AVAILABLE_AMOUNT");
              continue;
            }
            allocations.push({
              supplierInvoiceId: invoice.id,
              invoiceVersion: invoice.version,
              amount: toDbMoney(applied),
            });
            available.set(invoice.id, open.minus(applied));
            remaining = remaining.minus(applied);
          }
          if (!remaining.isZero())
            reasons.add("PAYMENT_PRECEDES_AVAILABLE_INVOICES");
          paymentPlans.push({
            receiptId: receipt.id,
            entryId: entry.id,
            amount: toDbMoney(entry.amount),
            allocations,
          });
        } else reasons.add(`UNSUPPORTED_AP_ENTRY:${entry.entryType}`);
      }
      if (
        !episodeInvoices.length ||
        !paymentPlans.length ||
        (!assignment &&
          Array.from(available.values()).some((value) => !value.isZero())) ||
        (assignment &&
          (episodeInvoices.length !== assignment.allocations.length ||
            paymentPlans.length !== 1))
      )
        reasons.add("EPISODE_NOT_FULLY_ALLOCATABLE");
      const episodePoIds = Array.from(
        new Set(
          episodeInvoices.flatMap((row) =>
            Array.from(invoicePoMap.get(row.id)!),
          ),
        ),
      ).sort((a, b) => a - b);
      if (reasons.size || branchId == null)
        report.excluded.push({
          episodeId,
          supplierId,
          branchId,
          entryIds: episodeRows.map((row) => row.row.id),
          reasons: Array.from(reasons).sort(),
        });
      else {
        const evidenceHash = fingerprint({
          version: 1,
          assignment: assignment ?? null,
          episodeId,
          originalBounds: [episodeRows[0].row.id, episodeRows.at(-1)!.row.id],
          removedProof,
          removedInvoiceIds: Array.from(removedInvoiceIds).sort(
            (a, b) => a - b,
          ),
          supplier: supplierRows.find((row) => row.id === supplierId),
          reconciliation: report.reconciliations.find(
            (row) => row.supplierId === supplierId,
          ),
          entries: episodeRows.map((row) => row.row),
          receipts: episodeReceipts,
          invoices: episodeInvoices,
          orders: orders.filter((row) => episodePoIds.includes(row.id)),
          invoicePoLinks: episodeInvoices.map((row) => [
            row.id,
            Array.from(invoicePoMap.get(row.id)!).sort((a, b) => a - b),
          ]),
          sourceShifts: sourceShifts.filter((row) =>
            episodeReceipts.some((receipt) => receipt.shiftId === row.id),
          ),
          payments: paymentPlans,
        });
        const episode: HistoricalSupplierEpisode = {
          episodeId,
          evidenceHash,
          supplierId,
          branchId,
          total: toDbMoney(
            paymentPlans.reduce((sum, row) => sum.plus(row.amount), money(0)),
          ),
          entryIds: episodeRows.map((row) => row.row.id),
          invoiceIds: episodeInvoices.map((row) => row.id),
          receiptIds: paymentPlans.map((row) => row.receiptId),
          payments: paymentPlans,
        };
        report.episodes.push(episode);
        contexts.set(episodeId, {
          episode,
          invoices: episodeInvoices,
          sourceReceipts: episodeReceipts,
          sourceEntries: episodeRows.map((row) => row.row),
          poIds: episodePoIds,
          invoicePoMap,
        });
      }
      episodeRows = [];
      negative = false;
    };
    for (const row of rows) {
      episodeRows.push(row);
      balance = balance.plus(row.effect);
      if (balance.lt(0)) negative = true;
      if (balance.isZero() && !assignment) finish(true);
    }
    finish(false);
  }
  return { report, contexts };
}

/** Draft only: no owner acceptance is implied by a successful preview. */
export async function previewHistoricalReceiptAssignment(
  input: HistoricalReceiptAssignment,
): Promise<HistoricalSupplierPreview> {
  const assignment = checkedAssignment(input);
  return withTx(
    async (tx) =>
      (
        await scan(
          tx,
          {
            supplierId: assignment.supplierId,
            branchId: assignment.branchId,
            maxEntries: MAX_ROWS,
          },
          assignment,
        )
      ).report,
    { gate: "NONE" },
  );
}

export async function previewHistoricalSupplierSettlements(
  input: HistoricalSupplierPreviewInput = {},
): Promise<HistoricalSupplierPreview> {
  return withTx(async (tx) => (await scan(tx, input)).report, { gate: "NONE" });
}

async function immutableFinancialState(tx: Tx, context: Context) {
  const { episode } = context;
  const [receiptCount] = await tx
    .select({ count: sql<string>`COUNT(*)` })
    .from(receipts);
  const [entryCount] = await tx
    .select({ count: sql<string>`COUNT(*)` })
    .from(accountingEntries);
  const [supplier] = await tx
    .select(supplierEvidence)
    .from(suppliers)
    .where(eq(suppliers.id, episode.supplierId));
  const originalReceipts = await tx
    .select(receiptEvidence)
    .from(receipts)
    .where(inArray(receipts.id, episode.receiptIds))
    .orderBy(asc(receipts.id));
  const originalEntries = await tx
    .select()
    .from(accountingEntries)
    .where(inArray(accountingEntries.id, episode.entryIds))
    .orderBy(asc(accountingEntries.id));
  const cols = {
    entryType: accountingEntries.entryType,
    amount: accountingEntries.amount,
    liabilityAccount: accountingEntries.purchaseLiabilityAccount,
    dedupeKey: accountingEntries.dedupeKey,
  };
  const [ap] = await tx
    .select({
      balance: sql<string>`COALESCE(SUM(${supplierApEffectSql(cols)}),0)`,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.supplierId, episode.supplierId));
  const cash: Record<string, string> = {
    treasury: toDbMoney(await computeTreasuryCashBalance(tx, episode.branchId)),
  };
  const shiftIds = Array.from(
    new Set(
      originalReceipts.flatMap((row) =>
        row.cashBucket === "DRAWER" && row.shiftId != null ? [row.shiftId] : [],
      ),
    ),
  ).sort((a, b) => a - b);
  for (const shiftId of shiftIds) {
    const [shift] = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, shiftId));
    if (!shift) fail("درج المصدر التاريخي مفقود");
    cash[`drawer:${shiftId}`] = toDbMoney(
      await computeDrawerCashBalance(tx, shiftId, shift.openingBalance),
    );
  }
  return {
    receiptCount: String(receiptCount.count),
    entryCount: String(entryCount.count),
    supplier,
    originalReceipts,
    originalEntries,
    ap: toDbMoney(ap.balance),
    cash,
  };
}

/** Adopt documentary links only. All application financial writers take the shared form of this gate. */
export async function adoptHistoricalSupplierSettlement(
  input: { episodeId: string; evidenceHash: string },
  actor: Actor,
): Promise<AdoptionResult> {
  return adoptHistoricalContext(input, actor);
}

/** Internal tooling only; a human owner must accept the entire displayed assignment. */
export async function adoptHistoricalReceiptAssignment(
  input: {
    assignment: HistoricalReceiptAssignment;
    evidenceHash: string;
    ownerAccepted: true;
  },
  actor: Actor,
): Promise<AdoptionResult> {
  if (input.ownerAccepted !== true)
    fail("يلزم قبول المالك الصريح للخطة الكاملة", "FORBIDDEN");
  const assignment = checkedAssignment(input.assignment);
  return adoptHistoricalContext(
    {
      episodeId: assignmentEpisodeId(assignment),
      evidenceHash: input.evidenceHash,
    },
    actor,
    assignment,
  );
}

async function adoptHistoricalContext(
  input: { episodeId: string; evidenceHash: string },
  actor: Actor,
  assignment?: HistoricalReceiptAssignment,
): Promise<AdoptionResult> {
  const identity = /^HSA:([0-9a-z]{1,11}):([0-9a-z]{1,11}):[a-f0-9]{22}$/.exec(
    input.episodeId,
  );
  if (!identity || !/^[a-f0-9]{64}$/.test(input.evidenceHash))
    fail("معرّف الحلقة أو بصمة الدليل غير صالح", "BAD_REQUEST");
  const supplierId = Number.parseInt(identity[1], 36);
  const branchId = Number.parseInt(identity[2], 36);
  if (
    ![supplierId, branchId].every((id) => Number.isSafeInteger(id) && id > 0) ||
    supplierId.toString(36) !== identity[1] ||
    branchId.toString(36) !== identity[2]
  )
    fail("نطاق الحلقة غير صالح", "BAD_REQUEST");
  return withGovernanceTx(async (tx) => {
    const [owner] = await tx
      .select()
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("update")
      .limit(1);
    if (!owner?.isActive || !owner.isOwner)
      fail(
        "اعتماد الدليل التاريخي يتطلب حساب مالك نشط في قاعدة البيانات",
        "FORBIDDEN",
      );
    const prior = await tx
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, ACTION),
          eq(auditLogs.entityType, "supplierSettlementEpisode"),
          eq(auditLogs.entityId, input.episodeId),
        ),
      )
      .orderBy(asc(auditLogs.id))
      .limit(2);
    if (prior.length) {
      if (prior.length !== 1) fail("سجل اعتماد الحلقة مكرر ويحتاج مراجعة");
      const saved = prior[0].newValue as AdoptionResult | null;
      if (
        !saved ||
        saved.evidenceHash !== input.evidenceHash ||
        saved.episodeId !== input.episodeId ||
        !Array.isArray(saved.paymentIds) ||
        !Array.isArray(saved.requestIds) ||
        (assignment && saved.assignment?.inputHash !== fingerprint(assignment))
      )
        fail("الحلقة معتمدة ببصمة دليل أخرى أو بسجل تدقيق غير صالح");
      return { ...saved, replayed: true };
    }
    if (assignment && assignment.assignmentDate !== baghdadToday())
      fail(
        "تاريخ قبول التخصيص الجديد يجب أن يكون يوم بغداد الحالي",
        "BAD_REQUEST",
      );
    // Re-read inside the exclusive gate; pending cancellation and source changes invalidate the proposal.
    const { contexts } = await scan(
      tx,
      {
        supplierId,
        branchId,
        maxEntries: MAX_ROWS,
      },
      assignment,
    );
    const context = contexts.get(input.episodeId);
    if (!context || context.episode.evidenceHash !== input.evidenceHash)
      fail("تغيرت مصادر الحلقة أو لم تعد مؤهلة للاعتماد");
    const { episode } = context;
    const before = await immutableFinancialState(tx, context);
    const paymentIds: number[] = [];
    const requestIds: number[] = [];
    const now = new Date();
    for (const payment of episode.payments) {
      const receipt = context.sourceReceipts.find(
        (row) => row.id === payment.receiptId,
      )!;
      const entry = context.sourceEntries.find(
        (row) => row.id === payment.entryId,
      )!;
      if (
        !["CASH", "CARD", "TRANSFER", "WALLET"].includes(receipt.paymentMethod)
      )
        fail("طريقة المصدر التاريخي غير مدعومة");
      const paymentMethod = receipt.paymentMethod as
        | "CASH"
        | "CARD"
        | "TRANSFER"
        | "WALLET";
      const currentInvoices = await tx
        .select()
        .from(supplierInvoices)
        .where(
          inArray(
            supplierInvoices.id,
            payment.allocations.map((row) => row.supplierInvoiceId),
          ),
        )
        .orderBy(asc(supplierInvoices.id))
        .for("update");
      const allocations = payment.allocations.map((row) => ({
        ...row,
        invoiceVersion: currentInvoices.find(
          (invoice) => invoice.id === row.supplierInvoiceId,
        )!.version,
        currencyAmount: row.amount,
      }));
      const historicalEvidence = {
        kind: "HISTORICAL_SUPPLIER_SETTLEMENT_ADOPTION",
        episodeId: episode.episodeId,
        evidenceHash: episode.evidenceHash,
        originalReceiptId: receipt.id,
        originalAccountingEntryId: entry.id,
        originalCreatedAt: receipt.createdAt.toISOString(),
        originalVoucherDate: receipt.voucherDate,
        originalEntryDate: entry.entryDate,
        receiptHash: fingerprint(receipt),
        entryHash: fingerprint(entry),
        adoptedBy: owner.id,
        adoptedAt: now.toISOString(),
        ...(assignment
          ? { kind: "OWNER_ACCEPTED_FULL_RECEIPT_ASSIGNMENT", assignment }
          : {}),
      };
      const externalReference =
        receipt.referenceNumber?.trim() ||
        (paymentMethod === "CASH" ? `HISTORICAL-RECEIPT:${receipt.id}` : null);
      if (!externalReference) fail("المصدر غير النقدي بلا مرجع دفع أصلي محفوظ");
      const payloadCanonical = canonical({
        supplierId: episode.supplierId,
        branchId: episode.branchId,
        currency: "IQD",
        exchangeRate: null,
        amount: payment.amount,
        currencyAmount: payment.amount,
        paymentMethod,
        cashSource:
          paymentMethod === "CASH"
            ? {
                mode: receipt.cashBucket,
                shiftId: receipt.shiftId,
                payerUserId: receipt.createdBy,
              }
            : null,
        externalReference,
        evidenceType: "OTHER",
        evidenceReference: `HISTORICAL:${receipt.id}:${entry.id}`,
        reason: "اعتماد روابط دليل سداد تاريخي قائم دون حركة نقد أو ذمة جديدة",
        allocations,
        historicalEvidence,
      });
      const payloadHash = sha256(payloadCanonical);
      const requestId = extractInsertId(
        await tx.insert(supplierPaymentRequests).values({
          requestKey: supplierVoucherRequestKey(receipt.id),
          supplierId: episode.supplierId,
          branchId: episode.branchId,
          currency: "IQD",
          exchangeRate: null,
          requestedAmount: payment.amount,
          requestedCurrencyAmount: payment.amount,
          paymentMethod,
          externalReference,
          payloadCanonical,
          payloadHash,
          evidenceType: "OTHER",
          evidenceReference: `HISTORICAL:${receipt.id}:${entry.id}`,
          evidenceHash: fingerprint({
            receiptId: receipt.id,
            entryId: entry.id,
            episodeHash: episode.evidenceHash,
          }),
          reason: "اعتماد دليل سداد تاريخي قائم؛ لا صرف أو اعتراف جديد",
          status: "APPROVED",
          pendingGuard: null,
          requestedBy: receipt.createdBy!,
          requestedAt: now,
          reviewedBy: owner.id,
          reviewedAt: now,
          reviewReason: assignment
            ? "تخصيص تصحيحي صريح قبله المالك لإيصال كامل قائم؛ ليس إثباتاً للتوزيع الأصلي"
            : "اعتماد تاريخي بدليل إيصال وقيد أصليين داخل حلقة ذمة مغلقة",
          decisionKey: `HISTORICAL:${episode.evidenceHash.slice(0, 24)}:${receipt.id}`,
          decisionHash: payloadHash,
          appliedAt: now,
        }),
      );
      requestIds.push(requestId);
      const requestAllocations: {
        id: number;
        invoiceId: number;
        amount: string;
        invoiceHash: string;
      }[] = [];
      for (const allocation of allocations) {
        const invoice = currentInvoices.find(
          (row) => row.id === allocation.supplierInvoiceId,
        )!;
        const invoiceSnapshot = canonical(invoice);
        const invoiceHash = sha256(invoiceSnapshot);
        const id = extractInsertId(
          await tx.insert(supplierPaymentRequestAllocations).values({
            requestId,
            supplierInvoiceId: invoice.id,
            invoiceVersion: invoice.version,
            requestedAmount: allocation.amount,
            requestedCurrencyAmount: allocation.amount,
            invoiceSnapshot,
            invoiceHash,
          }),
        );
        requestAllocations.push({
          id,
          invoiceId: invoice.id,
          amount: allocation.amount,
          invoiceHash,
        });
      }
      const paymentId = extractInsertId(
        await tx.insert(supplierPayments).values({
          paymentNumber: `HSP-${receipt.id}-${episode.evidenceHash.slice(0, 16)}`,
          requestId,
          supplierId: episode.supplierId,
          branchId: episode.branchId,
          currency: "IQD",
          exchangeRate: null,
          amount: payment.amount,
          currencyAmount: payment.amount,
          paymentMethod,
          externalReference,
          receiptId: receipt.id,
          accountingEntryId: entry.id,
          payloadCanonical,
          payloadHash,
          postedBy: owner.id,
          postedAt: now,
        }),
      );
      paymentIds.push(paymentId);
      await tx.insert(supplierPaymentAllocations).values(
        requestAllocations.map((row) => ({
          supplierPaymentId: paymentId,
          requestAllocationId: row.id,
          supplierInvoiceId: row.invoiceId,
          allocatedAmount: row.amount,
          allocatedCurrencyAmount: row.amount,
          invoiceHash: row.invoiceHash,
        })),
      );
      await tx
        .update(supplierPaymentRequestAllocations)
        .set({ activeInvoiceGuard: null })
        .where(eq(supplierPaymentRequestAllocations.requestId, requestId));
      for (const invoice of currentInvoices) {
        const [paid] = await tx
          .select({
            amount: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount}),0)`,
          })
          .from(supplierPaymentAllocations)
          .where(eq(supplierPaymentAllocations.supplierInvoiceId, invoice.id));
        const settled = money(paid.amount)
          .plus(invoice.legacySettledAmount)
          .eq(invoice.totalAmount);
        await tx
          .update(supplierInvoices)
          .set({
            version: invoice.version + 1,
            paymentGate: settled ? "SETTLED" : "OPEN",
            paymentGateReason: settled
              ? "تسوية مثبتة بربط إيصالات وقيود تاريخية قائمة"
              : null,
          })
          .where(eq(supplierInvoices.id, invoice.id));
      }
    }
    // Replace cache with the exact existing native/legacy allocation sum; never add to old paidAmount.
    for (const poId of context.poIds) {
      const linkedIds = Array.from(context.invoicePoMap)
        .filter(([, ids]) => ids.size === 1 && ids.has(poId))
        .map(([id]) => id);
      const invoiceRows = await tx
        .select()
        .from(supplierInvoices)
        .where(
          and(
            inArray(supplierInvoices.id, linkedIds),
            eq(supplierInvoices.status, "POSTED"),
          ),
        );
      const posted = await tx
        .select({
          invoiceId: supplierPaymentAllocations.supplierInvoiceId,
          amount: sql<string>`SUM(${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount})`,
        })
        .from(supplierPaymentAllocations)
        .where(inArray(supplierPaymentAllocations.supplierInvoiceId, linkedIds))
        .groupBy(supplierPaymentAllocations.supplierInvoiceId);
      const paid = invoiceRows.reduce(
        (sum, invoice) =>
          sum
            .plus(invoice.legacySettledAmount)
            .plus(
              posted.find((row) => row.invoiceId === invoice.id)?.amount ?? "0",
            ),
        money(0),
      );
      await tx
        .update(purchaseOrders)
        .set({ paidAmount: toDbMoney(paid) })
        .where(eq(purchaseOrders.id, poId));
    }
    const after = await immutableFinancialState(tx, context);
    if (fingerprint(before) !== fingerprint(after))
      fail(
        "تغير أصل مالي أو رصيد نقد أو ذمة أثناء ربط الدليل؛ أُلغيت المعاملة بالكامل",
      );
    const result: AdoptionResult = {
      episodeId: episode.episodeId,
      evidenceHash: episode.evidenceHash,
      replayed: false,
      paymentIds,
      requestIds,
      ...(assignment
        ? {
            assignment: {
              input: assignment,
              inputHash: fingerprint(assignment),
              acceptedBy: owner.id,
              acceptedAt: now.toISOString(),
            },
          }
        : {}),
    };
    await logAuditTx(
      tx,
      { userId: owner.id, branchId: episode.branchId },
      {
        action: ACTION,
        entityType: "supplierSettlementEpisode",
        entityId: episode.episodeId,
        oldValue: {
          immutableFinancialStateHash: fingerprint(before),
          receiptIds: episode.receiptIds,
          entryIds: episode.entryIds,
        },
        newValue: result,
      },
    );
    enqueueFinancialRefresh(tx, episode.branchId);
    return result;
  });
}

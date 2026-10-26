import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  fulfillmentChargePayments,
  exchangeTransactions,
  legacySupplierInvoiceSettlements,
  receipts,
  supplierBookSettlementAllocations as allocations,
  supplierBookSettlementSources as sources,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRequests,
  supplierPaymentRefundRequests,
  supplierPayments,
  shifts,
  users,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { canCrossBranches } from "../../lib/branchAuthority";
import { extractInsertId } from "../../lib/insertId";
import { enqueueFinancialRefresh } from "../../realtime/financialRefresh";
import { logAuditTx } from "../auditService";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import {
  invoiceReservations,
  lockPaymentAggregate,
  resolveInvoicePurchaseOrderIds,
} from "./supplierPayments";
import {
  isPurchaseAdvanceSnapshot,
  purchaseAdvanceAvailableAmount,
} from "./supplierBookProjection";
import { refreshTargets } from "./supplierBookSettlement";
import { assertSupplierAdvanceInboundHistory } from "./advanceRefundEvidence";

function fail(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر ربط سند الصرف السابق بفاتورة الشراء",
      why,
      doThis:
        "راجع المورد والفرع والسند وتخصيصاته ثم حدّث الفاتورة؛ لم ينفذ صرف جديد",
    }),
  });
}
const canonical = (value: unknown) =>
  stableCanonical(JSON.parse(JSON.stringify(value)));
const day = (value: Date | string) =>
  (value instanceof Date ? value.toISOString() : value).slice(0, 10);
function validIds(...ids: number[]) {
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0))
    fail("هوية السند أو المورد أو الفرع غير صالحة");
}

type EvidenceCache = {
  receipts: Array<typeof receipts.$inferSelect>;
  entries: Array<typeof accountingEntries.$inferSelect>;
  cancellations: Array<{ id: number; referenceNumber: string | null }>;
  legacy: Array<typeof legacySupplierInvoiceSettlements.$inferSelect>;
  exchange: Array<typeof exchangeTransactions.$inferSelect>;
  native: Array<typeof supplierPayments.$inferSelect>;
  sources: Array<typeof sources.$inferSelect>;
  allocations: Array<typeof allocations.$inferSelect>;
  shifts: Array<{ id: number; branchId: number }>;
  fulfillmentPayments: Array<{ receiptId: number | null }>;
};

/** A bounded number of indexed reads, independent of the number of listed vouchers. */
export async function listPurchasePriorPaymentEvidenceCache(
  db: DB | Tx,
  candidates: EvidenceCache["receipts"],
): Promise<EvidenceCache> {
  const ids = candidates.map((row) => row.id);
  const entries = await db
    .select()
    .from(accountingEntries)
    .where(inArray(accountingEntries.receiptId, ids));
  const entryIds = entries.map((row) => row.id);
  const claimed = await db
    .select()
    .from(sources)
    .where(
      or(
        inArray(sources.sourceReceiptId, ids),
        inArray(sources.sourceAccountingEntryId, entryIds),
      ),
    );
  return {
    receipts: candidates,
    entries,
    sources: claimed,
    fulfillmentPayments: await db
      .select({ receiptId: fulfillmentChargePayments.receiptId })
      .from(fulfillmentChargePayments)
      .where(inArray(fulfillmentChargePayments.receiptId, ids)),
    shifts: await db
      .select({ id: shifts.id, branchId: shifts.branchId })
      .from(shifts)
      .where(
        inArray(
          shifts.id,
          candidates.flatMap((row) =>
            row.paymentMethod === "CASH" && row.shiftId != null
              ? [row.shiftId]
              : [],
          ),
        ),
      ),
    cancellations: await db
      .select({ id: receipts.id, referenceNumber: receipts.referenceNumber })
      .from(receipts)
      .where(
        and(
          inArray(
            receipts.referenceNumber,
            ids.map((id) => `CANCEL-VCH-${id}`),
          ),
          inArray(receipts.approvalStatus, ["PENDING_APPROVAL", "APPROVED"]),
        ),
      ),
    legacy: await db
      .select()
      .from(legacySupplierInvoiceSettlements)
      .where(
        or(
          inArray(legacySupplierInvoiceSettlements.sourceReceiptId, ids),
          inArray(
            legacySupplierInvoiceSettlements.sourceAccountingEntryId,
            entryIds,
          ),
        ),
      ),
    exchange: await db
      .select()
      .from(exchangeTransactions)
      .where(inArray(exchangeTransactions.receiptId, ids)),
    native: await db
      .select()
      .from(supplierPayments)
      .where(
        or(
          inArray(supplierPayments.receiptId, ids),
          inArray(supplierPayments.accountingEntryId, entryIds),
        ),
      ),
    allocations: claimed.length
      ? await db
          .select()
          .from(allocations)
          .where(
            inArray(
              allocations.sourceId,
              claimed.map((row) => row.id),
            ),
          )
          .orderBy(asc(allocations.id))
      : [],
  };
}

/** Narrow lifetime history before the safety bound; full evidence remains authoritative. */
export async function purchasePriorPaymentCandidates(
  db: DB | Tx,
  input: { supplierId: number; branchId?: number },
  options: { requireUnused: boolean; allowPendingCancellation?: boolean },
) {
  return db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.partyType, "SUPPLIER"),
        eq(receipts.partyId, input.supplierId),
        input.branchId == null
          ? undefined
          : eq(receipts.branchId, input.branchId),
        eq(receipts.direction, "OUT"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
        inArray(receipts.paymentMethod, ["CASH", "CARD", "TRANSFER", "WALLET"]),
        sql`${receipts.amount} > 0`,
        sql`(${receipts.referenceNumber} IS NULL OR ${receipts.referenceNumber} NOT LIKE 'CANCEL-VCH-%')`,
        sql`EXISTS (SELECT 1 FROM accountingEntries pe WHERE pe.receiptId = ${receipts.id}
      AND pe.entryType = 'PAYMENT_OUT' AND pe.purchaseOrderId IS NULL
      AND pe.supplierId = ${receipts.partyId} AND pe.branchId = ${receipts.branchId}
      AND pe.amount = ${receipts.amount} AND (pe.purchaseLiabilityAccount IS NULL OR pe.purchaseLiabilityAccount <> 'CASH_CLEARING'))`,
        sql`NOT EXISTS (SELECT 1 FROM supplierPayments np WHERE np.receiptId = ${receipts.id}
      OR np.accountingEntryId IN (SELECT ne.id FROM accountingEntries ne WHERE ne.receiptId = ${receipts.id}))`,
        sql`NOT EXISTS (SELECT 1 FROM legacySupplierInvoiceSettlements lp WHERE lp.sourceReceiptId = ${receipts.id}
      OR lp.sourceAccountingEntryId IN (SELECT le.id FROM accountingEntries le WHERE le.receiptId = ${receipts.id}))`,
        sql`NOT EXISTS (SELECT 1 FROM exchangeTransactions ex WHERE ex.receiptId = ${receipts.id})`,
        sql`NOT EXISTS (SELECT 1 FROM fulfillmentChargePayments fp WHERE fp.receiptId = ${receipts.id})`,
        options.allowPendingCancellation
          ? undefined
          : sql`NOT EXISTS (SELECT 1 FROM receipts cancellation
      WHERE cancellation.referenceNumber = CONCAT('CANCEL-VCH-', ${receipts.id})
      AND cancellation.receiptApprovalStatus IN ('PENDING_APPROVAL', 'APPROVED'))`,
        sql`NOT EXISTS (SELECT 1 FROM supplierBookSettlementSources bs
      WHERE (bs.sourceReceiptId = ${receipts.id} OR bs.sourceAccountingEntryId IN
        (SELECT be.id FROM accountingEntries be WHERE be.receiptId = ${receipts.id}))
      AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(bs.sourceSnapshot, '$.purpose')), '') <> 'PURCHASE_ADVANCE'
        OR COALESCE(JSON_EXTRACT(bs.sourceSnapshot, '$.version'), 0) <> 1 OR bs.status = 'REVERSED'
        OR bs.amount - bs.reversedAmount ${
          options.requireUnused
            ? sql`- COALESCE((SELECT SUM(ba.allocatedAmount - ba.reversedAmount)
          FROM supplierBookSettlementAllocations ba WHERE ba.sourceId = bs.id), 0)`
            : sql``
        } <= 0))`,
      ),
    )
    .orderBy(asc(receipts.id))
    .limit(501);
}

/** Read and execution use the same eligibility checks. Execution requires GOVERNANCE at transaction entry. */
export async function readPurchasePriorPaymentEvidence(
  db: DB | Tx,
  receiptId: number,
  currentRead: boolean,
  cache?: EvidenceCache,
  options?: { allowPendingCancellation?: boolean },
) {
  const receiptQuery = db
    .select()
    .from(receipts)
    .where(eq(receipts.id, receiptId));
  const [receipt] = cache
    ? cache.receipts.filter((row) => row.id === receiptId)
    : await (currentRead ? receiptQuery.for("update") : receiptQuery);
  if (
    !receipt ||
    receipt.direction !== "OUT" ||
    receipt.partyType !== "SUPPLIER" ||
    receipt.partyId == null ||
    receipt.branchId == null ||
    receipt.status !== "COMPLETED" ||
    receipt.approvalStatus !== "APPROVED" ||
    !money(receipt.amount).gt(0) ||
    !["CASH", "CARD", "TRANSFER", "WALLET"].includes(receipt.paymentMethod) ||
    receipt.referenceNumber?.startsWith("CANCEL-VCH-") ||
    (receipt.paymentMethod === "CASH"
      ? !receipt.cashBucket ||
        (receipt.cashBucket === "DRAWER"
          ? receipt.shiftId == null
          : receipt.shiftId != null)
      : receipt.cashBucket != null) ||
    day(receipt.voucherDate ?? receipt.createdAt) > day(new Date())
  )
    fail("السند ليس صرف مورد معتمداً وفعلياً مؤهلاً للربط");
  if (receipt.paymentMethod === "CASH" && receipt.cashBucket === "DRAWER") {
    const [shift] = cache
      ? cache.shifts.filter((row) => row.id === receipt.shiftId)
      : await db
          .select({ branchId: shifts.branchId })
          .from(shifts)
          .where(eq(shifts.id, receipt.shiftId!));
    if (shift?.branchId !== receipt.branchId)
      fail("درج السند الأصلي لا يتبع فرع المورد");
  }
  const entryQuery = db
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.receiptId, receiptId));
  const entries = cache
    ? cache.entries.filter((row) => row.receiptId === receiptId)
    : await (currentRead ? entryQuery.for("share") : entryQuery);
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    !entry ||
    entry.entryType !== "PAYMENT_OUT" ||
    entry.supplierId !== receipt.partyId ||
    entry.branchId !== receipt.branchId ||
    entry.purchaseLiabilityAccount === "CASH_CLEARING" ||
    !money(entry.amount).eq(receipt.amount) ||
    entry.postingProfile?.includes("SHIPPING") ||
    entry.dedupeKey?.startsWith("PURCHASE_CHARGE_") ||
    entry.dedupeKey?.startsWith("FULFILLMENT_") ||
    day(entry.entryDate) > day(new Date())
  )
    fail("السند لا يملك قيد صرف AP أصلياً واحداً مطابقاً ومستقلاً عن أمر شراء");
  const fulfillment = cache
    ? cache.fulfillmentPayments.filter((row) => row.receiptId === receiptId)
    : await db
        .select({ receiptId: fulfillmentChargePayments.receiptId })
        .from(fulfillmentChargePayments)
        .where(eq(fulfillmentChargePayments.receiptId, receiptId))
        .for("share");
  if (fulfillment.length)
    fail("السند مملوك لتسوية أجر تنفيذ سابقة ولا يمثل رصيداً مقدماً");
  const cancellationQuery = db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.referenceNumber, `CANCEL-VCH-${receiptId}`),
        inArray(receipts.approvalStatus, ["PENDING_APPROVAL", "APPROVED"]),
      ),
    );
  const cancellation = cache
    ? cache.cancellations.filter(
        (row) => row.referenceNumber === `CANCEL-VCH-${receiptId}`,
      )
    : await (currentRead ? cancellationQuery.for("share") : cancellationQuery);
  if (cancellation.length && !options?.allowPendingCancellation)
    fail("السند له إلغاء قائم أو معتمد");
  const legacyQuery = db
    .select({ id: legacySupplierInvoiceSettlements.id })
    .from(legacySupplierInvoiceSettlements)
    .where(
      or(
        eq(legacySupplierInvoiceSettlements.sourceReceiptId, receiptId),
        eq(legacySupplierInvoiceSettlements.sourceAccountingEntryId, entry.id),
      ),
    );
  const exchangeQuery = db
    .select({ id: exchangeTransactions.id })
    .from(exchangeTransactions)
    .where(eq(exchangeTransactions.receiptId, receiptId));
  const legacy = cache
    ? cache.legacy.filter(
        (row) =>
          row.sourceReceiptId === receiptId ||
          row.sourceAccountingEntryId === entry.id,
      )
    : await (currentRead ? legacyQuery.for("share") : legacyQuery);
  const exchange = cache
    ? cache.exchange.filter((row) => row.receiptId === receiptId)
    : await (currentRead ? exchangeQuery.for("share") : exchangeQuery);
  if (legacy.length || exchange.length)
    fail("السند مملوك لمسار تسوية إرثية أو صيرفة");
  const nativeQuery = db
    .select()
    .from(supplierPayments)
    .where(
      or(
        eq(supplierPayments.receiptId, receiptId),
        eq(supplierPayments.accountingEntryId, entry.id),
      ),
    );
  const native = cache
    ? cache.native.filter(
        (row) =>
          row.receiptId === receiptId || row.accountingEntryId === entry.id,
      )
    : await (currentRead ? nativeQuery.for("share") : nativeQuery);
  if (!native.length && entry.purchaseOrderId != null)
    fail("السند مرتبط بأمر شراء سابق ولا يمثل رصيداً مقدماً حراً");
  const sourceQuery = db
    .select()
    .from(sources)
    .where(
      or(
        eq(sources.sourceReceiptId, receiptId),
        eq(sources.sourceAccountingEntryId, entry.id),
      ),
    );
  const claimed = cache
    ? cache.sources.filter(
        (row) =>
          row.sourceReceiptId === receiptId ||
          row.sourceAccountingEntryId === entry.id,
      )
    : await (currentRead ? sourceQuery.for("update") : sourceQuery);
  if (
    native.length > 1 ||
    claimed.length > 1 ||
    (native.length && claimed.length)
  )
    fail("مصدر السند مملوك لأكثر من تسوية");
  const source = claimed[0];
  const snapshot = canonical({
    purpose: "PURCHASE_ADVANCE",
    version: 1,
    entry,
    receipt,
    exchange: null,
  });
  if (
    source &&
    (source.sourceReceiptId !== receiptId ||
      source.sourceAccountingEntryId !== entry.id ||
      source.supplierId !== receipt.partyId ||
      source.branchId !== receipt.branchId ||
      source.kind !== "PAYMENT" ||
      source.sourceExchangeTransactionId != null ||
      !money(source.amount).eq(receipt.amount) ||
      source.status === "REVERSED" ||
      source.sourceHash !== sha256(source.sourceSnapshot) ||
      (isPurchaseAdvanceSnapshot(source.sourceSnapshot) &&
        source.sourceSnapshot !== snapshot))
  )
    fail("المصدر مخصص سابقاً أو تغير دليله الأصلي أو عُكس");
  const allocationQuery = source
    ? db
        .select()
        .from(allocations)
        .where(eq(allocations.sourceId, source.id))
        .orderBy(asc(allocations.id))
    : null;
  const rows = cache
    ? cache.allocations.filter((row) => row.sourceId === source?.id)
    : allocationQuery
      ? await (currentRead ? allocationQuery.for("update") : allocationQuery)
      : [];
  if (rows.some((row) => sha256(row.targetSnapshot) !== row.targetHash))
    fail("بصمة تخصيص المصدر غير صالحة");
  if (
    source &&
    !isPurchaseAdvanceSnapshot(source.sourceSnapshot) &&
    (!rows
      .reduce((sum, row) => sum.plus(row.allocatedAmount), money(0))
      .eq(source.amount) ||
      !rows
        .reduce((sum, row) => sum.plus(row.reversedAmount), money(0))
        .eq(source.reversedAmount))
  )
    fail("تخصيصات المصدر الدفتري التاريخي غير مكتملة");
  const availableAmount = !source
    ? receipt.amount
    : isPurchaseAdvanceSnapshot(source.sourceSnapshot)
      ? purchaseAdvanceAvailableAmount(source, rows)
      : "0.00";
  return {
    receipt,
    entry,
    source,
    rows,
    native: native[0],
    snapshot,
    availableAmount,
  };
}

export async function listPurchasePriorPayments(
  db: DB | Tx,
  input: { supplierId: number; branchId: number },
): Promise<
  Array<{
    id: number;
    voucherNumber: string | null;
    amount: string;
    availableAmount: string;
    paymentMethod: string;
    date: string;
  }>
> {
  validIds(input.supplierId, input.branchId);
  const candidates = await purchasePriorPaymentCandidates(db, input, {
    requireUnused: true,
  });
  if (candidates.length > 500)
    fail("تجاوز عدد السندات حد القراءة الآمنة؛ راجع حساب المورد");
  const result: Awaited<ReturnType<typeof listPurchasePriorPayments>> = [];
  if (!candidates.length) return result;
  const cache = await listPurchasePriorPaymentEvidenceCache(db, candidates);
  for (const candidate of candidates) {
    try {
      const value = await readPurchasePriorPaymentEvidence(
        db,
        candidate.id,
        false,
        cache,
      );
      if (value.native || !money(value.availableAmount).gt(0)) continue;
      result.push({
        id: candidate.id,
        voucherNumber: value.receipt.voucherNumber,
        amount: value.receipt.amount,
        availableAmount: value.availableAmount,
        paymentMethod: value.receipt.paymentMethod,
        date: day(value.receipt.voucherDate ?? value.receipt.createdAt),
      });
    } catch (error) {
      if (!(error instanceof TRPCError) || error.code !== "CONFLICT")
        throw error;
    }
  }
  if (result.length)
    await assertSupplierAdvanceInboundHistory(
      db,
      input.supplierId,
      input.branchId,
    );
  return result;
}

/** Caller owns independent purchase approval and enters withGovernanceTx before all domain locks. */
export async function applyPurchasePriorPaymentInTx(
  tx: Tx,
  input: {
    receiptId: number;
    invoiceId: number;
    purchaseOrderId: number;
    actor: Actor;
  },
): Promise<{ allocatedAmount: string; sourceId: number | null }> {
  validIds(
    input.receiptId,
    input.invoiceId,
    input.purchaseOrderId,
    input.actor.userId,
  );
  const [preview] = await tx
    .select({ supplierId: supplierInvoices.supplierId })
    .from(supplierInvoices)
    .where(eq(supplierInvoices.id, input.invoiceId));
  if (!preview) fail("فاتورة المورد غير موجودة");
  const aggregate = await lockPaymentAggregate(tx, preview.supplierId, [
    input.invoiceId,
  ]);
  const invoice = aggregate.invoices[0];
  const poIds = await resolveInvoicePurchaseOrderIds(tx, [input.invoiceId]);
  const po = aggregate.orders.find((row) => row.id === input.purchaseOrderId);
  const [user] = await tx
    .select()
    .from(users)
    .where(eq(users.id, input.actor.userId))
    .for("share");
  if (
    !user?.isActive ||
    !invoice ||
    !po ||
    !aggregate.supplier?.isActive ||
    aggregate.supplier.supplierKind !== "REGULAR" ||
    invoice.origin !== "NATIVE" ||
    invoice.liabilityClass !== "NATIVE_AP" ||
    invoice.status !== "POSTED" ||
    invoice.draftState !== "ACTIVE" ||
    !["OPEN", "SETTLED"].includes(invoice.paymentGate) ||
    invoice.currency !== "IQD" ||
    po.agreedCurrency !== "IQD" ||
    po.settlementType !== "CASH" ||
    !["CONFIRMED", "RECEIVED"].includes(po.status) ||
    po.supplierId !== invoice.supplierId ||
    po.branchId !== invoice.branchId ||
    poIds.length !== 1 ||
    poIds[0] !== input.purchaseOrderId ||
    (!canCrossBranches(user) &&
      (user.branchId !== invoice.branchId ||
        input.actor.branchId !== invoice.branchId))
  )
    fail("الفاعل أو الفاتورة أو أمر الشراء النقدي أو العملة أو الفرع غير مؤهل");
  const value = await readPurchasePriorPaymentEvidence(
    tx,
    input.receiptId,
    true,
  );
  await assertSupplierAdvanceInboundHistory(
    tx,
    invoice.supplierId,
    invoice.branchId,
  );
  if (
    value.receipt.partyId !== invoice.supplierId ||
    value.receipt.branchId !== invoice.branchId
  )
    fail("السند يعود إلى مورد أو فرع مختلف");
  if (value.native) {
    const native = value.native;
    const rows = await tx
      .select()
      .from(supplierPaymentAllocations)
      .where(eq(supplierPaymentAllocations.supplierPaymentId, native.id))
      .for("share");
    const [request] = await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.id, native.requestId))
      .for("share");
    const pendingRefunds = await tx
      .select({ id: supplierPaymentRefundRequests.id })
      .from(supplierPaymentRefundRequests)
      .where(
        and(
          eq(supplierPaymentRefundRequests.supplierPaymentId, native.id),
          eq(supplierPaymentRefundRequests.status, "PENDING"),
        ),
      )
      .for("share");
    if (
      native.receiptId !== value.receipt.id ||
      native.accountingEntryId !== value.entry.id ||
      native.supplierId !== invoice.supplierId ||
      native.branchId !== invoice.branchId ||
      native.currency !== "IQD" ||
      native.status !== "POSTED" ||
      native.paymentMethod !== value.receipt.paymentMethod ||
      !money(native.amount).eq(value.receipt.amount) ||
      !money(native.currencyAmount).eq(native.amount) ||
      request?.status !== "APPROVED" ||
      request.supplierId !== native.supplierId ||
      request.branchId !== native.branchId ||
      request.currency !== "IQD" ||
      request.paymentMethod !== native.paymentMethod ||
      !money(request.requestedAmount).eq(native.amount) ||
      !money(request.requestedCurrencyAmount).eq(native.currencyAmount) ||
      pendingRefunds.length > 0 ||
      rows.length !== 1 ||
      rows[0].supplierInvoiceId !== invoice.id ||
      !money(rows[0].refundedAmount).isZero() ||
      !money(rows[0].refundedCurrencyAmount).isZero() ||
      !money(rows[0].allocatedCurrencyAmount).eq(rows[0].allocatedAmount) ||
      !money(rows[0].allocatedAmount).eq(native.amount)
    )
      fail("دفعة السند الأصلية تخص فاتورة أخرى أو استُرد منها مبلغ");
    return { allocatedAmount: rows[0].allocatedAmount, sourceId: null };
  }
  const prior = value.rows.find((row) => row.supplierInvoiceId === invoice.id);
  if (prior)
    return {
      allocatedAmount: toDbMoney(
        money(prior.allocatedAmount).minus(prior.reversedAmount),
      ),
      sourceId: value.source!.id,
    };
  if (!money(value.availableAmount).gt(0))
    fail("رصيد السند السابق مستهلك بالكامل");
  const reservations = await invoiceReservations(tx, [invoice.id]);
  if (reservations.pending.has(invoice.id))
    fail("الفاتورة تحمل طلب سداد معلقاً");
  const remaining = money(invoice.totalAmount)
    .minus(invoice.legacySettledAmount)
    .minus(reservations.posted.get(invoice.id)?.amount ?? 0)
    .minus(reservations.creditReturns.get(invoice.id) ?? 0);
  if (!remaining.gt(0) || invoice.paymentGate !== "OPEN")
    fail("الفاتورة مسددة ولا تقبل تخصيصاً جديداً");
  const amount = toDbMoney(Decimal.min(value.availableAmount, remaining));
  const targetSnapshot = canonical({ invoice, purchaseOrderId: po.id });
  const sourceId =
    value.source?.id ??
    extractInsertId(
      await tx.insert(sources).values({
        supplierId: invoice.supplierId,
        branchId: invoice.branchId,
        sourceAccountingEntryId: value.entry.id,
        sourceReceiptId: value.receipt.id,
        kind: "PAYMENT",
        amount: value.receipt.amount,
        sourceSnapshot: value.snapshot,
        sourceHash: sha256(value.snapshot),
        planHash: sha256(
          canonical({
            receiptId: value.receipt.id,
            invoiceId: invoice.id,
            amount,
          }),
        ),
        adoptionKey: `PURCHASE-ADVANCE:${value.receipt.id}`,
        adoptedBy: input.actor.userId,
        reversalHistory: "[]",
      }),
    );
  await tx.insert(allocations).values({
    sourceId,
    supplierInvoiceId: invoice.id,
    allocatedAmount: amount,
    allocatedCurrencyAmount: amount,
    targetSnapshot,
    targetHash: sha256(targetSnapshot),
  });
  if (value.source)
    await tx
      .update(sources)
      .set({ version: value.source.version + 1 })
      .where(eq(sources.id, sourceId));
  await refreshTargets(tx, [invoice.id]);
  await logAuditTx(tx, input.actor, {
    action: "purchase.priorPayment.allocate",
    entityType: "supplierInvoice",
    entityId: invoice.id,
    newValue: {
      sourceId,
      receiptId: value.receipt.id,
      accountingEntryId: value.entry.id,
      purchaseOrderId: po.id,
      amount,
      remainingAdvance: toDbMoney(money(value.availableAmount).minus(amount)),
      purpose: "PURCHASE_ADVANCE",
    },
  });
  enqueueFinancialRefresh(tx, invoice.branchId);
  return { allocatedAmount: amount, sourceId };
}

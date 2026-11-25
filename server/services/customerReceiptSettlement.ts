import { activeDeliveryInvoiceIdsTx } from "./delivery/guards";
/** Receipt provenance only. Cash, ledger and AR remain owned by the caller's transaction. */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  accountingEntries,
  auditLogs,
  customerReceiptAllocations as allocations,
  customerReceiptCreditUses as creditUses,
  customerReceiptSettlements as settlements,
  customers,
  installmentPlans,
  invoices,
  journalEntries,
  journalLines,
  orderPayments,
  receipts,
  workOrders,
} from "../../drizzle/schema";
import {
  digitalIntentSettlements,
  digitalRefundPayments,
} from "../../drizzle/digitalSettlementSchema";
import type { DB, Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { isDeadInvoice } from "@shared/predicates";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { logAuditTx } from "./auditService";
import { computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, round2, toDbMoney } from "./money";
import type { Actor } from "./tx";
import { allocateVoucherToInvoiceTx } from "./voucher/invoiceAllocation";

/**
 * يستبعد فقط عرابين الحجز المحتجزة (HELD) أو المستردة غير المرتبطة بفاتورة؛
 * أما العرابين المطبّقة (APPLIED) فتُحتسب مع قيود SALE لتوازن الرصيد الدفتري.
 */
function entryNotUnappliedHoldReceiptCond(receiptIdCol: SQL | unknown): SQL {
  return sql`(
    ${receiptIdCol} IS NULL
    OR (
      NOT EXISTS (
        SELECT 1 FROM ${receipts} hr
        INNER JOIN ${workOrders} hwo ON hwo.id = hr.workOrderId
        WHERE hr.id = ${receiptIdCol}
          AND hwo.invoiceId IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${orderPayments} hop
        WHERE hop.receiptId = ${receiptIdCol}
          AND hop.orderPayKind = 'COLLECTION'
          AND hop.orderPayStatus IN ('HELD', 'REFUNDED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${orderPayments} hopr
        INNER JOIN ${orderPayments} hopp ON hopp.id = hopr.parentPaymentId
        WHERE hopr.receiptId = ${receiptIdCol}
          AND hopr.orderPayKind = 'REFUND'
          AND hopp.orderPayStatus IN ('HELD', 'REFUNDED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${digitalIntentSettlements} hds
        WHERE hds.collectionReceiptId = ${receiptIdCol}
          AND hds.invoiceId IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${digitalRefundPayments} hdr
        WHERE hdr.receiptId = ${receiptIdCol}
          AND hdr.intentId IS NOT NULL
          AND hdr.invoiceId IS NULL
      )
    )
  )`;
}

export interface CustomerBranchScope {
  customerId: number;
  branchId: number;
  entryBal: Decimal;
  manualArNet: Decimal;
  branchLedgerNet: Decimal;
  openInvoicesTotal: Decimal;
  trackedUnallocated: Decimal;
  crossBranchAdditionalHistorical: Decimal;
  totalCrossBranchCredit: Decimal;
  sameBranchAdditionalHistorical: Decimal;
  totalSameBranchCredit: Decimal;
}

export async function findCustomerCreditAuditByRequestIdTx(
  tx: Tx,
  invoiceId: number,
  clientRequestId: string | undefined,
): Promise<{
  creditApplied?: string;
  balanceBefore?: string;
  balanceAfter?: string;
} | null> {
  if (!clientRequestId) return null;
  const priorLogs = await tx
    .select({ newValue: auditLogs.newValue })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "sale.pay.customerCredit"),
        eq(auditLogs.entityType, "invoice"),
        eq(auditLogs.entityId, String(invoiceId)),
      ),
    )
    .orderBy(desc(auditLogs.id))
    .limit(50);
  const matched = priorLogs.find(
    (l) =>
      (l.newValue as { clientRequestId?: unknown } | null)?.clientRequestId ===
      clientRequestId,
  );
  return (matched?.newValue ?? null) as {
    creditApplied?: string;
    balanceBefore?: string;
    balanceAfter?: string;
  } | null;
}

function customerEntryArNetExprSql() {
  return sql`CASE
          WHEN ${accountingEntries.entryType} IN ('SALE','RETURN','OPENING') THEN ${accountingEntries.amount}
          WHEN ${accountingEntries.entryType} = 'PAYMENT_IN' AND (
            ${accountingEntries.dedupeKey} LIKE 'FULFILLMENT_COURIER_EXCESS:%'
            OR ${accountingEntries.dedupeKey} LIKE 'FULFILLMENT_CHARGE_EXCESS_REFUND:%'
          ) THEN 0
          WHEN ${accountingEntries.entryType} = 'PAYMENT_IN' THEN -CASE
            WHEN ${accountingEntries.dedupeKey} LIKE 'FULFILLMENT_CHARGE_COLLECTION:%'
            THEN COALESCE((
              SELECT SUM(fcp.amount)
              FROM fulfillmentChargePayments fcp
              WHERE fcp.receiptId = ${accountingEntries.receiptId}
                AND fcp.kind = 'COLLECTION'
            ), 0)
            ELSE ${accountingEntries.amount}
          END
          WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' AND ${accountingEntries.dedupeKey} LIKE 'FULFILLMENT_CHARGE_EXCESS_REFUND:%' THEN 0
          WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' THEN ${accountingEntries.amount}
          WHEN ${accountingEntries.entryType} = 'ADJUST' AND (
            ${accountingEntries.dedupeKey} LIKE 'INVOICE_CORRECTION_CUSTOMER_RECLASS:%'
            OR ${accountingEntries.dedupeKey} LIKE 'FULFILLMENT_CHARGE_ACCRUAL:%'
            OR ${accountingEntries.dedupeKey} LIKE 'FULFILLMENT_CHARGE_CREDIT:%'
            OR ${accountingEntries.dedupeKey} LIKE 'CUSTOMER_INTERBRANCH_OUT:%'
            OR ${accountingEntries.dedupeKey} LIKE 'NO-RECEIPT-CREDIT:%'
          ) THEN ${accountingEntries.amount}
          WHEN ${accountingEntries.entryType} = 'ADJUST' AND ${accountingEntries.dedupeKey} LIKE 'CUSTOMER_INTERBRANCH_IN:%' THEN -${accountingEntries.amount}
          WHEN ${accountingEntries.entryType} = 'DELIVERY_REMIT' AND ${accountingEntries.dedupeKey} LIKE 'INVOICE_AMEND_CUSTODY:%' THEN ${accountingEntries.amount}
          ELSE 0 END`;
}

/**
 * حساب صافي ذمة العميل ورصيده الدائن المتاح على مستوى (العميل × الفرع) بمصدر واحد:
 * يستبعد عرابين الحجز المحتجزة/المستردة، ويجمع قيود الدفتر + اليوميات اليدوية على AR +
 * الفواتير المفتوحة + السندات المتتبعة دون ازدواج في العد بين المسارين.
 */
export async function computeCustomerBranchScopeTx(
  db: DB | Tx,
  input: { customerIds: readonly number[]; branchId?: number },
): Promise<Map<string, CustomerBranchScope>> {
  const result = new Map<string, CustomerBranchScope>();
  const customerIds = Array.from(
    new Set(input.customerIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
  );
  if (customerIds.length === 0) return result;

  const [trackedRows, entryScopeRows, manualArRows, openInvoiceRows] = await Promise.all([
    db
      .select({
        customerId: settlements.customerId,
        branchId: settlements.branchId,
        credit: sql<string>`COALESCE(SUM(${settlements.unallocatedAmount}), 0)`,
      })
      .from(settlements)
      .where(
        and(
          inArray(settlements.customerId, customerIds),
          input.branchId != null ? eq(settlements.branchId, input.branchId) : undefined,
          isNull(settlements.reversalReceiptId),
          sql`${settlements.unallocatedAmount} > 0`,
        ),
      )
      .groupBy(settlements.customerId, settlements.branchId),
    db
      .select({
        customerId: accountingEntries.customerId,
        branchId: accountingEntries.branchId,
        bal: sql<string>`COALESCE(SUM(${customerEntryArNetExprSql()}), 0)`,
      })
      .from(accountingEntries)
      .where(
        and(
          inArray(accountingEntries.customerId, customerIds),
          input.branchId != null
            ? eq(accountingEntries.branchId, input.branchId)
            : sql`${accountingEntries.branchId} IS NOT NULL`,
          entryNotUnappliedHoldReceiptCond(accountingEntries.receiptId),
        ),
      )
      .groupBy(accountingEntries.customerId, accountingEntries.branchId),
    db
      .select({
        customerId: journalLines.customerId,
        branchId: sql<number>`COALESCE(${journalLines.branchId}, ${journalEntries.branchId})`,
        net: sql<string>`COALESCE(SUM(CAST(${journalLines.debit} AS DECIMAL(15,2)) - CAST(${journalLines.credit} AS DECIMAL(15,2))), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
      .where(
        and(
          inArray(journalLines.customerId, customerIds),
          inArray(journalLines.role, ["AR", "ACCOUNTS_RECEIVABLE"]),
          eq(journalEntries.status, "POSTED"),
          eq(journalEntries.postingProfile, "MANUAL_JOURNAL"),
          input.branchId != null
            ? sql`COALESCE(${journalLines.branchId}, ${journalEntries.branchId}) = ${input.branchId}`
            : sql`COALESCE(${journalLines.branchId}, ${journalEntries.branchId}) IS NOT NULL`,
        ),
      )
      .groupBy(
        journalLines.customerId,
        sql`COALESCE(${journalLines.branchId}, ${journalEntries.branchId})`,
      ),
    db
      .select({
        customerId: invoices.customerId,
        branchId: invoices.branchId,
        openTotal: sql<string>`COALESCE(SUM(GREATEST(CAST(${invoices.total} AS DECIMAL(15,2)) - COALESCE(CAST(${invoices.returnedTotal} AS DECIMAL(15,2)), 0) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)), 0)), 0)`,
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.customerId, customerIds),
          input.branchId != null ? eq(invoices.branchId, input.branchId) : undefined,
          sql`${invoices.status} NOT IN ('CANCELLED', 'RETURNED', 'SUPERSEDED')`,
        ),
      )
      .groupBy(invoices.customerId, invoices.branchId),
  ]);

  const acc = new Map<
    string,
    {
      customerId: number;
      branchId: number;
      entryBal: Decimal;
      manualArNet: Decimal;
      openInvoicesTotal: Decimal;
      trackedUnallocated: Decimal;
    }
  >();
  const ensure = (customerId: number, branchId: number) => {
    const k = `${customerId}:${branchId}`;
    let cur = acc.get(k);
    if (!cur) {
      cur = {
        customerId,
        branchId,
        entryBal: money(0),
        manualArNet: money(0),
        openInvoicesTotal: money(0),
        trackedUnallocated: money(0),
      };
      acc.set(k, cur);
    }
    return cur;
  };

  for (const r of trackedRows) {
    if (r.customerId == null || r.branchId == null) continue;
    const item = ensure(Number(r.customerId), Number(r.branchId));
    item.trackedUnallocated = item.trackedUnallocated.plus(money(r.credit));
  }
  for (const r of entryScopeRows) {
    if (r.customerId == null || r.branchId == null) continue;
    const item = ensure(Number(r.customerId), Number(r.branchId));
    item.entryBal = item.entryBal.plus(money(r.bal));
  }
  for (const r of manualArRows) {
    if (r.customerId == null || r.branchId == null) continue;
    const item = ensure(Number(r.customerId), Number(r.branchId));
    item.manualArNet = item.manualArNet.plus(money(r.net));
  }
  for (const r of openInvoiceRows) {
    if (r.customerId == null || r.branchId == null) continue;
    const item = ensure(Number(r.customerId), Number(r.branchId));
    item.openInvoicesTotal = item.openInvoicesTotal.plus(money(r.openTotal));
  }

  for (const [k, item] of Array.from(acc.entries())) {
    const branchLedgerNet = item.entryBal.plus(item.manualArNet);
    const crossBranchAdditionalHistorical = Decimal.max(
      0,
      branchLedgerNet.negated().minus(item.trackedUnallocated),
    );
    const totalCrossBranchCredit = item.trackedUnallocated.plus(
      crossBranchAdditionalHistorical,
    );
    const sameBranchAdditionalHistorical = Decimal.max(
      0,
      item.openInvoicesTotal
        .minus(branchLedgerNet)
        .minus(item.trackedUnallocated),
    );
    const totalSameBranchCredit = item.trackedUnallocated.plus(
      sameBranchAdditionalHistorical,
    );
    result.set(k, {
      ...item,
      branchLedgerNet,
      crossBranchAdditionalHistorical,
      totalCrossBranchCredit,
      sameBranchAdditionalHistorical,
      totalSameBranchCredit,
    });
  }
  return result;
}

type Receipt = typeof receipts.$inferSelect;
function conflict(message: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: "تعذرت تسوية سند العميل",
      why: message,
      doThis:
        "راجع سند القبض الأصلي ومستندات الرد والعكس في كشف العميل؛ تراجعت المعاملة كاملة",
    }),
  });
}
function sourceHash(r: Receipt) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: r.id,
        customerId: r.partyId,
        branchId: r.branchId,
        amount: toDbMoney(r.amount),
        direction: r.direction,
        method: r.paymentMethod,
        shiftId: r.shiftId,
        cashBucket: r.cashBucket,
        createdBy: r.createdBy,
      }),
    )
    .digest("hex");
}
async function sourceTx(tx: Tx, id: number, allowReversed = false) {
  const [r] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, id))
    .for("update");
  if (
    !r ||
    r.partyType !== "CUSTOMER" ||
    !r.partyId ||
    r.branchId == null ||
    r.approvalStatus !== "APPROVED" ||
    (r.status !== "COMPLETED" && !(allowReversed && r.status === "REVERSED"))
  )
    conflict("مصدر القبض غير منفذ");
  const entries = await tx
    .select()
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.receiptId, id),
        eq(
          accountingEntries.entryType,
          r.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
        ),
      ),
    );
  if (
    entries.length !== 1 ||
    entries[0].customerId !== r.partyId ||
    entries[0].branchId !== r.branchId ||
    !money(entries[0].amount).eq(r.amount)
  )
    conflict("القيد الأصلي لا يطابق السند");
  return { ...r, branchId: r.branchId!, partyId: r.partyId! };
}
async function assertSourceTx(tx: Tx, header: typeof settlements.$inferSelect) {
  const r = await sourceTx(tx, header.receiptId, true);
  if (
    r.direction !== "IN" ||
    header.customerId !== r.partyId ||
    header.branchId !== r.branchId ||
    header.sourceHash !== sourceHash(r) ||
    !money(header.amount).eq(r.amount)
  )
    conflict("تغير دليل مصدر القبض");
  return r;
}
export async function assertCustomerReceiptConservationTx(
  tx: Tx,
  settlementId: number,
) {
  const [h] = await tx
    .select()
    .from(settlements)
    .where(eq(settlements.id, settlementId));
  if (!h) conflict("دليل التوزيع مفقود");
  const rows = await tx
    .select({ amount: allocations.amount })
    .from(allocations)
    .where(eq(allocations.settlementId, settlementId));
  const total = rows.reduce(
    (sum, a) => sum.plus(a.amount),
    money(h.accountAmount).plus(h.unallocatedAmount).plus(h.refundedAmount),
  );
  if (!total.eq(h.amount))
    conflict("مجموع حصص السند لا يساوي مصدره؛ تراجعت المعاملة بالكامل");
}

/** Historical repair verifies the original source without posting money again. */
export async function verifyCustomerReceiptSettlementTx(
  tx: Tx,
  receiptId: number,
) {
  const [header] = await tx
    .select()
    .from(settlements)
    .where(eq(settlements.receiptId, receiptId));
  if (!header) conflict("دليل التوزيع التاريخي مفقود");
  await assertSourceTx(tx, header);
  await assertCustomerReceiptConservationTx(tx, header.id);
  return header;
}

/** Internal history importer: caller proves the entire customer funding snapshot under GOVERNANCE. */
export async function adoptHistoricalCustomerReceiptTx(
  tx: Tx,
  receiptId: number,
  plan: {
    accountAmount: string;
    unallocatedAmount: string;
    allocations: { invoiceId: number; amount: string; applyAmount: string }[];
  },
  actor: Actor,
) {
  const r = await sourceTx(tx, receiptId);
  if (
    r.direction !== "IN" ||
    r.invoiceId != null ||
    r.workOrderId != null ||
    r.reservationId != null ||
    !r.voucherNumber
  )
    conflict("هذا المصدر ليس سند قبض تاريخياً عاماً");
  const [existing] = await tx
    .select({ id: settlements.id })
    .from(settlements)
    .where(eq(settlements.receiptId, receiptId));
  if (existing)
    conflict("السند التاريخي مرتبط مسبقاً؛ أعد تشغيل دفعة التصحيح الأصلية");
  const [entry] = await tx
    .select({ entryDate: accountingEntries.entryDate })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.receiptId, receiptId),
        eq(accountingEntries.entryType, "PAYMENT_IN"),
      ),
    );
  const total = plan.allocations.reduce(
    (sum, p) => sum.plus(p.amount),
    money(plan.accountAmount).plus(plan.unallocatedAmount),
  );
  if (
    money(plan.accountAmount).lt(0) ||
    money(plan.unallocatedAmount).lt(0) ||
    !total.eq(r.amount)
  )
    conflict("خطة الربط التاريخي لا تحفظ قيمة مصدر القبض");
  const id = extractInsertId(
    await tx.insert(settlements).values({
      receiptId,
      customerId: r.partyId,
      branchId: r.branchId,
      amount: r.amount,
      accountAmount: plan.accountAmount,
      unallocatedAmount: plan.unallocatedAmount,
      initialUnallocatedAmount: plan.unallocatedAmount,
      sourceHash: sourceHash(r),
      createdBy: actor.userId,
    }),
  );
  for (const p of plan.allocations) {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, p.invoiceId));
    if (
      !inv ||
      inv.customerId !== r.partyId ||
      inv.branchId !== r.branchId ||
      isDeadInvoice(inv) ||
      money(p.amount).lte(0) ||
      money(p.applyAmount).lt(0) ||
      money(p.applyAmount).gt(p.amount)
    )
      conflict("تخصيص تاريخي خارج نطاق الفاتورة أو المصدر");
    if ((await activeDeliveryInvoiceIdsTx(tx, [inv.id])).has(inv.id))
      conflict("لا يُعاد بناء تخصيص على إرسالية نشطة");
    if (money(p.applyAmount).gt(0)) {
      await allocateVoucherToInvoiceTx(tx, {
        invoiceId: p.invoiceId,
        amount: money(p.applyAmount),
        installmentEffect: { sourceReceiptId: receiptId, effectReceiptId: receiptId, effectKey: `ADOPT:${receiptId}:${p.invoiceId}` },
        direction: "IN",
        paymentMethod: r.paymentMethod,
        voucherBranchId: r.branchId,
      });
      // Adoption is not a new collection. Retain any later original payment;
      // otherwise use the proven effective date of this receipt's ledger entry.
      const effectiveDate = new Date(entry.entryDate);
      await tx
        .update(invoices)
        .set({
          paymentDate:
            inv.paymentDate &&
            new Date(inv.paymentDate).getTime() > effectiveDate.getTime()
              ? inv.paymentDate
              : effectiveDate,
        })
        .where(eq(invoices.id, inv.id));
    }
    await addAllocationTx(tx, id, p.invoiceId, money(p.amount));
  }
  await verifyCustomerReceiptSettlementTx(tx, receiptId);
}
async function addAllocationTx(
  tx: Tx,
  settlementId: number,
  invoiceId: number,
  amount: Decimal,
) {
  const [old] = await tx
    .select()
    .from(allocations)
    .where(
      and(
        eq(allocations.settlementId, settlementId),
        eq(allocations.invoiceId, invoiceId),
      ),
    )
    .for("update");
  if (old) {
    await tx
      .update(allocations)
      .set({ amount: toDbMoney(money(old.amount).plus(amount)) })
      .where(eq(allocations.id, old.id));
  } else
    await tx.insert(allocations).values({
      settlementId,
      invoiceId,
      originalInvoiceId: invoiceId,
      originalAmount: toDbMoney(amount),
      amount: toDbMoney(amount),
    });
}

/** Called under the exclusive company gate for a generic customer receipt, before AR adjustment. */
export async function settleCustomerReceiptTx(
  tx: Tx,
  receiptId: number,
  actor: Actor,
) {
  const r = await sourceTx(tx, receiptId);
  if (r.direction !== "IN" || r.invoiceId != null)
    conflict("هذا المصدر ليس سند قبض عاماً");
  const [prior] = await tx
    .select()
    .from(settlements)
    .where(eq(settlements.receiptId, receiptId))
    .for("update");
  if (prior) {
    await assertSourceTx(tx, prior);
    if (prior.reversalReceiptId != null) conflict("السند معكوس بالفعل");
    await assertCustomerReceiptConservationTx(tx, prior.id);
    return;
  }
  const open = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, r.partyId!),
        eq(invoices.branchId, r.branchId),
        sql`${invoices.status} IN ('PENDING','PARTIALLY_PAID')`,
      ),
    )
    .orderBy(asc(invoices.id))
    .for("update");
  open.sort(
    (a, b) =>
      new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime() ||
      a.id - b.id,
  );
  const deliveryBlocked = await activeDeliveryInvoiceIdsTx(
    tx,
    open.map((inv) => inv.id),
  );
  const invoiceOpen = open.reduce(
    (sum, inv) =>
      sum.plus(
        Decimal.max(
          0,
          money(inv.total).minus(inv.returnedTotal).minus(inv.paidAmount),
        ),
      ),
    money(0),
  );
  // The current PAYMENT_IN has already posted; exclude it when measuring opening/unbilled debt.
  // يشمل استحقاقات أجور التنفيذ وإشعاراتها ومقاصات الفروع، ويستثني فقط عرابين المسودات/أوامر الشغل/الرقمي
  // التي ما زالت محتجزة (HELD) غير مفوترة بعد؛ أما العرابين المطبقة على فاتورة SALE فتُحتسب لتوازن قيد SALE.
  const [scope] = await tx
    .select({
      balance: sql<string>`COALESCE(SUM(${customerEntryArNetExprSql()}), 0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.customerId, r.partyId!),
        eq(accountingEntries.branchId, r.branchId),
        sql`(${accountingEntries.receiptId} IS NULL OR ${accountingEntries.receiptId} <> ${receiptId})`,
        entryNotUnappliedHoldReceiptCond(accountingEntries.receiptId),
      ),
    );
  const [manualArScope] = await tx
    .select({
      net: sql<string>`COALESCE(SUM(CAST(${journalLines.debit} AS DECIMAL(15,2)) - CAST(${journalLines.credit} AS DECIMAL(15,2))), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalId))
    .where(
      and(
        eq(journalLines.customerId, r.partyId!),
        inArray(journalLines.role, ["AR", "ACCOUNTS_RECEIVABLE"]),
        eq(journalEntries.status, "POSTED"),
        eq(journalEntries.postingProfile, "MANUAL_JOURNAL"),
        sql`COALESCE(${journalLines.branchId}, ${journalEntries.branchId}) = ${r.branchId}`,
      ),
    );
  const accountDebt = Decimal.max(
    0,
    money(scope?.balance).plus(manualArScope?.net ?? 0).minus(invoiceOpen),
  );
  let available = money(r.amount);
  const plan: { invoiceId: number; amount: string }[] = [];
  for (const inv of open) {
    if (deliveryBlocked.has(inv.id)) continue;
    const part = Decimal.min(
      available,
      Decimal.max(
        0,
        money(inv.total).minus(inv.returnedTotal).minus(inv.paidAmount),
      ),
    );
    if (part.lte(0)) continue;
    plan.push({ invoiceId: inv.id, amount: toDbMoney(part) });
    available = available.minus(part);
  }
  const accountAmount = Decimal.min(available, accountDebt);
  available = available.minus(accountAmount);
  const result = await tx.insert(settlements).values({
    receiptId,
    customerId: r.partyId!,
    branchId: r.branchId,
    amount: toDbMoney(r.amount),
    accountAmount: toDbMoney(accountAmount),
    unallocatedAmount: toDbMoney(available),
    initialUnallocatedAmount: toDbMoney(available),
    sourceHash: sourceHash(r),
    createdBy: actor.userId,
  });
  const settlementId = extractInsertId(result);
  for (const part of plan) {
    await allocateVoucherToInvoiceTx(tx, {
      invoiceId: part.invoiceId,
      amount: money(part.amount),
      installmentEffect: { sourceReceiptId: receiptId, effectReceiptId: receiptId, effectKey: `FIFO:${receiptId}:${part.invoiceId}` },
      direction: "IN",
      paymentMethod: r.paymentMethod,
      voucherBranchId: r.branchId,
    });
    await addAllocationTx(tx, settlementId, part.invoiceId, money(part.amount));
  }
  await assertCustomerReceiptConservationTx(tx, settlementId);
  await logAuditTx(tx, actor, {
    action: "customer.receipt.fifo",
    entityType: "receipt",
    entityId: receiptId,
    newValue: {
      settlementId,
      invoiceCount: plan.length,
      allocatedAmount: toDbMoney(
        money(r.amount).minus(accountAmount).minus(available),
      ),
      accountAmount: toDbMoney(accountAmount),
      creditAmount: toDbMoney(available),
    },
  });
}

/** Consume proven advance credit on a locked invoice. No new money or AR movement. */
export async function applyCustomerReceiptCreditTx(
  tx: Tx,
  invoiceId: number,
  limit: Decimal,
  actor: Actor,
): Promise<Decimal> {
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  if (!inv?.customerId || isDeadInvoice(inv)) return money(0);
  if ((await activeDeliveryInvoiceIdsTx(tx, [invoiceId])).has(invoiceId))
    return money(0);
  const sources = await tx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.customerId, inv.customerId),
        eq(settlements.branchId, inv.branchId),
        isNull(settlements.reversalReceiptId),
        sql`${settlements.unallocatedAmount} > 0`,
      ),
    )
    .orderBy(asc(settlements.id))
    .for("update");
  let remaining = Decimal.min(
    limit,
    Decimal.max(
      0,
      money(inv.total).minus(inv.returnedTotal).minus(inv.paidAmount),
    ),
  );
  const before = remaining;
  for (const h of sources) {
    const part = Decimal.min(remaining, money(h.unallocatedAmount));
    if (part.lte(0)) break;
    const r = await assertSourceTx(tx, h);
    await allocateVoucherToInvoiceTx(tx, {
      invoiceId,
      amount: part,
      direction: "IN",
      paymentMethod: r.paymentMethod,
      voucherBranchId: h.branchId,
      installmentEffect: { sourceReceiptId: r.id, effectReceiptId: r.id,
        effectKey: `CREDIT:${h.id}:${invoiceId}:${toDbMoney(h.unallocatedAmount)}:${toDbMoney(part)}` },
    });
    await addAllocationTx(tx, h.id, invoiceId, part);
    await tx
      .update(settlements)
      .set({
        unallocatedAmount: toDbMoney(money(h.unallocatedAmount).minus(part)),
      })
      .where(eq(settlements.id, h.id));
    await assertCustomerReceiptConservationTx(tx, h.id);
    await logAuditTx(tx, actor, {
      action: "customer.receipt.applyCredit",
      entityType: "receipt",
      entityId: h.receiptId,
      newValue: { invoiceId, amount: toDbMoney(part) },
    });
    remaining = remaining.minus(part);
  }
  return before.minus(remaining);
}

async function assertInvoiceNoActiveInstallmentPlanTx(
  tx: Tx,
  inv: { id: number; invoiceNumber?: string | null },
): Promise<void> {
  const [activePlan] = await tx
    .select({ id: installmentPlans.id })
    .from(installmentPlans)
    .where(eq(installmentPlans.activeInvoiceGuard, inv.id))
    .for("share")
    .limit(1);
  if (activePlan) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تسوية فاتورة أقساط نشطة من الرصيد التاريخي",
        why: `الفاتورة #${inv.invoiceNumber ?? inv.id} خاضعة لخطة أقساط نشطة ولا يمكن تحديث مدفوعها دون تخصيص قسط موثق بإيصال`,
        doThis: "استخدم مسار تحصيل الأقساط أو سند قبض عميل مرتبط بالخطة لضمان اتزان الأقساط",
      }),
    });
  }
}

/**
 * تطبيق الرصيد التاريخي أو القيود اليدوية الدائنة للعميل داخل نفس الفرع (مع استبعاد عرابين الحجز)
 * على الفاتورة دون مساس بالصندوق أو الخزينة، مع قيد مقاصة متوازن يصون اتزان reconcileCustomerBalances.
 */
export async function applyCustomerHistoricalCreditTx(
  tx: Tx,
  invoiceId: number,
  limit: Decimal,
  actor: Actor,
  requestKey?: string,
): Promise<Decimal> {
  if (!limit.gt(0)) return money(0);
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update")
    .limit(1);
  if (!inv || inv.customerId == null || isDeadInvoice(inv)) return money(0);

  const invRem = Decimal.max(
    0,
    money(inv.total).minus(inv.returnedTotal ?? 0).minus(inv.paidAmount),
  );
  const cap = Decimal.min(limit, invRem);
  if (!cap.gt(0)) return money(0);

  const scopeMap = await computeCustomerBranchScopeTx(tx, {
    customerIds: [inv.customerId],
    branchId: inv.branchId,
  });
  const scope = scopeMap.get(`${inv.customerId}:${inv.branchId}`);
  const histAvailable = scope?.sameBranchAdditionalHistorical ?? money(0);
  const applyAmt = Decimal.min(cap, histAvailable);
  if (!applyAmt.gt(0)) return money(0);

  await assertInvoiceNoActiveInstallmentPlanTx(tx, inv);

  const paidBeforeStr = toDbMoney(inv.paidAmount);
  await allocateVoucherToInvoiceTx(tx, {
    invoiceId: inv.id,
    amount: applyAmt,
    direction: "IN",
    voucherBranchId: inv.branchId,
  });

  const token = createHash("sha256")
    .update(`${inv.id}:${paidBeforeStr}:${toDbMoney(applyAmt)}:${requestKey ?? "auto"}`)
    .digest("hex")
    .slice(0, 32);
  const histComponents = {
    roleDebits: { AR: applyAmt },
    roleCredits: { INTERBRANCH_CLEARING: applyAmt },
  };
  const offsetComponents = {
    roleDebits: { INTERBRANCH_CLEARING: applyAmt },
    roleCredits: { AR: applyAmt },
  };
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: inv.branchId,
    createdBy: actor.userId,
    customerId: inv.customerId,
    amount: applyAmt,
    dedupeKey: `CUSTOMER_CREDIT_APPLY:HIST:${token}`,
    notes: `تسوية فاتورة #${inv.invoiceNumber ?? inv.id} من الرصيد التاريخي للعميل`,
    postingIntent: createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_OUT",
      "ADJUST",
      [debitLine("AR", applyAmt), creditLine("INTERBRANCH_CLEARING", applyAmt)],
      histComponents,
    ),
    postingSourceComponents: histComponents,
  });
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: inv.branchId,
    createdBy: actor.userId,
    customerId: inv.customerId,
    amount: applyAmt,
    dedupeKey: `CUSTOMER_CREDIT_APPLY:OFFSET:${token}`,
    notes: `مقابل تسوية فاتورة #${inv.invoiceNumber ?? inv.id} من الرصيد التاريخي للعميل`,
    postingIntent: createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_IN",
      "ADJUST",
      [debitLine("INTERBRANCH_CLEARING", applyAmt), creditLine("AR", applyAmt)],
      offsetComponents,
    ),
    postingSourceComponents: offsetComponents,
  });

  await logAuditTx(tx, actor, {
    action: "customer.receipt.applyHistoricalCredit",
    entityType: "invoice",
    entityId: inv.id,
    branchId: inv.branchId,
    newValue: {
      invoiceId: inv.id,
      amount: toDbMoney(applyAmt),
      clientRequestId: requestKey ?? null,
    },
  });

  return applyAmt;
}

/**
 * إجمالي الرصيد التاريخي غير المتتبع المُطبّق فعلياً على فاتورة محددة (بما يشمل تسويات الفروع)،
 * مع مراعاة حالات التصحيح السابقة للفاتورة عبر `customer.historicalCredit.correctionState`.
 */
type HistoricalCreditSourceSlice = { sourceBranchId: number; amount: string };

async function loadHistoricalCreditBreakdownForInvoiceTx(
  tx: Tx,
  invoiceId: number,
  invoiceBranchId?: number | null,
): Promise<{
  total: Decimal;
  sameBranch: Decimal;
  interbranchBySource: Map<number, Decimal>;
}> {
  const rows = await tx
    .select({
      action: auditLogs.action,
      branchId: auditLogs.branchId,
      newValue: auditLogs.newValue,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, "invoice"),
        eq(auditLogs.entityId, String(invoiceId)),
        inArray(auditLogs.action, [
          "customer.receipt.applyHistoricalCredit",
          "customer.historicalCredit.correctionState",
        ]),
      ),
    )
    .orderBy(asc(auditLogs.id));

  let sameBranch = money(0);
  let interbranchBySource = new Map<number, Decimal>();
  for (const row of rows) {
    const val = row.newValue as {
      amount?: unknown;
      activeAmount?: unknown;
      sourceBranchId?: unknown;
      interbranchSources?: HistoricalCreditSourceSlice[];
    } | null;
    if (row.action === "customer.historicalCredit.correctionState") {
      interbranchBySource = new Map<number, Decimal>();
      const activeTotal = round2(Decimal.max(0, money((val?.activeAmount as string | number | undefined) ?? "0")));
      let ibSum = money(0);
      if (Array.isArray(val?.interbranchSources) && activeTotal.gt(0)) {
        for (const item of val.interbranchSources) {
          const sb = Number(item.sourceBranchId);
          const amt = round2(Decimal.max(0, money(item.amount ?? "0")));
          if (Number.isSafeInteger(sb) && sb > 0 && amt.gt(0)) {
            interbranchBySource.set(sb, (interbranchBySource.get(sb) ?? money(0)).plus(amt));
            ibSum = ibSum.plus(amt);
          }
        }
      }
      sameBranch = round2(Decimal.max(0, activeTotal.minus(ibSum)));
    } else {
      const amt = round2(Decimal.max(0, money((val?.amount as string | number | undefined) ?? "0")));
      if (!amt.gt(0)) continue;
      const srcBranch = val?.sourceBranchId != null ? Number(val.sourceBranchId) : null;
      const targetBranch = invoiceBranchId ?? (row.branchId != null ? Number(row.branchId) : null);
      if (srcBranch != null && targetBranch != null && srcBranch !== targetBranch) {
        interbranchBySource.set(srcBranch, (interbranchBySource.get(srcBranch) ?? money(0)).plus(amt));
      } else {
        sameBranch = sameBranch.plus(amt);
      }
    }
  }
  const ibTotal = Array.from(interbranchBySource.values()).reduce((s, a) => s.plus(a), money(0));
  return {
    total: round2(sameBranch.plus(ibTotal)),
    sameBranch: round2(sameBranch),
    interbranchBySource,
  };
}

/**
 * إجمالي الرصيد التاريخي غير المتتبع المُطبّق فعلياً على فاتورة محددة (بما يشمل تسويات الفروع)،
 * مع مراعاة حالات التصحيح والإلغاء السابقة للفاتورة عبر `customer.historicalCredit.correctionState`.
 */
export async function loadHistoricalCreditAllocatedForInvoiceTx(
  tx: Tx,
  invoiceId: number,
): Promise<Decimal> {
  return (await loadHistoricalCreditBreakdownForInvoiceTx(tx, invoiceId)).total;
}

async function postSameBranchHistoricalCreditReversalTx(
  tx: Tx,
  input: {
    branchId: number;
    customerId: number;
    amount: Decimal;
    actor: Actor;
    token: string;
    noteSuffix: string;
  },
): Promise<void> {
  const amt = round2(Decimal.max(0, input.amount));
  if (!amt.gt(0)) return;
  const revComponents = {
    roleDebits: { INTERBRANCH_CLEARING: amt },
    roleCredits: { AR: amt },
  };
  const revOffsetComponents = {
    roleDebits: { AR: amt },
    roleCredits: { INTERBRANCH_CLEARING: amt },
  };
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    createdBy: input.actor.userId,
    customerId: input.customerId,
    amount: amt,
    dedupeKey: `CUSTOMER_CREDIT_APPLY:HIST_REV:${input.token}`,
    notes: `عكس رصيد عميل تاريخي مطبّق (${input.noteSuffix})`,
    postingIntent: createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_IN",
      "ADJUST",
      [debitLine("INTERBRANCH_CLEARING", amt), creditLine("AR", amt)],
      revComponents,
    ),
    postingSourceComponents: revComponents,
  });
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    createdBy: input.actor.userId,
    customerId: input.customerId,
    amount: amt,
    dedupeKey: `CUSTOMER_CREDIT_APPLY:OFFSET_REV:${input.token}`,
    notes: `مقابل عكس رصيد عميل تاريخي مطبّق (${input.noteSuffix})`,
    postingIntent: createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_OUT",
      "ADJUST",
      [debitLine("AR", amt), creditLine("INTERBRANCH_CLEARING", amt)],
      revOffsetComponents,
    ),
    postingSourceComponents: revOffsetComponents,
  });
}

async function postInterbranchHistoricalCreditReversalTx(
  tx: Tx,
  input: {
    invoiceId: number;
    invoiceBranchId: number;
    sourceBranchId: number;
    customerId: number;
    amount: Decimal;
    actor: Actor;
    token: string;
    noteSuffix: string;
  },
): Promise<void> {
  const amt = round2(Decimal.max(0, input.amount));
  if (!amt.gt(0)) return;
  const outComponents = {
    roleDebits: { AR: amt },
    roleCredits: { INTERBRANCH_CLEARING: amt },
  };
  const inComponents = {
    roleDebits: { INTERBRANCH_CLEARING: amt },
    roleCredits: { AR: amt },
  };
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.invoiceBranchId,
    createdBy: input.actor.userId,
    customerId: input.customerId,
    invoiceId: input.invoiceId,
    amount: amt,
    dedupeKey: `CUSTOMER_INTERBRANCH_OUT:HIST_REV:${input.token}`,
    notes: `عكس مقاصة تاريخية بين الفروع (${input.noteSuffix})`,
    postingIntent: createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_OUT",
      "ADJUST",
      [debitLine("AR", amt), creditLine("INTERBRANCH_CLEARING", amt)],
      outComponents,
    ),
    postingSourceComponents: outComponents,
  });
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.sourceBranchId,
    createdBy: input.actor.userId,
    customerId: input.customerId,
    amount: amt,
    dedupeKey: `CUSTOMER_INTERBRANCH_IN:HIST_REV:${input.token}`,
    notes: `استرجاع مقاصة تاريخية لفرع المصدر #${input.sourceBranchId} (${input.noteSuffix})`,
    postingIntent: createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_IN",
      "ADJUST",
      [debitLine("INTERBRANCH_CLEARING", amt), creditLine("AR", amt)],
      inComponents,
    ),
    postingSourceComponents: inComponents,
  });
}

/**
 * نقل الرصيد التاريخي المُطبّق عند تصحيح الفاتورة (`sales.correct`) وإصدار عكس متوازن لـ`HIST_REV`
 * لما تم تحريره إلى رصيد العميل الدائن كي يظل `reconcileCustomerBalances` متطابقاً تماماً.
 */
export async function transferHistoricalCreditAllocationOnCorrectionTx(
  tx: Tx,
  input: {
    fromInvoiceId: number;
    toInvoiceId: number;
    customerId: number | null;
    branchId: number;
    carriedAmount: Decimal;
    releasedToCreditAmount: Decimal;
    actor: Actor;
    requestKey: string;
  },
): Promise<void> {
  const carried = round2(Decimal.max(0, input.carriedAmount));
  const released = round2(Decimal.max(0, input.releasedToCreditAmount));
  const breakdown = await loadHistoricalCreditBreakdownForInvoiceTx(
    tx,
    input.fromInvoiceId,
    input.branchId,
  );

  // احتساب الجزء المحمول للمصادر المتفرعة والمحليّة على الترتيب
  let remCarry = carried;
  const carriedIb: HistoricalCreditSourceSlice[] = [];
  const releasedIb: Array<{ sourceBranchId: number; amount: Decimal }> = [];
  for (const [srcBranchId, amt] of Array.from(breakdown.interbranchBySource.entries())) {
    const take = round2(Decimal.min(remCarry, amt));
    if (take.gt(0)) carriedIb.push({ sourceBranchId: srcBranchId, amount: toDbMoney(take) });
    const drop = round2(amt.minus(take));
    if (drop.gt(0)) releasedIb.push({ sourceBranchId: srcBranchId, amount: drop });
    remCarry = round2(remCarry.minus(take));
  }
  const carriedSame = round2(Decimal.min(remCarry, breakdown.sameBranch));
  const releasedSame = round2(
    Decimal.min(released, Decimal.max(0, breakdown.sameBranch.minus(carriedSame))),
  );

  await logAuditTx(tx, input.actor, {
    action: "customer.historicalCredit.correctionState",
    entityType: "invoice",
    entityId: input.fromInvoiceId,
    branchId: input.branchId,
    newValue: {
      activeAmount: "0.00",
      supersededByInvoiceId: input.toInvoiceId,
      releasedToCreditAmount: toDbMoney(released),
    },
  });

  if (carried.gt(0)) {
    await logAuditTx(tx, input.actor, {
      action: "customer.historicalCredit.correctionState",
      entityType: "invoice",
      entityId: input.toInvoiceId,
      branchId: input.branchId,
      newValue: {
        activeAmount: toDbMoney(carried),
        fromInvoiceId: input.fromInvoiceId,
        ...(carriedIb.length > 0 ? { interbranchSources: carriedIb } : {}),
      },
    });
  }

  if (released.gt(0) && input.customerId != null) {
    const revToken = createHash("sha256")
      .update(`${input.fromInvoiceId}:${input.toInvoiceId}:${input.requestKey}`)
      .digest("hex")
      .slice(0, 32);
    const noteSuffix = `تصحيح #${input.fromInvoiceId} ← #${input.toInvoiceId}`;
    await postSameBranchHistoricalCreditReversalTx(tx, {
      branchId: input.branchId,
      customerId: input.customerId,
      amount: releasedSame,
      actor: input.actor,
      token: revToken,
      noteSuffix,
    });
    let ibRemRelease = round2(Decimal.max(0, released.minus(releasedSame)));
    for (const ib of releasedIb) {
      if (!ibRemRelease.gt(0)) break;
      const step = round2(Decimal.min(ibRemRelease, ib.amount));
      const ibToken = createHash("sha256")
        .update(`${revToken}:${ib.sourceBranchId}`)
        .digest("hex")
        .slice(0, 32);
      await postInterbranchHistoricalCreditReversalTx(tx, {
        invoiceId: input.fromInvoiceId,
        invoiceBranchId: input.branchId,
        sourceBranchId: ib.sourceBranchId,
        customerId: input.customerId,
        amount: step,
        actor: input.actor,
        token: ibToken,
        noteSuffix,
      });
      ibRemRelease = round2(ibRemRelease.minus(step));
    }
  }
}

/**
 * عكس تسويات الرصيد التاريخي (نفس الفرع وبين الفروع) عند إلغاء الفاتورة بالكامل
 * حتى يتطابق `reconcileCustomerBalances` مع عكس ذمة العميل بعد الإلغاء.
 */
export async function releaseHistoricalCreditOnInvoiceCancelTx(
  tx: Tx,
  input: {
    invoiceId: number;
    customerId: number | null;
    branchId: number;
    actor: Actor;
    requestKey: string;
  },
): Promise<void> {
  if (input.customerId == null) return;
  const breakdown = await loadHistoricalCreditBreakdownForInvoiceTx(
    tx,
    input.invoiceId,
    input.branchId,
  );
  if (!breakdown.total.gt(0)) return;

  const cancelToken = createHash("sha256")
    .update(`cancel:${input.invoiceId}:${input.requestKey}`)
    .digest("hex")
    .slice(0, 32);
  const noteSuffix = `إلغاء فاتورة #${input.invoiceId}`;

  await postSameBranchHistoricalCreditReversalTx(tx, {
    branchId: input.branchId,
    customerId: input.customerId,
    amount: breakdown.sameBranch,
    actor: input.actor,
    token: cancelToken,
    noteSuffix,
  });

  for (const [srcBranchId, ibAmt] of Array.from(breakdown.interbranchBySource.entries())) {
    if (!ibAmt.gt(0)) continue;
    const ibToken = createHash("sha256")
      .update(`${cancelToken}:${srcBranchId}`)
      .digest("hex")
      .slice(0, 32);
    await postInterbranchHistoricalCreditReversalTx(tx, {
      invoiceId: input.invoiceId,
      invoiceBranchId: input.branchId,
      sourceBranchId: srcBranchId,
      customerId: input.customerId,
      amount: ibAmt,
      actor: input.actor,
      token: ibToken,
      noteSuffix,
    });
  }

  await logAuditTx(tx, input.actor, {
    action: "customer.historicalCredit.correctionState",
    entityType: "invoice",
    entityId: input.invoiceId,
    branchId: input.branchId,
    newValue: {
      activeAmount: "0.00",
      cancelledInvoiceId: input.invoiceId,
      releasedOnCancelAmount: toDbMoney(breakdown.total),
    },
  });
}

/** Track real account refunds so refunded advances cannot pay a later invoice again. */
export async function consumeCustomerReceiptCreditTx(
  tx: Tx,
  receiptId: number,
  actor: Actor,
  limit?: Decimal,
) {
  const r = await sourceTx(tx, receiptId);
  if (r.direction !== "OUT") conflict("مصدر رد الرصيد ليس صرفاً فعلياً");
  const existing = await tx
    .select()
    .from(creditUses)
    .where(eq(creditUses.receiptId, receiptId))
    .for("update");
  if (existing.length) return;
  const sources = await tx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.customerId, r.partyId!),
        eq(settlements.branchId, r.branchId),
        isNull(settlements.reversalReceiptId),
        sql`${settlements.unallocatedAmount} > 0`,
      ),
    )
    .orderBy(asc(settlements.id))
    .for("update");
  let remaining = Decimal.min(money(r.amount), limit ?? money(r.amount));
  for (const h of sources) {
    const part = Decimal.min(remaining, money(h.unallocatedAmount));
    if (part.lte(0)) break;
    await assertSourceTx(tx, h);
    await tx
      .insert(creditUses)
      .values({ settlementId: h.id, receiptId, amount: toDbMoney(part) });
    await tx
      .update(settlements)
      .set({
        unallocatedAmount: toDbMoney(money(h.unallocatedAmount).minus(part)),
        refundedAmount: toDbMoney(money(h.refundedAmount).plus(part)),
      })
      .where(eq(settlements.id, h.id));
    await assertCustomerReceiptConservationTx(tx, h.id);
    remaining = remaining.minus(part);
  }
  await logAuditTx(tx, actor, {
    action: "customer.receipt.refundCredit",
    entityType: "receipt",
    entityId: receiptId,
    newValue: {
      trackedAmount: toDbMoney(
        Decimal.min(money(r.amount), limit ?? money(r.amount)).minus(remaining),
      ),
    },
  });
}

/** Counter receipts undo their original allocation/credit use; they never start a new FIFO. */
export async function reverseCustomerReceiptSettlementTx(
  tx: Tx,
  originalId: number,
  counterId: number,
  actor: Actor,
): Promise<boolean> {
  const counter = await sourceTx(tx, counterId);
  const original = await sourceTx(tx, originalId, true);
  if (
    original.direction === counter.direction ||
    original.partyId !== counter.partyId ||
    original.branchId !== counter.branchId ||
    original.paymentMethod !== counter.paymentMethod ||
    !money(original.amount).eq(counter.amount)
  )
    conflict("السند العكسي لا يطابق أصله");
  if (original.direction === "OUT") {
    const uses = await tx
      .select()
      .from(creditUses)
      .where(eq(creditUses.receiptId, originalId))
      .orderBy(asc(creditUses.settlementId))
      .for("update");
    for (const use of uses) {
      if (use.reversalReceiptId != null) {
        if (use.reversalReceiptId !== counterId)
          conflict("رد الرصيد معكوس بالفعل");
        continue;
      }
      const [h] = await tx
        .select()
        .from(settlements)
        .where(eq(settlements.id, use.settlementId))
        .for("update");
      if (
        !h ||
        h.reversalReceiptId != null ||
        money(h.refundedAmount).lt(use.amount)
      )
        conflict("مصدر رد الرصيد تغير");
      await assertSourceTx(tx, h);
      await tx
        .update(settlements)
        .set({
          unallocatedAmount: toDbMoney(
            money(h.unallocatedAmount).plus(use.amount),
          ),
          refundedAmount: toDbMoney(money(h.refundedAmount).minus(use.amount)),
        })
        .where(eq(settlements.id, h.id));
      await tx
        .update(creditUses)
        .set({ reversalReceiptId: counterId })
        .where(eq(creditUses.id, use.id));
      await assertCustomerReceiptConservationTx(tx, h.id);
    }
    return uses.length > 0;
  }
  const [h] = await tx
    .select()
    .from(settlements)
    .where(eq(settlements.receiptId, originalId))
    .for("update");
  if (!h) return false; // Old single-invoice receipts retain their existing inverse.
  await assertSourceTx(tx, h);
  if (h.reversalReceiptId != null) {
    if (h.reversalReceiptId !== counterId) conflict("القبض معكوس بالفعل");
    return true;
  }
  if (money(h.refundedAmount).gt(0))
    conflict(
      "عُدّ جزء من هذا القبض للعميل؛ اعكس مستند الرد أولاً لمنع صرفه مرتين",
    );
  const portions = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.settlementId, h.id))
    .orderBy(asc(allocations.invoiceId))
    .for("update");
  const deliveryBlocked = await activeDeliveryInvoiceIdsTx(
    tx,
    portions.filter((a) => money(a.amount).gt(0)).map((a) => a.invoiceId),
  );
  if (deliveryBlocked.size)
    conflict(
      "بعض حصص القبض صارت عربوناً لإرسالية نشطة؛ ألغ إسناد التوصيل من مساره المعتمد أولاً ثم أعد اعتماد العكس",
    );
  for (const a of portions) {
    if (money(a.amount).lte(0)) continue;
    // A native refund belongs to its original payment pool. Do not steal another source's paid balance.
    const [refund] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          eq(receipts.invoiceId, a.invoiceId),
          eq(receipts.direction, "OUT"),
          eq(receipts.status, "COMPLETED"),
          eq(receipts.approvalStatus, "APPROVED"),
        ),
      )
      .limit(1);
    if (refund)
      conflict(
        `الفاتورة #${a.invoiceId} لها رد منفذ؛ اعكس مستند الرد قبل إلغاء القبض`,
      );
    const [invBranch] = await tx
      .select({ branchId: invoices.branchId })
      .from(invoices)
      .where(eq(invoices.id, a.invoiceId))
      .limit(1);
    await allocateVoucherToInvoiceTx(tx, {
      invoiceId: a.invoiceId,
      amount: money(a.amount),
      direction: "OUT",
      installmentEffect: { sourceReceiptId: originalId, effectReceiptId: counterId, effectKey: `REVERSE:${counterId}`,
        reverseSourceReceiptId: originalId },
    });
    if (invBranch && Number(invBranch.branchId) !== Number(h.branchId)) {
      const revAmt = money(a.amount);
      const revOutComponents = {
        roleDebits: { AR: revAmt },
        roleCredits: { INTERBRANCH_CLEARING: revAmt },
      };
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(invBranch.branchId),
        createdBy: actor.userId,
        customerId: h.customerId,
        invoiceId: a.invoiceId,
        amount: revAmt,
        dedupeKey: `CUSTOMER_INTERBRANCH_OUT:REV:${counterId}:${h.id}:${a.invoiceId}`,
        notes: `عكس مقاصة بين الفروع لفاتورة #${a.invoiceId} بسبب إلغاء السند #${originalId}`,
        postingIntent: createPostingIntent(
          "ADJUST_CUSTOMER_AR_INTERBRANCH_OUT",
          "ADJUST",
          [debitLine("AR", revAmt), creditLine("INTERBRANCH_CLEARING", revAmt)],
          revOutComponents,
        ),
        postingSourceComponents: revOutComponents,
      });
      const revInComponents = {
        roleDebits: { INTERBRANCH_CLEARING: revAmt },
        roleCredits: { AR: revAmt },
      };
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(h.branchId),
        createdBy: actor.userId,
        customerId: h.customerId,
        amount: revAmt,
        dedupeKey: `CUSTOMER_INTERBRANCH_IN:REV:${counterId}:${h.id}:${a.invoiceId}`,
        notes: `عكس مقاصة بين الفروع على فرع المصدر بسبب إلغاء السند #${originalId}`,
        postingIntent: createPostingIntent(
          "ADJUST_CUSTOMER_AR_INTERBRANCH_IN",
          "ADJUST",
          [debitLine("INTERBRANCH_CLEARING", revAmt), creditLine("AR", revAmt)],
          revInComponents,
        ),
        postingSourceComponents: revInComponents,
      });
    }
  }
  await tx
    .update(settlements)
    .set({ reversalReceiptId: counterId })
    .where(eq(settlements.id, h.id));
  await assertCustomerReceiptConservationTx(tx, h.id);
  await logAuditTx(tx, actor, {
    action: "customer.receipt.reverse",
    entityType: "receipt",
    entityId: originalId,
    newValue: { counterReceiptId: counterId, invoiceCount: portions.length },
  });
  return true;
}

/** Same-customer correction moves only this invoice's portions, never the multi-invoice receipt. */
export async function transferCustomerReceiptAllocationsTx(
  tx: Tx,
  originalInvoiceId: number,
  replacementInvoiceId: number,
  paidCapacity: Decimal,
  options?: {
    actor?: Actor;
    requestKey?: string;
    unwindInterbranchReleased?: boolean;
  },
) {
  const [origInv] = await tx
    .select({ id: invoices.id, branchId: invoices.branchId })
    .from(invoices)
    .where(eq(invoices.id, originalInvoiceId))
    .limit(1);
  const rows = await tx
    .select({ a: allocations, h: settlements })
    .from(allocations)
    .innerJoin(settlements, eq(settlements.id, allocations.settlementId))
    .where(
      and(
        eq(allocations.invoiceId, originalInvoiceId),
        isNull(settlements.reversalReceiptId),
      ),
    )
    .orderBy(asc(allocations.id))
    .for("update");
  let remaining = Decimal.max(0, paidCapacity);
  for (const { a, h } of rows) {
    const carried = Decimal.min(remaining, money(a.amount));
    const released = money(a.amount).minus(carried);
    await tx
      .update(allocations)
      .set({ invoiceId: replacementInvoiceId, amount: toDbMoney(carried) })
      .where(eq(allocations.id, a.id));
    if (released.gt(0)) {
      await tx
        .update(settlements)
        .set({
          unallocatedAmount: sql`${settlements.unallocatedAmount} + ${toDbMoney(released)}`,
        })
        .where(eq(settlements.id, h.id));
      if (
        options?.unwindInterbranchReleased &&
        options.actor &&
        origInv &&
        Number(h.branchId) !== Number(origInv.branchId)
      ) {
        const revHash = createHash("sha256")
          .update(`${originalInvoiceId}:${replacementInvoiceId}:${h.id}:${a.id}:${options.requestKey ?? ""}`)
          .digest("hex")
          .slice(0, 32);
        const revOutComponents = {
          roleDebits: { AR: released },
          roleCredits: { INTERBRANCH_CLEARING: released },
        };
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: Number(origInv.branchId),
          createdBy: options.actor.userId,
          customerId: h.customerId,
          invoiceId: originalInvoiceId,
          amount: released,
          dedupeKey: `CUSTOMER_INTERBRANCH_OUT:CORR:${revHash}`,
          notes: `عكس مقاصة بين الفروع لفاتورة مصحَّحة #${originalInvoiceId} → #${replacementInvoiceId}`,
          postingIntent: createPostingIntent(
            "ADJUST_CUSTOMER_AR_INTERBRANCH_OUT",
            "ADJUST",
            [debitLine("AR", released), creditLine("INTERBRANCH_CLEARING", released)],
            revOutComponents,
          ),
          postingSourceComponents: revOutComponents,
        });
        const revInComponents = {
          roleDebits: { INTERBRANCH_CLEARING: released },
          roleCredits: { AR: released },
        };
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: Number(h.branchId),
          createdBy: options.actor.userId,
          customerId: h.customerId,
          invoiceId: originalInvoiceId,
          amount: released,
          dedupeKey: `CUSTOMER_INTERBRANCH_IN:CORR:${revHash}`,
          notes: `استرجاع مقاصة بين الفروع لفرع المصدر #${h.branchId} بعد تصحيح الفاتورة #${originalInvoiceId}`,
          postingIntent: createPostingIntent(
            "ADJUST_CUSTOMER_AR_INTERBRANCH_IN",
            "ADJUST",
            [debitLine("INTERBRANCH_CLEARING", released), creditLine("AR", released)],
            revInComponents,
          ),
          postingSourceComponents: revInComponents,
        });
      }
    }
    await assertCustomerReceiptConservationTx(tx, h.id);
    remaining = remaining.minus(carried);
  }
}

export async function customerReceiptAllocatedAmountTx(
  tx: Tx,
  invoiceId: number,
) {
  const rows = await tx
    .select({ amount: allocations.amount })
    .from(allocations)
    .innerJoin(settlements, eq(settlements.id, allocations.settlementId))
    .where(
      and(
        eq(allocations.invoiceId, invoiceId),
        isNull(settlements.reversalReceiptId),
      ),
    );
  return rows.reduce((sum, a) => sum.plus(a.amount), money(0));
}

export async function customerReceiptCreditTotalTx(tx: Tx, customerId: number) {
  const rows = await tx
    .select({ amount: settlements.unallocatedAmount })
    .from(settlements)
    .where(
      and(
        eq(settlements.customerId, customerId),
        isNull(settlements.reversalReceiptId),
      ),
    );
  return rows.reduce((sum, row) => sum.plus(row.amount), money(0));
}

/**
 * مقاصة رصيد دائن للعميل من فرع مصدر إلى فرع هدف عبر حساب المقاصة بين الفروع (`INTERBRANCH_CLEARING`)
 * بترتيب الأقفال (`invoices -> customers -> settlements`) ودون حركة نقدية أو تغيير في صافي الرصيد الكلي.
 */
export async function clearCustomerCreditInterbranchTx(
  tx: Tx,
  input: {
    customerId: number;
    sourceBranchId: number;
    targetBranchId: number;
    invoiceId?: number;
    amount?: string;
    requestKey: string;
    note?: string;
  },
  actor: Actor,
): Promise<{
  settledAmount: string;
  invoiceId: number | null;
  entryOutId: number | null;
  entryInId: number | null;
  balanceBefore: string;
  balanceAfter: string;
}> {
  if (input.sourceBranchId === input.targetBranchId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذرت المقاصة بين الفروع",
        why: "فرع المصدر والفرع المستهدف متطابقان",
        doThis: "استخدم التسوية المباشرة لنفس الفرع بدلاً من المقاصة بين الفروع",
      }),
    });
  }
  // 1) قفل الفواتير المفتوحة في الفرع المستهدف أولاً (invoices -> customers -> settlements)
  const targetInvoices = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, input.customerId),
        eq(invoices.branchId, input.targetBranchId),
        sql`${invoices.status} IN ('PENDING', 'PARTIALLY_PAID')`,
        ...(input.invoiceId != null ? [eq(invoices.id, input.invoiceId)] : []),
      ),
    )
    .orderBy(asc(invoices.id))
    .for("update");

  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .for("update");
  if (!cust) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذرت المقاصة",
        why: "حساب العميل غير موجود",
        doThis: "تحقق من معرف العميل وأعد المحاولة",
      }),
    });
  }
  const balanceBefore = toDbMoney(cust.currentBalance ?? "0");

  const sources = await tx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.customerId, input.customerId),
        eq(settlements.branchId, input.sourceBranchId),
        isNull(settlements.reversalReceiptId),
        sql`${settlements.unallocatedAmount} > 0`,
      ),
    )
    .orderBy(asc(settlements.id))
    .for("update");

  const deliveryBlocked = targetInvoices.length
    ? await activeDeliveryInvoiceIdsTx(
        tx,
        targetInvoices.map((i) => i.id),
      )
    : new Set<number>();

  const eligibleInvoices = targetInvoices.filter(
    (inv) =>
      !isDeadInvoice(inv) &&
      !deliveryBlocked.has(inv.id) &&
      money(inv.total).minus(inv.returnedTotal ?? 0).minus(inv.paidAmount).gt(0),
  );
  if (!eligibleInvoices.length) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لا توجد فواتير مفتوحة مؤهلة للمقاصة في الفرع المستهدف",
        why: "الفواتير مسددة أو مرتبطة بتحصيل مندوب نشط",
        doThis: "راجع كشف العميل وتأكد من بقاء فاتورة مفتوحة في الفرع المطلوب",
      }),
    });
  }

  const totalOpenTarget = eligibleInvoices.reduce(
    (sum, inv) =>
      sum.plus(
        money(inv.total).minus(inv.returnedTotal ?? 0).minus(inv.paidAmount),
      ),
    money(0),
  );
  const totalSourceAvailable = sources.reduce(
    (sum, h) => sum.plus(h.unallocatedAmount),
    money(0),
  );

  const scopeMap = await computeCustomerBranchScopeTx(tx, {
    customerIds: [input.customerId],
    branchId: input.sourceBranchId,
  });
  const sourceScope = scopeMap.get(`${input.customerId}:${input.sourceBranchId}`);
  const historicalSourceCredit = sourceScope?.crossBranchAdditionalHistorical ?? money(0);
  const availableCredit = totalSourceAvailable.plus(historicalSourceCredit);

  if (!availableCredit.gt(0)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لا يوجد رصيد دائن متاح في فرع المصدر",
        why: `الفرع رقم ${input.sourceBranchId} لا يملك رصيداً دائناً غير مخصص للعميل`,
        doThis: "راجع كشف العميل في فرع المصدر قبل إجراء المقاصة",
      }),
    });
  }

  const requestedCap = input.amount != null ? money(input.amount) : availableCredit;
  const maxTransfer = Decimal.min(requestedCap, Decimal.min(availableCredit, totalOpenTarget));
  if (!maxTransfer.gt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "مبلغ المقاصة غير صالح",
        why: "المبلغ المطلوب صفر أو لا يغطي أياً من الفواتير المفتوحة",
        doThis: "أدخل مبلغاً موجباً ضمن الرصيد الدائن المتاح والمطلوب",
      }),
    });
  }

  let left = maxTransfer;
  let settledTotal = money(0);
  let trackedSettledTotal = money(0);
  let historicalSettledTotal = money(0);
  const settledInvoiceIds: number[] = [];
  let entryOutId: number | null = null;
  let entryInId: number | null = null;

  // استهلاك مصادر التخصيص المتتبعة في فرع المصدر أولاً ثم الرصيد التاريخي الإضافي بالتتابع.
  let consumeLeft = Decimal.min(maxTransfer, totalSourceAvailable);
  const touchedSourceIds: number[] = [];
  const sourcePortions: Array<{ receiptId: number | null; paymentMethod: string; amount: Decimal; settlementId: number }> = [];
  for (const h of sources) {
    if (consumeLeft.lte(0)) break;
    const part = Decimal.min(consumeLeft, money(h.unallocatedAmount));
    if (part.lte(0)) continue;
    const r = await assertSourceTx(tx, h);
    sourcePortions.push({
      receiptId: r.id,
      paymentMethod: r.paymentMethod,
      amount: part,
      settlementId: h.id,
    });
    consumeLeft = consumeLeft.minus(part);
  }
  let histRemaining = Decimal.min(
    maxTransfer.minus(sourcePortions.reduce((s, p) => s.plus(p.amount), money(0))),
    historicalSourceCredit,
  );

  for (const inv of eligibleInvoices) {
    if (left.lte(0)) break;
    const needed = money(inv.total).minus(inv.returnedTotal ?? 0).minus(inv.paidAmount);
    const applyAmt = Decimal.min(left, needed);
    if (applyAmt.lte(0)) continue;

    let invApplied = money(0);
    let invPortionLeft = applyAmt;
    for (const sp of sourcePortions) {
      if (invPortionLeft.lte(0) || sp.amount.lte(0)) continue;
      const stepAmt = Decimal.min(invPortionLeft, sp.amount);
      await allocateVoucherToInvoiceTx(tx, {
        invoiceId: inv.id,
        amount: stepAmt,
        direction: "IN",
        paymentMethod: sp.paymentMethod,
        voucherBranchId: input.sourceBranchId,
        allowInterBranchClearing: true,
        installmentEffect: sp.receiptId != null
          ? {
              sourceReceiptId: sp.receiptId,
              effectReceiptId: sp.receiptId,
              effectKey: `INTERBRANCH:${input.requestKey}:${sp.settlementId}:${inv.id}`,
            }
          : undefined,
      });
      await addAllocationTx(tx, sp.settlementId, inv.id, stepAmt);
      const [curH] = await tx.select().from(settlements).where(eq(settlements.id, sp.settlementId));
      if (curH) {
        await tx
          .update(settlements)
          .set({ unallocatedAmount: toDbMoney(money(curH.unallocatedAmount).minus(stepAmt)) })
          .where(eq(settlements.id, sp.settlementId));
      }
      if (!touchedSourceIds.includes(sp.settlementId)) touchedSourceIds.push(sp.settlementId);
      sp.amount = sp.amount.minus(stepAmt);
      invPortionLeft = invPortionLeft.minus(stepAmt);
      invApplied = invApplied.plus(stepAmt);
      trackedSettledTotal = trackedSettledTotal.plus(stepAmt);
    }

    if (invPortionLeft.gt(0) && histRemaining.gt(0)) {
      await assertInvoiceNoActiveInstallmentPlanTx(tx, inv);
      const histStep = Decimal.min(invPortionLeft, histRemaining);
      await allocateVoucherToInvoiceTx(tx, {
        invoiceId: inv.id,
        amount: histStep,
        direction: "IN",
        voucherBranchId: input.sourceBranchId,
        allowInterBranchClearing: true,
      });
      histRemaining = histRemaining.minus(histStep);
      invApplied = invApplied.plus(histStep);
      historicalSettledTotal = historicalSettledTotal.plus(histStep);
      await logAuditTx(tx, actor, {
        action: "customer.receipt.applyHistoricalCredit",
        entityType: "invoice",
        entityId: inv.id,
        branchId: inv.branchId,
        newValue: {
          invoiceId: inv.id,
          amount: toDbMoney(histStep),
          clientRequestId: `${input.requestKey}:IB:${inv.id}`,
          sourceBranchId: input.sourceBranchId,
        },
      });
    }

    if (invApplied.gt(0)) {
      settledInvoiceIds.push(inv.id);
      settledTotal = settledTotal.plus(invApplied);
      left = left.minus(invApplied);
    }
  }

  for (const sid of touchedSourceIds) {
    await assertCustomerReceiptConservationTx(tx, sid);
  }

  const singleInvoiceId = settledInvoiceIds.length === 1 ? settledInvoiceIds[0]! : null;
  if (settledTotal.gt(0)) {
    const postOutEntry = async (mode: "TRACKED" | "HIST", amt: Decimal) => {
      const outSourceComponents = {
        roleDebits: { AR: amt },
        roleCredits: { INTERBRANCH_CLEARING: amt },
      };
      const outIntent = createPostingIntent(
        "ADJUST_CUSTOMER_AR_INTERBRANCH_OUT",
        "ADJUST",
        [debitLine("AR", amt), creditLine("INTERBRANCH_CLEARING", amt)],
        outSourceComponents,
      );
      const keyToken =
        input.requestKey.length <= 42
          ? input.requestKey
          : createHash("sha256").update(input.requestKey).digest("hex").slice(0, 32);
      return postEntry(tx, {
        entryType: "ADJUST",
        branchId: input.sourceBranchId,
        createdBy: actor.userId,
        customerId: input.customerId,
        amount: amt,
        dedupeKey: `CUSTOMER_INTERBRANCH_OUT:${mode}:${keyToken}`,
        notes: input.note?.trim() || `مقاصة رصيد عميل بين فرع ${input.sourceBranchId} وفرع ${input.targetBranchId}`,
        postingIntent: outIntent,
        postingSourceComponents: outSourceComponents,
      });
    };

    if (trackedSettledTotal.gt(0)) {
      entryOutId = await postOutEntry("TRACKED", trackedSettledTotal);
    }
    if (historicalSettledTotal.gt(0)) {
      const histOutId = await postOutEntry("HIST", historicalSettledTotal);
      if (entryOutId == null) entryOutId = histOutId;
    }

    const inSourceComponents = {
      roleDebits: { INTERBRANCH_CLEARING: settledTotal },
      roleCredits: { AR: settledTotal },
    };
    const inIntent = createPostingIntent(
      "ADJUST_CUSTOMER_AR_INTERBRANCH_IN",
      "ADJUST",
      [debitLine("INTERBRANCH_CLEARING", settledTotal), creditLine("AR", settledTotal)],
      inSourceComponents,
    );
    const inKeyToken =
      input.requestKey.length <= 48
        ? input.requestKey
        : createHash("sha256").update(input.requestKey).digest("hex").slice(0, 32);
    entryInId = await postEntry(tx, {
      entryType: "ADJUST",
      branchId: input.targetBranchId,
      createdBy: actor.userId,
      customerId: input.customerId,
      invoiceId: singleInvoiceId,
      amount: settledTotal,
      dedupeKey: `CUSTOMER_INTERBRANCH_IN:${inKeyToken}`,
      notes: input.note?.trim() || `استلام مقاصة رصيد عميل من فرع ${input.sourceBranchId} إلى فرع ${input.targetBranchId}`,
      postingIntent: inIntent,
      postingSourceComponents: inSourceComponents,
    });
  }

  return {
    settledAmount: toDbMoney(settledTotal),
    invoiceId: singleInvoiceId,
    entryOutId,
    entryInId,
    balanceBefore,
    balanceAfter: balanceBefore,
  };
}

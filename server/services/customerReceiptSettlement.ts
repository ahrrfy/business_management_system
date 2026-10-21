import { activeDeliveryInvoiceIdsTx } from "./delivery/guards";
/** Receipt provenance only. Cash, ledger and AR remain owned by the caller's transaction. */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  accountingEntries,
  customerReceiptAllocations as allocations,
  customerReceiptCreditUses as creditUses,
  customerReceiptSettlements as settlements,
  invoices,
  receipts,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { isDeadInvoice } from "@shared/predicates";
import { logAuditTx } from "./auditService";
import { money, toDbMoney } from "./money";
import type { Actor } from "./tx";
import { allocateVoucherToInvoiceTx } from "./voucher/invoiceAllocation";

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
    if (money(p.applyAmount).gt(0))
      await allocateVoucherToInvoiceTx(tx, {
        invoiceId: p.invoiceId,
        amount: money(p.applyAmount),
        direction: "IN",
        paymentMethod: r.paymentMethod,
        voucherBranchId: r.branchId,
      });
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
  const [scope] = await tx
    .select({
      balance: sql<string>`COALESCE(SUM(CASE
    WHEN ${accountingEntries.entryType} IN ('SALE','RETURN','OPENING') THEN ${accountingEntries.amount}
    WHEN ${accountingEntries.entryType} = 'PAYMENT_IN' THEN -${accountingEntries.amount}
    WHEN ${accountingEntries.entryType} = 'PAYMENT_OUT' THEN ${accountingEntries.amount}
    WHEN ${accountingEntries.entryType} = 'ADJUST' AND ${accountingEntries.dedupeKey} LIKE 'INVOICE_CORRECTION_CUSTOMER_RECLASS:%' THEN ${accountingEntries.amount}
    WHEN ${accountingEntries.entryType} = 'DELIVERY_REMIT' AND ${accountingEntries.dedupeKey} LIKE 'INVOICE_AMEND_CUSTODY:%' THEN ${accountingEntries.amount}
    ELSE 0 END),0)`,
    })
    .from(accountingEntries)
    .where(
      and(
        eq(accountingEntries.customerId, r.partyId!),
        eq(accountingEntries.branchId, r.branchId),
        sql`(${accountingEntries.receiptId} IS NULL OR ${accountingEntries.receiptId} <> ${receiptId})`,
      ),
    );
  const accountDebt = Decimal.max(0, money(scope?.balance).minus(invoiceOpen));
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
    await allocateVoucherToInvoiceTx(tx, {
      invoiceId: a.invoiceId,
      amount: money(a.amount),
      direction: "OUT",
    });
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
) {
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
    if (released.gt(0))
      await tx
        .update(settlements)
        .set({
          unallocatedAmount: sql`${settlements.unallocatedAmount} + ${toDbMoney(released)}`,
        })
        .where(eq(settlements.id, h.id));
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

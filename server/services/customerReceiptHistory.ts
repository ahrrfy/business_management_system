/** Reconstruct old receipt provenance; never receive cash or change customer AR. */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { isDeadInvoice } from "@shared/predicates";
import {
  accountingEntries,
  auditLogs,
  customers,
  customerReceiptSettlements,
  deliveryConsignments,
  deliveryLedgerEntries,
  invoices,
  orderPayments,
  receipts,
  users,
  workOrders,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { money, toDbMoney } from "./money";
import { withGovernanceTx, requireDb, type Actor } from "./tx";
import { logAuditTx } from "./auditService";
import { loadRefundCapsByInvoiceIds } from "./returns/refundCaps";
import { activeDeliveryInvoiceIdsTx } from "./delivery/guards";
import {
  adoptHistoricalCustomerReceiptTx,
  verifyCustomerReceiptSettlementTx,
} from "./customerReceiptSettlement";

const ACTION = "customer.receipt.history.adopt";
const requestSchema = z
  .object({
    receiptIds: z.array(z.number().int().positive()).min(1).max(200),
    cutoffUtc: z.string().datetime(),
  })
  .strict();
export type CustomerReceiptHistoryRequest = z.infer<typeof requestSchema>;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fail(why: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: "تعذرت مطابقة سندات القبض التاريخية",
      why,
      doThis:
        "أعد المعاينة من مصادر القبض والدفتر والتوصيل الحالية؛ لم يُنشأ قبض أو خفض ذمة جديد",
    }),
  });
}
function normalize(raw: CustomerReceiptHistoryRequest) {
  const input = requestSchema.parse(raw);
  if (new Set(input.receiptIds).size !== input.receiptIds.length)
    fail("معرف سند مكرر في النطاق");
  return {
    ...input,
    receiptIds: input.receiptIds.slice().sort((a, b) => a - b),
  };
}
async function evidence(tx: Tx, input: CustomerReceiptHistoryRequest) {
  const sources = await tx
    .select()
    .from(receipts)
    .where(inArray(receipts.id, input.receiptIds))
    .orderBy(asc(receipts.id));
  if (sources.length !== input.receiptIds.length) fail("أحد مصادر القبض مفقود");
  const customerIds = Array.from(
    new Set(
      sources.map((r) => r.partyId).filter((id): id is number => id != null),
    ),
  ).sort((a, b) => a - b);
  if (!customerIds.length) fail("سندات بلا عميل مثبت");
  const invoiceRows = await tx
    .select()
    .from(invoices)
    .where(inArray(invoices.customerId, customerIds))
    .orderBy(asc(invoices.id))
    .limit(5001);
  if (invoiceRows.length > 5000) fail("النطاق أكبر من حد المعالجة التاريخية");
  const invoiceIds = invoiceRows.map((i) => i.id);
  const customerRows = await tx
    .select({ id: customers.id, currentBalance: customers.currentBalance })
    .from(customers)
    .where(inArray(customers.id, customerIds))
    .orderBy(asc(customers.id));
  const ledger = await tx
    .select({
      id: accountingEntries.id,
      entryType: accountingEntries.entryType,
      branchId: accountingEntries.branchId,
      customerId: accountingEntries.customerId,
      receiptId: accountingEntries.receiptId,
      invoiceId: accountingEntries.invoiceId,
      deliveryPartyId: accountingEntries.deliveryPartyId,
      amount: accountingEntries.amount,
      entryDate: accountingEntries.entryDate,
      dedupeKey: accountingEntries.dedupeKey,
      createdAt: accountingEntries.createdAt,
    })
    .from(accountingEntries)
    .where(
      or(
        inArray(accountingEntries.customerId, customerIds),
        inArray(accountingEntries.receiptId, input.receiptIds),
        invoiceIds.length
          ? inArray(accountingEntries.invoiceId, invoiceIds)
          : undefined,
      ),
    )
    .orderBy(asc(accountingEntries.id))
    .limit(20001);
  if (ledger.length > 20000) fail("دفتر النطاق أكبر من حد المعالجة التاريخية");
  const receiptRows = await tx
    .select({
      id: receipts.id,
      invoiceId: receipts.invoiceId,
      workOrderId: receipts.workOrderId,
      reservationId: receipts.reservationId,
      branchId: receipts.branchId,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      cashBucket: receipts.cashBucket,
      shiftId: receipts.shiftId,
      status: receipts.status,
      approvalStatus: receipts.approvalStatus,
      partyId: receipts.partyId,
      partyType: receipts.partyType,
      voucherNumber: receipts.voucherNumber,
      createdAt: receipts.createdAt,
    })
    .from(receipts)
    .where(
      or(
        and(
          eq(receipts.partyType, "CUSTOMER"),
          inArray(receipts.partyId, customerIds),
        ),
        invoiceIds.length ? inArray(receipts.invoiceId, invoiceIds) : undefined,
        inArray(
          receipts.id,
          tx
            .select({ id: workOrders.depositReceiptId })
            .from(workOrders)
            .where(inArray(workOrders.customerId, customerIds)),
        ),
      ),
    )
    .orderBy(asc(receipts.id))
    .limit(10001);
  if (receiptRows.length > 10000)
    fail("إيصالات النطاق أكبر من حد المعالجة التاريخية");
  const holds = await tx
    .select({
      id: workOrders.id,
      customerId: workOrders.customerId,
      branchId: workOrders.branchId,
      deposit: workOrders.deposit,
      depositReceiptId: workOrders.depositReceiptId,
    })
    .from(workOrders)
    .where(
      and(
        inArray(workOrders.customerId, customerIds),
        isNull(workOrders.invoiceId),
        sql`${workOrders.deposit}>0 AND ${workOrders.status}<>'CANCELLED'`,
      ),
    )
    .orderBy(asc(workOrders.id));
  const payments = await tx
    .select()
    .from(orderPayments)
    .where(
      or(
        inArray(orderPayments.customerId, customerIds),
        inArray(orderPayments.receiptId, input.receiptIds),
      ),
    )
    .orderBy(asc(orderPayments.id));
  const tracked = await tx
    .select()
    .from(customerReceiptSettlements)
    .where(inArray(customerReceiptSettlements.customerId, customerIds))
    .orderBy(asc(customerReceiptSettlements.id));
  const delivery = invoiceIds.length
    ? await tx
        .select()
        .from(deliveryConsignments)
        .where(inArray(deliveryConsignments.invoiceId, invoiceIds))
        .orderBy(asc(deliveryConsignments.id))
    : [];
  const deliveryIds = delivery.map((d) => d.id);
  const custody = deliveryIds.length
    ? await tx
        .select()
        .from(deliveryLedgerEntries)
        .where(inArray(deliveryLedgerEntries.consignmentId, deliveryIds))
        .orderBy(asc(deliveryLedgerEntries.id))
    : [];
  const caps = await loadRefundCapsByInvoiceIds(tx, invoiceIds);
  const courierFamilies = [
    "PAYMENT_IN:COURIER_DELIVERY:",
    "PAYMENT_IN:COURIER_DELIVERY_SUPP:",
    "PAYMENT_IN:REMIT:",
    "PAYMENT_IN:WRITEOFF:CN:",
    "PAYMENT_IN:DELIVERY_RECONCILE:",
  ];
  for (const entry of ledger.filter(
    (e) => e.entryType === "PAYMENT_IN" && e.deliveryPartyId != null,
  )) {
    const inv = invoiceRows.find((i) => i.id === entry.invoiceId);
    if (
      inv &&
      (entry.customerId !== inv.customerId ||
        entry.branchId !== inv.branchId ||
        !courierFamilies.some((prefix) => entry.dedupeKey?.startsWith(prefix)))
    )
      fail(`مصدر تحصيل التوصيل للفاتورة #${inv.id} غير مطابق`);
  }
  if (ledger.some((e) => e.dedupeKey?.startsWith("INVOICE_AMEND_CUSTODY:")))
    fail(
      "نطاق يتضمن نقل عهدة عبر تصحيح فاتورة يحتاج مطابقة سلسلة المصدر أولاً",
    );
  const funding = invoiceRows.map((i) => ({
    invoiceId: i.id,
    amount: toDbMoney(
      Decimal.max(
        0,
        (caps.get(i.id)?.nonCourierNet ?? money(0)).plus(
          ledger
            .filter(
              (e) =>
                e.invoiceId === i.id &&
                e.entryType === "PAYMENT_IN" &&
                e.deliveryPartyId != null,
            )
            .reduce((sum, e) => sum.plus(e.amount), money(0)),
        ),
      ),
    ),
  }));
  const blocked = Array.from(
    await activeDeliveryInvoiceIdsTx(tx, invoiceIds),
  ).sort((a, b) => a - b);
  return {
    sources,
    customerIds,
    invoiceRows,
    customerRows,
    ledger,
    receiptRows,
    holds,
    payments,
    tracked,
    delivery,
    custody,
    funding,
    blocked,
  };
}
type Evidence = Awaited<ReturnType<typeof evidence>>;
type Portion = { invoiceId: number; amount: string; applyAmount: string };
type SourcePlan = {
  receiptId: number;
  customerId: number;
  branchId: number;
  amount: string;
  accountAmount: string;
  unallocatedAmount: string;
  allocations: Portion[];
};
function arAmount(e: Evidence["ledger"][number]) {
  if (["SALE", "RETURN", "OPENING", "PAYMENT_OUT"].includes(e.entryType))
    return money(e.amount);
  if (e.entryType === "PAYMENT_IN") return money(e.amount).neg();
  if (
    (e.entryType === "ADJUST" &&
      e.dedupeKey?.startsWith("INVOICE_CORRECTION_CUSTOMER_RECLASS:")) ||
    (e.entryType === "DELIVERY_REMIT" &&
      e.dedupeKey?.startsWith("INVOICE_AMEND_CUSTODY:"))
  )
    return money(e.amount);
  return money(0);
}
function planHistory(input: CustomerReceiptHistoryRequest, e: Evidence) {
  const sum = <T>(rows: T[], value: (r: T) => Decimal) =>
    rows.reduce((a, r) => a.plus(value(r)), money(0));
  const funding = new Map(e.funding.map((f) => [f.invoiceId, money(f.amount)]));
  const blocked = new Set(e.blocked);
  for (const r of e.sources) {
    const entries = e.ledger.filter((x) => x.receiptId === r.id);
    if (
      r.direction !== "IN" ||
      r.partyType !== "CUSTOMER" ||
      !r.partyId ||
      r.branchId == null ||
      r.invoiceId != null ||
      r.workOrderId != null ||
      r.reservationId != null ||
      !r.voucherNumber ||
      r.status !== "COMPLETED" ||
      r.approvalStatus !== "APPROVED" ||
      r.createdAt >= new Date(input.cutoffUtc) ||
      money(r.amount).lte(0)
    )
      fail(`مصدر غير مؤهل #${r.id}`);
    if (
      entries.length !== 1 ||
      entries[0].entryType !== "PAYMENT_IN" ||
      entries[0].customerId !== r.partyId ||
      entries[0].branchId !== r.branchId ||
      entries[0].invoiceId != null ||
      entries[0].deliveryPartyId != null ||
      !money(entries[0].amount).eq(r.amount)
    )
      fail(`القيد الأصلي لا يطابق المصدر #${r.id}`);
    if (e.payments.some((p) => p.receiptId === r.id))
      fail(`السند #${r.id} مملوك لمسار عربون/تطبيق قائم`);
    if (e.tracked.some((h) => h.receiptId === r.id))
      fail(`السند #${r.id} مرتبط مسبقاً`);
  }
  for (const c of e.customerRows) {
    const ledger = sum(
      e.ledger.filter((x) => x.customerId === c.id),
      arAmount,
    );
    const held = sum(
      e.holds.filter((h) => h.customerId === c.id),
      (h) => {
        const receipt = e.receiptRows.find((r) => r.id === h.depositReceiptId);
        if (
          !receipt ||
          receipt.status !== "COMPLETED" ||
          receipt.approvalStatus !== "APPROVED" ||
          receipt.direction !== "IN" ||
          !money(receipt.amount).eq(h.deposit ?? "0")
        )
          fail(`عربون محتجز بلا دليل مطابق #${h.id}`);
        return money(h.deposit);
      },
    );
    if (
      e.payments.some(
        (p) =>
          p.customerId === c.id &&
          p.kind === "COLLECTION" &&
          p.status === "HELD",
      )
    )
      fail(`للعميل #${c.id} عربون استقبال محتجز يتطلب فصل مصدره`);
    if (!ledger.plus(held).eq(c.currentBalance))
      fail(`كشف العميل #${c.id} لا يطابق دفتره بعد فصل العرابين`);
  }
  const sources: SourcePlan[] = [];
  let existingTotal = money(0),
    appliedTotal = money(0),
    accountTotal = money(0),
    unallocatedTotal = money(0);
  const groups = Array.from(
    new Set(e.sources.map((r) => `${r.partyId}:${r.branchId}`)),
  ).sort();
  for (const inv of e.invoiceRows) {
    if (
      !isDeadInvoice(inv) &&
      money(inv.paidAmount).gt(funding.get(inv.id) ?? money(0)) &&
      !groups.includes(`${inv.customerId}:${inv.branchId}`)
    )
      fail(`سداد غير منسوب في فرع آخر للفاتورة #${inv.id}`);
  }
  for (const key of groups) {
    const group = e.sources
      .filter((r) => `${r.partyId}:${r.branchId}` === key)
      .sort((a, b) => {
        const ea = e.ledger.find((x) => x.receiptId === a.id)!,
          eb = e.ledger.find((x) => x.receiptId === b.id)!;
        return (
          new Date(ea.entryDate).getTime() - new Date(eb.entryDate).getTime() ||
          ea.id - eb.id
        );
      });
    const customerId = group[0].partyId!,
      branchId = group[0].branchId!;
    const eligible = e.invoiceRows
      .filter(
        (i) =>
          i.customerId === customerId &&
          i.branchId === branchId &&
          !isDeadInvoice(i),
      )
      .sort(
        (a, b) =>
          new Date(a.invoiceDate).getTime() -
            new Date(b.invoiceDate).getTime() || a.id - b.id,
      );
    const total = sum(group, (r) => money(r.amount));
    const customerLedger = e.ledger.filter((x) => x.customerId === customerId);
    const unscoped = sum(
      customerLedger.filter((x) => x.branchId == null),
      arAmount,
    );
    if (
      !unscoped.isZero() &&
      customerLedger.some(
        (x) =>
          x.branchId != null &&
          x.branchId !== branchId &&
          !arAmount(x).isZero(),
      )
    )
      fail(`للعميل #${customerId} رصيد عام وفروع متعددة دون مقاصة مثبتة`);
    const scopeLedger = customerLedger.filter(
      (x) => x.branchId === branchId || x.branchId == null,
    );
    const open = sum(eligible, (i) =>
      Decimal.max(0, money(i.total).minus(i.returnedTotal).minus(i.paidAmount)),
    );
    const accountBalance = sum(scopeLedger, arAmount).plus(
      sum(
        e.holds.filter(
          (h) => h.customerId === customerId && h.branchId === branchId,
        ),
        (h) => money(h.deposit),
      ),
    );
    const tracked = e.tracked.filter(
      (h) =>
        h.customerId === customerId &&
        h.branchId === branchId &&
        h.reversalReceiptId == null,
    );
    const remainingTracked = sum(tracked, (h) => money(h.unallocatedAmount));
    const targets = eligible.map((i) => {
      const known = funding.get(i.id) ?? money(0);
      if (known.gt(i.paidAmount))
        fail(`الفاتورة #${i.id} لها مصدر مثبت لا يطابق مدفوعها`);
      const existing = money(i.paidAmount).minus(known);
      if (blocked.has(i.id) && existing.gt(0))
        fail(`الفاتورة #${i.id} لها عهدة نشطة وسداد قديم غير منسوب`);
      return {
        invoiceId: i.id,
        existing,
        fresh: money(0),
        open: blocked.has(i.id)
          ? money(0)
          : Decimal.max(
              0,
              money(i.total).minus(i.returnedTotal).minus(i.paidAmount),
            ),
      };
    });
    const existing = sum(targets, (t) => t.existing);
    if (existing.gt(total))
      fail(`السداد القديم للعميل #${customerId} يتجاوز مصادره المختارة`);
    const free = Decimal.min(
      total.minus(existing),
      Decimal.max(0, open.minus(accountBalance).minus(remainingTracked)),
    );
    let available = free;
    for (const t of targets) {
      t.fresh = Decimal.min(available, t.open);
      available = available.minus(t.fresh);
    }
    let account = total.minus(existing).minus(free);
    const generalOut = e.receiptRows
      .filter(
        (r) =>
          r.partyId === customerId &&
          r.branchId === branchId &&
          r.partyType === "CUSTOMER" &&
          r.direction === "OUT" &&
          r.invoiceId == null &&
          r.workOrderId == null &&
          r.reservationId == null &&
          r.voucherNumber &&
          r.approvalStatus === "APPROVED" &&
          r.status === "COMPLETED",
      )
      .filter((r) => {
        const entries = e.ledger.filter((x) => x.receiptId === r.id);
        return (
          entries.length === 1 &&
          entries[0].entryType === "PAYMENT_OUT" &&
          entries[0].customerId === customerId &&
          entries[0].branchId === branchId &&
          entries[0].invoiceId == null &&
          entries[0].deliveryPartyId == null &&
          money(entries[0].amount).eq(r.amount)
        );
      });
    const accountSupport = Decimal.max(
      0,
      sum(
        scopeLedger.filter(
          (x) =>
            x.entryType === "OPENING" ||
            (x.entryType === "PAYMENT_OUT" &&
              generalOut.some((r) => r.id === x.receiptId)),
        ),
        (x) => money(x.amount),
      ).minus(sum(tracked, (h) => money(h.accountAmount))),
    );
    if (account.gt(accountSupport))
      fail(
        `جزء الحساب للعميل #${customerId} غير مدعوم بافتتاحي أو صرف حسابي مثبت`,
      );
    existingTotal = existingTotal.plus(existing);
    appliedTotal = appliedTotal.plus(free.minus(available));
    accountTotal = accountTotal.plus(account);
    unallocatedTotal = unallocatedTotal.plus(available);
    for (const r of group) {
      let budget = money(r.amount);
      const accountPart = Decimal.min(budget, account);
      account = account.minus(accountPart);
      budget = budget.minus(accountPart);
      const allocations: Portion[] = [];
      for (const t of targets) {
        const old = Decimal.min(budget, t.existing);
        t.existing = t.existing.minus(old);
        budget = budget.minus(old);
        const fresh = Decimal.min(budget, t.fresh);
        t.fresh = t.fresh.minus(fresh);
        budget = budget.minus(fresh);
        if (old.plus(fresh).gt(0))
          allocations.push({
            invoiceId: t.invoiceId,
            amount: toDbMoney(old.plus(fresh)),
            applyAmount: toDbMoney(fresh),
          });
      }
      const unallocated = Decimal.min(budget, available);
      available = available.minus(unallocated);
      budget = budget.minus(unallocated);
      if (!budget.isZero()) fail(`باق غير مثبت للسند #${r.id}`);
      sources.push({
        receiptId: r.id,
        customerId,
        branchId,
        amount: r.amount,
        accountAmount: toDbMoney(accountPart),
        unallocatedAmount: toDbMoney(unallocated),
        allocations,
      });
    }
    if (
      !account.isZero() ||
      !available.isZero() ||
      targets.some((t) => !t.existing.isZero() || !t.fresh.isZero())
    )
      fail(`خطة العميل #${customerId} لا تحفظ الأجزاء`);
  }
  return {
    sources,
    totals: {
      receiptCount: sources.length,
      customerCount: e.customerIds.length,
      sourceAmount: toDbMoney(
        existingTotal
          .plus(appliedTotal)
          .plus(accountTotal)
          .plus(unallocatedTotal),
      ),
      existingPaidLinked: toDbMoney(existingTotal),
      newInvoiceAllocation: toDbMoney(appliedTotal),
      accountAmount: toDbMoney(accountTotal),
      unallocatedAmount: toDbMoney(unallocatedTotal),
      newCash: "0.00",
      newLedgerEntries: 0,
      newCustomerBalanceEffect: "0.00",
    },
  };
}
async function previewTx(tx: Tx, input: CustomerReceiptHistoryRequest) {
  const e = await evidence(tx, input);
  const ids = await tx
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        inArray(receipts.partyId, e.customerIds),
        eq(receipts.partyType, "CUSTOMER"),
        eq(receipts.direction, "IN"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.approvalStatus, "APPROVED"),
        isNull(receipts.invoiceId),
        isNull(receipts.workOrderId),
        isNull(receipts.reservationId),
        lt(receipts.createdAt, new Date(input.cutoffUtc)),
        sql`${receipts.voucherNumber} IS NOT NULL`,
        sql`NOT EXISTS(SELECT 1 FROM customerReceiptSettlements h WHERE h.receiptId=${receipts.id})`,
      ),
    )
    .orderBy(asc(receipts.id));
  if (JSON.stringify(ids.map((r) => r.id)) !== JSON.stringify(input.receiptIds))
    fail("نطاق العميل لا يشمل جميع سنداته التاريخية المؤهلة");
  const plan = planHistory(input, e);
  return { input, e, plan, evidenceHash: digest({ input, e, plan }) };
}
export async function previewCustomerReceiptHistory(
  raw: CustomerReceiptHistoryRequest,
) {
  const input = normalize(raw);
  return requireDb().transaction(
    async (tx) => {
      const p = await previewTx(tx, input);
      return { input, evidenceHash: p.evidenceHash, ...p.plan };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function adoptCustomerReceiptHistory(
  raw: CustomerReceiptHistoryRequest & {
    batchKey: string;
    evidenceHash: string;
  },
  actor: Actor,
) {
  const { batchKey, evidenceHash, ...request } = raw;
  if (
    !/^[a-zA-Z0-9_-]{1,50}$/.test(batchKey) ||
    !/^[a-f0-9]{64}$/.test(evidenceHash)
  )
    fail("بصمة أو رقم دفعة غير صالح");
  const input = normalize(request);
  return withGovernanceTx(async (tx) => {
    const [owner] = await tx
      .select()
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share");
    if (!owner?.isOwner || !owner.isActive)
      fail("التصحيح التاريخي يتطلب مالكاً نشطاً مثبتاً في القاعدة");
    const [prior] = await tx
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, ACTION), eq(auditLogs.entityId, batchKey)),
      );
    if (prior) {
      const saved = prior.newValue as {
        evidenceHash: string;
        requestHash: string;
        totals: ReturnType<typeof planHistory>["totals"];
      };
      if (
        saved.evidenceHash !== evidenceHash ||
        saved.requestHash !== digest(input)
      )
        fail("رقم الدفعة مستعمل لخطة أخرى");
      for (const id of input.receiptIds)
        await verifyCustomerReceiptSettlementTx(tx, id);
      return { mode: "REPLAY_VERIFIED" as const, ...saved.totals };
    }
    const p = await previewTx(tx, input);
    if (p.evidenceHash !== evidenceHash)
      fail("تغيرت مصادر أو فواتير الخطة بعد المعاينة");
    for (const r of p.plan.sources)
      await adoptHistoricalCustomerReceiptTx(tx, r.receiptId, r, actor);
    const after = await evidence(tx, input);
    if (
      digest([
        p.e.customerRows,
        p.e.ledger,
        p.e.receiptRows,
        p.e.delivery,
        p.e.custody,
      ]) !==
      digest([
        after.customerRows,
        after.ledger,
        after.receiptRows,
        after.delivery,
        after.custody,
      ])
    )
      fail("المعالجة غيّرت نقداً أو دفتراً أو ذمة أو عهدة");
    const expected = new Map<number, Decimal>();
    for (const r of p.plan.sources)
      for (const a of r.allocations)
        expected.set(
          a.invoiceId,
          (expected.get(a.invoiceId) ?? money(0)).plus(a.applyAmount),
        );
    const afterFunding = new Map(
      after.funding.map((f) => [f.invoiceId, money(f.amount)]),
    );
    for (const inv of after.invoiceRows) {
      const before = p.e.invoiceRows.find((i) => i.id === inv.id)!;
      if (
        !money(inv.paidAmount).eq(
          money(before.paidAmount).plus(expected.get(inv.id) ?? money(0)),
        )
      )
        fail(`تغير مدفوع الفاتورة #${inv.id} خارج حصتها`);
      if (
        expected.has(inv.id) &&
        !(afterFunding.get(inv.id) ?? money(0)).eq(inv.paidAmount)
      )
        fail(`مصدر الفاتورة #${inv.id} لا يطابق التسوية`);
    }
    await logAuditTx(tx, actor, {
      action: ACTION,
      entityType: "customerReceiptHistory",
      entityId: batchKey,
      newValue: {
        evidenceHash,
        requestHash: digest(input),
        receiptIds: input.receiptIds,
        totals: p.plan.totals,
        reconstruction: "FIFO_SOURCE_LINKS_EXISTING_MONEY_ONLY",
      },
    });
    return { mode: "APPLIED" as const, ...p.plan.totals };
  });
}

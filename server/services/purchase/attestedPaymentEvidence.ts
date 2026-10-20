import { loadSupplierBookSourceClaims } from "./supplierBookProjection";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  accountingEntries,
  receipts,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
  supplierPayments,
  supplierPaymentRefundRequests,
  supplierPaymentRefunds,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { supplierApEffectSql } from "../ledger/supplierApEffect";
import { money } from "../money";
import { usesInvoiceCurrencySettlement } from "./supplierVoucherCurrency";
import { sha256, stableCanonical } from "./grniAccounting";

const LIMIT = 1000;
type FinancialRow = Record<string, unknown>;
export type AttestedPaymentEvidence = {
  paymentIds: number[];
  receiptIds: number[];
  entryIds: number[];
  invoiceIds: number[];
  evidenceHash: string;
  snapshots: Array<{
    payment: FinancialRow;
    entry: FinancialRow;
    receipt: FinancialRow;
    request: FinancialRow;
    allocations: FinancialRow[];
    requestAllocations: FinancialRow[];
    invoices: FinancialRow[];
  }>;
};
const entryFields = {
  id: accountingEntries.id,
  supplierId: accountingEntries.supplierId,
  branchId: accountingEntries.branchId,
  receiptId: accountingEntries.receiptId,
  customerId: accountingEntries.customerId,
  purchaseOrderId: accountingEntries.purchaseOrderId,
  entryType: accountingEntries.entryType,
  amount: accountingEntries.amount,
  entryDate: accountingEntries.entryDate,
  dedupeKey: accountingEntries.dedupeKey,
  purchaseLiabilityAccount: accountingEntries.purchaseLiabilityAccount,
  createdBy: accountingEntries.createdBy,
  createdAt: accountingEntries.createdAt,
  postingIntentHash: accountingEntries.postingIntentHash,
};
const apEffect = supplierApEffectSql({
  entryType: accountingEntries.entryType,
  amount: accountingEntries.amount,
  liabilityAccount: accountingEntries.purchaseLiabilityAccount,
  dedupeKey: accountingEntries.dedupeKey,
});
function fail(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر إثبات أن السداد اللاحق يخص فواتير أخرى",
      why,
      doThis:
        "راجع الإيصال والقيد وكامل التخصيصات والاستردادات قبل تسجيل صرف إضافي",
    }),
  });
}
function bounded<T>(rows: T[], label: string): T[] {
  if (rows.length > LIMIT) fail(`دليل ${label} يتجاوز حد الفحص الآمن`);
  return rows;
}
const canonical = (value: unknown) =>
  stableCanonical(JSON.parse(JSON.stringify(value)));

/** Caller holds the exclusive company gate; this helper only reads an existing transaction. */
export async function assertAttestedPaymentEvidenceTx(
  tx: Tx,
  supplierId: number,
  branchId: number,
  postingEntryId: number,
  allTargetInvoiceIds: readonly number[],
): Promise<AttestedPaymentEvidence> {
  if (
    ![supplierId, branchId, postingEntryId, ...allTargetInvoiceIds].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    !allTargetInvoiceIds.length ||
    allTargetInvoiceIds.length > 50
  )
    fail("نطاق فحص الدليل غير صالح");
  const targets = new Set(allTargetInvoiceIds);
  const [anchor] = await tx
    .select({
      supplierId: accountingEntries.supplierId,
      branchId: accountingEntries.branchId,
      effect: sql<string>`${apEffect}`,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.id, postingEntryId))
    .limit(1);
  if (
    !anchor ||
    anchor.supplierId !== supplierId ||
    anchor.branchId !== branchId ||
    !money(anchor.effect).gt(0)
  )
    fail("قيد الاعتراف الأصلي لا يطابق المورد والفرع");
  const later = bounded(
    await tx
      .select({ ...entryFields, apEffect: sql<string>`${apEffect}` })
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.supplierId, supplierId),
          eq(accountingEntries.branchId, branchId),
          gt(accountingEntries.id, postingEntryId),
          inArray(accountingEntries.entryType, [
            "PAYMENT_OUT",
            "EXCHANGE_SETTLE",
          ]),
        ),
      )
      .orderBy(asc(accountingEntries.id))
      .limit(LIMIT + 1),
    "القيود اللاحقة",
  );
  const result: Omit<AttestedPaymentEvidence, "evidenceHash"> = {
    paymentIds: [],
    receiptIds: [],
    entryIds: [],
    invoiceIds: [],
    snapshots: [],
  };
  if (
    later.some(
      (row) =>
        row.entryType !== "PAYMENT_OUT" ||
        !money(row.amount).gt(0) ||
        !money(row.apEffect).eq(money(row.amount).neg()),
    )
  )
    fail("يوجد قيد صرف أو صيرفة لاحق مجهول أو خارج ذمة المورد");
  if (later.length) {
    if ((await loadSupplierBookSourceClaims(tx, later.map(row => Number(row.id)), { currentRead: true })).size)
      fail("قيد سداد لاحق مملوك لتسوية BOOK؛ لا يجوز إعادة استخدام مصدر مثبت");
    const payments = bounded(
      await tx
        .select()
        .from(supplierPayments)
        .where(
          inArray(
            supplierPayments.accountingEntryId,
            later.map((row) => row.id),
          ),
        )
        .orderBy(asc(supplierPayments.id))
        .limit(LIMIT + 1),
      "رؤوس الدفعات",
    );
    for (const entry of later)
      if (
        payments.filter((row) => row.accountingEntryId === entry.id).length !==
        1
      )
        fail(
          "قيد سداد لاحق بلا دفعة أصلية وحيدة؛ لا يجوز تجاهل سند عام غير مخصص",
        );
    const paymentIds = payments.map((row) => row.id);
    const receiptIds = payments.map((row) => row.receiptId);
    const requestIds = payments.map((row) => row.requestId);
    const sourceReceipts = bounded(
      await tx
        .select({
          id: receipts.id,
          supplierPartyId: receipts.partyId,
          partyType: receipts.partyType,
          branchId: receipts.branchId,
          direction: receipts.direction,
          amount: receipts.amount,
          paymentMethod: receipts.paymentMethod,
          cashBucket: receipts.cashBucket,
          shiftId: receipts.shiftId,
          invoiceId: receipts.invoiceId,
          workOrderId: receipts.workOrderId,
          reservationId: receipts.reservationId,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
          createdBy: receipts.createdBy,
          createdAt: receipts.createdAt,
          approvedBy: receipts.approvedBy,
          approvedAt: receipts.approvedAt,
          executedBy: receipts.executedBy,
          executedAt: receipts.executedAt,
          voucherDate: receipts.voucherDate,
          referenceNumber: receipts.referenceNumber,
        })
        .from(receipts)
        .where(inArray(receipts.id, receiptIds))
        .orderBy(asc(receipts.id))
        .limit(LIMIT + 1),
      "إيصالات المصادر",
    );
    const receiptEntries = bounded(
      await tx
        .select({
          id: accountingEntries.id,
          receiptId: accountingEntries.receiptId,
        })
        .from(accountingEntries)
        .where(inArray(accountingEntries.receiptId, receiptIds))
        .limit(LIMIT + 1),
      "روابط الإيصالات بالقيود",
    );
    const cancellations = bounded(
      await tx
        .select({
          id: receipts.id,
          referenceNumber: receipts.referenceNumber,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
        })
        .from(receipts)
        .where(
          inArray(
            receipts.referenceNumber,
            receiptIds.map((id) => `CANCEL-VCH-${id}`),
          ),
        )
        .limit(LIMIT + 1),
      "طلبات إلغاء الإيصالات",
    );
    const requests = bounded(
      await tx
        .select()
        .from(supplierPaymentRequests)
        .where(inArray(supplierPaymentRequests.id, requestIds))
        .limit(LIMIT + 1),
      "طلبات السداد الأصلية",
    );
    const allocations = bounded(
      await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(
          inArray(supplierPaymentAllocations.supplierPaymentId, paymentIds),
        )
        .orderBy(asc(supplierPaymentAllocations.id))
        .limit(LIMIT + 1),
      "التخصيصات الأصلية",
    );
    const requestAllocations = bounded(
      await tx
        .select()
        .from(supplierPaymentRequestAllocations)
        .where(inArray(supplierPaymentRequestAllocations.requestId, requestIds))
        .orderBy(asc(supplierPaymentRequestAllocations.id))
        .limit(LIMIT + 1),
      "تفاصيل طلبات التخصيص",
    );
    const refunded = bounded(
      await tx
        .select({ id: supplierPaymentRefunds.id })
        .from(supplierPaymentRefunds)
        .where(inArray(supplierPaymentRefunds.supplierPaymentId, paymentIds))
        .limit(LIMIT + 1),
      "الاستردادات",
    );
    const pendingRefunds = bounded(
      await tx
        .select({ id: supplierPaymentRefundRequests.id })
        .from(supplierPaymentRefundRequests)
        .where(
          and(
            inArray(
              supplierPaymentRefundRequests.supplierPaymentId,
              paymentIds,
            ),
            eq(supplierPaymentRefundRequests.status, "PENDING"),
          ),
        )
        .limit(LIMIT + 1),
      "طلبات الاسترداد المعلقة",
    );
    if (refunded.length || pendingRefunds.length)
      fail("مصدر الدفع اللاحق مسترد أو له استرداد معلق");
    const invoiceIds = Array.from(
      new Set(allocations.map((row) => row.supplierInvoiceId)),
    );
    const invoices = invoiceIds.length
      ? bounded(
          await tx
            .select({
              id: supplierInvoices.id,
              supplierId: supplierInvoices.supplierId,
              branchId: supplierInvoices.branchId,
              invoiceNumber: supplierInvoices.invoiceNumber,
              currency: supplierInvoices.currency,
              agreedRate: supplierInvoices.agreedRate,
              usdTotal: supplierInvoices.usdTotal,
              liabilityClass: supplierInvoices.liabilityClass,
              status: supplierInvoices.status,
              paymentGate: supplierInvoices.paymentGate,
              version: supplierInvoices.version,
              totalAmount: supplierInvoices.totalAmount,
              legacySettledAmount: supplierInvoices.legacySettledAmount,
            })
            .from(supplierInvoices)
            .where(inArray(supplierInvoices.id, invoiceIds))
            .orderBy(asc(supplierInvoices.id))
            .limit(LIMIT + 1),
          "فواتير الدفعات",
        )
      : [];
    for (const entry of later) {
      const payment = payments.find(
        (row) => row.accountingEntryId === entry.id,
      )!;
      const receipt = sourceReceipts.find(
        (row) => row.id === payment.receiptId,
      );
      const request = requests.find((row) => row.id === payment.requestId);
      const invoiceCurrencySettlement = usesInvoiceCurrencySettlement(payment);
      if (
        payment.status !== "POSTED" ||
        payment.currency !== "IQD" ||
        payment.exchangeRate != null ||
        payment.supplierId !== supplierId ||
        payment.branchId !== branchId ||
        !money(payment.amount).eq(entry.amount) ||
        !money(payment.currencyAmount).eq(payment.amount) ||
        entry.receiptId !== payment.receiptId ||
        entry.customerId != null
      )
        fail("رأس الدفعة لا يطابق القيد أو المورد أو الفرع أو عملة الدينار");
      if (
        !receipt ||
        receipt.direction !== "OUT" ||
        receipt.status !== "COMPLETED" ||
        receipt.approvalStatus !== "APPROVED" ||
        receipt.partyType !== "SUPPLIER" ||
        receipt.supplierPartyId !== supplierId ||
        receipt.branchId !== branchId ||
        receipt.paymentMethod !== payment.paymentMethod ||
        !money(receipt.amount).eq(payment.amount) ||
        receipt.invoiceId != null ||
        receipt.workOrderId != null ||
        receipt.reservationId != null ||
        receiptEntries.filter((row) => row.receiptId === receipt.id).length !==
          1
      )
        fail(
          "إيصال الدفعة لا يطابق الملكية أو المبلغ أو الحالة أو يرتبط بمصدر مختلط",
        );
      if (
        !request ||
        request.status !== "APPROVED" ||
        request.supplierId !== supplierId ||
        request.branchId !== branchId ||
        request.currency !== "IQD" ||
        request.exchangeRate != null ||
        request.paymentMethod !== payment.paymentMethod ||
        request.requestedBy !== receipt.createdBy ||
        request.reviewedBy !== payment.postedBy ||
        !money(request.requestedAmount).eq(payment.amount) ||
        !money(request.requestedCurrencyAmount).eq(payment.amount) ||
        request.payloadCanonical !== payment.payloadCanonical ||
        request.payloadHash !== payment.payloadHash ||
        sha256(payment.payloadCanonical) !== payment.payloadHash
      )
        fail("طلب الدفعة أو بصمة دليلها لا يطابق المصدر الأصلي");
      if (
        cancellations.some(
          (row) =>
            row.referenceNumber === `CANCEL-VCH-${receipt.id}` &&
            ["PENDING", "COMPLETED"].includes(row.status) &&
            row.approvalStatus !== "REJECTED",
        )
      )
        fail("يوجد طلب إلغاء قائم لإيصال الدفع اللاحق");
      const paid = allocations.filter(
        (row) => row.supplierPaymentId === payment.id,
      );
      const requested = requestAllocations.filter(
        (row) => row.requestId === request.id,
      );
      if (
        !paid.length ||
        paid.length !== requested.length ||
        new Set(paid.map((row) => row.supplierInvoiceId)).size !==
          paid.length ||
        !paid
          .reduce((sum, row) => sum.plus(row.allocatedAmount), money(0))
          .eq(payment.amount) ||
        (!invoiceCurrencySettlement && !paid
          .reduce((sum, row) => sum.plus(row.allocatedCurrencyAmount), money(0))
          .eq(payment.currencyAmount))
      )
        fail("الدفعة اللاحقة بلا تخصيص أصلي كامل يساوي مبلغ رأسها");
      let payload: {
        supplierId?: number;
        branchId?: number;
        currency?: string;
        paymentMethod?: string;
        amount?: string;
        currencyAmount?: string;
        allocations?: Array<{
          supplierInvoiceId: number;
          invoiceVersion: number;
          amount: string;
          currencyAmount: string;
        }>;
      };
      try {
        payload = JSON.parse(payment.payloadCanonical);
      } catch {
        fail("دليل الدفعة المحفوظ غير قابل للقراءة");
      }
      if (
        !payload ||
        payload.supplierId !== supplierId ||
        payload.branchId !== branchId ||
        payload.currency !== "IQD" ||
        payload.paymentMethod !== payment.paymentMethod ||
        typeof payload.amount !== "string" ||
        typeof payload.currencyAmount !== "string" ||
        !money(payload.amount).eq(payment.amount) ||
        !money(payload.currencyAmount).eq(payment.amount) ||
        !Array.isArray(payload.allocations) ||
        payload.allocations.length !== requested.length
      )
        fail("الحمولة المالية الأصلية للدفعة غير متطابقة");
      for (const allocation of paid) {
        const original = requested.find(
          (row) => row.id === allocation.requestAllocationId,
        );
        const invoice = invoices.find(
          (row) => row.id === allocation.supplierInvoiceId,
        );
        if (
          !money(allocation.allocatedAmount).gt(0) ||
          !money(allocation.allocatedCurrencyAmount).gt(0) ||
          (!invoiceCurrencySettlement && !money(allocation.allocatedCurrencyAmount).eq(
            allocation.allocatedAmount,
          )) ||
          !money(allocation.refundedAmount).isZero() ||
          !money(allocation.refundedCurrencyAmount).isZero()
        )
          fail("التخصيص مسترد أو مختلط العملة أو غير موجب");
        if (
          !invoice ||
          invoice.supplierId !== supplierId ||
          invoice.branchId !== branchId ||
          invoice.status !== "POSTED" ||
          (!invoiceCurrencySettlement && invoice.currency !== "IQD") ||
          !["NATIVE_AP", "LEGACY_AP"].includes(invoice.liabilityClass)
        )
          fail("فاتورة التخصيص لا تطابق المورد أو الفرع أو الحالة أو العملة");
        if (targets.has(invoice.id))
          fail("تخصيص الدفعة اللاحقة يشمل فاتورة من الإقرار نفسه");
        if (
          !original ||
          original.supplierInvoiceId !== invoice.id ||
          original.activeInvoiceGuard != null ||
          !money(original.requestedAmount).eq(allocation.allocatedAmount) ||
          !money(original.requestedCurrencyAmount).eq(
            allocation.allocatedCurrencyAmount,
          ) ||
          original.invoiceHash !== allocation.invoiceHash ||
          sha256(original.invoiceSnapshot) !== original.invoiceHash
        )
          fail("تفصيل طلب التخصيص لا يطابق التخصيص الأصلي المثبت");
        if (invoiceCurrencySettlement) {
          const sourceInvoice = JSON.parse(original.invoiceSnapshot);
          if (sourceInvoice.currency !== invoice.currency || sourceInvoice.agreedRate !== invoice.agreedRate ||
            (invoice.currency === "IQD" && !money(allocation.allocatedCurrencyAmount).eq(allocation.allocatedAmount)) ||
            (invoice.currency === "USD" && money(allocation.allocatedCurrencyAmount).gt(sourceInvoice.usdTotal)))
            fail("عملة تخصيص الدفعة لا تطابق لقطة الفاتورة المثبتة");
        }
        const originalPayload = payload.allocations.filter(
          (row) => row.supplierInvoiceId === invoice.id,
        );
        if (
          originalPayload.length !== 1 ||
          originalPayload[0].invoiceVersion !== original.invoiceVersion ||
          !money(originalPayload[0].amount).eq(original.requestedAmount) ||
          !money(originalPayload[0].currencyAmount).eq(
            original.requestedCurrencyAmount,
          )
        )
          fail("تفصيل الحمولة لا يطابق مبلغ التخصيص ونسخته");
      }
      const { referenceNumber, ...receiptSnapshot } = receipt;
      result.paymentIds.push(payment.id);
      result.receiptIds.push(receipt.id);
      result.entryIds.push(entry.id);
      result.snapshots.push({
        payment: {
          id: payment.id,
          paymentNumber: payment.paymentNumber,
          requestId: request.id,
          supplierId,
          branchId,
          status: payment.status,
          currency: payment.currency,
          amount: payment.amount,
          currencyAmount: payment.currencyAmount,
          paymentMethod: payment.paymentMethod,
          receiptId: receipt.id,
          accountingEntryId: entry.id,
          version: payment.version,
          payloadHash: payment.payloadHash,
          postedBy: payment.postedBy,
          postedAt: payment.postedAt,
        },
        entry,
        receipt: {
          ...receiptSnapshot,
          referenceHash: sha256(referenceNumber ?? ""),
        },
        request: {
          id: request.id,
          status: request.status,
          payloadHash: request.payloadHash,
          requestedBy: request.requestedBy,
          reviewedBy: request.reviewedBy,
          requestedAt: request.requestedAt,
          reviewedAt: request.reviewedAt,
        },
        allocations: paid,
        requestAllocations: requested.map((row) => ({
          id: row.id,
          supplierInvoiceId: row.supplierInvoiceId,
          invoiceVersion: row.invoiceVersion,
          requestedAmount: row.requestedAmount,
          requestedCurrencyAmount: row.requestedCurrencyAmount,
          invoiceHash: row.invoiceHash,
          activeInvoiceGuard: row.activeInvoiceGuard,
        })),
        invoices: invoices.filter((invoice) =>
          paid.some((row) => row.supplierInvoiceId === invoice.id),
        ),
      });
    }
    result.invoiceIds = invoiceIds.sort((a, b) => a - b);
  }
  return {
    ...result,
    evidenceHash: sha256(
      canonical({
        supplierId,
        branchId,
        postingEntryId,
        allTargetInvoiceIds: Array.from(targets).sort((a, b) => a - b),
        snapshots: result.snapshots,
      }),
    ),
  };
}

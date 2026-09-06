import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  goodsReceiptItems,
  purchaseOrderItems,
  purchaseOrders,
  purchaseReturnReversals,
  purchaseReturns,
  receipts,
  supplierInvoiceMatchRuns,
  supplierInvoiceMatchAllocations,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRefundItems,
  supplierPaymentRefundRequestItems,
  supplierPaymentRefundRequests,
  supplierPaymentRefunds,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
  supplierPayments,
  suppliers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import {
  assertApprovedTreasuryOutAvailable,
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  authorizeExternalTreasuryDisbursement,
  type ExternalTreasuryDisbursementApproval,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import {
  adjustSupplierBalance,
  adjustSupplierBalanceUsd,
  postEntry,
} from "../ledgerService";
import { money, round2, sumMoney, toDbMoney } from "../money";
import { paymentAssetRole } from "../sale/paymentPosting";
import { shiftIdForCashTx } from "../shiftService";
import { withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import {
  assertExpectedVersion,
  assertIndependentPurchaseReviewer,
} from "./returnGovernance";
import { supplierPaymentRefundTrigger, supplierPaymentTrigger } from "@shared/approvalTriggers";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { payloadHashMatches } from "../idempotency";

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
export const SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY = Symbol(
  "supplier-payment-treasury-decision",
);
export type SupplierPaymentTreasuryDecisionCapability =
  typeof SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY;

export function assertSupplierPaymentTreasuryDecisionAuthority(
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
): void {
  if (
    actor.role === "admin" ||
    actor.role === "manager" ||
    actor.role === "accountant" ||
    capability === SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY
  ) {
    return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "قرار سداد المورد أو استرداده يتطلب صلاحية الخزينة الكاملة؛ صلاحية المشتريات وحدها لا تكفي",
  });
}
type Evidence =
  | "PAYMENT_ORDER"
  | "BANK_ADVICE"
  | "TRANSFER_RECEIPT"
  | "CASH_ACKNOWLEDGEMENT"
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "OTHER";

export interface RequestSupplierPaymentInput {
  supplierId: number;
  branchId: number;
  requestKey: string;
  currency: "IQD" | "USD";
  exchangeRate?: string | null;
  amount: string;
  currencyAmount: string;
  paymentMethod: Method;
  externalReference?: string | null;
  evidenceType: Evidence;
  evidenceReference: string;
  reason: string;
  allocations: Array<{
    supplierInvoiceId: number;
    invoiceVersion: number;
    amount: string;
    currencyAmount: string;
  }>;
}

export interface DecideSupplierPaymentInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

export interface RequestSupplierPaymentRefundInput {
  supplierPaymentId: number;
  expectedPaymentVersion: number;
  requestKey: string;
  refundMethod: Method;
  externalReference?: string | null;
  evidenceType:
    | "SUPPLIER_ACKNOWLEDGEMENT"
    | "BANK_ADVICE"
    | "TRANSFER_RECEIPT"
    | "CASH_RECEIPT"
    | "DOCUMENT_IMAGE"
    | "PDF"
    | "OTHER";
  evidenceReference: string;
  reason: string;
  allocations: Array<{
    supplierPaymentAllocationId: number;
    amount: string;
    currencyAmount: string;
  }>;
}

export interface DecideSupplierPaymentRefundInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

function required(
  value: string | null | undefined,
  label: string,
  max: number,
): string {
  const result = value?.trim() ?? "";
  if (!result)
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (result.length > max)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يتجاوز ${max} محرفاً`,
    });
  return result;
}

function uniqueIds(ids: number[], label: string): void {
  const set = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${label} غير صالح`,
      });
    if (set.has(id))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يجوز تكرار ${label}`,
      });
    set.add(id);
  }
}

export function assertPaymentTotals(
  amount: string,
  currencyAmount: string,
  allocations: Array<{ amount: string; currencyAmount: string }>,
): void {
  const total = round2(amount);
  const currencyTotal = round2(currencyAmount);
  if (!total.gt(0) || !currencyTotal.gt(0))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مبلغ الدفعة يجب أن يكون موجباً",
    });
  if (
    !round2(sumMoney(allocations.map((row) => row.amount))).eq(total) ||
    !round2(sumMoney(allocations.map((row) => row.currencyAmount))).eq(
      currencyTotal,
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مجموع تخصيصات الدفعة لا يساوي رأس الدفعة",
    });
  }
}

/**
 * Currency amounts are source-of-truth amounts.  The IQD book value may differ
 * only by the final 2-decimal rounding of currencyAmount * agreedRate.
 */
export function assertAgreedRateAmount(
  amountIqd: string | number | Decimal,
  currencyAmount: string | number | Decimal,
  agreedRate: string | number | Decimal | null | undefined,
  label: string,
): void {
  const rate = money(agreedRate);
  if (
    !rate.gt(0) ||
    !round2(money(currencyAmount).times(rate)).eq(round2(amountIqd))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label}: مبلغ IQD لا يساوي مبلغ العملة × سعر الصرف المتفق عليه`,
    });
  }
}

export function effectiveInvoicePayable(
  invoiceTotal: string | number | Decimal,
  netCreditReturns: string | number | Decimal,
): ReturnType<typeof money> {
  const effective = round2(money(invoiceTotal).minus(netCreditReturns));
  return effective.isNegative() ? money(0) : effective;
}

export function assertSupplierInvoicePayable(invoice: {
  status: string;
  paymentGate: string;
  liabilityClass: string;
  legacySettlementEvidenceHash?: string | null;
}): void {
  if (invoice.status !== "POSTED" || invoice.paymentGate !== "OPEN")
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة المورد ليست POSTED مؤهلة للدفع",
    });
  if (
    !(["NATIVE_AP", "LEGACY_AP"] as const).includes(
      invoice.liabilityClass as "NATIVE_AP" | "LEGACY_AP",
    )
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "الفاتورة ليست التزام AP صالحاً؛ مسار CASH_CLEARING أو UNKNOWN محظور",
    });
  }
  if (
    invoice.liabilityClass === "LEGACY_AP" &&
    !invoice.legacySettlementEvidenceHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة AP الإرثية بلا دليل تسوية مادي",
    });
  }
}

function decisionPayloadHash(
  requestId: number,
  action: string,
  reviewReason: string,
): string {
  return sha256(stableCanonical({ requestId, action, reviewReason }));
}

export function sortedUniquePurchaseOrderIds(ids: number[]): number[] {
  return Array.from(
    new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0)),
  ).sort((a, b) => a - b);
}

async function resolveInvoicePurchaseOrderIds(
  tx: Tx,
  invoiceIds: number[],
): Promise<number[]> {
  const [legacy, matched] = await Promise.all([
    tx
      .select({ id: supplierInvoices.legacyPurchaseOrderId })
      .from(supplierInvoices)
      .where(inArray(supplierInvoices.id, invoiceIds)),
    tx
      .select({ id: purchaseOrderItems.purchaseOrderId })
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
      .where(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, invoiceIds)),
  ]);
  return sortedUniquePurchaseOrderIds([
    ...legacy.map((row) => Number(row.id ?? 0)),
    ...matched.map((row) => Number(row.id)),
  ]);
}

/** Canonical financial aggregate lock order: PO ids asc -> supplier -> invoices asc. */
async function lockPaymentAggregate(
  tx: Tx,
  supplierId: number,
  invoiceIds: number[],
) {
  const sortedInvoiceIds = sortedUniquePurchaseOrderIds(invoiceIds);
  const poIds = await resolveInvoicePurchaseOrderIds(tx, sortedInvoiceIds);
  if (poIds.length)
    await tx
      .select({ id: purchaseOrders.id })
      .from(purchaseOrders)
      .where(inArray(purchaseOrders.id, poIds))
      .orderBy(asc(purchaseOrders.id))
      .for("update");
  const supplier = (
    await tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.id, supplierId))
      .for("update")
      .limit(1)
  )[0];
  const invoices = await tx
    .select()
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, sortedInvoiceIds))
    .orderBy(asc(supplierInvoices.id))
    .for("update");
  return { supplier, invoices };
}

async function accountingEntryId(tx: Tx, dedupeKey: string): Promise<number> {
  const row = (
    await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, dedupeKey))
      .limit(1)
  )[0];
  if (!row) throw new Error(`accounting entry missing: ${dedupeKey}`);
  return Number(row.id);
}

async function lockPaymentInstrument(
  tx: Tx,
  branchId: number,
  method: Method,
  actor: Actor,
  label: string,
  direction: "IN" | "OUT",
  makerUserIds: Array<number | null | undefined>,
): Promise<{
  shiftId: number | null;
  cashBucket: "DRAWER" | "TREASURY" | null;
  treasuryApproval: ExternalTreasuryDisbursementApproval | null;
}> {
  if (method !== "CASH")
    return { shiftId: null, cashBucket: null, treasuryApproval: null };
  const result = await shiftIdForCashTx(
    tx,
    { ...actor, branchId },
    branchId,
    label,
  );
  if (direction === "OUT" && result.cashBucket === "TREASURY") {
    const treasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
      actor,
      makerUserIds,
      branchIds: [branchId],
      operation: label,
    });
    return { ...result, treasuryApproval };
  }
  await lockCashSourceForUpdate(tx, {
    branchId,
    shiftId: result.shiftId,
    cashBucket: result.cashBucket,
  });
  return { ...result, treasuryApproval: null };
}

async function invoiceReservations(tx: Tx, invoiceIds: number[]) {
  const posted = await tx
    .select({
      invoiceId: supplierPaymentAllocations.supplierInvoiceId,
      amount: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount}),0)`,
      currencyAmount: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedCurrencyAmount} - ${supplierPaymentAllocations.refundedCurrencyAmount}),0)`,
    })
    .from(supplierPaymentAllocations)
    .where(inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds))
    .groupBy(supplierPaymentAllocations.supplierInvoiceId)
    .for("update");
  const pending = await tx
    .select({
      invoiceId: supplierPaymentRequestAllocations.supplierInvoiceId,
      amount: sql<string>`COALESCE(SUM(${supplierPaymentRequestAllocations.requestedAmount}),0)`,
      currencyAmount: sql<string>`COALESCE(SUM(${supplierPaymentRequestAllocations.requestedCurrencyAmount}),0)`,
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
      and(
        eq(supplierPaymentRequests.status, "PENDING"),
        inArray(
          supplierPaymentRequestAllocations.supplierInvoiceId,
          invoiceIds,
        ),
      ),
    )
    .groupBy(supplierPaymentRequestAllocations.supplierInvoiceId)
    .for("update");
  const credited = await tx
    .select({
      invoiceId: purchaseReturns.supplierInvoiceId,
      amount: sql<string>`COALESCE(SUM(${purchaseReturns.creditOffsetAmount}),0)`,
    })
    .from(purchaseReturns)
    .where(inArray(purchaseReturns.supplierInvoiceId, invoiceIds))
    .groupBy(purchaseReturns.supplierInvoiceId);
  const creditReversed = await tx
    .select({
      invoiceId: purchaseReturnReversals.supplierInvoiceId,
      amount: sql<string>`COALESCE(SUM(${purchaseReturnReversals.totalAmount}),0)`,
    })
    .from(purchaseReturnReversals)
    .innerJoin(
      purchaseReturns,
      eq(purchaseReturns.id, purchaseReturnReversals.purchaseReturnId),
    )
    .where(
      and(
        inArray(purchaseReturnReversals.supplierInvoiceId, invoiceIds),
        eq(purchaseReturns.settlement, "CREDIT"),
      ),
    )
    .groupBy(purchaseReturnReversals.supplierInvoiceId);
  const reversedByInvoice = new Map(
    creditReversed.map((row) => [Number(row.invoiceId), money(row.amount)]),
  );
  return {
    posted: new Map(
      posted.map((row) => [
        Number(row.invoiceId),
        {
          amount: money(row.amount),
          currencyAmount: money(row.currencyAmount),
        },
      ]),
    ),
    pending: new Map(
      pending.map((row) => [
        Number(row.invoiceId),
        {
          amount: money(row.amount),
          currencyAmount: money(row.currencyAmount),
        },
      ]),
    ),
    creditReturns: new Map(
      credited.map((row) => [
        Number(row.invoiceId),
        DecimalMaxZero(
          money(row.amount).minus(
            reversedByInvoice.get(Number(row.invoiceId)) ?? money(0),
          ),
        ),
      ]),
    ),
  };
}

function legacyCurrencySettled(invoice: typeof supplierInvoices.$inferSelect) {
  if (invoice.currency === "IQD") return money(invoice.legacySettledAmount);
  const rate = money(invoice.agreedRate);
  return rate.gt(0)
    ? round2(money(invoice.legacySettledAmount).dividedBy(rate))
    : money(0);
}

function assertAllocationAvailable(
  invoice: typeof supplierInvoices.$inferSelect,
  requested: { amount: string; currencyAmount: string },
  used: {
    amount: ReturnType<typeof money>;
    currencyAmount: ReturnType<typeof money>;
  },
  netCreditReturns: ReturnType<typeof money>,
): void {
  const effectiveTotal = effectiveInvoicePayable(
    invoice.totalAmount,
    netCreditReturns,
  );
  const remaining = round2(
    effectiveTotal.minus(invoice.legacySettledAmount).minus(used.amount),
  );
  const sourceCurrencyTotal =
    invoice.currency === "USD"
      ? money(invoice.usdTotal).minus(
          round2(netCreditReturns.dividedBy(money(invoice.agreedRate))),
        )
      : effectiveTotal;
  const remainingCurrency = round2(
    sourceCurrencyTotal
      .minus(legacyCurrencySettled(invoice))
      .minus(used.currencyAmount),
  );
  if (
    money(requested.amount).gt(remaining) ||
    money(requested.currencyAmount).gt(remainingCurrency)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `تخصيص الدفعة يتجاوز المتبقي في فاتورة المورد ${invoice.invoiceNumber}`,
    });
  }
}

export async function requestSupplierPaymentInTx(
  tx: Tx,
  input: RequestSupplierPaymentInput,
  actor: Actor,
) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const reason = required(input.reason, "سبب الدفع", 500);
  const evidenceReference = required(
    input.evidenceReference,
    "مرجع الدليل",
    500,
  );
  const externalReference = input.externalReference?.trim() || null;
  if (input.paymentMethod !== "CASH" && !externalReference)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع أداة الدفع مطلوب للدفع غير النقدي",
    });
  if (!input.allocations.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف تخصيص فاتورة واحداً على الأقل",
    });
  uniqueIds(
    input.allocations.map((row) => row.supplierInvoiceId),
    "فاتورة المورد",
  );
  const normalized = [...input.allocations]
    .map((row) => ({
      ...row,
      amount: toDbMoney(row.amount),
      currencyAmount: toDbMoney(row.currencyAmount),
    }))
    .sort((a, b) => a.supplierInvoiceId - b.supplierInvoiceId);
  assertPaymentTotals(input.amount, input.currencyAmount, normalized);
  const amount = toDbMoney(input.amount);
  const currencyAmount = toDbMoney(input.currencyAmount);
  const rate =
    input.currency === "USD" ? money(input.exchangeRate).toFixed(4) : null;
  if (input.currency === "USD" && !money(rate).gt(0))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سعر الصرف مطلوب للدفع بالدولار",
    });
  if (input.currency === "USD")
    assertAgreedRateAmount(amount, currencyAmount, rate, "رأس دفعة المورد");
  if (
    input.currency === "IQD" &&
    (!money(amount).eq(currencyAmount) || input.exchangeRate != null)
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "دفعة IQD لا تقبل سعر صرف ويجب تطابق مبلغيها",
    });
  const canonical = stableCanonical({
    supplierId: input.supplierId,
    branchId: input.branchId,
    currency: input.currency,
    exchangeRate: rate,
    amount,
    currencyAmount,
    paymentMethod: input.paymentMethod,
    externalReference,
    evidenceType: input.evidenceType,
    evidenceReference,
    reason,
    allocations: normalized,
  });
  const payloadHash = sha256(canonical);
  const evidenceHash = sha256(
    stableCanonical({ type: input.evidenceType, reference: evidenceReference }),
  );
  const replay = (
    await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.requestKey, requestKey))
      .limit(1)
  )[0];
  if (replay) {
    assertPurchaseBranch(replay, actor);
    if (!payloadHashMatches(payloadHash, replay.payloadHash))
      throw new TRPCError({
        code: "CONFLICT",
        message: "مفتاح الطلب مستعمل بدفعة مختلفة",
      });
    return {
      requestId: Number(replay.id),
      status: replay.status,
      idempotent: true as const,
    };
  }
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  const ids = normalized.map((row) => row.supplierInvoiceId);
  const { supplier, invoices } = await lockPaymentAggregate(
    tx,
    input.supplierId,
    ids,
  );
  if (!supplier || !supplier.isActive)
    throw new TRPCError({
      code: "CONFLICT",
      message: "المورد غير موجود أو غير نشط",
    });
  if (invoices.length !== ids.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "بعض فواتير المورد غير موجودة",
    });
  const invoiceById = new Map(invoices.map((row) => [Number(row.id), row]));
  const reservations = await invoiceReservations(tx, ids);
  const rows = normalized.map((allocation) => {
    const invoice = invoiceById.get(allocation.supplierInvoiceId)!;
    assertPurchaseBranch(invoice, actor);
    assertSupplierInvoicePayable(invoice);
    assertExpectedVersion(
      Number(invoice.version),
      allocation.invoiceVersion,
      "فاتورة المورد",
    );
    if (
      Number(invoice.supplierId) !== input.supplierId ||
      Number(invoice.branchId) !== input.branchId ||
      invoice.currency !== input.currency
    )
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الفاتورة لا تطابق المورد أو الفرع أو العملة",
      });
    if (input.currency === "USD") {
      if (
        !money(invoice.agreedRate)
          .toDecimalPlaces(4)
          .eq(money(rate).toDecimalPlaces(4))
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يجوز جمع فواتير بأسعار صرف مختلفة في دفعة واحدة",
        });
      assertAgreedRateAmount(
        allocation.amount,
        allocation.currencyAmount,
        invoice.agreedRate,
        `تخصيص الفاتورة ${invoice.invoiceNumber}`,
      );
    }
    const posted = reservations.posted.get(allocation.supplierInvoiceId) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const pending = reservations.pending.get(
      allocation.supplierInvoiceId,
    ) ?? { amount: money(0), currencyAmount: money(0) };
    const creditReturns =
      reservations.creditReturns.get(allocation.supplierInvoiceId) ??
      money(0);
    assertAllocationAvailable(
      invoice,
      allocation,
      {
        amount: posted.amount.plus(pending.amount),
        currencyAmount: posted.currencyAmount.plus(pending.currencyAmount),
      },
      creditReturns,
    );
    const snapshot = stableCanonical({
      invoiceId: Number(invoice.id),
      invoiceNumber: invoice.invoiceNumber,
      version: Number(invoice.version),
      status: invoice.status,
      paymentGate: invoice.paymentGate,
      liabilityClass: invoice.liabilityClass,
      legacySettledAmount: invoice.legacySettledAmount,
      legacySettlementEvidenceHash: invoice.legacySettlementEvidenceHash,
      totalAmount: invoice.totalAmount,
      usdTotal: invoice.usdTotal,
    });
    return { allocation, snapshot, hash: sha256(snapshot) };
  });
  const inserted = await tx
    .insert(supplierPaymentRequests)
    .values({
      requestKey,
      supplierId: input.supplierId,
      branchId: input.branchId,
      currency: input.currency,
      exchangeRate: rate,
      requestedAmount: amount,
      requestedCurrencyAmount: currencyAmount,
      paymentMethod: input.paymentMethod,
      externalReference,
      payloadCanonical: canonical,
      payloadHash,
      evidenceType: input.evidenceType,
      evidenceReference,
      evidenceHash,
      reason,
      pendingGuard: `SUPPLIER-PAY:${input.supplierId}:${input.branchId}:${input.currency}`,
      requestedBy: actor.userId,
    });
  const requestId = extractInsertId(inserted);
  await tx
    .insert(supplierPaymentRequestAllocations)
    .values(
      rows.map(({ allocation, snapshot, hash }) => ({
        requestId,
        supplierInvoiceId: allocation.supplierInvoiceId,
        invoiceVersion: allocation.invoiceVersion,
        requestedAmount: allocation.amount,
        requestedCurrencyAmount: allocation.currencyAmount,
        invoiceSnapshot: snapshot,
        invoiceHash: hash,
      })),
    );
  return {
    requestId,
    status: "PENDING" as const,
    idempotent: false as const,
  };
}

/**
 * قرار المالك (٦/٩/٢٦): أمر الشراء النقديّ يُسدَّد فوراً ضمن معاملة اعتماده نفسها —
 * لا يمكن استدعاء `requestSupplierPayment` (تفتح `withTx` خاصّتها) من داخل معاملةٍ
 * جارية بلا فتح اتصالٍ ثانٍ فوق الأول غير المُلتزَم. هذا الغلاف الرقيق يحتفظ بالمسار
 * العام كما هو، وسدادُ أمر الشراء يمرّ عبر `requestSupplierPaymentInTx` مباشرةً.
 */
export async function requestSupplierPayment(
  input: RequestSupplierPaymentInput,
  actor: Actor,
) {
  const reason = required(input.reason, "سبب الدفع", 500);
  const result = await withTx((tx) =>
    requestSupplierPaymentInTx(tx, input, actor),
  );
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "supplier.payment.decide",
    id: result.requestId,
    reason,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

export async function decideSupplierPaymentInTx(
  tx: Tx,
  input: DecideSupplierPaymentInput,
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
) {
  assertSupplierPaymentTreasuryDecisionAuthority(actor, capability);
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const hash = decisionPayloadHash(input.requestId, input.action, reviewReason);
  const preview = (
    await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.id, input.requestId))
      .limit(1)
  )[0];
  if (!preview)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "طلب دفع المورد غير موجود",
    });
  assertPurchaseBranch(preview, actor);
  const instrument =
    input.action === "APPROVE" && preview.status === "PENDING"
      ? await lockPaymentInstrument(
          tx,
          Number(preview.branchId),
          preview.paymentMethod,
          actor,
          "دفع مورد",
          "OUT",
          [preview.requestedBy],
        )
      : { shiftId: null, cashBucket: null, treasuryApproval: null };
  const previewAllocations =
    input.action === "APPROVE"
      ? await tx
          .select({
            supplierInvoiceId:
              supplierPaymentRequestAllocations.supplierInvoiceId,
          })
          .from(supplierPaymentRequestAllocations)
          .where(
            eq(supplierPaymentRequestAllocations.requestId, input.requestId),
          )
      : [];
  const aggregate =
    input.action === "APPROVE"
      ? await lockPaymentAggregate(
          tx,
          Number(preview.supplierId),
          previewAllocations.map((row) => Number(row.supplierInvoiceId)),
        )
      : {
          supplier: null,
          invoices: [] as Array<typeof supplierInvoices.$inferSelect>,
        };
  const request = (
    await tx
      .select()
      .from(supplierPaymentRequests)
      .where(eq(supplierPaymentRequests.id, input.requestId))
      .for("update")
      .limit(1)
  )[0]!;
  // سدادُ المورّد **خروجُ مال**، وهذه البوّابة هي التفويض الوحيد له: إيصال OUT مكتمل
  // بـcashBucket + حارسُ توفّرٍ + قفلُ مصدر النقد. ⇒ المالك حصراً.
  // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — كما في السندات (voucher/approval.ts)
  // بلا انتظار علَم ownerOnlyApproval؛ التفصيل هناك.
  const supplierPaymentApprover = await resolveApprovalActor(tx, actor);
  assertApprover({
    actor: await resolveApprovalActor(tx, actor),
    trigger: supplierPaymentTrigger(input.action),
    subject: `سداد مورّد (طلب ${input.requestId})`,
    legacy: () => {
      if (supplierPaymentApprover.isOwner) return;
      assertIndependentPurchaseReviewer(Number(request.requestedBy), actor.userId);
    },
  });
  if (request.status !== "PENDING") {
    if (request.decisionKey === decisionKey && request.decisionHash === hash)
      return {
        requestId: input.requestId,
        status: request.status,
        supplierPaymentId: null,
        idempotent: true as const,
      };
    throw new TRPCError({
      code: "CONFLICT",
      message: "حُسم طلب الدفع مسبقاً",
    });
  }
  if (input.action === "REJECT") {
    await tx
      .update(supplierPaymentRequestAllocations)
      .set({ activeInvoiceGuard: null })
      .where(
        eq(supplierPaymentRequestAllocations.requestId, input.requestId),
      );
    await tx
      .update(supplierPaymentRequests)
      .set({
        status: "REJECTED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason,
        decisionKey,
        decisionHash: hash,
      })
      .where(eq(supplierPaymentRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      status: "REJECTED" as const,
      supplierPaymentId: null,
      idempotent: false as const,
    };
  }
  const supplier = aggregate.supplier;
  if (!supplier || !supplier.isActive)
    throw new TRPCError({
      code: "CONFLICT",
      message: "المورد غير صالح للدفع",
    });
  const requested = await tx
    .select()
    .from(supplierPaymentRequestAllocations)
    .where(eq(supplierPaymentRequestAllocations.requestId, input.requestId))
    .orderBy(asc(supplierPaymentRequestAllocations.supplierInvoiceId))
    .for("update");
  const ids = requested.map((row) => Number(row.supplierInvoiceId));
  const invoices = aggregate.invoices;
  const invoiceById = new Map(invoices.map((row) => [Number(row.id), row]));
  const reservations = await invoiceReservations(tx, ids);
  const staleInvoice = requested.find((row) => {
    const invoice = invoiceById.get(Number(row.supplierInvoiceId));
    return (
      !invoice ||
      Number(invoice.version) !== Number(row.invoiceVersion) ||
      invoice.status !== "POSTED" ||
      invoice.paymentGate !== "OPEN"
    );
  });
  if (staleInvoice) {
    await tx
      .update(supplierPaymentRequestAllocations)
      .set({ activeInvoiceGuard: null })
      .where(
        eq(supplierPaymentRequestAllocations.requestId, input.requestId),
      );
    await tx
      .update(supplierPaymentRequests)
      .set({
        status: "STALE",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason: "تغيّرت فاتورة مورد مخصصة بعد إنشاء الطلب",
        decisionKey,
        decisionHash: hash,
      })
      .where(eq(supplierPaymentRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      status: "STALE" as const,
      supplierPaymentId: null,
      idempotent: false as const,
    };
  }
  for (const row of requested) {
    const invoice = invoiceById.get(Number(row.supplierInvoiceId));
    if (!invoice)
      throw new TRPCError({
        code: "CONFLICT",
        message: "فاتورة مخصصة مفقودة",
      });
    assertSupplierInvoicePayable(invoice);
    assertExpectedVersion(
      Number(invoice.version),
      Number(row.invoiceVersion),
      "فاتورة المورد",
    );
    if (
      Number(invoice.supplierId) !== Number(request.supplierId) ||
      Number(invoice.branchId) !== Number(request.branchId)
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت ملكية الفاتورة",
      });
    const posted = reservations.posted.get(Number(invoice.id)) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const pendingAll = reservations.pending.get(Number(invoice.id)) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const pendingOther = {
      amount: pendingAll.amount.minus(row.requestedAmount),
      currencyAmount: pendingAll.currencyAmount.minus(
        row.requestedCurrencyAmount,
      ),
    };
    const creditReturns =
      reservations.creditReturns.get(Number(invoice.id)) ?? money(0);
    if (request.currency === "USD")
      assertAgreedRateAmount(
        row.requestedAmount,
        row.requestedCurrencyAmount,
        invoice.agreedRate,
        `تخصيص الفاتورة ${invoice.invoiceNumber}`,
      );
    assertAllocationAvailable(
      invoice,
      {
        amount: row.requestedAmount,
        currencyAmount: row.requestedCurrencyAmount,
      },
      {
        amount: posted.amount.plus(pendingOther.amount),
        currencyAmount: posted.currencyAmount.plus(
          pendingOther.currencyAmount,
        ),
      },
      creditReturns,
    );
  }
  if (request.currency === "USD")
    assertAgreedRateAmount(
      request.requestedAmount,
      request.requestedCurrencyAmount,
      request.exchangeRate,
      "رأس دفعة المورد",
    );
  const amount = money(request.requestedAmount);
  if (request.paymentMethod === "CASH") {
    if (instrument.cashBucket === "TREASURY") {
      if (!instrument.treasuryApproval)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "إثبات اعتماد دفع المورد من الخزينة مفقود",
        });
      await assertApprovedTreasuryOutAvailable(
        tx,
        { branchId: Number(request.branchId), amount, operation: "دفع مورد" },
        instrument.treasuryApproval,
      );
    } else if (instrument.cashBucket === "DRAWER") {
      await assertCashOutAvailable(tx, {
        branchId: Number(request.branchId),
        shiftId: instrument.shiftId,
        cashBucket: "DRAWER",
        amount,
        operation: "دفع مورد",
      });
    } else {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "مصدر دفع المورد النقدي مفقود",
      });
    }
  } else {
    assertNonPhysicalOutReceipt({
      classification: "NON_CASH_METHOD",
      paymentMethod: request.paymentMethod,
      cashBucket: null,
      approvalStatus: "APPROVED",
      operation: "دفع مورد",
    });
  }
  const receipt = await tx
    .insert(receipts)
    .values({
      branchId: Number(request.branchId),
      shiftId: instrument.shiftId,
      cashBucket: instrument.cashBucket,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: request.paymentMethod,
      referenceNumber:
        request.externalReference ?? `SUPPLIER-PAY-REQ:${input.requestId}`,
      partyType: "SUPPLIER",
      partyId: Number(request.supplierId),
      description: request.reason,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      createdBy: actor.userId,
    });
  const receiptId = extractInsertId(receipt);
  const asset = paymentAssetRole(
    request.paymentMethod,
    instrument.cashBucket,
    "OUT",
  );
  const source = {
    roleDebits: { AP: amount },
    roleCredits: { [asset]: amount },
  };
  const dedupeKey = `SUPPLIER_PAYMENT_REQUEST:${input.requestId}`;
  await postEntry(tx, {
    entryType: "PAYMENT_OUT",
    branchId: Number(request.branchId),
    supplierId: Number(request.supplierId),
    receiptId,
    amount,
    paymentMethod: request.paymentMethod,
    createdBy: actor.userId,
    dedupeKey,
    notes: request.reason,
    postingIntent: createPostingIntent(
      "PAYMENT_OUT_SUPPLIER",
      "PAYMENT_OUT",
      [debitLine("AP", amount), creditLine(asset, amount)],
      source,
    ),
    postingSourceComponents: source,
  });
  const entryId = await accountingEntryId(tx, dedupeKey);
  const paymentNumber = `SP-${request.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha256").update(request.requestKey).digest("hex").slice(0, 16).toUpperCase()}`;
  const inserted = await tx
    .insert(supplierPayments)
    .values({
      paymentNumber,
      requestId: input.requestId,
      supplierId: Number(request.supplierId),
      branchId: Number(request.branchId),
      currency: request.currency,
      exchangeRate: request.exchangeRate,
      amount: request.requestedAmount,
      currencyAmount: request.requestedCurrencyAmount,
      paymentMethod: request.paymentMethod,
      externalReference: request.externalReference,
      receiptId,
      accountingEntryId: entryId,
      payloadCanonical: request.payloadCanonical,
      payloadHash: request.payloadHash,
      postedBy: actor.userId,
    });
  const supplierPaymentId = extractInsertId(inserted);
  await tx
    .insert(supplierPaymentAllocations)
    .values(
      requested.map((row) => ({
        supplierPaymentId,
        requestAllocationId: Number(row.id),
        supplierInvoiceId: Number(row.supplierInvoiceId),
        allocatedAmount: row.requestedAmount,
        allocatedCurrencyAmount: row.requestedCurrencyAmount,
        invoiceHash: row.invoiceHash,
      })),
    );
  await tx
    .update(supplierPaymentRequestAllocations)
    .set({ activeInvoiceGuard: null })
    .where(eq(supplierPaymentRequestAllocations.requestId, input.requestId));
  await adjustSupplierBalance(tx, Number(request.supplierId), amount.neg());
  if (request.currency === "USD")
    await adjustSupplierBalanceUsd(
      tx,
      Number(request.supplierId),
      money(request.requestedCurrencyAmount).neg(),
    );
  for (const row of requested) {
    const invoice = invoiceById.get(Number(row.supplierInvoiceId))!;
    const posted = reservations.posted.get(Number(invoice.id)) ?? {
      amount: money(0),
      currencyAmount: money(0),
    };
    const newPaid = round2(
      money(invoice.legacySettledAmount)
        .plus(posted.amount)
        .plus(row.requestedAmount),
    );
    const effectiveTotal = effectiveInvoicePayable(
      invoice.totalAmount,
      reservations.creditReturns.get(Number(invoice.id)) ?? money(0),
    );
    await tx
      .update(supplierInvoices)
      .set({
        version: sql`${supplierInvoices.version} + 1`,
        paymentGate: newPaid.gte(effectiveTotal) ? "SETTLED" : "OPEN",
        paymentGateReason: newPaid.gte(effectiveTotal)
          ? "سُوّيت بالكامل بعد صافي المرتجعات وتخصيصات الدفع الذرية"
          : null,
      })
      .where(eq(supplierInvoices.id, Number(invoice.id)));
  }
  await tx
    .update(supplierPaymentRequests)
    .set({
      status: "APPROVED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      reviewReason,
      decisionKey,
      decisionHash: hash,
      appliedAt: new Date(),
    })
    .where(eq(supplierPaymentRequests.id, input.requestId));
  return {
    requestId: input.requestId,
    status: "APPROVED" as const,
    supplierPaymentId,
    idempotent: false as const,
  };
}

export async function decideSupplierPayment(
  input: DecideSupplierPaymentInput,
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
) {
  return withTx((tx) => decideSupplierPaymentInTx(tx, input, actor, capability));
}

export async function requestSupplierPaymentRefund(
  input: RequestSupplierPaymentRefundInput,
  actor: Actor,
) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const reason = required(input.reason, "سبب الاسترداد", 500);
  const evidenceReference = required(
    input.evidenceReference,
    "مرجع الدليل",
    500,
  );
  const externalReference = input.externalReference?.trim() || null;
  if (input.refundMethod !== "CASH" && !externalReference)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع أداة الاسترداد مطلوب",
    });
  if (!input.allocations.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف تخصيص استرداد واحداً على الأقل",
    });
  uniqueIds(
    input.allocations.map((row) => row.supplierPaymentAllocationId),
    "تخصيص الدفع",
  );
  const normalized = [...input.allocations]
    .map((row) => ({
      ...row,
      amount: toDbMoney(row.amount),
      currencyAmount: toDbMoney(row.currencyAmount),
    }))
    .sort(
      (a, b) => a.supplierPaymentAllocationId - b.supplierPaymentAllocationId,
    );
  const amount = toDbMoney(sumMoney(normalized.map((row) => row.amount)));
  const currencyAmount = toDbMoney(
    sumMoney(normalized.map((row) => row.currencyAmount)),
  );
  assertPaymentTotals(amount, currencyAmount, normalized);
  const canonical = stableCanonical({
    supplierPaymentId: input.supplierPaymentId,
    expectedPaymentVersion: input.expectedPaymentVersion,
    refundMethod: input.refundMethod,
    externalReference,
    evidenceType: input.evidenceType,
    evidenceReference,
    reason,
    allocations: normalized,
  });
  const payloadHash = sha256(canonical);
  const result = await withTx(async (tx) => {
    const replay = (
      await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(eq(supplierPaymentRefundRequests.requestKey, requestKey))
        .limit(1)
    )[0];
    if (replay) {
      assertPurchaseBranch(replay, actor);
      if (!payloadHashMatches(payloadHash, replay.payloadHash))
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح الطلب مستعمل باسترداد مختلف",
        });
      return {
        requestId: Number(replay.id),
        status: replay.status,
        idempotent: true as const,
      };
    }
    const payment = (
      await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, input.supplierPaymentId))
        .for("update")
        .limit(1)
    )[0];
    if (!payment)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "دفعة المورد غير موجودة",
      });
    assertPurchaseBranch(payment, actor);
    assertExpectedVersion(
      Number(payment.version),
      input.expectedPaymentVersion,
      "دفعة المورد",
    );
    if (payment.status === "REFUNDED")
      throw new TRPCError({
        code: "CONFLICT",
        message: "الدفعة مستردة بالكامل",
      });
    const ids = normalized.map((row) => row.supplierPaymentAllocationId);
    const allocations = await tx
      .select()
      .from(supplierPaymentAllocations)
      .where(inArray(supplierPaymentAllocations.id, ids))
      .orderBy(asc(supplierPaymentAllocations.id))
      .for("update");
    const byId = new Map(allocations.map((row) => [Number(row.id), row]));
    for (const row of normalized) {
      const allocation = byId.get(row.supplierPaymentAllocationId);
      if (
        !allocation ||
        Number(allocation.supplierPaymentId) !== input.supplierPaymentId
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تخصيص لا يخص الدفعة",
        });
      if (payment.currency === "USD")
        assertAgreedRateAmount(
          row.amount,
          row.currencyAmount,
          payment.exchangeRate,
          "تخصيص استرداد دفعة المورد",
        );
      if (
        money(row.amount).gt(
          money(allocation.allocatedAmount).minus(allocation.refundedAmount),
        ) ||
        money(row.currencyAmount).gt(
          money(allocation.allocatedCurrencyAmount).minus(
            allocation.refundedCurrencyAmount,
          ),
        )
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "الاسترداد يتجاوز المتبقي من تخصيص الدفع",
        });
    }
    if (payment.currency === "USD")
      assertAgreedRateAmount(
        amount,
        currencyAmount,
        payment.exchangeRate,
        "رأس استرداد دفعة المورد",
      );
    const inserted = await tx
      .insert(supplierPaymentRefundRequests)
      .values({
        requestKey,
        supplierPaymentId: input.supplierPaymentId,
        branchId: Number(payment.branchId),
        basePaymentVersion: input.expectedPaymentVersion,
        requestedAmount: amount,
        requestedCurrencyAmount: currencyAmount,
        refundMethod: input.refundMethod,
        externalReference,
        payloadCanonical: canonical,
        payloadHash,
        evidenceType: input.evidenceType,
        evidenceReference,
        reason,
        pendingGuard: `SUPPLIER-PAY-REFUND:${input.supplierPaymentId}`,
        requestedBy: actor.userId,
      });
    const requestId = extractInsertId(inserted);
    await tx
      .insert(supplierPaymentRefundRequestItems)
      .values(
        normalized.map((row) => ({
          requestId,
          supplierPaymentAllocationId: row.supplierPaymentAllocationId,
          amount: row.amount,
          currencyAmount: row.currencyAmount,
        })),
      );
    return {
      requestId,
      status: "PENDING" as const,
      idempotent: false as const,
    };
  });
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "supplier.payment.refund",
    id: result.requestId,
    reason,
  });
  return approved ? { ...result, status: "APPROVED" as const } : result;
}

export async function decideSupplierPaymentRefund(
  input: DecideSupplierPaymentRefundInput,
  actor: Actor,
  capability?: SupplierPaymentTreasuryDecisionCapability,
) {
  assertSupplierPaymentTreasuryDecisionAuthority(actor, capability);
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const hash = decisionPayloadHash(input.requestId, input.action, reviewReason);
  return withTx(async (tx) => {
    const preview = (
      await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(eq(supplierPaymentRefundRequests.id, input.requestId))
        .limit(1)
    )[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب استرداد الدفعة غير موجود",
      });
    assertPurchaseBranch(preview, actor);
    const previewPayment =
      input.action === "APPROVE"
        ? (
            await tx
              .select()
              .from(supplierPayments)
              .where(eq(supplierPayments.id, Number(preview.supplierPaymentId)))
              .limit(1)
          )[0]
        : null;
    const instrument =
      input.action === "APPROVE" && preview.status === "PENDING"
        ? await lockPaymentInstrument(
            tx,
            Number(preview.branchId),
            preview.refundMethod,
            actor,
            "استرداد دفعة مورد",
            "IN",
            [],
          )
        : { shiftId: null, cashBucket: null, treasuryApproval: null };
    const previewItems =
      input.action === "APPROVE"
        ? await tx
            .select({
              allocationId:
                supplierPaymentRefundRequestItems.supplierPaymentAllocationId,
            })
            .from(supplierPaymentRefundRequestItems)
            .where(
              eq(supplierPaymentRefundRequestItems.requestId, input.requestId),
            )
        : [];
    const previewAllocations = previewItems.length
      ? await tx
          .select({
            id: supplierPaymentAllocations.id,
            supplierInvoiceId: supplierPaymentAllocations.supplierInvoiceId,
          })
          .from(supplierPaymentAllocations)
          .where(
            inArray(
              supplierPaymentAllocations.id,
              previewItems.map((row) => Number(row.allocationId)),
            ),
          )
      : [];
    if (input.action === "APPROVE" && previewPayment)
      await lockPaymentAggregate(
        tx,
        Number(previewPayment.supplierId),
        previewAllocations.map((row) => Number(row.supplierInvoiceId)),
      );
    const request = (
      await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(eq(supplierPaymentRefundRequests.id, input.requestId))
        .for("update")
        .limit(1)
    )[0]!;
    // استردادُ السداد **محوُ أثر**: عكسٌ جبريٌّ سطراً بسطر للدفع — إيصال IN مقابل OUT،
    // وPAYMENT_IN مقابل PAYMENT_OUT، ورصيدُ المورّد يعود، والفاتورة تعود OPEN.
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — التفصيل في voucher/approval.ts.
    const supplierPaymentRefundApprover = await resolveApprovalActor(tx, actor);
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: supplierPaymentRefundTrigger(input.action),
      subject: `استرداد سداد (طلب ${input.requestId})`,
      legacy: () => {
        if (supplierPaymentRefundApprover.isOwner) return;
        assertIndependentPurchaseReviewer(Number(request.requestedBy), actor.userId);
      },
    });
    if (request.status !== "PENDING") {
      if (request.decisionKey === decisionKey && request.decisionHash === hash)
        return {
          requestId: input.requestId,
          status: request.status,
          refundId: null,
          idempotent: true as const,
        };
      throw new TRPCError({
        code: "CONFLICT",
        message: "حُسم طلب الاسترداد مسبقاً",
      });
    }
    if (input.action === "REJECT") {
      await tx
        .update(supplierPaymentRefundRequests)
        .set({
          status: "REJECTED",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason,
          decisionKey,
          decisionHash: hash,
        })
        .where(eq(supplierPaymentRefundRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "REJECTED" as const,
        refundId: null,
        idempotent: false as const,
      };
    }
    const payment = (
      await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, Number(request.supplierPaymentId)))
        .for("update")
        .limit(1)
    )[0];
    if (!payment)
      throw new TRPCError({ code: "CONFLICT", message: "دفعة المورد مفقودة" });
    if (Number(payment.version) !== Number(request.basePaymentVersion)) {
      await tx
        .update(supplierPaymentRefundRequests)
        .set({
          status: "STALE",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason: "تغيّرت دفعة المورد بعد إنشاء طلب الاسترداد",
          decisionKey,
          decisionHash: hash,
        })
        .where(eq(supplierPaymentRefundRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "STALE" as const,
        refundId: null,
        idempotent: false as const,
      };
    }
    const items = await tx
      .select()
      .from(supplierPaymentRefundRequestItems)
      .where(eq(supplierPaymentRefundRequestItems.requestId, input.requestId))
      .orderBy(
        asc(supplierPaymentRefundRequestItems.supplierPaymentAllocationId),
      )
      .for("update");
    const ids = items.map((row) => Number(row.supplierPaymentAllocationId));
    const allocations = await tx
      .select()
      .from(supplierPaymentAllocations)
      .where(inArray(supplierPaymentAllocations.id, ids))
      .orderBy(asc(supplierPaymentAllocations.id))
      .for("update");
    const byId = new Map(allocations.map((row) => [Number(row.id), row]));
    if (payment.currency === "USD")
      assertAgreedRateAmount(
        request.requestedAmount,
        request.requestedCurrencyAmount,
        payment.exchangeRate,
        "رأس استرداد دفعة المورد",
      );
    for (const row of items) {
      const allocation = byId.get(Number(row.supplierPaymentAllocationId));
      if (payment.currency === "USD")
        assertAgreedRateAmount(
          row.amount,
          row.currencyAmount,
          payment.exchangeRate,
          "تخصيص استرداد دفعة المورد",
        );
      if (
        !allocation ||
        Number(allocation.supplierPaymentId) !== Number(payment.id) ||
        money(row.amount).gt(
          money(allocation.allocatedAmount).minus(allocation.refundedAmount),
        ) ||
        money(row.currencyAmount).gt(
          money(allocation.allocatedCurrencyAmount).minus(
            allocation.refundedCurrencyAmount,
          ),
        )
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر المبلغ القابل للاسترداد",
        });
    }
    const amount = money(request.requestedAmount);
    const receipt = await tx
      .insert(receipts)
      .values({
        branchId: Number(request.branchId),
        shiftId: instrument.shiftId,
        cashBucket: instrument.cashBucket,
        direction: "IN",
        amount: request.requestedAmount,
        paymentMethod: request.refundMethod,
        referenceNumber:
          request.externalReference ?? `SUPPLIER-REFUND-REQ:${input.requestId}`,
        partyType: "SUPPLIER",
        partyId: Number(payment.supplierId),
        description: request.reason,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
        createdBy: actor.userId,
      });
    const receiptId = extractInsertId(receipt);
    const asset = paymentAssetRole(
      request.refundMethod,
      instrument.cashBucket,
      "IN",
    );
    const source = {
      roleDebits: { [asset]: amount },
      roleCredits: { AP: amount },
    };
    const dedupeKey = `SUPPLIER_PAYMENT_REFUND_REQUEST:${input.requestId}`;
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(request.branchId),
      supplierId: Number(payment.supplierId),
      receiptId,
      amount,
      paymentMethod: request.refundMethod,
      createdBy: actor.userId,
      dedupeKey,
      notes: request.reason,
      postingIntent: createPostingIntent(
        "PAYMENT_IN_SUPPLIER_REFUND",
        "PAYMENT_IN",
        [debitLine(asset, amount), creditLine("AP", amount)],
        source,
      ),
      postingSourceComponents: source,
    });
    const entryId = await accountingEntryId(tx, dedupeKey);
    const refundNumber = `SPR-${request.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha256").update(request.requestKey).digest("hex").slice(0, 16).toUpperCase()}`;
    const inserted = await tx
      .insert(supplierPaymentRefunds)
      .values({
        refundNumber,
        requestId: input.requestId,
        supplierPaymentId: Number(payment.id),
        supplierId: Number(payment.supplierId),
        branchId: Number(request.branchId),
        amount: request.requestedAmount,
        currencyAmount: request.requestedCurrencyAmount,
        receiptId,
        accountingEntryId: entryId,
        payloadCanonical: request.payloadCanonical,
        payloadHash: request.payloadHash,
        postedBy: actor.userId,
      });
    const refundId = extractInsertId(inserted);
    for (const row of items) {
      const updated = await tx
        .update(supplierPaymentAllocations)
        .set({
          refundedAmount: sql`${supplierPaymentAllocations.refundedAmount} + ${row.amount}`,
          refundedCurrencyAmount: sql`${supplierPaymentAllocations.refundedCurrencyAmount} + ${row.currencyAmount}`,
        })
        .where(
          and(
            eq(
              supplierPaymentAllocations.id,
              Number(row.supplierPaymentAllocationId),
            ),
            sql`${supplierPaymentAllocations.refundedAmount} + ${row.amount} <= ${supplierPaymentAllocations.allocatedAmount}`,
            sql`${supplierPaymentAllocations.refundedCurrencyAmount} + ${row.currencyAmount} <= ${supplierPaymentAllocations.allocatedCurrencyAmount}`,
          ),
        );
      if (extractAffectedRows(updated) !== 1)
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر تخصيص الدفع أثناء الاسترداد",
        });
      await tx
        .insert(supplierPaymentRefundItems)
        .values({
          refundId,
          supplierPaymentAllocationId: Number(row.supplierPaymentAllocationId),
          amount: row.amount,
          currencyAmount: row.currencyAmount,
        });
    }
    const affectedInvoiceIds = sortedUniquePurchaseOrderIds(
      allocations.map((row) => Number(row.supplierInvoiceId)),
    );
    const affectedInvoices = await tx
      .select()
      .from(supplierInvoices)
      .where(inArray(supplierInvoices.id, affectedInvoiceIds))
      .orderBy(asc(supplierInvoices.id));
    const afterRefund = await invoiceReservations(tx, affectedInvoiceIds);
    for (const invoice of affectedInvoices) {
      const paid =
        afterRefund.posted.get(Number(invoice.id))?.amount ?? money(0);
      const creditReturns =
        afterRefund.creditReturns.get(Number(invoice.id)) ?? money(0);
      const effectiveTotal = effectiveInvoicePayable(
        invoice.totalAmount,
        creditReturns,
      );
      const settled = money(invoice.legacySettledAmount)
        .plus(paid)
        .gte(effectiveTotal);
      await tx
        .update(supplierInvoices)
        .set({
          version: sql`${supplierInvoices.version} + 1`,
          paymentGate: settled ? "SETTLED" : "OPEN",
          paymentGateReason: settled
            ? "سُوّيت بالكامل بعد صافي المرتجعات وتخصيصات الدفع"
            : null,
        })
        .where(eq(supplierInvoices.id, Number(invoice.id)));
    }
    await adjustSupplierBalance(tx, Number(payment.supplierId), amount);
    if (payment.currency === "USD")
      await adjustSupplierBalanceUsd(
        tx,
        Number(payment.supplierId),
        money(request.requestedCurrencyAmount),
      );
    const totals = (
      await tx
        .select({
          refunded: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.refundedAmount}),0)`,
          allocated: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedAmount}),0)`,
        })
        .from(supplierPaymentAllocations)
        .where(
          eq(supplierPaymentAllocations.supplierPaymentId, Number(payment.id)),
        )
    )[0];
    const status = money(totals?.refunded).gte(money(totals?.allocated))
      ? ("REFUNDED" as const)
      : ("PARTIALLY_REFUNDED" as const);
    await tx
      .update(supplierPayments)
      .set({ status, version: sql`${supplierPayments.version} + 1` })
      .where(eq(supplierPayments.id, Number(payment.id)));
    await tx
      .update(supplierPaymentRefundRequests)
      .set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason,
        decisionKey,
        decisionHash: hash,
        appliedAt: new Date(),
      })
      .where(eq(supplierPaymentRefundRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      status: "APPROVED" as const,
      refundId,
      idempotent: false as const,
    };
  });
}

export async function listPendingSupplierPaymentRequests(
  branchId: number,
  actor: Actor,
) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx(
    (tx) =>
      tx
        .select()
        .from(supplierPaymentRequests)
        .where(
          and(
            eq(supplierPaymentRequests.branchId, branchId),
            eq(supplierPaymentRequests.status, "PENDING"),
          ),
        )
        .orderBy(asc(supplierPaymentRequests.requestedAt)),
    { gate: "NONE" },
  );
}

export async function listPendingSupplierPaymentRefundRequests(
  input: {
    branchId: number;
    limit: number;
    cursor?: { requestedAt: Date; id: number } | null;
  },
  actor: Actor,
) {
  const { branchId } = input;
  assertPurchaseBranch({ branchId }, actor);
  return withTx(
    async (tx) => {
      const rows = await tx
        .select()
        .from(supplierPaymentRefundRequests)
        .where(
          and(
            eq(supplierPaymentRefundRequests.branchId, branchId),
            eq(supplierPaymentRefundRequests.status, "PENDING"),
            input.cursor == null
              ? undefined
              : or(
                  gt(
                    supplierPaymentRefundRequests.requestedAt,
                    input.cursor.requestedAt,
                  ),
                  and(
                    eq(
                      supplierPaymentRefundRequests.requestedAt,
                      input.cursor.requestedAt,
                    ),
                    gt(supplierPaymentRefundRequests.id, input.cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(
          asc(supplierPaymentRefundRequests.requestedAt),
          asc(supplierPaymentRefundRequests.id),
        )
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);
      return {
        rows: page,
        hasMore,
        nextCursor:
          hasMore && last
            ? { requestedAt: last.requestedAt, id: Number(last.id) }
            : null,
      };
    },
    { gate: "NONE" },
  );
}

export async function listSupplierPaymentSources(
  input: {
    branchId: number;
    supplierId?: number;
    limit?: number;
    cursor?: { invoiceDate: string; id: number } | null;
  },
  actor: Actor,
) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(
    async (tx) => {
      const postedAmount = sql<string>`COALESCE((
        SELECT SUM(spa.allocatedAmount - spa.refundedAmount)
        FROM supplierPaymentAllocations spa
        WHERE spa.supplierInvoiceId = ${supplierInvoices.id}
      ), 0)`;
      const postedCurrencyAmount = sql<string>`COALESCE((
        SELECT SUM(spa.allocatedCurrencyAmount - spa.refundedCurrencyAmount)
        FROM supplierPaymentAllocations spa
        WHERE spa.supplierInvoiceId = ${supplierInvoices.id}
      ), 0)`;
      const pendingAmount = sql<string>`COALESCE((
        SELECT SUM(spra.requestedAmount)
        FROM supplierPaymentRequestAllocations spra
        INNER JOIN supplierPaymentRequests spr ON spr.id = spra.requestId
        WHERE spra.supplierInvoiceId = ${supplierInvoices.id}
          AND spr.status = 'PENDING'
      ), 0)`;
      const pendingCurrencyAmount = sql<string>`COALESCE((
        SELECT SUM(spra.requestedCurrencyAmount)
        FROM supplierPaymentRequestAllocations spra
        INNER JOIN supplierPaymentRequests spr ON spr.id = spra.requestId
        WHERE spra.supplierInvoiceId = ${supplierInvoices.id}
          AND spr.status = 'PENDING'
      ), 0)`;
      const netCreditReturns = sql<string>`GREATEST(
        COALESCE((SELECT SUM(pr.creditOffsetAmount) FROM purchaseReturns pr
          WHERE pr.supplierInvoiceId = ${supplierInvoices.id}), 0)
        - COALESCE((SELECT SUM(prr.totalAmount)
          FROM purchaseReturnReversals prr
          INNER JOIN purchaseReturns pr ON pr.id = prr.purchaseReturnId
          WHERE prr.supplierInvoiceId = ${supplierInvoices.id}
            AND pr.settlement = 'CREDIT'), 0),
        0
      )`;
      const remainingAmount = sql<string>`GREATEST(
        GREATEST(${supplierInvoices.totalAmount} - ${netCreditReturns}, 0)
        - ${supplierInvoices.legacySettledAmount}
        - ${postedAmount}
        - ${pendingAmount},
        0
      )`;
      const remainingCurrencyAmount = sql<string>`CASE
        WHEN ${supplierInvoices.currency} = 'IQD' THEN ${remainingAmount}
        WHEN ${supplierInvoices.agreedRate} > 0 THEN GREATEST(
          ${supplierInvoices.usdTotal}
          - ROUND(${netCreditReturns} / ${supplierInvoices.agreedRate}, 2)
          - ROUND(${supplierInvoices.legacySettledAmount} / ${supplierInvoices.agreedRate}, 2)
          - ${postedCurrencyAmount}
          - ${pendingCurrencyAmount},
          0
        )
        ELSE 0
      END`;
      const eligibleWhere = and(
        eq(supplierInvoices.branchId, input.branchId),
        input.supplierId == null
          ? undefined
          : eq(supplierInvoices.supplierId, input.supplierId),
        eq(supplierInvoices.status, "POSTED"),
        eq(supplierInvoices.paymentGate, "OPEN"),
        or(
          eq(supplierInvoices.liabilityClass, "NATIVE_AP"),
          and(
            eq(supplierInvoices.liabilityClass, "LEGACY_AP"),
            sql`${supplierInvoices.legacySettlementEvidenceHash} IS NOT NULL`,
          ),
        ),
        sql`${remainingAmount} > 0`,
        sql`${remainingCurrencyAmount} > 0`,
      );
      const pageWhere = and(
        eligibleWhere,
        input.cursor == null
          ? undefined
          : or(
              gt(supplierInvoices.invoiceDate, input.cursor.invoiceDate),
              and(
                eq(supplierInvoices.invoiceDate, input.cursor.invoiceDate),
                gt(supplierInvoices.id, input.cursor.id),
              ),
            ),
      );
      const limit = Math.min(input.limit ?? 100, 200);
      const total = Number((await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(supplierInvoices)
        .where(eligibleWhere))[0]?.count ?? 0);
      const invoices = await tx
        .select()
        .from(supplierInvoices)
        .where(pageWhere)
        .orderBy(asc(supplierInvoices.invoiceDate), asc(supplierInvoices.id))
        .limit(limit + 1);
      const hasMore = invoices.length > limit;
      const page = hasMore ? invoices.slice(0, limit) : invoices;
      if (!page.length) return { rows: [], hasMore: false, nextCursor: null, total };
      const ids = page.map((row) => Number(row.id));
      const reservations = await invoiceReservations(tx, ids);
      const rows = page.map((invoice) => {
          const paid = reservations.posted.get(Number(invoice.id)) ?? {
            amount: money(0),
            currencyAmount: money(0),
          };
          const pending = reservations.pending.get(Number(invoice.id)) ?? {
            amount: money(0),
            currencyAmount: money(0),
          };
          const creditReturns =
            reservations.creditReturns.get(Number(invoice.id)) ?? money(0);
          const effectiveTotal = effectiveInvoicePayable(
            invoice.totalAmount,
            creditReturns,
          );
          const sourceCurrency =
            invoice.currency === "USD"
              ? money(invoice.usdTotal).minus(
                  round2(creditReturns.dividedBy(money(invoice.agreedRate))),
                )
              : effectiveTotal;
          return {
            id: Number(invoice.id),
            invoiceNumber: invoice.invoiceNumber,
            externalInvoiceNumber: invoice.externalInvoiceNumber,
            supplierId: Number(invoice.supplierId),
            branchId: Number(invoice.branchId),
            version: Number(invoice.version),
            currency: invoice.currency,
            agreedRate: invoice.agreedRate,
            totalAmount: toDbMoney(invoice.totalAmount),
            currencyTotal: toDbMoney(sourceCurrency),
            legacySettledAmount: toDbMoney(invoice.legacySettledAmount),
            paidAmount: toDbMoney(paid.amount),
            paidCurrencyAmount: toDbMoney(paid.currencyAmount),
            pendingAmount: toDbMoney(pending.amount),
            pendingCurrencyAmount: toDbMoney(pending.currencyAmount),
            netCreditReturnAmount: toDbMoney(creditReturns),
            remainingAmount: toDbMoney(
              DecimalMaxZero(
                effectiveTotal
                  .minus(invoice.legacySettledAmount)
                  .minus(paid.amount)
                  .minus(pending.amount),
              ),
            ),
            remainingCurrencyAmount: toDbMoney(
              DecimalMaxZero(
                sourceCurrency
                  .minus(legacyCurrencySettled(invoice))
                  .minus(paid.currencyAmount)
                  .minus(pending.currencyAmount),
              ),
            ),
          };
        });
      const last = page.at(-1);
      return {
        rows,
        hasMore,
        nextCursor: hasMore && last
          ? { invoiceDate: last.invoiceDate, id: Number(last.id) }
          : null,
        total,
      };
    },
    { gate: "NONE" },
  );
}

function DecimalMaxZero(value: ReturnType<typeof money>) {
  return value.isNegative() ? money(0) : value;
}

export async function listSupplierPaymentRefundSources(
  input: {
    branchId: number;
    supplierId?: number;
    limit?: number;
    cursor?: { postedAt: Date; id: number } | null;
  },
  actor: Actor,
) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(
    async (tx) => {
      const eligibleWhere = and(
        eq(supplierPayments.branchId, input.branchId),
        input.supplierId == null
          ? undefined
          : eq(supplierPayments.supplierId, input.supplierId),
        sql`${supplierPayments.status} <> 'REFUNDED'`,
        sql`EXISTS (
          SELECT 1 FROM supplierPaymentAllocations spa
          WHERE spa.supplierPaymentId = ${supplierPayments.id}
            AND spa.allocatedAmount > spa.refundedAmount
            AND spa.allocatedCurrencyAmount > spa.refundedCurrencyAmount
        )`,
      );
      const pageWhere = and(
        eligibleWhere,
        input.cursor == null
          ? undefined
          : or(
              gt(supplierPayments.postedAt, input.cursor.postedAt),
              and(
                eq(supplierPayments.postedAt, input.cursor.postedAt),
                gt(supplierPayments.id, input.cursor.id),
              ),
            ),
      );
      const limit = Math.min(input.limit ?? 100, 200);
      const total = Number((await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(supplierPayments)
        .where(eligibleWhere))[0]?.count ?? 0);
      const payments = await tx
        .select()
        .from(supplierPayments)
        .where(pageWhere)
        .orderBy(asc(supplierPayments.postedAt), asc(supplierPayments.id))
        .limit(limit + 1);
      const hasMore = payments.length > limit;
      const page = hasMore ? payments.slice(0, limit) : payments;
      if (!page.length) return { rows: [], hasMore: false, nextCursor: null, total };
      const allocations = await tx
        .select()
        .from(supplierPaymentAllocations)
        .where(
          inArray(
            supplierPaymentAllocations.supplierPaymentId,
            page.map((row) => Number(row.id)),
          ),
        )
        .orderBy(
          asc(supplierPaymentAllocations.supplierPaymentId),
          asc(supplierPaymentAllocations.id),
        );
      const byPayment = new Map<number, typeof allocations>();
      for (const allocation of allocations) {
        const list = byPayment.get(Number(allocation.supplierPaymentId)) ?? [];
        list.push(allocation);
        byPayment.set(Number(allocation.supplierPaymentId), list);
      }
      const rows = page
        .map((payment) => ({
          id: Number(payment.id),
          paymentNumber: payment.paymentNumber,
          supplierId: Number(payment.supplierId),
          branchId: Number(payment.branchId),
          version: Number(payment.version),
          status: payment.status,
          currency: payment.currency,
          exchangeRate: payment.exchangeRate,
          amount: payment.amount,
          currencyAmount: payment.currencyAmount,
          paymentMethod: payment.paymentMethod,
          postedAt: payment.postedAt,
          allocations: (byPayment.get(Number(payment.id)) ?? [])
            .map((allocation) => ({
              id: Number(allocation.id),
              supplierInvoiceId: Number(allocation.supplierInvoiceId),
              allocatedAmount: allocation.allocatedAmount,
              allocatedCurrencyAmount: allocation.allocatedCurrencyAmount,
              refundableAmount: toDbMoney(
                money(allocation.allocatedAmount).minus(
                  allocation.refundedAmount,
                ),
              ),
              refundableCurrencyAmount: toDbMoney(
                money(allocation.allocatedCurrencyAmount).minus(
                  allocation.refundedCurrencyAmount,
                ),
              ),
            }))
            .filter((allocation) => money(allocation.refundableAmount).gt(0)),
        }))
        .filter((payment) => payment.allocations.length > 0);
      const last = page.at(-1);
      return {
        rows,
        hasMore,
        nextCursor: hasMore && last
          ? { postedAt: last.postedAt, id: Number(last.id) }
          : null,
        total,
      };
    },
    { gate: "NONE" },
  );
}

import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { appErrorMessage } from "@shared/errors";
import {
  allocateSupplierVoucherFifo,
  validateSupplierVoucherAllocations,
  type SupplierVoucherAllocation,
} from "@shared/supplierVoucherSettlement";
import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  receipts,
  supplierInvoices,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, toDbMoney } from "../money";
import { assertPurchaseBranch } from "../purchase/internal";
import {
  invoiceReservations,
  requestSupplierPaymentInTx,
} from "../purchase/supplierPayments";
import type { Actor } from "../tx";
import { assertBranchOwnership } from "./helpers";
import {
  linkedSupplierVoucherRequest,
  supplierVoucherConflict,
  supplierVoucherRequestKey,
  SUPPLIER_VOUCHER_REQUEST_CAPABILITY,
} from "./supplierPaymentLink";
import type { VoucherInput } from "./types";
import { supplierVoucherCurrencyAmount } from "../purchase/supplierVoucherCurrency";

type PreparedAllocation = SupplierVoucherAllocation & {
  currencyAmount: string;
};

const INPUT_OPERATION = "voucher.supplierSettlementInput";
function settlementInputHash(input: VoucherInput) {
  return idempotencyHash({
    allocationMode: input.supplierAllocations == null ? "FIFO" : "MANUAL",
    allocations:
      input.supplierAllocations == null
        ? null
        : [...input.supplierAllocations]
            .map((row) => ({
              supplierInvoiceId: row.supplierInvoiceId,
              invoiceVersion: row.invoiceVersion,
              amount: toDbMoney(row.amount),
            }))
            .sort((a, b) => a.supplierInvoiceId - b.supplierInvoiceId),
    cashSource:
      input.paymentMethod !== "CASH"
        ? null
        : {
            mode: input.supplierCashSource?.mode ?? "TREASURY",
            shiftId: input.supplierCashSource?.shiftId ?? null,
          },
  });
}

export async function prepareSupplierVoucherSettlementTx(
  tx: Tx,
  input: VoucherInput,
  actor: Actor,
): Promise<PreparedAllocation[] | null> {
  if (
    input.voucherType !== "PAYMENT" ||
    input.partyType !== "SUPPLIER" ||
    !input.partyId
  ) {
    if (input.supplierAllocations != null || input.supplierCashSource != null)
      throw supplierVoucherConflict(
        "توزيع فواتير المورد متاح لسند صرف المورد فقط",
      );
    return null;
  }
  if (input.paymentMethod === "CHECK" || input.paymentMethod === "EXCHANGE") {
    if (input.supplierAllocations != null || input.supplierCashSource != null)
      throw supplierVoucherConflict(
        "طريقة الدفع غير مدعومة في تخصيص سند المورد",
      );
  }
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  const invoices = await tx
    .select()
    .from(supplierInvoices)
    .where(
      and(
        eq(supplierInvoices.supplierId, input.partyId),
        eq(supplierInvoices.branchId, input.branchId),
        eq(supplierInvoices.status, "POSTED"),
        eq(supplierInvoices.paymentGate, "OPEN"),
        or(
          eq(supplierInvoices.liabilityClass, "NATIVE_AP"),
          and(
            eq(supplierInvoices.liabilityClass, "LEGACY_AP"),
            sql`${supplierInvoices.legacySettlementEvidenceHash} IS NOT NULL`,
          ),
        ),
      ),
    )
    .orderBy(asc(supplierInvoices.invoiceDate), asc(supplierInvoices.id));
  if (input.paymentMethod === "CHECK" || input.paymentMethod === "EXCHANGE") {
    if (invoices.some((invoice) => invoice.liabilityClass === "LEGACY_AP"))
      throw supplierVoucherConflict(
        "طريقة الدفع غير مدعومة لتسوية فواتير المورد المؤهلة",
      );
    // The generic path retains its native-debt guard and unadopted legacy policy.
    return null;
  }
  if (!invoices.length && input.supplierAllocations == null) return null;
  const reservations = invoices.length
    ? await invoiceReservations(
        tx,
        invoices.map((row) => row.id),
        false,
      )
    : null;
  const sources = invoices.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    version: row.version,
    remainingAmount: toDbMoney(
      money(row.totalAmount)
        .minus(row.legacySettledAmount)
        .minus(reservations?.posted.get(row.id)?.amount ?? 0)
        .minus(reservations?.pending.get(row.id)?.amount ?? 0)
        .minus(reservations?.creditReturns.get(row.id) ?? 0),
    ),
  }));
  try {
    const allocations =
      input.supplierAllocations ??
      allocateSupplierVoucherFifo(input.amount, sources);
    validateSupplierVoucherAllocations(input.amount, sources, allocations);
    return allocations.map((row) => ({
      ...row,
      amount: toDbMoney(row.amount),
      currencyAmount: supplierVoucherCurrencyAmount(
        invoices.find((invoice) => invoice.id === row.supplierInvoiceId)!,
        row.amount,
        {
          amount: toDbMoney(
            money(
              reservations?.posted.get(row.supplierInvoiceId)?.amount ?? 0,
            ).plus(
              reservations?.pending.get(row.supplierInvoiceId)?.amount ?? 0,
            ),
          ),
          currencyAmount: toDbMoney(
            money(
              reservations?.posted.get(row.supplierInvoiceId)?.currencyAmount ??
                0,
            ).plus(
              reservations?.pending.get(row.supplierInvoiceId)
                ?.currencyAmount ?? 0,
            ),
          ),
        },
        toDbMoney(reservations?.creditReturns.get(row.supplierInvoiceId) ?? 0),
        toDbMoney(reservations?.creditCurrencyAmounts.get(row.supplierInvoiceId) ?? 0),
      ),
    }));
  } catch (error) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر توزيع سند الصرف على فواتير المورد",
        why: error instanceof Error ? error.message : "التوزيع غير صالح",
        doThis: "حدّث الفواتير وراجع المبالغ المخصصة قبل الحفظ",
      }),
    });
  }
}

export async function createSupplierVoucherSettlementTx(
  tx: Tx,
  receipt: typeof receipts.$inferSelect,
  input: VoucherInput,
  allocations: PreparedAllocation[],
  actor: Actor,
) {
  if (input.paymentMethod === "CHECK" || input.paymentMethod === "EXCHANGE")
    throw supplierVoucherConflict("طريقة الدفع غير مدعومة في تخصيص سند المورد");
  const result = await requestSupplierPaymentInTx(
    tx,
    {
      supplierId: input.partyId!,
      branchId: input.branchId,
      requestKey: supplierVoucherRequestKey(receipt.id),
      currency: "IQD",
      amount: input.amount,
      currencyAmount: input.amount,
      paymentMethod: input.paymentMethod,
      cashSource:
        input.paymentMethod === "CASH"
          ? (input.supplierCashSource ?? { mode: "TREASURY" })
          : null,
      externalReference: input.referenceNumber?.trim() || receipt.voucherNumber,
      evidenceType: "PAYMENT_ORDER",
      evidenceReference: receipt.voucherNumber!,
      reason: input.description.trim(),
      allocations: allocations.map((row) => ({
        ...row,
        currencyAmount: row.currencyAmount,
      })),
    },
    actor,
    SUPPLIER_VOUCHER_REQUEST_CAPABILITY,
  );
  const existing = await checkIdempotency(
    tx,
    INPUT_OPERATION,
    String(receipt.id),
    settlementInputHash(input),
    { requireStoredHash: true },
  );
  if (existing == null)
    await recordIdempotencyKey(
      tx,
      INPUT_OPERATION,
      String(receipt.id),
      receipt.id,
      settlementInputHash(input),
    );
  return result;
}

export async function assertSupplierVoucherReplayTx(
  tx: Tx,
  input: VoucherInput,
  receiptId: number,
) {
  const request = await linkedSupplierVoucherRequest(tx, receiptId);
  if (!request) {
    if (input.supplierAllocations != null || input.supplierCashSource != null)
      throw supplierVoucherConflict(
        "مفتاح إعادة المحاولة مرتبط بسند بلا تخصيص فواتير",
      );
    return;
  }
  const original = await checkIdempotency(
    tx,
    INPUT_OPERATION,
    String(receiptId),
    settlementInputHash(input),
    { requireStoredHash: true },
  );
  if (original == null) {
    // Adopted pre-adapter vouchers had no allocation/source input extension.
    const payload = JSON.parse(request.payloadCanonical) as {
      historicalEvidence?: { kind?: string; originalReceiptId?: number };
    };
    const proof = payload.historicalEvidence;
    if (
      input.supplierAllocations != null ||
      input.supplierCashSource != null ||
      proof?.originalReceiptId !== receiptId ||
      ![
        "HISTORICAL_SUPPLIER_SETTLEMENT_ADOPTION",
        "OWNER_ACCEPTED_FULL_RECEIPT_ASSIGNMENT",
      ].includes(proof.kind ?? "") ||
      createHash("sha256").update(request.payloadCanonical).digest("hex") !==
        request.payloadHash
    )
      throw supplierVoucherConflict(
        "تعذر التحقق من مدخلات توزيع سند المورد الأصلية",
      );
  } else if (original !== receiptId) {
    throw supplierVoucherConflict("بصمة مدخلات التوزيع مرتبطة بسند مختلف");
  }
  if (input.supplierAllocations != null) {
    const rows = await tx
      .select()
      .from(supplierPaymentRequestAllocations)
      .where(eq(supplierPaymentRequestAllocations.requestId, request.id));
    const canonical = (values: readonly SupplierVoucherAllocation[]) =>
      JSON.stringify(
        [...values]
          .map((row) => ({
            supplierInvoiceId: row.supplierInvoiceId,
            invoiceVersion: row.invoiceVersion,
            amount: toDbMoney(row.amount),
          }))
          .sort((a, b) => a.supplierInvoiceId - b.supplierInvoiceId),
      );
    if (
      canonical(input.supplierAllocations) !==
      canonical(
        rows.map((row) => ({
          supplierInvoiceId: row.supplierInvoiceId,
          invoiceVersion: row.invoiceVersion,
          amount: row.requestedAmount,
        })),
      )
    )
      throw supplierVoucherConflict(
        "مفتاح إعادة المحاولة مستعمل بتوزيع فواتير مختلف",
      );
  }
  if (input.supplierCashSource != null) {
    const payload = JSON.parse(request.payloadCanonical) as {
      cashSource?: { mode: string; shiftId: number | null };
    };
    if (
      payload.cashSource?.mode !== input.supplierCashSource.mode ||
      (input.supplierCashSource.shiftId != null &&
        payload.cashSource.shiftId !== input.supplierCashSource.shiftId)
    )
      throw supplierVoucherConflict(
        "مفتاح إعادة المحاولة مستعمل بمصدر نقد مختلف",
      );
  }
}

export async function supplierVoucherSettlementDetails(
  db: DB | Tx,
  receiptId: number,
) {
  const request = await linkedSupplierVoucherRequest(db, receiptId);
  if (!request) return null;
  const allocations = await db
    .select({
      supplierInvoiceId: supplierPaymentRequestAllocations.supplierInvoiceId,
      invoiceVersion: supplierPaymentRequestAllocations.invoiceVersion,
      amount: supplierPaymentRequestAllocations.requestedAmount,
      invoiceNumber: supplierInvoices.invoiceNumber,
      invoiceDate: supplierInvoices.invoiceDate,
      currency: supplierInvoices.currency,
      currencyAmount: supplierPaymentRequestAllocations.requestedCurrencyAmount,
    })
    .from(supplierPaymentRequestAllocations)
    .innerJoin(
      supplierInvoices,
      eq(
        supplierInvoices.id,
        supplierPaymentRequestAllocations.supplierInvoiceId,
      ),
    )
    .where(eq(supplierPaymentRequestAllocations.requestId, request.id))
    .orderBy(asc(supplierInvoices.invoiceDate), asc(supplierInvoices.id));
  return { requestId: request.id, status: request.status, allocations };
}

/** Lock request before receipt, matching native decisions; pending withdrawal never moves money. */
export async function withdrawSupplierVoucherSettlementTx(
  tx: Tx,
  receiptId: number,
  actor: Actor,
) {
  const preview = await linkedSupplierVoucherRequest(tx, receiptId, true);
  if (!preview) return null;
  await assertBranchOwnership(tx, actor, preview.branchId, "سند المورد");
  const [request] = await tx
    .select()
    .from(supplierPaymentRequests)
    .where(eq(supplierPaymentRequests.id, preview.id))
    .for("update")
    .limit(1);
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .for("update")
    .limit(1);
  if (!receipt || !request || receipt.voucherNumber == null)
    throw supplierVoucherConflict("طلب سند المورد مفقود");
  if (request.status === "APPROVED" || receipt.approvalStatus === "APPROVED")
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر إلغاء سند سداد المورد من الصرف العام",
        why: "السند يسدد فواتير بتخصيصات مالية مترابطة",
        doThis:
          "استخدم طلب استرداد دفعة من سداد الموردين لعكس النقد والذمة والتخصيصات معاً",
      }),
    });
  if (receipt.status === "REVERSED")
    throw supplierVoucherConflict("السند مسحوب بالفعل");
  await tx
    .update(supplierPaymentRequestAllocations)
    .set({ activeInvoiceGuard: null })
    .where(eq(supplierPaymentRequestAllocations.requestId, request.id));
  await tx
    .update(supplierPaymentRequests)
    .set({
      status: "REJECTED",
      pendingGuard: null,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      reviewReason: "سحب سند الصرف قبل التنفيذ",
      decisionKey: `VOUCHER-WITHDRAW:${receiptId}`,
      decisionHash: createHash("sha256")
        .update(`VOUCHER-WITHDRAW:${receiptId}`)
        .digest("hex"),
    })
    .where(eq(supplierPaymentRequests.id, request.id));
  await tx
    .update(receipts)
    .set({ status: "REVERSED" })
    .where(eq(receipts.id, receiptId));
  return {
    receiptId,
    voucherNumber: receipt.voucherNumber,
    status: "REVERSED" as const,
  };
}

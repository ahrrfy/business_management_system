import Decimal from "decimal.js";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  receipts,
  supplierBookSettlementSources as sources,
  supplierBookSettlementAllocations as allocations,
  supplierInvoices,
  supplierPayments,
  supplierPaymentAllocations,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { enqueueFinancialRefresh } from "../../realtime/financialRefresh";
import { logAuditTx } from "../auditService";
import { money, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { assertBranchOwnership } from "../voucher/helpers";
import type { VoucherInput } from "../voucher/types";
import { readPurchasePriorPaymentEvidence } from "./priorPayment";
import { sha256, stableCanonical } from "./grniAccounting";
import {
  isPurchaseAdvanceSnapshot,
  purchaseAdvanceAvailableAmount,
} from "./supplierBookProjection";
import {
  refreshTargets,
  unapplySupplierBookSettlementSourceTx,
} from "./supplierBookSettlement";
import { invoiceReservations } from "./supplierPayments";
import {
  writeAdvanceRefundEvidence,
  ADVANCE_REFUND_RESTORE_ACTION,
  advanceRefundError as fail,
  assertSupplierAdvanceInboundHistory,
  readAdvanceRefundEvidence,
  type AdvanceRefundEvidence,
} from "./advanceRefundEvidence";

async function candidates(
  db: DB | Tx,
  supplierId: number,
  branchId?: number,
  includePendingCancellation = false,
) {
  const rows = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        eq(receipts.partyType, "SUPPLIER"),
        eq(receipts.partyId, supplierId),
        branchId == null ? undefined : eq(receipts.branchId, branchId),
        eq(receipts.direction, "OUT"),
        eq(receipts.approvalStatus, "APPROVED"),
        eq(receipts.status, "COMPLETED"),
      ),
    )
    .orderBy(asc(receipts.id))
    .limit(501);
  if (rows.length > 500) fail("تجاوز عدد مصادر المورد حد المراجعة الآمنة");
  const result = [];
  for (const row of rows) {
    let value;
    try {
      value = await readPurchasePriorPaymentEvidence(
        db,
        row.id,
        false,
        undefined,
        { allowPendingCancellation: includePendingCancellation },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "CONFLICT"
      )
        continue;
      throw error;
    }
    if (
      value.native ||
      (value.source && !isPurchaseAdvanceSnapshot(value.source.sourceSnapshot))
    )
      continue;
    const remaining = money(value.receipt.amount).minus(
      value.source?.reversedAmount ?? 0,
    );
    if (remaining.gt(0))
      result.push({
        id: row.id,
        voucherNumber: value.receipt.voucherNumber,
        paymentMethod: value.receipt.paymentMethod,
        amount: value.receipt.amount,
        remainingAmount: toDbMoney(remaining),
        unusedAmount: value.availableAmount,
      });
  }
  return result;
}

export async function listSupplierAdvanceRefundSources(
  input: { supplierId: number; branchId: number },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await assertBranchOwnership(tx, actor, input.branchId, "دفعات المورد");
    const rows = await candidates(tx, input.supplierId, input.branchId);
    if (rows.length)
      await assertSupplierAdvanceInboundHistory(
        tx,
        input.supplierId,
        input.branchId,
      );
    return rows;
  });
}

/** Runs before any receipt/ledger writes. Public supplier IN enters exclusive governance. */
export async function prepareSupplierAdvanceRefundTx(
  tx: Tx,
  input: VoucherInput,
  actor: Actor,
) {
  const receiptId = input.supplierAdvanceRefundReceiptId;
  if (
    receiptId != null &&
    (input.voucherType !== "RECEIPT" ||
      input.partyType !== "SUPPLIER" ||
      !input.partyId)
  )
    fail("ربط الدفعة السابقة متاح لسند قبض مورد فقط");
  if (
    input.voucherType !== "RECEIPT" ||
    input.partyType !== "SUPPLIER" ||
    !input.partyId
  )
    return null;
  await assertBranchOwnership(tx, actor, input.branchId, "استرداد دفعة المورد");
  if (receiptId == null) {
    if ((await candidates(tx, input.partyId, undefined, true)).length)
      fail(
        "توجد دفعة مورد أصلية قابلة للاسترداد؛ يلزم اختيار سند الصرف الأصلي كي لا يبقى المبلغ المسترد متاحاً للسداد",
      );
    const [native] = await tx
      .select({ id: supplierPayments.id })
      .from(supplierPayments)
      .innerJoin(
        supplierPaymentAllocations,
        eq(supplierPaymentAllocations.supplierPaymentId, supplierPayments.id),
      )
      .where(
        and(
          eq(supplierPayments.supplierId, input.partyId),
          sql`${supplierPaymentAllocations.allocatedAmount} > ${supplierPaymentAllocations.refundedAmount}`,
        ),
      )
      .for("share")
      .limit(1);
    if (native)
      fail(
        "توجد دفعة أصلية مرتبطة بفاتورة مورد؛ استخدم استرداد دفعات الموردين وحدد الدفعة وتخصيصها بدلاً من سند قبض غير مربوط",
      );
    return null;
  }
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0)
    fail("هوية سند الصرف الأصلي غير صالحة");
  await assertSupplierAdvanceInboundHistory(tx, input.partyId, input.branchId);
  const value = await readPurchasePriorPaymentEvidence(tx, receiptId, true);
  if (
    value.native ||
    (value.source && !isPurchaseAdvanceSnapshot(value.source.sourceSnapshot)) ||
    value.receipt.partyId !== input.partyId ||
    value.receipt.branchId !== input.branchId
  )
    fail(
      "السند لا يمثل دفعة مقدمة أصلية لهذا المورد والفرع؛ استخدم استرداد الدفعة المرتبطة لفواتير المورد",
    );
  const remaining = money(value.receipt.amount).minus(
    value.source?.reversedAmount ?? 0,
  );
  if (!money(input.amount).gt(0) || money(input.amount).gt(remaining))
    fail("مبلغ الاسترداد يتجاوز المتبقي من سند الصرف الأصلي");
  const sourceId =
    value.source?.id ??
    extractInsertId(
      await tx.insert(sources).values({
        supplierId: input.partyId,
        branchId: input.branchId,
        sourceAccountingEntryId: value.entry.id,
        sourceReceiptId: receiptId,
        kind: "PAYMENT",
        amount: value.receipt.amount,
        sourceSnapshot: value.snapshot,
        sourceHash: sha256(value.snapshot),
        planHash: sha256(
          stableCanonical({ purpose: "ADVANCE_REFUND", receiptId }),
        ),
        adoptionKey: `PURCHASE-ADVANCE:${receiptId}`,
        adoptedBy: actor.userId,
        reversalHistory: "[]",
      }),
    );
  return {
    sourceId,
    sourceReceiptId: receiptId,
    supplierId: input.partyId,
    branchId: input.branchId,
    amount: toDbMoney(input.amount),
  };
}

export async function applySupplierAdvanceRefundTx(
  tx: Tx,
  receiptId: number,
  plan: NonNullable<Awaited<ReturnType<typeof prepareSupplierAdvanceRefundTx>>>,
  actor: Actor,
) {
  const before = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.sourceId, plan.sourceId))
    .for("update");
  await unapplySupplierBookSettlementSourceTx(
    tx,
    {
      sourceReceiptId: plan.sourceReceiptId,
      amount: plan.amount,
      reversalKey: `ADVANCE_REFUND:${receiptId}`,
    },
    actor,
  );
  const after = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.sourceId, plan.sourceId));
  const data: AdvanceRefundEvidence = {
    version: 1,
    ...plan,
    allocations: after.flatMap((row) => {
      const delta = money(row.reversedAmount).minus(
        before.find((old) => old.id === row.id)?.reversedAmount ?? 0,
      );
      return delta.gt(0) ? [{ id: row.id, amount: toDbMoney(delta) }] : [];
    }),
  };
  await writeAdvanceRefundEvidence(tx, receiptId, data, actor);
  enqueueFinancialRefresh(tx, plan.branchId);
}

export async function assertSupplierAdvanceRefundReplayTx(
  tx: Tx,
  input: VoucherInput,
  receiptId: number,
) {
  const saved = await readAdvanceRefundEvidence(tx, receiptId);
  if (
    (saved?.sourceReceiptId ?? null) !==
    (input.supplierAdvanceRefundReceiptId ?? null)
  )
    fail("مفتاح السند مستخدم باسترداد من مصدر أصلي مختلف");
}

/** Full generic cancellation must not repay money already returned by a bound partial refund. */
export async function assertAdvanceOriginalCancellationTx(
  tx: Tx,
  originalReceiptId: number,
) {
  const [source] = await tx
    .select()
    .from(sources)
    .where(eq(sources.sourceReceiptId, originalReceiptId))
    .for("update");
  if (
    source &&
    isPurchaseAdvanceSnapshot(source.sourceSnapshot) &&
    money(source.reversedAmount).gt(0)
  )
    fail(
      "استُرد جزء من سند الصرف الأصلي؛ أنشئ سند قبض مرتبطاً بالمبلغ المتبقي بدلاً من إلغاء كامل المبلغ الأصلي",
    );
  if (source && isPurchaseAdvanceSnapshot(source.sourceSnapshot)) {
    await assertSupplierAdvanceInboundHistory(
      tx,
      source.supplierId,
      source.branchId,
    );
  } else if (!source) {
    let original;
    try {
      original = await readPurchasePriorPaymentEvidence(
        tx,
        originalReceiptId,
        true,
        undefined,
        { allowPendingCancellation: true },
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "CONFLICT"
        )
      )
        throw error;
    }
    if (original && !original.native)
      await assertSupplierAdvanceInboundHistory(
        tx,
        original.receipt.partyId!,
        original.receipt.branchId!,
      );
  }
}

/** Cancelling IN posts its normal OUT/AP once; this restores only source capacity and safe allocations. */
export async function restoreSupplierAdvanceRefundTx(
  tx: Tx,
  refundReceiptId: number,
  cancellationReceiptId: number,
  actor: Actor,
) {
  const evidence = await readAdvanceRefundEvidence(tx, refundReceiptId);
  if (!evidence) return false;
  await assertBranchOwnership(
    tx,
    actor,
    evidence.branchId,
    "عكس استرداد دفعة المورد",
  );
  const [source] = await tx
    .select()
    .from(sources)
    .where(eq(sources.id, evidence.sourceId))
    .for("update");
  if (
    !source ||
    source.sourceReceiptId !== evidence.sourceReceiptId ||
    source.supplierId !== evidence.supplierId ||
    source.branchId !== evidence.branchId ||
    sha256(source.sourceSnapshot) !== source.sourceHash ||
    !isPurchaseAdvanceSnapshot(source.sourceSnapshot)
  )
    fail("مصدر الاسترداد المحفوظ لا يطابق الدفعة الأصلية");
  const key = `ADVANCE_REFUND_RESTORE:${refundReceiptId}`;
  const history = JSON.parse(source.reversalHistory) as {
    key: string;
    amount: string;
  }[];
  if (history.some((row) => row.key === key)) return true;
  const original = history.find(
    (row) => row.key === `ADVANCE_REFUND:${refundReceiptId}`,
  );
  if (
    !original ||
    !money(original.amount).eq(evidence.amount) ||
    money(source.reversedAmount).lt(evidence.amount)
  )
    fail("مبلغ الاسترداد المحفوظ لا يطابق تاريخ عكس المصدر");
  const rows = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.sourceId, source.id))
    .for("update");
  const touched = new Set<number>();
  for (const undo of evidence.allocations) {
    const row = rows.find((item) => item.id === undo.id);
    if (
      !row ||
      row.supplierInvoiceId == null ||
      sha256(row.targetSnapshot) !== row.targetHash ||
      money(row.reversedAmount).lt(undo.amount)
    )
      fail("تخصيص الاسترداد المحفوظ غير صالح للاستعادة");
    const [invoice] = await tx
      .select()
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, row.supplierInvoiceId))
      .for("update");
    if (
      !invoice ||
      invoice.currency !== "IQD" ||
      invoice.supplierId !== source.supplierId ||
      invoice.branchId !== source.branchId
    )
      fail("فاتورة تخصيص الاسترداد لا تطابق المصدر الأصلي");
    if (
      invoice.status !== "POSTED" ||
      invoice.draftState !== "ACTIVE" ||
      !["OPEN", "SETTLED"].includes(invoice.paymentGate)
    )
      continue;
    const reservations = await invoiceReservations(tx, [invoice.id]);
    const remaining = money(invoice.totalAmount)
      .minus(invoice.legacySettledAmount)
      .minus(reservations.posted.get(invoice.id)?.amount ?? 0)
      .minus(reservations.pending.get(invoice.id)?.amount ?? 0)
      .minus(reservations.creditReturns.get(invoice.id) ?? 0);
    const restore = Decimal.min(undo.amount, Decimal.max(0, remaining));
    if (!restore.gt(0)) continue;
    await tx
      .update(allocations)
      .set({
        reversedAmount: toDbMoney(money(row.reversedAmount).minus(restore)),
        reversedCurrencyAmount: toDbMoney(
          money(row.reversedCurrencyAmount).minus(restore),
        ),
      })
      .where(eq(allocations.id, row.id));
    touched.add(invoice.id);
  }
  const reversed = money(source.reversedAmount).minus(evidence.amount);
  await tx
    .update(sources)
    .set({
      reversedAmount: toDbMoney(reversed),
      status: reversed.isZero() ? "APPLIED" : "PARTIALLY_REVERSED",
      version: source.version + 1,
      reversalHistory: stableCanonical([
        ...history,
        { key, amount: toDbMoney(money(evidence.amount).neg()) },
      ]),
    })
    .where(eq(sources.id, source.id));
  const finalRows = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.sourceId, source.id));
  purchaseAdvanceAvailableAmount(
    { amount: source.amount, reversedAmount: toDbMoney(reversed) },
    finalRows,
  );
  await refreshTargets(tx, Array.from(touched));
  await logAuditTx(tx, actor, {
    action: ADVANCE_REFUND_RESTORE_ACTION,
    entityType: "receipt",
    entityId: cancellationReceiptId,
    newValue: {
      refundReceiptId,
      sourceId: source.id,
      amount: evidence.amount,
      restoredInvoiceIds: Array.from(touched),
    },
  });
  enqueueFinancialRefresh(tx, source.branchId);
  return true;
}

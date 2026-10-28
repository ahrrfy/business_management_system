import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { eq, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  exchangeTransactions,
  purchaseOrders,
  receipts,
  suppliers,
  supplierInvoices,
  supplierBookSettlementSources,
  supplierBookSettlementAllocations,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, round2, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { sha256, stableCanonical } from "../purchase/grniAccounting";
import { assertPurchaseBranch } from "../purchase/internal";
import { refreshTargets } from "../purchase/supplierBookSettlement";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import {
  assertNativePurchaseSettlementEvidence,
  assertSupplierInvoicePayable,
  invoiceReservations,
  resolveInvoicePurchaseOrderIds,
} from "../purchase/supplierPayments";
import { cumulativeCurrencyDelta } from "../purchase/supplierVoucherCurrency";

function invalid(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر تسديد فاتورة المورد عبر الصيرفة",
      why,
      doThis:
        "اختر أمر الشراء الدولاري الصحيح وراجع فاتورة المورد وتخصيصات سدادها؛ أكمل أي طلب سداد أو قضية مطابقة معلقة قبل الصرف",
    }),
  });
}

export type PreparedExchangeInvoiceSettlement = {
  invoice: typeof supplierInvoices.$inferSelect;
  purchaseOrderId: number;
  amountIqd: string;
  amountUsd: string;
};

/** Caller holds branch -> PO -> supplier; invoice and reservation locks follow.
 * No wallet/AP effect is allowed before this source validation completes. */
export async function prepareExchangeInvoiceSettlementTx(
  tx: Tx,
  input: {
    order: typeof purchaseOrders.$inferSelect | null;
    supplier: typeof suppliers.$inferSelect;
    settledUsd: string;
    settledIqd: string;
  },
  actor: Actor,
): Promise<PreparedExchangeInvoiceSettlement | null> {
  const { order, supplier } = input;
  if (!supplier.isActive) invalid("المورد غير فعال ولا يقبل سداداً جديداً");
  if (!order) {
    const [governed] = await tx
      .select({ id: supplierInvoices.id })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.supplierId, Number(supplier.id)))
      .for("share")
      .limit(1);
    if (governed)
      invalid(
        "للمورد فواتير محكومة؛ لا يمكن إطفاء ذمتها دون تحديد أمر الشراء وتخصيص الفاتورة",
      );
    return null;
  }
  const documents = await tx
    .select()
    .from(supplierInvoices)
    .where(
      or(
        eq(supplierInvoices.legacyPurchaseOrderId, Number(order.id)),
        sql`EXISTS (SELECT 1 FROM supplierInvoiceLines sil
      INNER JOIN purchaseOrderRevisionItems pori ON pori.id = sil.purchaseOrderRevisionItemId
      INNER JOIN purchaseOrderRevisions por ON por.id = pori.revisionId
      WHERE sil.supplierInvoiceId = ${supplierInvoices.id} AND por.purchaseOrderId = ${order.id})`,
        sql`EXISTS (SELECT 1 FROM supplierInvoiceMatchRuns simr
      INNER JOIN supplierInvoiceMatchAllocations sima ON sima.matchRunId = simr.id
      INNER JOIN goodsReceiptItems gri ON gri.id = sima.goodsReceiptItemId
      INNER JOIN purchaseOrderItems poi ON poi.id = gri.purchaseOrderItemId
      WHERE simr.supplierInvoiceId = ${supplierInvoices.id} AND poi.purchaseOrderId = ${order.id})`,
      ),
    )
    .for("update");
  await assertNativePurchaseSettlementEvidence(tx, {
    supplier,
    orders: [order],
    invoices: documents,
  });
  if (!documents.length) {
    // Historical PO-only settlements must still prove their original purchase
    // ledger and unconsumed source capacity. A supplier's global AP is not proof.
    const projection = (
      await loadPurchaseSettlements(tx, [order], { currentRead: true })
    ).get(Number(order.id));
    if (
      !projection ||
      projection.requiresReview ||
      money(input.settledIqd).gt(projection.remainingAmountIqd) ||
      money(input.settledUsd).gt(projection.remainingAmountCurrency)
    ) {
      invalid(
        "دليل أمر الشراء التاريخي أو المبلغ المتبقي غير محسوم؛ يلزم ربط مستند الشراء قبل تسديده",
      );
    }
    return null;
  }
  const posted = documents.filter((invoice) => invoice.status === "POSTED");
  if (posted.length !== 1)
    invalid("أمر الشراء لا يحدد فاتورة مورد مرحّلة واحدة صالحة للتخصيص");
  const invoice = posted[0];
  assertPurchaseBranch(invoice, actor);
  assertSupplierInvoicePayable(invoice);
  if (
    Number(invoice.branchId) !== Number(order.branchId) ||
    Number(invoice.supplierId) !== Number(supplier.id) ||
    invoice.currency !== "USD" ||
    !money(invoice.agreedRate).eq(order.agreedRate ?? 0)
  ) {
    invalid("المورد أو الفرع أو عملة فاتورة المورد وسعرها لا تطابق أمر الشراء");
  }
  const poIds = await resolveInvoicePurchaseOrderIds(tx, [Number(invoice.id)]);
  if (poIds.length !== 1 || poIds[0] !== Number(order.id))
    invalid("فاتورة المورد مرتبطة بأكثر من أمر شراء؛ يلزم تخصيص موثق لكل مصدر");
  const reservations = await invoiceReservations(tx, [Number(invoice.id)]);
  const pending = reservations.pending.get(Number(invoice.id));
  if (money(pending?.amount).gt(0) || money(pending?.currencyAmount).gt(0))
    invalid("فاتورة المورد محجوزة لطلب سداد معلق");
  const paid = reservations.posted.get(Number(invoice.id));
  const totalIqd = round2(
    money(invoice.totalAmount).minus(
      reservations.creditReturns.get(Number(invoice.id)) ?? 0,
    ),
  );
  const totalUsd = round2(
    money(invoice.usdTotal).minus(
      reservations.creditCurrencyAmounts.get(Number(invoice.id)) ?? 0,
    ),
  );
  const usedIqd = round2(
    money(invoice.legacySettledAmount).plus(paid?.amount ?? 0),
  );
  const usedUsd = round2(
    money(invoice.legacySettledAmount).div(money(invoice.agreedRate)),
  ).plus(paid?.currencyAmount ?? 0);
  if (money(input.settledUsd).gt(totalUsd.minus(usedUsd)))
    invalid("مبلغ الدولار يتجاوز المتبقي المثبت في فاتورة المورد");
  const amountIqd = cumulativeCurrencyDelta(
    toDbMoney(totalUsd),
    toDbMoney(totalIqd),
    toDbMoney(usedUsd),
    toDbMoney(usedIqd),
    input.settledUsd,
  );
  return {
    invoice,
    purchaseOrderId: Number(order.id),
    amountIqd,
    amountUsd: input.settledUsd,
  };
}

/** Own the existing exchange receipt/GL once. BOOK allocations carry invoice
 * denomination; the exchange writer alone owns cash, wallet, AP and USD. */
export async function applyExchangeInvoiceSettlementTx(
  tx: Tx,
  prepared: PreparedExchangeInvoiceSettlement,
  source: { txnId: number; receiptId: number; entryDedupeKey: string },
  actor: Actor,
): Promise<void> {
  const [entry] = await tx
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.dedupeKey, source.entryDedupeKey))
    .limit(1);
  if (
    !entry ||
    entry.entryType !== "EXCHANGE_SETTLE" ||
    Number(entry.receiptId) !== source.receiptId ||
    Number(entry.supplierId) !== Number(prepared.invoice.supplierId) ||
    Number(entry.branchId) !== Number(prepared.invoice.branchId) ||
    !money(entry.amount).eq(prepared.amountIqd)
  )
    invalid("قيد تسديد الصيرفة لا يطابق مصدر تخصيص الفاتورة");
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, source.receiptId))
    .limit(1);
  const [exchange] = await tx
    .select()
    .from(exchangeTransactions)
    .where(eq(exchangeTransactions.id, source.txnId))
    .limit(1);
  if (
    !receipt ||
    receipt.direction !== "OUT" ||
    receipt.paymentMethod !== "EXCHANGE" ||
    receipt.partyType !== "SUPPLIER" ||
    receipt.partyId !== prepared.invoice.supplierId ||
    receipt.branchId !== prepared.invoice.branchId ||
    !money(receipt.amount).eq(prepared.amountIqd) ||
    !exchange ||
    exchange.type !== "SETTLE" ||
    exchange.status !== "ACTIVE" ||
    exchange.receiptId !== receipt.id ||
    exchange.purchaseOrderId !== prepared.purchaseOrderId ||
    exchange.branchId !== receipt.branchId ||
    exchange.supplierId !== receipt.partyId ||
    !money(exchange.settledIqd).eq(prepared.amountIqd) ||
    !money(exchange.settledUsd).eq(prepared.amountUsd)
  ) {
    invalid("أطراف سند الصيرفة وعملية التسديد لا تطابق مصدر الفاتورة");
  }
  const sourceSnapshot = stableCanonical(
    JSON.parse(
      JSON.stringify({
        version: 1,
        purpose: "EXCHANGE_INVOICE_SETTLEMENT",
        sourceExchangeTransactionId: source.txnId,
        sourceReceiptId: source.receiptId,
        sourceAccountingEntryId: Number(entry.id),
        settledIqd: prepared.amountIqd,
        settledUsd: prepared.amountUsd,
        entry,
        receipt,
        exchange,
      }),
    ),
  );
  const targetSnapshot = stableCanonical(
    JSON.parse(
      JSON.stringify({
        purchaseOrderId: prepared.purchaseOrderId,
        invoice: prepared.invoice,
        amount: prepared.amountIqd,
        currencyAmount: prepared.amountUsd,
      }),
    ),
  );
  const sourceId = extractInsertId(
    await tx.insert(supplierBookSettlementSources).values({
      supplierId: Number(prepared.invoice.supplierId),
      branchId: Number(prepared.invoice.branchId),
      sourceAccountingEntryId: Number(entry.id),
      sourceReceiptId: source.receiptId,
      sourceExchangeTransactionId: source.txnId,
      kind: "PAYMENT",
      amount: prepared.amountIqd,
      sourceSnapshot,
      sourceHash: sha256(sourceSnapshot),
      planHash: sha256(stableCanonical({ sourceSnapshot, targetSnapshot })),
      adoptionKey: `exchange-settle:${source.txnId}`,
      adoptedBy: actor.userId,
      reversalHistory: "[]",
    }),
  );
  await tx.insert(supplierBookSettlementAllocations).values({
    sourceId,
    supplierInvoiceId: Number(prepared.invoice.id),
    allocatedAmount: prepared.amountIqd,
    allocatedCurrencyAmount: prepared.amountUsd,
    targetSnapshot,
    targetHash: sha256(targetSnapshot),
  });
  await refreshTargets(tx, [Number(prepared.invoice.id)]);
}

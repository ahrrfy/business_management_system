import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customers, invoiceItems, invoices, productVariants, receipts, shifts } from "../../drizzle/schema";
import {
  computeInvoiceCost,
  computeInvoiceTotals,
  computeLineTotal,
  snapshotUnitCost,
} from "./billing";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, toDbMoney } from "./money";
import { nextInvoiceNumber } from "./numbering";
import { getUnitPrice, resolveTier, type PriceTier } from "./pricing";
import { withTx, type Actor } from "./tx";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface SaleLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
}

export interface CreateSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  sourceType: "POS" | "ONLINE" | "ORDER" | "WORKORDER";
  lines: SaleLineInput[];
  invoiceDiscount?: string | null;
  taxRatePercent?: string | null;
  payment?: { amount: string; method: PaymentMethod } | null;
  clientRequestId?: string | null;
  notes?: string | null;
}

export interface CreateSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
}

export async function createSale(input: CreateSaleInput, actor: Actor): Promise<CreateSaleResult> {
  return withTx(async (tx) => {
    // 1. Idempotency: replay the existing invoice for a repeated clientRequestId.
    if (input.clientRequestId) {
      const existing = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1);
      if (existing[0]) {
        return {
          invoiceId: Number(existing[0].id),
          invoiceNumber: existing[0].invoiceNumber,
          total: existing[0].total,
          status: existing[0].status as CreateSaleResult["status"],
          idempotentReplay: true,
        };
      }
    }

    if (!input.lines.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء فاتورة بلا أصناف" });
    }

    // 2. Shift must be OPEN and belong to the branch (when provided — POS).
    if (input.shiftId) {
      const s = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).limit(1);
      if (!s[0] || s[0].status !== "OPEN" || Number(s[0].branchId) !== input.branchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية غير مفتوحة أو لا تخص هذا الفرع" });
      }
    }

    // 3. Resolve the effective price tier.
    let customerTier: PriceTier | null = null;
    if (input.customerId) {
      const c = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (!c[0]) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      customerTier = c[0].defaultPriceTier as PriceTier;
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier });

    // 4. Price/cost/convert each line.
    const computed = [];
    for (const l of input.lines) {
      const v = await tx
        .select({ costPrice: productVariants.costPrice, isActive: productVariants.isActive })
        .from(productVariants)
        .where(eq(productVariants.id, l.variantId))
        .limit(1);
      if (!v[0]) throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${l.variantId} غير موجود` });
      if (v[0].isActive === false) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${l.variantId} معطّل` });
      }

      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : await getUnitPrice(tx, l.productUnitId, tier);
      const unitCost = snapshotUnitCost(v[0].costPrice);
      const lineRes = computeLineTotal({
        unitPrice,
        quantity: money(l.quantity),
        discountPercent: l.discountPercent,
        discountAmount: l.discountAmount,
      });
      computed.push({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        baseQuantity,
        unitPrice: lineRes.unitPrice,
        unitCost,
        quantity: lineRes.quantity,
        discountAmount: lineRes.discountAmount,
        total: lineRes.total,
      });
    }

    // 5. Deterministic lock order: sort by variantId ascending.
    computed.sort((a, b) => a.variantId - b.variantId);

    // 6. Totals + COGS.
    const totals = computeInvoiceTotals({
      lineTotals: computed.map((c) => c.total),
      invoiceDiscount: input.invoiceDiscount,
      taxRatePercent: input.taxRatePercent,
    });
    const costTotal = computeInvoiceCost(
      computed.map((c) => ({ unitCost: c.unitCost, baseQuantity: c.baseQuantity }))
    );

    // 7. Credit-sale guard.
    const paidNow = money(input.payment?.amount ?? "0");
    if (paidNow.lt(money(totals.total)) && !input.customerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البيع الآجل يتطلب عميلاً محدداً" });
    }

    // 8. Invoice header.
    const invoiceNumber = await nextInvoiceNumber(tx, input.branchId);
    const status = computeInvoiceStatus(totals.total, toDbMoney(paidNow));
    const insRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: input.sourceType,
      sourceId: input.clientRequestId ?? null,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      customerId: input.customerId ?? null,
      priceTier: tier,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      discountAmount: totals.discountAmount,
      total: totals.total,
      costTotal,
      status,
      paidAmount: toDbMoney(paidNow),
      paymentMethod: input.payment?.method ?? null,
      paymentDate: paidNow.gt(0) ? new Date() : null,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const invoiceId = Number((insRes as any)[0]?.insertId ?? (insRes as any).insertId);

    // 9. Items.
    for (const c of computed) {
      await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitPrice: c.unitPrice,
        unitCost: c.unitCost,
        discountAmount: c.discountAmount,
        total: c.total,
      });
    }

    // 10. Deduct stock (OUT) per line.
    for (const c of computed) {
      await applyMovement(tx, {
        variantId: c.variantId,
        branchId: input.branchId,
        baseQuantity: c.baseQuantity,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: invoiceId,
        createdBy: actor.userId,
      });
    }

    // 11. SALE ledger entry (revenue = net before tax).
    const revenue = money(totals.subtotal).minus(money(totals.discountAmount));
    const cost = money(costTotal);
    await postEntry(tx, {
      entryType: "SALE",
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue,
      cost,
      profit: revenue.minus(cost),
      taxAmount: money(totals.taxAmount),
      amount: money(totals.total),
    });

    // 12. Payment + AR.
    if (paidNow.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        invoiceId,
        branchId: input.branchId,
        shiftId: input.shiftId ?? null,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        invoiceId,
        receiptId,
        customerId: input.customerId ?? null,
        amount: paidNow,
      });
    }
    if (input.customerId) {
      await adjustCustomerBalance(tx, input.customerId, money(totals.total).minus(paidNow));
    }

    return { invoiceId, invoiceNumber, total: totals.total, status };
  });
}

export interface ProcessPaymentInput {
  invoiceId: number;
  amount: string;
  method: PaymentMethod;
  shiftId?: number | null;
}

/** Record a later payment against a credit invoice; updates status + AR. */
export async function processPayment(input: ProcessPaymentInput, actor: Actor) {
  return withTx(async (tx) => {
    const rows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = rows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الدفع على فاتورة ملغاة أو مرتجعة" });
    }
    const amount = money(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    const rRes = await tx.insert(receipts).values({
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      shiftId: input.shiftId ?? null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: input.method,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);

    const newPaid = money(inv.paidAmount).plus(amount);
    const status = computeInvoiceStatus(inv.total, toDbMoney(newPaid));
    await tx
      .update(invoices)
      .set({ paidAmount: toDbMoney(newPaid), status, paymentDate: new Date(), paymentMethod: input.method })
      .where(eq(invoices.id, input.invoiceId));

    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      receiptId,
      customerId: inv.customerId,
      amount,
    });
    if (inv.customerId) {
      await adjustCustomerBalance(tx, Number(inv.customerId), amount.neg());
    }

    return { invoiceId: input.invoiceId, paidAmount: toDbMoney(newPaid), status };
  });
}

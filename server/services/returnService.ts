import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { accountingEntries, invoiceItems, invoices, receipts } from "../../drizzle/schema";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { applyMovement } from "./inventoryService";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, round2, toDbMoney } from "./money";
import { openShiftIdTx } from "./shiftService";
import { withTx, type Actor } from "./tx";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface ReturnLineInput {
  invoiceItemId: number;
  baseQuantity: number;
}
export interface ReturnSaleInput {
  invoiceId: number;
  lines: ReturnLineInput[];
  refund?: { amount: string; method: PaymentMethod } | null;
  restock?: boolean;
  /** Idempotency: نفس المفتاح يُعاد تشغيله بنتيجة المرتجع الأول (لا استرداد/إرجاع مزدوج). */
  clientRequestId?: string | null;
}

export async function returnSale(input: ReturnSaleInput, actor: Actor) {
  return withTx(async (tx) => {
    // Idempotency: تكرار الطلب نفسه يُعاد تشغيله بنتيجة المرتجع الأول بلا استرداد مكرّر.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "sale.return", input.clientRequestId);
      if (existingRefId != null) {
        return { invoiceId: input.invoiceId, returnedTotal: "0.00", fullyReturned: false, idempotentReplay: true as const };
      }
    }

    const invRows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = invRows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة ملغاة أو مرتجعة بالكامل" });
    }
    // فاتورة أمر الشغل تبيع متغيّراً أساس لم يُضَف للمخزون فعلاً (المواد استُهلكت عند البدء)،
    // فإعادة التخزين تخلق مخزوناً وهمياً لمنتج مُخصَّص. افرض restock=false لها.
    const restock = inv.sourceType === "WORKORDER" ? false : input.restock !== false;
    if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا أصناف للإرجاع" });

    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId));
    const itemById = new Map(items.map((i) => [Number(i.id), i]));

    const work = input.lines.map((l) => {
      const item = itemById.get(l.invoiceItemId);
      if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: `بند ${l.invoiceItemId} لا يخص الفاتورة` });
      if (!Number.isInteger(l.baseQuantity) || l.baseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الإرجاع يجب أن تكون صحيحة موجبة" });
      }
      const remaining = item.baseQuantity - (item.returnedBaseQuantity ?? 0);
      if (l.baseQuantity > remaining) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `كمية الإرجاع تتجاوز المتبقّي القابل للإرجاع للبند ${l.invoiceItemId}` });
      }
      return { line: l, item };
    });
    work.sort((a, b) => Number(a.item.variantId) - Number(b.item.variantId));

    // Proportional allocation of revenue/tax against the invoice totals.
    const subtotal = money(inv.subtotal);
    const discountAmount = money(inv.discountAmount);
    const taxAmount = money(inv.taxAmount);
    const discountRatio = subtotal.gt(0) ? discountAmount.dividedBy(subtotal) : new Decimal(0);
    const taxable = subtotal.minus(discountAmount);
    const taxRate = taxable.gt(0) ? taxAmount.dividedBy(taxable) : new Decimal(0);

    let returnedGrossNet = new Decimal(0);
    let returnedCost = new Decimal(0);

    for (const { line, item } of work) {
      const portion = new Decimal(line.baseQuantity).dividedBy(item.baseQuantity);
      returnedGrossNet = returnedGrossNet.plus(money(item.total).times(portion));
      returnedCost = returnedCost.plus(round2(money(item.unitCost).times(line.baseQuantity)));

      if (restock) {
        await applyMovement(tx, {
          variantId: Number(item.variantId),
          branchId: Number(inv.branchId),
          baseQuantity: line.baseQuantity,
          movementType: "RETURN",
          referenceType: "RETURN",
          referenceId: input.invoiceId,
          createdBy: actor.userId,
        });
      }
      await tx
        .update(invoiceItems)
        .set({ returnedBaseQuantity: (item.returnedBaseQuantity ?? 0) + line.baseQuantity })
        .where(eq(invoiceItems.id, Number(item.id)));
    }

    // Completion is known now (returnedBaseQuantity was updated in the loop).
    const refreshed = await tx
      .select({ baseQuantity: invoiceItems.baseQuantity, returnedBaseQuantity: invoiceItems.returnedBaseQuantity })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, input.invoiceId));
    const fullyReturned = refreshed.every((r) => (r.returnedBaseQuantity ?? 0) >= r.baseQuantity);

    // Prior RETURN entries (stored negative) → positive cumulative totals.
    const priorRows = await tx
      .select({
        rev: sql<string>`COALESCE(SUM(${accountingEntries.revenue}), 0)`,
        tax: sql<string>`COALESCE(SUM(${accountingEntries.taxAmount}), 0)`,
        amt: sql<string>`COALESCE(SUM(${accountingEntries.amount}), 0)`,
      })
      .from(accountingEntries)
      .where(and(eq(accountingEntries.invoiceId, input.invoiceId), eq(accountingEntries.entryType, "RETURN")));
    const priorRevenue = money(priorRows[0]?.rev ?? "0").neg();
    const priorTax = money(priorRows[0]?.tax ?? "0").neg();
    const priorTotal = money(priorRows[0]?.amt ?? "0").neg();

    let returnedRevenue: Decimal;
    let returnedTax: Decimal;
    let returnedTotal: Decimal;
    if (fullyReturned) {
      // Last-installment remainder: cumulative returns equal the original exactly.
      const invoiceRevenue = money(inv.subtotal).minus(money(inv.discountAmount));
      returnedRevenue = round2(invoiceRevenue.minus(priorRevenue));
      returnedTax = round2(money(inv.taxAmount).minus(priorTax));
      returnedTotal = round2(money(inv.total).minus(priorTotal));
    } else {
      returnedRevenue = round2(returnedGrossNet.times(new Decimal(1).minus(discountRatio)));
      returnedTax = round2(returnedRevenue.times(taxRate));
      returnedTotal = round2(returnedRevenue.plus(returnedTax));
    }
    returnedCost = round2(returnedCost);

    // RETURN ledger entry: negative values.
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      customerId: inv.customerId,
      revenue: returnedRevenue.neg(),
      cost: returnedCost.neg(),
      profit: returnedRevenue.minus(returnedCost).neg(),
      taxAmount: returnedTax.neg(),
      amount: returnedTotal.neg(),
    });

    // Cash refund capped to min(returnedTotal, amount actually paid). Reject overage.
    const requestedRefund = money(input.refund?.amount ?? "0");
    if (requestedRefund.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الاسترداد لا يصحّ أن يكون سالباً" });
    }
    // سقف الاسترداد بالطريقة نفسها: المتاح = Σ(IN بهذه الطريقة) − Σ(OUT بهذه الطريقة)،
    // فلا يُسترَدّ نقداً ما دُفع بطاقةً (يُفرّغ الصندوق) ولا يتجاوز المقبوض فعلاً بتلك الطريقة.
    const refundMethod = input.refund?.method;
    let methodAvailable = new Decimal(0);
    if (refundMethod) {
      const mr = await tx
        .select({
          inSum: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`,
          outSum: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`,
        })
        .from(receipts)
        .where(
          and(
            eq(receipts.invoiceId, input.invoiceId),
            eq(receipts.paymentMethod, refundMethod),
            eq(receipts.status, "COMPLETED"),
          ),
        );
      methodAvailable = money(mr[0]?.inSum ?? "0").minus(money(mr[0]?.outSum ?? "0"));
    }
    const refundCap = Decimal.min(returnedTotal, methodAvailable);
    if (requestedRefund.gt(refundCap)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الاسترداد بـ${refundMethod ?? "—"} (${requestedRefund.toFixed(2)}) يتجاوز المسموح (${refundCap.toFixed(2)} = الأقل من قيمة المرتجع والمقبوض بهذه الطريقة)`,
      });
    }
    const cashRefund = requestedRefund;

    if (cashRefund.gt(0)) {
      // انسب الاسترداد النقدي لوردية الموظّف المفتوحة (وإلا فالـZ-report يُظهر عجزاً وهمياً).
      const shiftId = await openShiftIdTx(tx, actor.userId, Number(inv.branchId));
      const rRes = await tx.insert(receipts).values({
        invoiceId: input.invoiceId,
        branchId: Number(inv.branchId),
        shiftId,
        direction: "OUT",
        amount: toDbMoney(cashRefund),
        paymentMethod: input.refund!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(inv.branchId),
        invoiceId: input.invoiceId,
        receiptId,
        customerId: inv.customerId,
        amount: cashRefund,
      });
    }

    // paidAmount tracks Σ(IN) − Σ(OUT); recompute status.
    // returnedTotal تراكمي عبر مرتجعات جزئية ⇒ يمنع انحراف AR في reconcile/aging.
    const newPaid = money(inv.paidAmount).minus(cashRefund);
    const newReturnedTotal = money(inv.returnedTotal ?? "0").plus(returnedTotal);
    const status = fullyReturned ? "RETURNED" : computeInvoiceStatus(inv.total, toDbMoney(newPaid));
    await tx
      .update(invoices)
      .set({
        paidAmount: toDbMoney(newPaid),
        returnedTotal: toDbMoney(newReturnedTotal),
        status,
      })
      .where(eq(invoices.id, input.invoiceId));

    // AR: the portion not refunded in cash is dropped from the customer's balance.
    if (inv.customerId) {
      await adjustCustomerBalance(tx, Number(inv.customerId), returnedTotal.minus(cashRefund).neg());
    }

    // Idempotency: سجّل المفتاح بعد نجاح الكتابة (refId = الفاتورة).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "sale.return", input.clientRequestId, input.invoiceId);
    }

    return {
      invoiceId: input.invoiceId,
      returnedTotal: returnedTotal.toFixed(2),
      fullyReturned,
    };
  });
}

// READY → DELIVERED: إنشاء فاتورة (sourceType=WORKORDER) + دفعة اختيارية + قيد SALE + تسوية الذمم.
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { invoiceItems, invoices, productUnits, receipts, workOrders } from "../../../drizzle/schema";
import { assertCreditLimit } from "../../lib/credit";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { openShiftIdTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import type { PaymentMethod } from "./types";

export interface DeliverWorkOrderInput {
  workOrderId: number;
  payment?: { amount: string; method: PaymentMethod } | null;
  clientRequestId?: string | null;
}

/** READY → DELIVERED: create invoice (sourceType=WORKORDER) + optional payment + SALE entry + AR adjust. */
export async function deliverWorkOrder(input: DeliverWorkOrderInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    // Idempotency: double-click / network-retry ⇒ return the already-created invoice.
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "workOrder.deliver", input.clientRequestId);
      if (existingId != null) {
        const inv = (await tx.select({ invoiceNumber: invoices.invoiceNumber, status: invoices.status })
          .from(invoices).where(eq(invoices.id, existingId)).limit(1))[0];
        return { workOrderId: input.workOrderId, invoiceId: existingId, invoiceNumber: inv?.invoiceNumber ?? "", status: inv?.status ?? "PENDING", idempotentReplay: true as const };
      }
    }
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للتسليم" });

    // أمر خدمة خالص (بلا منتج أساس): الفاتورة بلا سطر مخزون (invoiceItems.variantId = NOT NULL FK).
    // كانت deliver السابقة تُدرج variantId = Number(null) = 0 ⇒ انتهاك FK ⇒ تعذّر تسليم أوامر
    // التخصيص الخالصة. الآن: سطرٌ فقط حين يوجد منتج أساس؛ صافي الفاتورة/القيد محفوظ بـsalePrice.
    const hasBaseVariant = wo.baseVariantId != null;
    const baseUnit = hasBaseVariant
      ? (
          await tx
            .select({ id: productUnits.id })
            .from(productUnits)
            .where(eq(productUnits.variantId, Number(wo.baseVariantId)))
            .limit(1)
        )[0]
      : undefined;

    const quantity = wo.quantity;
    const salePrice = money(wo.salePrice);
    const unitPrice = round2(salePrice.dividedBy(quantity));
    const materialsCost = money(wo.materialsCost);
    const laborCost = money(wo.laborCost);
    const costTotal = round2(materialsCost.plus(laborCost));

    // Credit-sale guard. العربون المقبوض سابقاً (receipt+PAYMENT_IN عند الإنشاء) يُضمّ لمدفوع الفاتورة.
    const paidNow = money(input.payment?.amount ?? "0");
    const depositPaid = round2(money(wo.deposit ?? "0"));
    const totalPaid = round2(depositPaid.plus(paidNow));
    if (paidNow.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع لا يمكن أن يكون سالباً" });
    if (totalPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع (مع العربون) يتجاوز إجمالي الأمر" });
    if (totalPaid.lt(salePrice) && !wo.customerId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب الخدمة الآجل يتطلب عميلاً محدداً" });

    // H5: فحص حدّ الائتمان على الجزء الآجل قبل إنشاء الفاتورة (يَرمي FORBIDDEN عند التجاوز).
    const unpaidPortion = round2(salePrice.minus(totalPaid));
    if (wo.customerId && unpaidPortion.gt(0)) {
      await assertCreditLimit(tx, Number(wo.customerId), unpaidPortion, Number(wo.branchId));
    }

    // Invoice number — reuse the invoice numbering (per-branch daily seq).
    const { nextInvoiceNumber } = await import("../numbering");
    const invoiceNumber = await nextInvoiceNumber(tx, Number(wo.branchId));
    const status = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(totalPaid));
    const sourceId = `WO-${wo.id}`;
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId,
      branchId: Number(wo.branchId),
      customerId: wo.customerId ?? null,
      priceTier: "RETAIL",
      subtotal: salePrice.toFixed(2),
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: salePrice.toFixed(2),
      costTotal: costTotal.toFixed(2),
      status,
      paidAmount: toDbMoney(totalPaid),
      paymentMethod: input.payment?.method ?? null,
      paymentDate: totalPaid.gt(0) ? new Date() : null,
      notes: `طلب خدمة ${wo.orderNumber}: ${wo.title}`,
      createdBy: actor.userId,
    });
    const invoiceId = extractInsertId(invRes);

    if (hasBaseVariant) {
      await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: Number(wo.baseVariantId),
        productUnitId: baseUnit ? Number(baseUnit.id) : null,
        workOrderId: Number(wo.id),
        quantity: Number(quantity).toFixed(3),
        baseQuantity: quantity,
        unitPrice: unitPrice.toFixed(2),
        unitCost: round2(costTotal.dividedBy(quantity)).toFixed(2),
        discountAmount: "0",
        total: salePrice.toFixed(2),
      });
    }

    // Ledger: SALE entry (no stock movement here — already consumed at start).
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`, // حارس بنيوي: قيد SALE واحد لكل فاتورة
      branchId: Number(wo.branchId),
      invoiceId,
      customerId: wo.customerId ?? null,
      revenue: salePrice,
      cost: costTotal,
      profit: round2(salePrice.minus(costTotal)),
      amount: salePrice,
    });

    // AR if credit portion (المتبقّي بعد العربون + دفعة التسليم).
    if (wo.customerId) {
      const unpaid = round2(salePrice.minus(totalPaid));
      if (unpaid.gt(0)) await adjustCustomerBalance(tx, Number(wo.customerId), unpaid);
    }

    // A1 (١٩/٦/٢٦) — append-only:
    // - receipt.invoiceId يُحدَّث (المقبوضات قابلة للنقل: ليست قيوداً محاسبية).
    // - accountingEntries.invoiceId يبقى NULL على قيد العربون (الـPAYMENT_IN الأصلي) ⇒ append-only صارم.
    // الإقفال محاسبياً: deposit مُحتسَب في invoice.paidAmount عند التسليم (totalPaid). reconcileService
    // يستثني قيد العربون من voucherSum عبر فلتر receipt.workOrderId NOT NULL (لا يعتمد على entry.invoiceId).
    if (depositPaid.gt(0)) {
      const depRcpt = (await tx.select({ id: receipts.id }).from(receipts)
        .where(and(eq(receipts.workOrderId, Number(wo.id)), isNull(receipts.invoiceId))).limit(1))[0];
      if (depRcpt) {
        await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcpt.id)));
        // ⛔ كان هنا UPDATE accountingEntries.invoiceId — أُزيل ضمن A1: انتهاك append-only
        //     على دفتر الأستاذ. الـUPDATE لم يكن load-bearing لأي حساب.
      }
    }

    // Optional payment receipt + PAYMENT_IN entry.
    if (paidNow.gt(0)) {
      // انسب الدفع النقدي لوردية الموظّف المفتوحة (تسوية الصندوق/Z-report) — تفضيل وردية الاستقبال.
      const shiftId = await openShiftIdTx(tx, actor.userId, Number(wo.branchId), "RECEPTION");
      if (input.payment!.method === "CASH" && shiftId == null)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يَلزم وردية مفتوحة للدفع النقدي" });
      const rRes = await tx.insert(receipts).values({
        branchId: Number(wo.branchId),
        shiftId,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        // cashBucket='DRAWER' للنقد ⇒ يَدخل تسوية الدرج/Z-report (مرآة createSale/processPayment).
        cashBucket: input.payment!.method === "CASH" ? "DRAWER" : null,
        status: "COMPLETED",
        invoiceId,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: Number(wo.branchId),
        invoiceId,
        receiptId,
        customerId: wo.customerId ?? null,
        amount: paidNow,
      });
    }

    await tx
      .update(workOrders)
      .set({ status: "DELIVERED", invoiceId, deliveredAt: new Date() })
      .where(eq(workOrders.id, Number(wo.id)));

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "workOrder.deliver", input.clientRequestId, invoiceId);
    }

    return { workOrderId: Number(wo.id), invoiceId, invoiceNumber, status };
  });
}

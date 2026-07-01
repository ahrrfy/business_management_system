// التحوّلات (محاسبة العهدة) — ترتيب أقفال موحّد لمنع الجمود: الإرسالية → الجهة → الفاتورة → الوردية.
//
// READY → DELIVERED + إرسالية: فاتورة (customerId=NULL) + SALE + عهدة COD على الجهة (D3).
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  invoiceItems,
  invoices,
  productUnits,
  receipts,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { nextInvoiceNumber } from "../numbering";
import { withTx } from "../tx";
import { nextConsignmentNumber } from "./numbering";
import type { DeliveryTxActor } from "./types";

// ═══════════════════════════ التحوّلات (محاسبة العهدة) ═══════════════════════════
// ترتيب أقفال موحّد لمنع الجمود: الإرسالية → الجهة → الفاتورة → الوردية.

/** READY → DELIVERED + إرسالية: فاتورة (customerId=NULL) + SALE + عهدة COD على الجهة (D3). */
export interface DispatchInput {
  workOrderId: number;
  partyId: number;
  deliveryFee?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  clientRequestId?: string | null;
}

export async function dispatchToDelivery(input: DispatchInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.dispatch", input.clientRequestId);
      if (existingId != null) {
        const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, existingId)).limit(1))[0];
        return {
          consignmentId: existingId,
          consignmentNumber: cn?.consignmentNumber ?? "",
          invoiceId: Number(cn?.invoiceId ?? 0),
          invoiceNumber: "",
          codAmount: String(cn?.codAmount ?? "0"),
          deliveryFee: String(cn?.deliveryFee ?? "0"),
          idempotentReplay: true as const,
        };
      }
    }

    const wo = (await tx.select().from(workOrders).where(eq(workOrders.id, input.workOrderId)).for("update").limit(1))[0];
    if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشغل غير موجود" });
    const elevated = actor.role === "admin" || actor.role === "manager";
    if (!elevated && actor.branchId != null && Number(wo.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إرسال أمر فرعٍ آخر" });
    }
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للإرسال" });

    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل غير متاحة" });

    const salePrice = money(wo.salePrice);
    const quantity = wo.quantity;
    const costTotal = round2(money(wo.materialsCost).plus(money(wo.laborCost)));
    const depositPaid = round2(money(wo.deposit ?? "0"));
    if (depositPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "العربون يتجاوز إجمالي الأمر" });
    const codAmount = round2(salePrice.minus(depositPaid)); // >= 0
    const fee = round2(money(input.deliveryFee ?? party.defaultFee ?? "0"));

    // فاتورة COD: customerId=NULL (الطرف المقابل = جهة التوصيل، عهدة لا AR ⇒ مطابقة AR/الائتمان سليمة).
    const invoiceNumber = await nextInvoiceNumber(tx, Number(wo.branchId));
    const invStatus = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(depositPaid));
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId: `WO-${wo.id}`,
      branchId: Number(wo.branchId),
      customerId: null,
      priceTier: "RETAIL",
      subtotal: salePrice.toFixed(2),
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: salePrice.toFixed(2),
      costTotal: costTotal.toFixed(2),
      status: invStatus,
      paidAmount: toDbMoney(depositPaid),
      paymentMethod: null,
      paymentDate: depositPaid.gt(0) ? new Date() : null,
      notes: `توصيل طلب خدمة ${wo.orderNumber}: ${wo.title}`,
      createdBy: actor.userId,
    });
    const invoiceId = extractInsertId(invRes);

    if (wo.baseVariantId != null) {
      const baseUnit = (await tx.select({ id: productUnits.id }).from(productUnits).where(eq(productUnits.variantId, Number(wo.baseVariantId))).limit(1))[0];
      const unitPrice = round2(salePrice.dividedBy(quantity));
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

    // SALE: الإيراد يُعترف عند الإرسال (D3). customerId=NULL على القيد أيضاً.
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`,
      branchId: Number(wo.branchId),
      invoiceId,
      revenue: salePrice,
      cost: costTotal,
      profit: round2(salePrice.minus(costTotal)),
      amount: salePrice,
    });

    // ربط إيصال العربون بالفاتورة (كان workOrderId-only) — append-only على القيد كـdeliverWorkOrder.
    if (depositPaid.gt(0)) {
      const depRcpt = (await tx.select({ id: receipts.id }).from(receipts)
        .where(and(eq(receipts.workOrderId, Number(wo.id)), isNull(receipts.invoiceId))).limit(1))[0];
      if (depRcpt) await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcpt.id)));
    }

    const consignmentNumber = await nextConsignmentNumber(tx, Number(wo.branchId));
    const codPositive = codAmount.gt(0);
    const cnRes = await tx.insert(deliveryConsignments).values({
      consignmentNumber,
      branchId: Number(wo.branchId),
      partyId: input.partyId,
      invoiceId,
      workOrderId: Number(wo.id),
      endCustomerId: wo.customerId ?? null,
      codAmount: toDbMoney(codAmount),
      collectedAmount: "0",
      deliveryFee: toDbMoney(fee),
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? wo.deliveryAddress ?? null,
      // codAmount=0 (مدفوع كامل بالعربون) ⇒ إرسالية تسليم فقط بلا عهدة.
      status: codPositive ? "DISPATCHED" : "DELIVERED",
      settledAt: codPositive ? null : new Date(),
      dispatchedBy: actor.userId,
    });
    const consignmentId = extractInsertId(cnRes);

    if (codPositive) {
      await adjustDeliveryBalance(tx, input.partyId, codAmount);
      await postEntry(tx, {
        entryType: "DELIVERY_DISPATCH",
        dedupeKey: `DELIVERY_DISPATCH:${consignmentId}`,
        branchId: Number(wo.branchId),
        invoiceId,
        deliveryPartyId: input.partyId,
        amount: codAmount,
        notes: `إرسالية ${consignmentNumber}`,
      });
    }

    await tx.update(workOrders).set({ status: "DELIVERED", invoiceId, deliveredAt: new Date() }).where(eq(workOrders.id, Number(wo.id)));
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.dispatch", input.clientRequestId, consignmentId);

    return { consignmentId, consignmentNumber, invoiceId, invoiceNumber, codAmount: codAmount.toFixed(2), deliveryFee: fee.toFixed(2) };
  });
}

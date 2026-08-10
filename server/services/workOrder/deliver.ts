// READY → DELIVERED: إنشاء فاتورة (sourceType=WORKORDER) + دفعة اختيارية + قيد SALE + تسوية الذمم.
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, notLike, or } from "drizzle-orm";
import { invoiceItems, invoices, productUnits, receipts, shifts, workOrders } from "../../../drizzle/schema";
import { assertCreditLimit } from "../../lib/credit";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { readOpeningWindowState } from "../openingModeService";
import { linkSoleTargetCollectionsToInvoice } from "../reception/deposits";
import { openShiftIdTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import type { PaymentMethod } from "./types";
import { userNameSnapshot } from "../userSnapshot";

export interface DeliverWorkOrderInput {
  workOrderId: number;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null } | null;
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
    const paymentReference = input.payment?.reference?.trim() || null;
    if (paidNow.gt(0) && input.payment?.method !== "CASH" && !paymentReference) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع عملية البطاقة/التحويل مطلوب" });
    }
    const depositPaid = round2(money(wo.deposit ?? "0"));
    const totalPaid = round2(depositPaid.plus(paidNow));
    if (paidNow.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع لا يمكن أن يكون سالباً" });
    if (totalPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع (مع العربون) يتجاوز إجمالي الأمر" });
    if (totalPaid.lt(salePrice) && !wo.customerId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب الخدمة الآجل يتطلب عميلاً محدداً" });

    // H5: فحص حدّ الائتمان على الجزء الآجل قبل إنشاء الفاتورة (يَرمي FORBIDDEN عند التجاوز).
    // وضع الافتتاح (قرار المالك ١٠/٨): أثناء النافذة الفعّالة يُعفى تسليم أمر الشغل من حاجز الائتمان —
    // الجزء الآجل يُرحَّل ذمّةً على العميل (AR) كالمعتاد دون رفض. مؤقّتٌ وينتهي بانتهاء النافذة.
    const unpaidPortion = round2(salePrice.minus(totalPaid));
    if (wo.customerId && unpaidPortion.gt(0) && !(await readOpeningWindowState(tx)).active) {
      await assertCreditLimit(tx, Number(wo.customerId), unpaidPortion, Number(wo.branchId));
    }

    // Invoice number — reuse the invoice numbering (per-branch daily seq).
    const { nextInvoiceNumber } = await import("../numbering");
    const invoiceNumber = await nextInvoiceNumber(tx, Number(wo.branchId));
    const status = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(totalPaid));
    const sourceId = `WO-${wo.id}`;
    const salespersonNameSnapshot = await userNameSnapshot(tx, actor.userId);
    // ش١ (٥/٨): فاتورة التسليم تنتمي لوردية مُسلِّمها — كانت تُنشأ بلا shiftId فتسقط خارج
    // طابور فواتير المحطة (innerJoin shifts) وخارج نطاق reception.collectOnInvoice، بينما هي
    // **الحالة الأولى** لتسديد المتبقّي (عربونٌ مقبوض والباقي عند الاستلام). تُحلّ مبكراً وتُعاد
    // في إيصال الدفعة أدناه (نفس الوردية حتماً — لا انشطار درج).
    // مراجعة عدائية (٥/٨): الختم بوردية **RECEPTION حصراً** — openShiftIdTx المرن كان يلتقط
    // وردية RETAIL/PRINT_SERVICES الوحيدة فتسقط الفاتورة من طابور المحطة (innerJoin RECEPTION)
    // وتتضخّم Z تلك الوردية بمبيعاتٍ ليست لها. غيابها ⇒ null (سلوك ما قبل ش١، دلالة نظيفة).
    const receptionShiftRow = (
      await tx
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(
          eq(shifts.userId, actor.userId),
          eq(shifts.branchId, Number(wo.branchId)),
          eq(shifts.status, "OPEN"),
          eq(shifts.shiftType, "RECEPTION"),
        ))
        .limit(1)
    )[0];
    const deliveryShiftId = receptionShiftRow ? Number(receptionShiftRow.id) : null;
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId,
      shiftId: deliveryShiftId,
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
      salespersonNameSnapshot,
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
      // ش٠ (V3): هويّة إيصال العربون من عموده الصريح — الالتقاط القديم بـ`.limit(1)` على
      // (workOrderId, invoiceId NULL) كان يتصادم مع إيصال أجرة COUNTER (نفس البصمة) فقد يربط
      // إيصال الأجرة بالفاتورة بدل العربون. البديل الاحتياطي (أوامر قديمة قبل 0151 لم يلتقطها
      // backfill) يستثني إيصالات الأجرة صراحةً.
      const depRcptId = wo.depositReceiptId != null
        ? Number(wo.depositReceiptId)
        : (await tx.select({ id: receipts.id }).from(receipts)
            .where(and(
              eq(receipts.workOrderId, Number(wo.id)),
              eq(receipts.direction, "IN"),
              isNull(receipts.invoiceId),
              or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
            )).limit(1))[0]?.id;
      if (depRcptId != null) {
        await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcptId)));
        // ⛔ كان هنا UPDATE accountingEntries.invoiceId — أُزيل ضمن A1: انتهاك append-only
        //     على دفتر الأستاذ. الـUPDATE لم يكن load-bearing لأي حساب.
      }
      // ش٤: حصص العربون المقبوضة **سلفاً** (مسوّدة ⇒ orderPayments APPLICATION على هذا الأمر) —
      // إيصال القبض أحاديّ الهدف يُختم بفاتورة التسليم (نفس نمط append-only أعلاه)؛ المُشظّى
      // بين أهدافٍ يبقى بلا ختم وحقيقتُه في orderPayments (I4). depositReceiptId يحمل N وحده.
      await linkSoleTargetCollectionsToInvoice(tx, Number(wo.id), invoiceId);
    }

    // Optional payment receipt + PAYMENT_IN entry.
    if (paidNow.gt(0)) {
      // انسب الدفع النقدي لوردية الموظّف المفتوحة (تسوية الصندوق/Z-report) — تفضيل وردية الاستقبال.
      // الحلّ **المرن** هنا عمداً (بخلاف ختم الفاتورة): النقد يدخل الدرج المفتوح فعلاً أياً كان نوعه.
      const shiftId = deliveryShiftId ?? await openShiftIdTx(tx, actor.userId, Number(wo.branchId), "RECEPTION");
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
        referenceNumber: paymentReference,
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

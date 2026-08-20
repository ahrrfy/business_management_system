// READY → DELIVERED: إنشاء فاتورة (sourceType=WORKORDER) + دفعة اختيارية + قيد SALE + تسوية الذمم.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, notLike, or } from "drizzle-orm";
import { invoiceItems, invoices, productUnits, receipts, shifts, workOrders } from "../../../drizzle/schema";
import { assertCreditLimit } from "../../lib/credit";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { readOpeningWindowState } from "../openingModeService";
import { appliedCollectionsForWorkOrder, linkSoleTargetCollectionsToInvoice } from "../reception/deposits";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import { assertSiblingsReady } from "./siblings";
import type { PaymentMethod } from "./types";
import { userNameSnapshot } from "../userSnapshot";
import { paymentAssetRole } from "../sale/paymentPosting";

export interface DeliverWorkOrderInput {
  workOrderId: number;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null } | null;
  clientRequestId?: string | null;
  /** إقرارُ تسليم جزءٍ من طلبٍ إخوتُه لم يجهزوا — يفشل مغلقاً بدونه (ش٥). */
  partialDispatchConfirmed?: boolean;
}

/** READY → DELIVERED: create invoice (sourceType=WORKORDER) + optional payment + SALE entry + AR adjust. */
export async function deliverWorkOrder(input: DeliverWorkOrderInput, actor: Actor & { role?: string }) {
  // دفعة التسليم قبضٌ ذاتي من الموظف؛ نرفض غير النقدي قبل فحص idempotency وقفل الأمر.
  if (input.payment) assertPosPaymentMethodEnabled(input.payment.method);
  return withTx(async (tx) => {
    const requestFingerprint = input.clientRequestId ? idempotencyHash(input) : null;
    // Idempotency: double-click / network-retry ⇒ return the already-created invoice.
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "workOrder.deliver", input.clientRequestId, requestFingerprint);
      if (existingId != null) {
        const inv = (await tx.select({ invoiceNumber: invoices.invoiceNumber, status: invoices.status })
          .from(invoices).where(eq(invoices.id, existingId)).limit(1))[0];
        return { workOrderId: input.workOrderId, invoiceId: existingId, invoiceNumber: inv?.invoiceNumber ?? "", status: inv?.status ?? "PENDING", idempotentReplay: true as const };
      }
    }
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للتسليم" });
    // إخوةُ السلّة الواحدة: التسليمُ المباشر مخرجٌ ثالثٌ كان يفلت من حارس الإرسال الجزئيّ،
    // ومسوّدةٌ كلُّها أوامرُ شغل لا تصل إليه أصلاً (لا فاتورة بضاعةٍ لها).
    await assertSiblingsReady(tx, {
      draftId: wo.draftId,
      excludeWorkOrderId: input.workOrderId,
      confirmed: input.partialDispatchConfirmed === true,
      action: "deliver",
    });
    // أمرٌ مخصّص للتوصيل لا يجوز إغلاقه من مسار الاستلام المباشر. هذا المسار لا ينشئ
    // deliveryConsignment؛ السماح به كان يحوّل الأمر إلى DELIVERED ثم يُسقطه من طابور
    // التوصيل بلا أي سجل يستطيع المندوب/الشركة رؤيته.
    if (wo.hasDelivery) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "هذا الطلب مخصّص للتوصيل — أسنده من «إدارة التوصيل» ولا تستخدم التسليم المباشر",
      });
    }
    // ١٨/٨: للأمر فاتورةٌ سلفاً (أُرسل للتوصيل ثمّ أُلغي إسنادُه، فبقيت فاتورتُه وقيدُ بيعها
    // حيَّين وتحوّل إلى استلامٍ مباشر). التسليم هنا كان سيُنشئ **فاتورةً وقيدَ بيعٍ ثانيَين**
    // لبضاعةٍ واحدة ⇒ إيرادٌ وذمّةٌ مضاعفان. المخرج المشروع: تحصيلُ الفاتورة القائمة من طابور
    // المحطة، أو استرجاعُ الإرسالية أوّلاً (عكسٌ كامل) ثمّ إعادة البيع.
    if (wo.invoiceId != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لهذا الطلب فاتورةٌ صادرة سلفاً — حصّلها من طابور الفواتير، أو استرجع إرساليّته أوّلاً ثمّ أعد البيع",
      });
    }

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
    const appliedDepositParts = depositPaid.gt(0)
      ? await appliedCollectionsForWorkOrder(tx, Number(wo.id))
      : [];
    const appliedDepositTotal = round2(
      appliedDepositParts.reduce((sum, part) => sum.plus(money(part.amount)), money(0)),
    );
    const directDepositExpected = round2(depositPaid.minus(appliedDepositTotal));
    if (directDepositExpected.lt(0)) {
      throw new TRPCError({ code: "CONFLICT", message: "حصص العربون المطبقة تتجاوز عربون أمر الشغل" });
    }
    const appliedReceiptIds = Array.from(new Set(
      appliedDepositParts.map((part) => part.receiptId).filter((id): id is number => id != null),
    ));
    if (appliedDepositParts.some((part) => part.receiptId == null)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "عربون أمر الشغل يحتوي قبضاً قديماً بلا إيصال قابل لإثبات التنفيذ",
      });
    }
    if (appliedReceiptIds.length) {
      const appliedReceipts = await tx
        .select({ id: receipts.id, direction: receipts.direction, status: receipts.status, approvalStatus: receipts.approvalStatus })
        .from(receipts)
        .where(inArray(receipts.id, appliedReceiptIds))
        .for("update");
      const validIds = new Set(
        appliedReceipts
          .filter((receipt) => receipt.direction === "IN" && receipt.status === "COMPLETED" && receipt.approvalStatus === "APPROVED")
          .map((receipt) => Number(receipt.id)),
      );
      if (appliedReceiptIds.some((id) => !validIds.has(id))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يُحتسب عربون غير منفذ: يلزم إيصال IN بحالة COMPLETED واعتماد APPROVED",
        });
      }
    }
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
    /**
     * **نسبة البيع لمنشئ الطلب لا للمُسلِّم** (١٩/٨ — قاعدة #638: «العمولة تتبع البائع
     * الأصليّ»). فاتورة أمر الشغل تُنشأ لحظة التسليم، وقد ينفّذه كاشيرٌ آخر عن الذي استقبل
     * الطلب وباعه فعلاً — فكان `createdBy = actor` ينسب البيعَ والعمولةَ للمُسلِّم، وتقارير
     * الموظفين تعرض اسمه، بينما البائع الحقيقيّ لا أثر له.
     *
     * وأثرُ المُسلِّم **يبقى كاملاً بلا عمودٍ جديد**: إيصال القبض بـ`createdBy = actor`،
     * والفاتورة تُختم بوردية المُسلِّم (`deliveryShiftId` أدناه) ⇒ النقد والدرج وZ كلّها
     * عليه — وهو الصحيح مالياً: النقد في درجه هو.
     */
    const sellerUserId = wo.createdBy != null ? Number(wo.createdBy) : actor.userId;
    const salespersonNameSnapshot = await userNameSnapshot(tx, sellerUserId);
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
        .for("update")
        .limit(1)
    )[0];
    const deliveryShiftId = receptionShiftRow ? Number(receptionShiftRow.id) : null;
    if (input.payment?.method === "CASH" && paidNow.gt(0) && deliveryShiftId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "افتح وردية RECEPTION قبل قبض دفعة أمر الشغل نقداً؛ لا يجوز DRAWER بلا وردية استقبال مقفلة",
      });
    }
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
      createdBy: sellerUserId,
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
      cost: materialsCost,
      profit: round2(salePrice.minus(materialsCost)),
      amount: salePrice,
      notes: `تكلفة أمر الشغل التحليلية=${toDbMoney(costTotal)}؛ مواد COGS/WIP=${toDbMoney(materialsCost)}؛ أجور تحليلية غير مرسملة=${toDbMoney(laborCost)} (تظهر في فاتورة/تقرير ربحية الأمر، والأجر الفعلي في قيود الرواتب/المصروف)`,
      postingIntent: createPostingIntent("SALE_SERVICE_FLEX", "SALE", [debitLine("AR", salePrice), creditLine("SALES_FLEX", salePrice), ...(materialsCost.isZero() ? [] : [debitLine("COGS", materialsCost), creditLine("WORK_IN_PROGRESS", materialsCost)]), ...(depositPaid.isZero() ? [] : [debitLine("OTHER_LIABILITY", depositPaid), creditLine("AR", depositPaid)])], { roleDebits: { AR: salePrice, OTHER_LIABILITY: depositPaid, COGS: materialsCost }, roleCredits: { SALES_FLEX: salePrice, WORK_IN_PROGRESS: materialsCost, AR: depositPaid } }),
      postingSourceComponents: { roleDebits: { AR: salePrice, OTHER_LIABILITY: depositPaid, COGS: materialsCost }, roleCredits: { SALES_FLEX: salePrice, WORK_IN_PROGRESS: materialsCost, AR: depositPaid } },
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
      const depRcpt = directDepositExpected.gt(0)
        ? wo.depositReceiptId != null
          ? (await tx
              .select({ id: receipts.id, amount: receipts.amount, direction: receipts.direction, status: receipts.status, approvalStatus: receipts.approvalStatus })
              .from(receipts)
              .where(eq(receipts.id, Number(wo.depositReceiptId)))
              .for("update")
              .limit(1))[0]
          : (await tx.select({ id: receipts.id, amount: receipts.amount, direction: receipts.direction, status: receipts.status, approvalStatus: receipts.approvalStatus }).from(receipts)
            .where(and(
              eq(receipts.workOrderId, Number(wo.id)),
              eq(receipts.direction, "IN"),
              eq(receipts.status, "COMPLETED"),
              eq(receipts.approvalStatus, "APPROVED"),
              isNull(receipts.invoiceId),
              or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
            )).for("update").limit(1))[0]
        : undefined;
      if (
        directDepositExpected.gt(0) &&
        (!depRcpt || depRcpt.direction !== "IN" || depRcpt.status !== "COMPLETED" || depRcpt.approvalStatus !== "APPROVED" || !money(depRcpt.amount).eq(directDepositExpected))
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "العربون المباشر لا يطابق إيصال IN منفذاً ومعتمداً؛ أوقف التسليم وراجع القبض",
        });
      }
      if (depRcpt != null) {
        await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcpt.id)));
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
    // الدفعة النقدية لا تدخل إلا درج RECEPTION المقفول نفسه الذي خُتمت به الفاتورة.
      const shiftId = deliveryShiftId;
      const rRes = await tx.insert(receipts).values({
        branchId: Number(wo.branchId),
        shiftId,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        // cashBucket='DRAWER' للنقد ⇒ يَدخل تسوية الدرج/Z-report (مرآة createSale/processPayment).
        cashBucket: input.payment!.method === "CASH" ? "DRAWER" : null,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: paymentReference,
        invoiceId,
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      const paymentRole = paymentAssetRole(input.payment!.method, input.payment!.method === "CASH" ? "DRAWER" : null, "IN");
      const paymentPostingSource = {
        roleDebits: { [paymentRole]: paidNow },
        roleCredits: { AR: paidNow },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: Number(wo.branchId),
        invoiceId,
        receiptId,
        customerId: wo.customerId ?? null,
        amount: paidNow,
        paymentMethod: input.payment!.method, // دلو النقد للدفتر المزدوج (لا يُخزَّن)
        postingIntent: createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [debitLine(paymentRole, paidNow), creditLine("AR", paidNow)], paymentPostingSource),
        postingSourceComponents: paymentPostingSource,
      });
    }

    await tx
      .update(workOrders)
      .set({ status: "DELIVERED", invoiceId, deliveredAt: new Date() })
      .where(eq(workOrders.id, Number(wo.id)));

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "workOrder.deliver", input.clientRequestId, invoiceId, requestFingerprint);
    }

    return { workOrderId: Number(wo.id), invoiceId, invoiceNumber, status };
  });
}

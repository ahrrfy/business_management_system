// التحوّلات (محاسبة العهدة) — ترتيب أقفال موحّد لمنع الجمود: الإرسالية → الجهة → الفاتورة → الوردية.
//
// READY → DELIVERED + إرسالية: فاتورة (customerId=NULL) + SALE + عهدة COD على الجهة (D3).
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, notLike, or, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  invoiceItems,
  invoices,
  productUnits,
  receipts,
  shifts as shiftsTable,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { nextInvoiceNumber } from "../numbering";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import { withTx } from "../tx";
import { nextConsignmentNumber } from "./numbering";
import { assertFloatLimit } from "./parties";
import type { DeliveryTxActor } from "./types";
import { userNameSnapshot } from "../userSnapshot";

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
    const payloadHash = idempotencyHash({
      workOrderId: Number(input.workOrderId),
      partyId: Number(input.partyId),
      deliveryFee: input.deliveryFee == null ? null : toDbMoney(round2(money(input.deliveryFee))),
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? null,
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.dispatch", input.clientRequestId, payloadHash);
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
    // حارس خادمي مقابل طابور الواجهة: لا يتحول الاستلام المباشر إلى شحنة بسبب
    // رابط قديم أو طلب API يدوي. يحدد موظف خدمة العملاء طريقة التسليم أولاً.
    if (!wo.hasDelivery) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الطلب مضبوط للاستلام المباشر — غيّر طريقة التسليم إلى توصيل أولاً",
      });
    }

    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل غير متاحة" });
    if (party.branchId != null && Number(party.branchId) !== Number(wo.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع أمر الشغل" });
    }

    const salePrice = money(wo.salePrice);
    const quantity = wo.quantity;
    const costTotal = round2(money(wo.materialsCost).plus(money(wo.laborCost)));
    const depositPaid = round2(money(wo.deposit ?? "0"));
    if (depositPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "العربون يتجاوز إجمالي الأمر" });
    // ٥/٨ — أجرة التوصيل تمريرٌ لا إيراد (قرار المالك): salePrice بضاعةٌ وخدمةٌ فقط، وcodAmount
    // = **مالُنا** الذي يحصّله المندوب ويورّده. الأجرة رقمٌ موازٍ لا يدخل الفاتورة ولا الإيراد.
    // كان الحارس القديم يرفض fee > codAmount لأن الأجرة كانت مضمومةً داخل codAmount؛ وبعد فصلها
    // صار الرفض خاطئاً بنيوياً — بل هو الحالة العادية في الطلب المدفوع كاملاً (codAmount=0).
    const codAmount = round2(salePrice.minus(depositPaid)); // >= 0
    const fee = round2(money(input.deliveryFee ?? party.defaultFee ?? "0"));
    if (fee.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أجرة التوصيل لا تصحّ أن تكون سالبة" });
    }
    // مَن قبض الأجرة: يتبع ما ثُبِّت على أمر الشغل في الاستقبال (COURIER افتراضياً).
    const feeCollection = (wo.deliveryFeeCollection ?? "COURIER") as "COURIER" | "COUNTER" | "SHOP";
    if (feeCollection === "COUNTER") {
      // مراجعة عدائية ٩/٨ — حارسان بدل فحص wo.deliveryCost الاسمي:
      // (١) الأمانة تُقاس بصافي **إيصالات القبض الفعلية** (DLV-FEE-WO) لا بحقل الطلب — أمرٌ
      //     قديم/قناة لا تلتقط الأمانة كان يصرف OUT نقداً بلا IN يقابله ⇒ المكتبة تدفع من
      //     مالها أجرةً لم يدفعها الزبون قط وΣ(FEE_HELD) سالبة صامتة (مرآة حارس dispatchInvoice).
      // (٢) **مساواة** لا سقف: COUNTER معناها «الزبون دفع أجرة المندوب سلفاً» — أجرةٌ أقل من
      //     الأمانة كانت تُبرّئ جزءاً وتترك الفرق دنانير زبونٍ عالقة في الدرج بلا مسار ولا
      //     تبويب للأبد (التوريد لا يخصمها بعد ختم feeSettledAt والإرجاع لا يردّها).
      const heldRow = (
        await tx
          .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
          .from(receipts)
          .where(and(
            eq(receipts.workOrderId, Number(wo.id)),
            eq(receipts.referenceNumber, `DLV-FEE-WO-${wo.id}`),
            eq(receipts.status, "COMPLETED"),
          ))
      )[0];
      const heldD = round2(money(heldRow?.v ?? "0"));
      if (heldD.lte(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "«مقبوضة في الاستقبال» بلا إيصال قبض أمانة لهذا الطلب — اقبض الأجرة أولاً أو غيّر طريقة قبضها إلى «المندوب يقبضها» / «على المكتبة»",
        });
      }
      if (!fee.eq(heldD)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `الأمانة المقبوضة من الزبون (${heldD.toFixed(2)}) يجب أن تساوي أجرة المندوب — اجعل الأجرة ${heldD.toFixed(2)} أو صحّح المقبوض قبل الإرسال`,
        });
      }
    }

    // مراجعة PR #495 — سقف عهدة المندوب: كان يُقرأ في مسار إسناد الفاتورة وحده، فبقي هذا المسار
    // (أوامر الشغل الجاهزة) يرفع `currentBalance` بلا حدّ. الفحص هنا **قبل** أيّ كتابة (فاتورة/
    // مخزون/عهدة) وتحت قفل صفّ الجهة أعلاه ⇒ الرفض لا يترك فاتورةً يتيمة.
    if (codAmount.gt(0)) assertFloatLimit(party, codAmount);

    // فاتورة COD: customerId=NULL (الطرف المقابل = جهة التوصيل، عهدة لا AR ⇒ مطابقة AR/الائتمان سليمة).
    const invoiceNumber = await nextInvoiceNumber(tx, Number(wo.branchId));
    const invStatus = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(depositPaid));
    const salespersonNameSnapshot = await userNameSnapshot(tx, actor.userId);
    // ش١ (٥/٨): فاتورة الإرسال تنتمي لوردية مُرسِلها (مرآة deliver.ts) — تظهر في طابور فواتير
    // المحطة بحالتها التسليمية بدل أن تختفي بلا shiftId.
    // مراجعة عدائية (٥/٨): الختم بوردية RECEPTION **حصراً أو null** — الحلّ المرن كان يلتقط
    // وردية RETAIL الوحيدة فتتضخّم Z ورديةٍ ليست لها والفاتورة تسقط من طابور المحطة معاً.
    const dispatchShiftRow = (
      await tx
        .select({ id: shiftsTable.id })
        .from(shiftsTable)
        .where(and(
          eq(shiftsTable.userId, actor.userId),
          eq(shiftsTable.branchId, Number(wo.branchId)),
          eq(shiftsTable.status, "OPEN"),
          eq(shiftsTable.shiftType, "RECEPTION"),
        ))
        .limit(1)
    )[0];
    const dispatchShiftId = dispatchShiftRow ? Number(dispatchShiftRow.id) : null;
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId: `WO-${wo.id}`,
      shiftId: dispatchShiftId,
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
      salespersonNameSnapshot,
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
    // ش٠ (V3): بهويّته الصريحة (depositReceiptId) — الالتقاط الظنّي كان يتصادم مع إيصال أجرة COUNTER.
    if (depositPaid.gt(0)) {
      const depRcptId = wo.depositReceiptId != null
        ? Number(wo.depositReceiptId)
        : (await tx.select({ id: receipts.id }).from(receipts)
            .where(and(
              eq(receipts.workOrderId, Number(wo.id)),
              eq(receipts.direction, "IN"),
              isNull(receipts.invoiceId),
              or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
            )).limit(1))[0]?.id;
      if (depRcptId != null) await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcptId)));
    }

    const consignmentNumber = await nextConsignmentNumber(tx, Number(wo.branchId));
    const codPositive = codAmount.gt(0);
    // الأجرة تُسوَّى لحظة الإرسال متى كان النقد بأيدينا أو لا توريدَ يُنتظَر:
    //   COUNTER ⇒ قبضناها أمانةً في الاستقبال والمندوب واقفٌ الآن ⇒ تُدفَع له نقداً من الدرج.
    //   codAmount=0 ⇒ لا توريد قادم أصلاً ⇒ لا مجال لخصمها لاحقاً (هذه هي الحالة التي كانت
    //   تبتلع الأجرة صامتةً: إرسالية تُنشَأ DELIVERED فوراً فلا يراها مسار التوريد أبداً).
    // ما عدا ذلك (COURIER بـCOD موجب) لا يمرّ بدفترنا إطلاقاً؛ وSHOP بـCOD موجب يُخصَم مصروفاً
    // عند التوريد كما كان.
    const settleFeeNow = fee.gt(0) && feeCollection !== "COURIER" && (feeCollection === "COUNTER" || !codPositive);
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
      // اِستقبال (٤/٨): هاتف المستلم المُلتقَط عند إنشاء/تصنيف أمر الشغل — نفس نمط fallback العنوان
      // أدناه؛ يمنع مندوباً يُرسَل بلا وسيلة اتصال بالزبون حين لا يُدخِل الموظّف رقماً صريحاً هنا.
      recipientPhone: input.recipientPhone ?? wo.deliveryPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? wo.deliveryAddress ?? null,
      feeCollection,
      feeSettledAt: settleFeeNow ? new Date() : null,
      // codAmount=0 (مدفوع كامل بالعربون) ⇒ إرسالية تسليم فقط بلا عهدة.
      status: codPositive ? "DISPATCHED" : "DELIVERED",
      settledAt: codPositive ? null : new Date(),
      dispatchedBy: actor.userId,
    });
    const consignmentId = extractInsertId(cnRes);

    // صرف الأجرة للمندوب نقداً من الدرج (إيصال OUT) ⇒ الدرج يُطابِق فعلاً عند الإغلاق.
    // COUNTER: تبرئة أمانةٍ مقبوضة (بلا مصروف — تمرير). SHOP: مصروفٌ حقيقيّ تتحمّله المكتبة.
    if (settleFeeNow) {
      const { shiftId, cashBucket } = await shiftIdForCashTx(
        tx,
        { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role },
        Number(wo.branchId),
        "صرف أجرة توصيل",
        "RECEPTION",
      );
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(wo.branchId),
        shiftId,
        invoiceId,
        direction: "OUT",
        amount: toDbMoney(fee),
        paymentMethod: "CASH",
        cashBucket,
        status: "COMPLETED",
        partyType: "OTHER",
        referenceNumber: consignmentNumber,
        description: `أجرة توصيل إرسالية ${consignmentNumber}`,
        createdBy: actor.userId,
      });
      const feeReceiptId = extractInsertId(feeOut);
      await postEntry(tx, {
        entryType: feeCollection === "COUNTER" ? "DELIVERY_FEE_HELD" : "DELIVERY_FEE",
        dedupeKey: `DELIVERY_FEE_DISPATCH:${consignmentId}`,
        branchId: Number(wo.branchId),
        invoiceId,
        deliveryPartyId: input.partyId,
        receiptId: feeReceiptId,
        // تدقيق ٦/٨ (ث٨): إشارةُ التبرئة **سالبة** — الوارد (workOrder/create) موجبٌ، فبقاؤها
        // موجبةً هنا يجعل Σ(DELIVERY_FEE_HELD) لكل مستندٍ = ضعفَ الأجرة بدل صفر، فيستحيل
        // على أيّ تقريرٍ أن يجيب «كم أمانةً قُبضت ولم تُبرَّأ؟». الثابت: Σ = 0 ⇔ مُبرَّأة.
        amount: feeCollection === "COUNTER" ? fee.neg() : fee,
        // COUNTER تمرير: قبضناها ودفعناها ⇒ صفر أثرٍ على الأرباح. SHOP تحمُّلٌ فعليّ ⇒ مصروف.
        ...(feeCollection === "SHOP" ? { cost: fee, profit: fee.neg() } : {}),
        notes: `أجرة توصيل ${consignmentNumber}`,
      });
    }

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
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.dispatch", input.clientRequestId, consignmentId, payloadHash);

    return { consignmentId, consignmentNumber, invoiceId, invoiceNumber, codAmount: codAmount.toFixed(2), deliveryFee: fee.toFixed(2) };
  });
}

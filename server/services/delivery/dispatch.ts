// التحوّلات (محاسبة العهدة) — ترتيب أقفال موحّد لمنع الجمود: الإرسالية → الجهة → الفاتورة → الوردية.
//
// READY → DELIVERED + إرسالية: فاتورة عميل + SALE + عهدة COD على الجهة (D3).
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, notLike, or, sql } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryPartyMembers,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  products,
  receipts,
  shifts as shiftsTable,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { isDeadInvoiceStatus, invoiceStatusLabel } from "@shared/invoiceStatus";
import { nextInvoiceNumber } from "../numbering";
import { openShiftIdTx } from "../shiftService";
import { withTx } from "../tx";
import { nextConsignmentNumber } from "./numbering";
import { assertFloatLimitTx } from "./parties";
import { assertSiblingsReady } from "../workOrder/siblings";
import type { DeliveryTxActor } from "./types";
import { userNameSnapshot } from "../userSnapshot";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { deliveryWorkOrderSaleIntent } from "./posting";
import { titleForChannel } from "@shared/productChannelTitles";

// ═══════════════════════════ التحوّلات (محاسبة العهدة) ═══════════════════════════
// ترتيب أقفال موحّد لمنع الجمود: الإرسالية → الجهة → الفاتورة → الوردية.

/** READY → DELIVERED + إرسالية: فاتورة عميل + SALE + عهدة COD على الجهة (D3). */
export interface DispatchInput {
  workOrderId: number;
  partyId: number;
  deliveryFee?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  clientRequestId?: string | null;
  assignedUserId?: number | null;
  /** إقرارُ إرسال جزءٍ من طلبٍ إخوتُه لم يجهزوا — يفشل مغلقاً بدونه (ش٥). */
  partialDispatchConfirmed?: boolean;
}

export async function dispatchToDelivery(input: DispatchInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    const payloadHash = idempotencyHash({
      workOrderId: Number(input.workOrderId),
      partyId: Number(input.partyId),
      deliveryFee: input.deliveryFee == null ? null : toDbMoney(round2(money(input.deliveryFee))),
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      assignedUserId: input.assignedUserId ?? null,
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
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
    // المدير صار مقيَّداً بفرعه فيَخضع لفحص المطابقة أدناه (كان `|| manager` يُعفيه).
    const elevated = actor.role === "admin";
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
    let assignedUserId = input.assignedUserId ?? null;
    if (assignedUserId == null && party.partyType === "INDIVIDUAL") {
      assignedUserId = party.userId != null ? Number(party.userId) : null;
      if (assignedUserId == null) {
        const driver = (await tx.select({ userId: deliveryPartyMembers.userId }).from(deliveryPartyMembers).where(and(
          eq(deliveryPartyMembers.partyId, input.partyId),
          eq(deliveryPartyMembers.memberRole, "DRIVER"),
          eq(deliveryPartyMembers.isActive, true),
        )).limit(1))[0];
        assignedUserId = driver?.userId != null ? Number(driver.userId) : null;
      }
    }
    if (assignedUserId != null) {
      const driver = (await tx.select({ id: deliveryPartyMembers.id }).from(deliveryPartyMembers).where(and(
        eq(deliveryPartyMembers.partyId, input.partyId),
        eq(deliveryPartyMembers.userId, assignedUserId),
        eq(deliveryPartyMembers.memberRole, "DRIVER"),
        eq(deliveryPartyMembers.isActive, true),
      )).limit(1))[0];
      if (!driver && Number(party.userId) !== assignedUserId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "السائق المختار ليس عضواً نشطاً في جهة التوصيل" });
      }
    }
    if (party.branchId != null && Number(party.branchId) !== Number(wo.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع أمر الشغل" });
    }

    const salePrice = money(wo.salePrice);
    const quantity = wo.quantity;
    const materialsCost = round2(money(wo.materialsCost));
    const costTotal = round2(materialsCost.plus(money(wo.laborCost)));
    const depositPaid = round2(money(wo.deposit ?? "0"));
    if (depositPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "العربون يتجاوز إجمالي الأمر" });
    // ٥/٨ — أجرة التوصيل تمريرٌ لا إيراد (قرار المالك): salePrice بضاعةٌ وخدمةٌ فقط، وcodAmount
    // = **مالُنا** الذي يحصّله المندوب ويورّده. الأجرة رقمٌ موازٍ لا يدخل الفاتورة ولا الإيراد.
    //
    // Codex #854 P1 (٢٨/٨/٢٦) — بتصحيح CI (٢٩/٨/٢٦): احترام wo.paymentMode مع الحفاظ على
    // العقد التاريخيّ. الاختبارات القائمة تُنشئ أوامرَ بـPREPAID الافتراضيّ + deposit جزئيّ +
    // hasDelivery=true وتتوقّع أن يحمل المندوب المتبقّي (السلوك قبل paymentMode enum). فتفريغُ
    // codAmount لـPREPAID كسر ٤ اختبارات (deliveryFeePassthrough + pr495ReviewFixes).
    //
    // الدلالة المصحَّحة (تطابق CLAUDE.md «لا دينار يضيع بصمت»):
    //   • CREDIT ⇒ codAmount = 0 (اتّفق مع العميل على ذمّة — لا يُطلب من المندوب تحصيل).
    //   • COD/PREPAID/غياب ⇒ codAmount = salePrice − deposit (المتبقّي، السلوك التاريخيّ).
    //     PREPAID لا تعني «دُفع كاملاً» بل «سُدِّد ما دُفع لحظة الإنشاء» — يبقى المتبقّي COD.
    //
    // على الإسناد الأوّل تُنشأ الفاتورة هنا فيتطابق هذا مع متبقّيها. أمّا **إعادة الإسناد**
    // فتُعيد استعمال فاتورةٍ حيّة قد تكون قُبضت جزئياً أو كلّياً بعد الإلغاء ⇒ يُعاد اشتقاقه
    // من الفاتورة أدناه (تصويب مراجعة Codex، ٢٠/٨).
    const woPaymentMode = (wo.paymentMode ?? "PREPAID") as "PREPAID" | "COD" | "CREDIT";
    let codAmount = woPaymentMode === "CREDIT" ? round2(money(0)) : round2(salePrice.minus(depositPaid));
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
    if (codAmount.gt(0)) await assertFloatLimitTx(tx, party, codAmount);

    // ═══ إعادة الإسناد بعد إلغائه (١٩/٨) ═══
    // بلا هذا الفرع كان `cancelDeliveryAssignment` يحبس الأمر **إلى الأبد**: يعود إلى طابور
    // «جاهز للإرسال» (بعد إصلاح NOT EXISTS) لكن أيّ إسنادٍ ثانٍ يصطدم بقيدَين فريدين —
    // `uq_wo_invoice` (للأمر فاتورةٌ سلفاً) و`uq_consignment_source` — فيفشل بخطأ قاعدةٍ خامّ.
    // السابقة المُختبَرة في `dispatchInvoice.ts`: **إعادة تنشيط الصفّ الملغى في مكانه** بدل
    // إدراج ثانٍ — تحفظ سلسلة المسؤولية (deliveryEvents append-only) وتُبقي القيدَين حارسَين
    // بنيويَّين، بلا هجرة. والفاتورة تُعاد استعمالها فلا SALE ثانٍ ولا ذمّةٌ مضاعفة.
    const priorCn = (await tx
      .select()
      .from(deliveryConsignments)
      .where(and(
        eq(deliveryConsignments.sourceType, "WORK_ORDER"),
        eq(deliveryConsignments.sourceId, Number(wo.id)),
      ))
      .for("update")
      .limit(1))[0];
    if (priorCn && (
      priorCn.status !== "CANCELLED"
      || priorCn.parcelStatus !== "CANCELLED"
      || priorCn.moneyStatus !== "CANCELLED"
    )) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الأمر مُسنَد أصلاً للإرسالية ${priorCn.consignmentNumber} — ألغِ إسنادها أو استرجعها قبل إسنادٍ جديد`,
      });
    }
    if (priorCn && (!round2(money(priorCn.collectedAmount ?? "0")).isZero() || priorCn.remittanceId != null)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "الإرسالية الملغاة تحمل تحصيلاً أو توريداً؛ لا يمكن إعادة تنشيطها",
      });
    }
    // الفاتورة القائمة (من الإسناد الملغى) تُعاد استعمالها — ما لم تكن ميتة.
    const priorInvoice = wo.invoiceId != null
      ? (await tx.select().from(invoices).where(eq(invoices.id, Number(wo.invoiceId))).for("update").limit(1))[0]
      : undefined;
    if (priorInvoice && isDeadInvoiceStatus(priorInvoice.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `فاتورة الأمر ${priorInvoice.invoiceNumber} ${invoiceStatusLabel(priorInvoice.status)} — أنشئ بيعاً جديداً بدل إعادة الإسناد`,
      });
    }
    const reusingInvoice = priorInvoice != null;
    // إخوةُ السلّة الواحدة — نفس حارس التسليم المباشر وإرسال الفاتورة.
    await assertSiblingsReady(tx, {
      draftId: wo.draftId,
      excludeWorkOrderId: Number(input.workOrderId),
      confirmed: input.partialDispatchConfirmed === true,
      action: "dispatch",
    });
    if (priorInvoice) {
      /**
       * **متبقّي الفاتورة الحيّة هو الحقيقة** — مرآةُ `dispatchInvoice.ts` حرفياً.
       *
       * حارسُ التوصيل يمنع القبض على إرساليةٍ **مُرسَلة** فقط؛ وبعد إلغاء الإسناد تعود
       * الفاتورة قابلةً للسداد على الكاونتر. فلو دفع الزبون ثمّ أُعيد الإسناد، كان
       * `salePrice − deposit` يطلب من المندوب تحصيلَ مبلغٍ **مسدَّدٍ سلفاً** — ثمّ يفشل
       * تأكيدُ التسليم على فحص متبقّي الفاتورة، فيعلق الطرد بلا مخرج.
       */
      // Codex #854 P1 — بتصحيح CI (٢٩/٨/٢٦): CREDIT ⇒ 0 (ذمّة معتَمدة، لا تحصيل). PREPAID/COD/غياب
      // ⇒ متبقّي الفاتورة الفعليّ (السلوك التاريخيّ) — إعادةُ الإسناد لا تُحوِّل الاتفاق الأصلي.
      if (woPaymentMode === "CREDIT") {
        codAmount = round2(money(0));
      } else {
        codAmount = round2(
          money(priorInvoice.total)
            .minus(money(priorInvoice.returnedTotal ?? "0"))
            .minus(money(priorInvoice.paidAmount ?? "0")),
        );
        if (codAmount.lt(0)) codAmount = round2(money(0));
      }
    }

    // ترتيب الأقفال القانوني (فحص الحمل ٣٠/٨/٢٦): صفّ العميل يُقفَل **قبل** عدّاد الترقيم —
    // هذا المسار كان الوحيد الذي يقلب الاتجاه دائماً (عدّاد ٢٧٢ ← تحديث رصيد العميل ٣٨٢ بلا
    // أيّ قفلٍ مسبق) مقابل البيع (عميل ← عدّاد) ⇒ ABBA deadlock بين كاشيرٍ يبيع للعميل
    // ومُرسِلٍ يوزّع طلبه في اللحظة نفسها. القفل هنا بعد قفل الفاتورة القائمة (invoices ← customers
    // يطابق sale/payment وreverseDelivery) وقبل العدّاد.
    if (wo.customerId != null) {
      await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, Number(wo.customerId)))
        .for("update")
        .limit(1);
    }
    // الفاتورة تبقى منسوبة إلى عميل أمر الشغل كي تظهر في كشفه وأعمار الذمم. جهة التوصيل
    // هي حائز النقد/الطرد، وليست بديلاً عن هوية العميل على المستند التجاري.
    const invoiceNumber = reusingInvoice
      ? priorInvoice!.invoiceNumber
      : await nextInvoiceNumber(tx, Number(wo.branchId));
    const invStatus = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(depositPaid));
    // نسبة البيع لمنشئ الطلب لا للمُرسِل (نفس قاعدة deliver.ts — العمولة تتبع البائع الأصليّ).
    const sellerUserId = wo.createdBy != null ? Number(wo.createdBy) : actor.userId;
    const salespersonNameSnapshot = await userNameSnapshot(tx, sellerUserId);
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
    // الفاتورة القائمة تُعاد استعمالها كما هي: لا رقمَ جديداً ولا SALE ثانياً ولا ذمّةً
    // مضاعفة على العميل — البيعُ وقع مرّةً واحدة، وما تغيّر هو **حائز الطرد** لا المستند.
    const invRes = reusingInvoice ? null : await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId: `WO-${wo.id}`,
      shiftId: dispatchShiftId,
      branchId: Number(wo.branchId),
      customerId: wo.customerId ?? null,
      priceTier: "RETAIL",
      subtotal: salePrice.toFixed(2),
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: salePrice.toFixed(2),
      costTotal: costTotal.toFixed(2),
      status: invStatus,
      paidAmount: toDbMoney(depositPaid),
      paymentMethod: null,
      // Codex #854 P2: نشرُ paymentMode من الأمر إلى الفاتورة (كانت تُختَم PREPAID افتراضاً
      // بحكم default العمود ⇒ الأمر والفاتورة يختلفان في «كيف يُحصَّل» — تقاريرُ AR/COD تُظهر
      // ذمّةً وهمية على عميلٍ COD لأنّ الفاتورة تبدو غير مدفوعة).
      paymentMode: woPaymentMode,
      paymentDate: depositPaid.gt(0) ? new Date() : null,
      notes: `توصيل طلب خدمة ${wo.orderNumber}: ${wo.title}`,
      salespersonNameSnapshot,
      createdBy: sellerUserId,
    });
    const invoiceId = reusingInvoice ? Number(priorInvoice!.id) : extractInsertId(invRes!);

    // البنود والقيد والذمّة تُكتب **مرّةً واحدة** مع الفاتورة؛ إعادة التنشيط تتخطّاها كلّها.
    if (!reusingInvoice && wo.baseVariantId != null) {
      const productNameRow = (await tx
        .select({ name: products.name, invoiceLabel: products.invoiceLabel, shortTitle: products.shortTitle })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productVariants.id, Number(wo.baseVariantId)))
        .limit(1))[0];
      const itemNameSnapshot = productNameRow ? titleForChannel(productNameRow, "invoice") : null;
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
        itemNameSnapshot,
      });
    }

    // SALE: حافظ على هوية العميل كي يبقى القيد والفاتورة وكشف العميل مترابطة.
    // ⚠️ عند إعادة التنشيط: القيد والذمّة وربط العربون وقعت كلّها في الإسناد الأول ولم
    // يعكسها الإلغاء (هو «فكّ إسنادٍ» لا عكسُ بيع) ⇒ تكرارُها هنا يضاعف الإيراد والذمّة.
    if (!reusingInvoice) {
    await postEntry(tx, {
      entryType: "SALE",
      postingIntent: deliveryWorkOrderSaleIntent(salePrice, depositPaid, materialsCost),
      postingSourceComponents: {
        roleDebits: {
          AR: salePrice,
          COGS: materialsCost,
          OTHER_LIABILITY: depositPaid,
        },
        roleCredits: {
          SALES_FLEX: salePrice,
          WORK_IN_PROGRESS: materialsCost,
          AR: depositPaid,
        },
      },
      dedupeKey: `SALE:${invoiceId}`,
      branchId: Number(wo.branchId),
      invoiceId,
      customerId: wo.customerId ?? null,
      revenue: salePrice,
      // Labour is a management allocation on the invoice; only consumed
      // materials are an accounted WIP asset released to COGS.
      cost: materialsCost,
      profit: round2(salePrice.minus(materialsCost)),
      amount: salePrice,
      createdBy: sellerUserId,
      createdByNameSnapshot: salespersonNameSnapshot,
    });
    if (wo.customerId != null && codAmount.gt(0)) {
      await adjustCustomerBalance(tx, Number(wo.customerId), codAmount);
    }

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
    }

    const consignmentNumber = priorCn
      ? priorCn.consignmentNumber
      : await nextConsignmentNumber(tx, Number(wo.branchId));
    const codPositive = codAmount.gt(0);
    // الأجرة تُسوَّى لحظة الإرسال متى كان النقد بأيدينا أو لا توريدَ يُنتظَر:
    //   COUNTER ⇒ قبضناها أمانةً في الاستقبال والمندوب واقفٌ الآن ⇒ تُدفَع له نقداً من الدرج.
    //   codAmount=0 ⇒ لا توريد قادم أصلاً ⇒ لا مجال لخصمها لاحقاً (هذه هي الحالة التي كانت
    //   تبتلع الأجرة صامتةً: إرسالية تُنشَأ DELIVERED فوراً فلا يراها مسار التوريد أبداً).
    // ما عدا ذلك (COURIER بـCOD موجب) لا يمرّ بدفترنا إطلاقاً؛ وSHOP بـCOD موجب يُخصَم مصروفاً
    // عند التوريد كما كان.
    // Phase 2: fees are earned only after physical delivery.
    // إعادة التنشيط: تحديثُ الصفّ الملغى في مكانه (سابقة dispatchInvoice.ts) — يحفظ سلسلة
    // أحداثه وتاريخه، ويُبقي القيدَين الفريدَين حارسَين بنيويَّين بلا هجرة ولا شواهد قبور.
    if (priorCn) {
      await tx.update(deliveryConsignments).set({
        branchId: Number(wo.branchId),
        partyId: input.partyId,
        invoiceId,
        assignedUserId,
        endCustomerId: wo.customerId ?? null,
        codAmount: toDbMoney(codAmount),
        collectedAmount: "0",
        deliveryFee: toDbMoney(fee),
        recipientName: input.recipientName ?? null,
        recipientPhone: input.recipientPhone ?? wo.deliveryPhone ?? null,
        deliveryAddress: input.deliveryAddress ?? wo.deliveryAddress ?? null,
        feeCollection,
        feeSettledAt: null,
        parcelStatus: "ASSIGNED",
        moneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
        status: "DISPATCHED",
        remittanceId: null,
        settledAt: codPositive ? null : new Date(),
        dispatchedBy: actor.userId,
        dispatchedAt: new Date(),
        acceptedAt: null,
        pickedUpAt: null,
        outForDeliveryAt: null,
        courierDeliveredAt: null,
        custodyRecognizedAt: null,
        failedAt: null,
        failureReason: null,
        cancelledAt: null,
        cancellationReason: null,
        cancelledBy: null,
        returnedAt: null,
      }).where(eq(deliveryConsignments.id, Number(priorCn.id)));
    }
    const cnRes = priorCn ? null : await tx.insert(deliveryConsignments).values({
      consignmentNumber,
      branchId: Number(wo.branchId),
      partyId: input.partyId,
      invoiceId,
      workOrderId: Number(wo.id),
      sourceType: "WORK_ORDER",
      sourceId: Number(wo.id),
      assignedUserId,
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
      feeSettledAt: null,
      parcelStatus: "ASSIGNED",
      moneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
      // COD=0 يعني «لا عهدة مالية»، لا يعني أن الطرد وصل. كل طرد يبدأ تشغيلياً
      // DISPATCHED ويبقى ظاهراً للمندوب حتى ختم التسليم الفعلي.
      status: "DISPATCHED",
      settledAt: codPositive ? null : new Date(),
      dispatchedBy: actor.userId,
    });
    const consignmentId = priorCn ? Number(priorCn.id) : extractInsertId(cnRes!);

    await appendDeliveryEvent(tx, {
      // مفتاحُ حدثٍ فريدٌ لكل إسناد (append-only): إعادةُ التنشيط حدثٌ مستقلّ لا استبدالٌ
      // للأول — فيبقى تاريخ الطرد كاملاً: أُسنِد، أُلغي، أُعيد إسناده لجهةٍ أخرى.
      eventKey: priorCn
        ? `CN:${consignmentId}:REASSIGNED:${input.clientRequestId ?? Date.now()}`
        : `CN:${consignmentId}:ASSIGNED`,
      consignmentId,
      eventType: "ASSIGNED",
      toParcelStatus: "ASSIGNED",
      toMoneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
      actorUserId: actor.userId,
      payload: { partyId: input.partyId, sourceType: "WORK_ORDER", sourceId: Number(wo.id) },
    });
    if (codPositive) {
      await appendDeliveryLedgerEntry(tx, {
        // تعرّضٌ جديد لجهةٍ جديدة ⇒ قيدٌ جديد (الأول حُرِّر بـCOD_RELEASED عند الإلغاء).
        eventKey: priorCn
          ? `CN:${consignmentId}:COD_ASSIGNED:REACTIVATED:${input.clientRequestId ?? Date.now()}`
          : `CN:${consignmentId}:COD_ASSIGNED`,
        partyId: input.partyId,
        consignmentId,
        branchId: Number(wo.branchId),
        entryType: "COD_ASSIGNED",
        amount: toDbMoney(codAmount),
        actorUserId: actor.userId,
      });
    }

    // Assignment is not customer delivery. The READY row is excluded from
    // the assignment queue by its consignment, and closes only at delivery.
    await tx.update(workOrders).set({ invoiceId }).where(eq(workOrders.id, Number(wo.id)));
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.dispatch", input.clientRequestId, consignmentId, payloadHash);

    return { consignmentId, consignmentNumber, invoiceId, invoiceNumber, codAmount: codAmount.toFixed(2), deliveryFee: fee.toFixed(2) };
  });
}

// إنشاء أمر شغل (RECEIVED) — لا يُستهلَك المخزون بعد؛ عربون مقبوض عند الإنشاء إن وُجد.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  productVariants,
  receipts,
  users,
  workOrderImages,
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { assertTelecomCollectAllowed } from "../reception/telecom";
import { openShiftIdTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { nextWorkOrderNumber } from "./helpers";
import type { CreateWorkOrderInput } from "./types";
import type { Tx } from "../../db";

/** Create a work order in RECEIVED status — stock is NOT consumed yet. */
export async function createWorkOrderInTx(tx: Tx, input: CreateWorkOrderInput, actor: Actor) {
    // idempotency: إعادة طلب بنفس المفتاح ⇒ نُعيد الأمر الأول دون إنشاء/قبض عربون ثانٍ.
    const replayId = await findIdempotentRefId(tx, "workOrder.create", input.clientRequestId);
    if (replayId) {
      const ex = (
        await tx.select({ orderNumber: workOrders.orderNumber }).from(workOrders).where(eq(workOrders.id, replayId)).limit(1)
      )[0];
      return { workOrderId: replayId, orderNumber: ex?.orderNumber ?? "", idempotent: true };
    }
    if (!input.title.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان الأمر مطلوب" });
    if (!input.salePrice || money(input.salePrice).lte(0))
      throw new TRPCError({ code: "BAD_REQUEST", message: "سعر البيع يجب أن يكون موجباً" });
    if (actor.role != null && actor.role !== "admin" && actor.role !== "manager" && money(input.laborCost ?? "0").gt(0)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "تكلفة العمالة لا يحددها الكاشير؛ يلزم مسار إداري موثّق",
      });
    }
    const qty = Math.trunc(input.quantity ?? 1);
    if (!Number.isInteger(qty) || qty <= 0)
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون عدداً صحيحاً موجباً" });
    // تدقيق ١٧/٧: العربون لا يتجاوز سعر البيع الإجمالي (السعر ثابت لحظة الإنشاء) — عربون أكبر كان يُقبل
    // ثم يجعل الأمر غير قابل للتسليم نهائياً (deliver يرفض totalPaid > salePrice). الإشارة السالبة مصدودة بـzod.
    if (round2(money(input.deposit ?? "0")).gt(money(input.salePrice)))
      throw new TRPCError({ code: "BAD_REQUEST", message: "العربون لا يمكن أن يتجاوز سعر البيع الإجمالي للأمر" });

    // الإسناد عند الإنشاء تنفيذٌ تشغيلي، لا اختيار حساب عام: فني مطبعة فعّال من الفرع أو فني مشترك فقط.
    // تركه null يضع الأمر في الطابور الوارد ليسحبه الفني من محطة التنفيذ.
    if (input.assignedTo != null) {
      const assignee = (await tx.select({ role: users.role, branchId: users.branchId, isActive: users.isActive })
        .from(users).where(eq(users.id, input.assignedTo)).limit(1))[0];
      if (!assignee || !assignee.isActive || assignee.role !== "print_operator"
        || (assignee.branchId != null && Number(assignee.branchId) !== Number(input.branchId))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يمكن إسناد أمر الشغل إلى فني مطبعة من الفرع فقط" });
      }
    }

    // v3-add-screens(100%): baseVariantId اختياري — طلب خدمة قد يكون خدمة تخصيص بلا منتج خام.
    if (input.baseVariantId != null) {
      const base = (
        await tx.select().from(productVariants).where(eq(productVariants.id, input.baseVariantId)).limit(1)
      )[0];
      if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج الأساس لطلب الخدمة غير موجود" });
    }

    // Validate materials list — allow zero materials (printing-only WO).
    for (const m of input.materials ?? []) {
      if (!Number.isInteger(m.baseQuantity) || m.baseQuantity <= 0)
        throw new TRPCError({ code: "BAD_REQUEST", message: "كميات المواد يجب أن تكون أعداداً صحيحة موجبة" });
      const v = await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, m.variantId)).limit(1);
      if (!v[0]) throw new TRPCError({ code: "NOT_FOUND", message: `مادة #${m.variantId} غير موجودة` });
    }

    // البطاقة/التحويل/المحفظة مسارات غير نقدية قابلة للمطابقة؛ يلزم مرجع يمنع دفعة مجهولة المصدر.
    if (
      (input.paymentMethod === "CARD" || input.paymentMethod === "TRANSFER" || input.paymentMethod === "WALLET") &&
      !(input.paymentReference?.trim())
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          input.paymentMethod === "CARD" ? "رقم العملية المرجعي مطلوب لدفع البطاقة"
          : input.paymentMethod === "WALLET" ? "رقم عملية المحفظة مطلوب"
          : "رقم مرجع التحويل مطلوب",
      });
    }

    const orderNumber = await nextWorkOrderNumber(tx, input.branchId);
    const insRes = await tx.insert(workOrders).values({
      orderNumber,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      baseVariantId: input.baseVariantId ?? null,
      title: input.title.trim(),
      customizationText: input.customizationText?.trim() || null,
      quantity: qty,
      materialsCost: "0",
      laborCost: input.laborCost ? round2(money(input.laborCost)).toFixed(2) : "0.00",
      salePrice: round2(money(input.salePrice)).toFixed(2),
      status: "RECEIVED",
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdBy: actor.userId,
      assignedTo: input.assignedTo ?? null,
      // v3-add-screens(100%): الأعمدة الجديدة تذهب مباشرة لجدول workOrders.
      receptionChannel: input.receptionChannel ?? "WALK_IN",
      channelHandle: input.channelHandle?.trim() || null,
      priority: input.priority ?? "NORMAL",
      deposit: input.deposit ? round2(money(input.deposit)).toFixed(2) : "0.00",
      paymentMethod: input.paymentMethod ?? "CASH",
      paymentReference: input.paymentReference?.trim() || null,
      paymentReceiptUrl: input.paymentReceiptUrl?.trim() || null,
      hasDelivery: !!input.hasDelivery,
      deliveryAddress: input.deliveryAddress?.trim() || null,
      deliveryCost: input.deliveryCost ? round2(money(input.deliveryCost)).toFixed(2) : "0.00",
      deliveryPhone: input.deliveryPhone?.trim() || null,
      // ٥/٨ — الأجرة تمرير: تُخزَّن في عمودها وحدها ولا تُضمّ إلى salePrice أبداً.
      deliveryFeeCollection: input.deliveryFeeCollection ?? "COURIER",
      contactName: input.contactName?.trim() || null,
      contactPhone: input.contactPhone?.trim() || null,
    });
    const workOrderId = extractInsertId(insRes);
    // سجّل مفتاح الـidempotency فوراً بعد إدراج الأمر — طلبٌ متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK) قبل قبض العربون.
    if (input.clientRequestId) await recordIdempotencyKey(tx, "workOrder.create", input.clientRequestId, workOrderId);

    // عربون مقبوض عند الإنشاء: نقدٌ حقيقي يدخل الصندوق ⇒ سجّله receipt(IN) بـshiftId + قيد PAYMENT_IN
    // (وإلا فهو نقد غير محتسَب في تسوية الوردية/الدفتر). يُربَط بالفاتورة عند التسليم.
    const depositD = round2(money(input.deposit ?? "0"));
    // ش٤ (§٧.٢): جزءٌ من العربون قد يكون قُبض **سلفاً** (عرابين مسوّدة عبر orderPayments) — له
    // إيصاله وقيده منذ لحظة قبضه، والإيصال هنا يُنشأ للجزء **الجديد** وحده (I5: لا إيصال ثانٍ
    // لمالٍ سبق قبضه). عمود deposit يخزّن الكامل (P+N) — هو ما يقرؤه deliver/cancel.
    const depositPreD = round2(money(input.depositPreCollected ?? "0"));
    if (depositPreD.gt(depositD)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المقبوض سلفاً يتجاوز عربون الأمر — خلل توزيع" });
    }
    const newDepositD = round2(depositD.minus(depositPreD));
    // ش٠ (V4): وردية السلة المُتحقَّق منها (من checkoutReception) تُلزِم درجاً واحداً لكل نقد
    // السلة؛ الإنشاء المفرد (بلا shiftId) يبقى على الحلّ الذاتي — يفاضل RECEPTION لو فُتحت وردِيتان.
    const basketShiftId = input.shiftId ?? null;
    if (newDepositD.gt(0)) {
      const depositMethod = input.paymentMethod ?? "CASH";
      // ش٥ (§٩.٤): عربون زين على الإنشاء المفرد المباشر (بلا shiftId من سلة الاستقبال) يمرّ
      // بضوابطه هنا — مسار السلة/المسوّدة أُسقط عنه (checkoutReceptionInTx فحص مبلغ القبض كله
      // سلفاً؛ إعادة الفحص لكل أمرٍ كانت سترفض سلّةً بأمرين على كودٍ واحدٍ مشروع).
      if (depositMethod === "TELECOM" && basketShiftId == null) {
        await assertTelecomCollectAllowed(tx, {
          userId: actor.userId,
          branchId: input.branchId,
          amount: newDepositD.toFixed(2),
          reference: input.paymentReference,
        });
      }
      const shiftId = basketShiftId ?? await openShiftIdTx(tx, actor.userId, input.branchId, "RECEPTION");
      // عربون نقدي يدخل الدُرج ⇒ يلزم وردية مفتوحة لينعكس في تسوية الصندوق/Z-report (لا نقد «معلّق» بلا وردية).
      if (depositMethod === "CASH" && shiftId == null)
        throw new TRPCError({ code: "CONFLICT", message: "افتح وردية أولاً لقبض عربون نقدي" });
      const dRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId,
        workOrderId,
        direction: "IN",
        amount: toDbMoney(newDepositD),
        paymentMethod: depositMethod,
        referenceNumber: input.paymentReference?.trim() || null,
        // cashBucket='DRAWER' للعربون النقدي ⇒ يَدخل تسوية الدرج/Z-report (مرآة دفعة التسليم/البيع).
        // كان NULL ⇒ يُستثنى من computeExpectedCash (cashBucket='DRAWER') ⇒ فائضٌ زائف عند إقفال وردية الاستقبال.
        cashBucket: depositMethod === "CASH" ? "DRAWER" : null,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const depositReceiptId = extractInsertId(dRes);
      // ش٠ (V3): هويّة إيصال العربون تُثبَّت على الأمر لحظة قبضه — قرّاؤها (deliver/cancel/dispatch)
      // لم يعودوا يلتقطون بـ`.limit(1)` الملتبسة مع إيصال أجرة COUNTER.
      // (depositReceiptId يحمل إيصال الجزء الجديد N وحده؛ حصص P حقيقتها في orderPayments.)
      await tx.update(workOrders).set({ depositReceiptId }).where(eq(workOrders.id, workOrderId));
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        receiptId: depositReceiptId,
        customerId: input.customerId ?? null,
        amount: newDepositD,
        notes: `[WO_DEPOSIT:${workOrderId}]`,
        paymentMethod: depositMethod, // دلو النقد للدفتر المزدوج (لا يُخزَّن)
      });
    }

    // ٥/٨ — أجرة توصيل قُبضت في الاستقبال (COUNTER): نقدٌ حقيقيّ يدخل الدرج لكنه **ليس بيعاً**.
    // يُسجَّل إيصالاً مستقلاً عن الفاتورة + قيد DELIVERY_FEE_HELD (مبلغٌ فقط: لا إيراد ولا تكلفة
    // ولا ربح) ⇒ يظهر في «النقد المتوقّع» فيُطابِق الدرج فعلاً، ثم يُبرَّأ حين يُخصَم من توريد
    // المندوب. بلا هذا الإيصال يكون النقد في الدرج بلا مصدرٍ مسجَّل ⇒ فائضٌ يمنع إغلاق الوردية.
    const heldFeeD = round2(money(input.deliveryCost ?? "0"));
    if (input.hasDelivery && (input.deliveryFeeCollection ?? "COURIER") === "COUNTER" && heldFeeD.gt(0)) {
      // تدقيق ٦/٨ (ث٩): الأجرة أمانةٌ **نقديّة** تُصرَف للمندوب نقداً من الدرج — فاشتقاق
      // طريقتها من طريقة دفع السلّة كان يقبضها بطاقةً/تحويلاً (خارج الدرج، cashBucket=NULL)
      // ثم يصرفها نقداً ⇒ نقدٌ يخرج بلا نظيرٍ داخل. تُثبَّت نقداً حتماً، مرآةَ مسار الفاتورة
      // (receptionCheckoutService) الذي يفعل ذلك أصلاً. وبهذا يسقط فحص TELECOM من جذره.
      const feeMethod = "CASH" as const;
      // ش٠ (V4): نفس درج السلة المُتحقَّق منه — لا ينشطر نقد سلةٍ واحدة على درجين.
      const feeShiftId = basketShiftId ?? await openShiftIdTx(tx, actor.userId, input.branchId, "RECEPTION");
      if (feeMethod === "CASH" && feeShiftId == null) {
        throw new TRPCError({ code: "CONFLICT", message: "افتح وردية أولاً لقبض أجرة توصيل نقداً" });
      }
      const feeRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId: feeShiftId,
        workOrderId,
        direction: "IN",
        amount: toDbMoney(heldFeeD),
        paymentMethod: feeMethod,
        referenceNumber: `DLV-FEE-WO-${workOrderId}`,
        cashBucket: feeMethod === "CASH" ? "DRAWER" : null,
        status: "COMPLETED",
        partyType: "OTHER",
        description: `أجرة توصيل مقبوضة أمانةً للمندوب — طلب ${orderNumber}`,
        createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        dedupeKey: `DELIVERY_FEE_HELD:WO:${workOrderId}`,
        branchId: input.branchId,
        receiptId: extractInsertId(feeRes),
        amount: heldFeeD,
        notes: `أمانة أجرة توصيل — طلب ${orderNumber}`,
      });
    }

    for (const m of input.materials ?? []) {
      await tx.insert(workOrderMaterials).values({
        workOrderId,
        variantId: m.variantId,
        baseQuantity: m.baseQuantity,
        unitCost: "0", // snapshot on consumption
      });
    }

    // السلامة المخزنية/المحاسبية (٢١/٦/٢٦): أُزيل إدراج `workOrderItems` (أصناف البيع المصغّرة).
    // كان طلب الخدمة يُخزّنها بلا خصم مخزون (start يستهلك المواد فقط) وبلا تكلفة (COGS) في الفاتورة
    // ⇒ مخزونٌ مُبالَغ فيه وربحٌ مُبالَغ فيه. القرار (أ): الأصناف الجاهزة تُباع بفاتورة بيع مستقلّة
    // عبر saleRouter (خصم مخزون + COGS + قيد SALE)، وطلب الخدمة يحمل خدمة التخصيص فقط. الجدول
    // workOrderItems يبقى في المخطّط (بلا كاتب) تفادياً لهجرة، وقد يُستعمل مستقبلاً لمنطق صحيح.

    // v3-add-screens(100%): صور نموذج العمل في جدولها الصحيح.
    const imgs = (input.designImages ?? []).filter((i) => i.url?.trim()).slice(0, 10);
    for (let i = 0; i < imgs.length; i++) {
      await tx.insert(workOrderImages).values({
        workOrderId,
        url: imgs[i].url.trim(),
        caption: imgs[i].caption?.trim() || null,
        sortOrder: imgs[i].sortOrder ?? i,
      } as any);
    }

    return { workOrderId, orderNumber };
}

/** Public wrapper for callers that create one work order outside a composed transaction. */
export async function createWorkOrder(input: CreateWorkOrderInput, actor: Actor) {
  return withTx((tx) => createWorkOrderInTx(tx, input, actor));
}

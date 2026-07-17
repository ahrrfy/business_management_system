// إنشاء أمر شغل (RECEIVED) — لا يُستهلَك المخزون بعد؛ عربون مقبوض عند الإنشاء إن وُجد.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  productVariants,
  receipts,
  workOrderImages,
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { openShiftIdTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import { nextWorkOrderNumber } from "./helpers";
import type { CreateWorkOrderInput } from "./types";

/** Create a work order in RECEIVED status — stock is NOT consumed yet. */
export async function createWorkOrder(input: CreateWorkOrderInput, actor: Actor) {
  return withTx(async (tx) => {
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
    const qty = Math.trunc(input.quantity ?? 1);
    if (!Number.isInteger(qty) || qty <= 0)
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون عدداً صحيحاً موجباً" });
    // تدقيق ١٧/٧: العربون لا يتجاوز سعر البيع الإجمالي (السعر ثابت لحظة الإنشاء) — عربون أكبر كان يُقبل
    // ثم يجعل الأمر غير قابل للتسليم نهائياً (deliver يرفض totalPaid > salePrice). الإشارة السالبة مصدودة بـzod.
    if (round2(money(input.deposit ?? "0")).gt(money(input.salePrice)))
      throw new TRPCError({ code: "BAD_REQUEST", message: "العربون لا يمكن أن يتجاوز سعر البيع الإجمالي للأمر" });

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

    // v3-add-screens(100%): الدفع بالبطاقة يستلزم مرجع.
    if (input.paymentMethod === "CARD" && !(input.paymentReference?.trim())) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "رقم العملية المرجعي مطلوب لدفع البطاقة" });
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
    });
    const workOrderId = extractInsertId(insRes);
    // سجّل مفتاح الـidempotency فوراً بعد إدراج الأمر — طلبٌ متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK) قبل قبض العربون.
    if (input.clientRequestId) await recordIdempotencyKey(tx, "workOrder.create", input.clientRequestId, workOrderId);

    // عربون مقبوض عند الإنشاء: نقدٌ حقيقي يدخل الصندوق ⇒ سجّله receipt(IN) بـshiftId + قيد PAYMENT_IN
    // (وإلا فهو نقد غير محتسَب في تسوية الوردية/الدفتر). يُربَط بالفاتورة عند التسليم.
    const depositD = round2(money(input.deposit ?? "0"));
    if (depositD.gt(0)) {
      const depositMethod = input.paymentMethod ?? "CASH";
      // نقد أوامر الشغل ينتمي لوردية خدمة الزبائن (RECEPTION) عند وجودها؛ الحلّ المرن يستعمل
      // وردية المشغّل الواحد أيّاً كان نوعها، ويفاضل RECEPTION لو فُتحت وردِيتان.
      const shiftId = await openShiftIdTx(tx, actor.userId, input.branchId, "RECEPTION");
      // عربون نقدي يدخل الدُرج ⇒ يلزم وردية مفتوحة لينعكس في تسوية الصندوق/Z-report (لا نقد «معلّق» بلا وردية).
      if (depositMethod === "CASH" && shiftId == null)
        throw new TRPCError({ code: "CONFLICT", message: "افتح وردية أولاً لقبض عربون نقدي" });
      const dRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId,
        workOrderId,
        direction: "IN",
        amount: toDbMoney(depositD),
        paymentMethod: depositMethod,
        // cashBucket='DRAWER' للعربون النقدي ⇒ يَدخل تسوية الدرج/Z-report (مرآة دفعة التسليم/البيع).
        // كان NULL ⇒ يُستثنى من computeExpectedCash (cashBucket='DRAWER') ⇒ فائضٌ زائف عند إقفال وردية الاستقبال.
        cashBucket: depositMethod === "CASH" ? "DRAWER" : null,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const depositReceiptId = extractInsertId(dRes);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        receiptId: depositReceiptId,
        customerId: input.customerId ?? null,
        amount: depositD,
        notes: `[WO_DEPOSIT:${workOrderId}]`,
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
  });
}

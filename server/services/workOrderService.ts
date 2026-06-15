import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import {
  accountingEntries,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  receipts,
  workOrderImages,
  workOrderItems,
  workOrderMaterials,
  workOrders,
} from "../../drizzle/schema";
import { applyMovement } from "./inventoryService";
import {
  adjustCustomerBalance,
  computeInvoiceStatus,
  postEntry,
} from "./ledgerService";
import { money, round2, sumMoney, toDateStr, toDbMoney } from "./money";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { openShiftIdTx } from "./shiftService";
import { withTx, type Actor } from "./tx";
import { assertCreditLimit } from "../lib/credit";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface WorkOrderMaterialInput {
  variantId: number;
  baseQuantity: number;
}

export interface CreateWorkOrderInput {
  branchId: number;
  customerId?: number | null;
  // v3-add-screens(100%): اختياري لأمر شغل خدمة تخصيص خالصة بلا منتج خام.
  baseVariantId?: number | null;
  title: string;
  customizationText?: string | null;
  quantity?: number; // default 1
  materials?: WorkOrderMaterialInput[]; // additional consumables
  laborCost?: string; // default 0
  salePrice: string;
  dueDate?: string | null; // YYYY-MM-DD
  notes?: string | null;
  // المنفّذ المسؤول عند الإنشاء (يذهب لعمود workOrders.assignedTo؛ null = غير مُسنَد).
  assignedTo?: number | null;
  // v3-add-screens(100%): الحقول الجديدة التي تذهب لأعمدة workOrders الحقيقية.
  receptionChannel?: "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | "OTHER" | null;
  channelHandle?: string | null;
  priority?: "LOW" | "NORMAL" | "URGENT" | null;
  deposit?: string | null;
  paymentMethod?: "CASH" | "CARD" | null;
  paymentReference?: string | null;
  paymentReceiptUrl?: string | null;
  hasDelivery?: boolean | null;
  deliveryAddress?: string | null;
  deliveryCost?: string | null;
  // v3-add-screens(100%): أصناف نقطة البيع المصغّرة (تذهب لجدول workOrderItems).
  items?: Array<{
    variantId: number;
    productUnitId?: number | null;
    quantity: string;          // كمية بالوحدة المختارة
    baseQuantity: number;      // كمية بالوحدة الأساس
    unitPrice: string;
    discountAmount?: string | null;
    total: string;
  }>;
  // v3-add-screens(100%): صور نموذج العمل (تذهب لجدول workOrderImages).
  designImages?: Array<{ url: string; caption?: string | null; sortOrder?: number | null }>;
  /** idempotency: نقرة مزدوجة/إعادة شبكة بنفس المفتاح ⇒ أمر شغل واحد (لا عربون نقدي مزدوج). */
  clientRequestId?: string | null;
}

async function nextWorkOrderNumber(tx: any, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `WO-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: workOrders.orderNumber })
    .from(workOrders)
    .where(like(workOrders.orderNumber, `${prefix}%`))
    .orderBy(desc(workOrders.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

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

    // v3-add-screens(100%): baseVariantId اختياري — أمر شغل قد يكون خدمة تخصيص بلا منتج خام.
    if (input.baseVariantId != null) {
      const base = (
        await tx.select().from(productVariants).where(eq(productVariants.id, input.baseVariantId)).limit(1)
      )[0];
      if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج الأساس لأمر الشغل غير موجود" });
    }

    // Validate materials list — allow zero materials (printing-only WO).
    for (const m of input.materials ?? []) {
      if (!Number.isInteger(m.baseQuantity) || m.baseQuantity <= 0)
        throw new TRPCError({ code: "BAD_REQUEST", message: "كميات المواد يجب أن تكون أعداداً صحيحة موجبة" });
      const v = await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, m.variantId)).limit(1);
      if (!v[0]) throw new TRPCError({ code: "NOT_FOUND", message: `مادة #${m.variantId} غير موجودة` });
    }

    // v3-add-screens(100%): تحقّق أصناف نقطة البيع المصغّرة قبل الكتابة.
    for (const it of input.items ?? []) {
      const v = await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, it.variantId)).limit(1);
      if (!v[0]) throw new TRPCError({ code: "NOT_FOUND", message: `صنف #${it.variantId} غير موجود` });
      if (!Number.isInteger(it.baseQuantity) || it.baseQuantity <= 0)
        throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الصنف يجب أن تكون عدداً صحيحاً موجباً" });
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
      const shiftId = await openShiftIdTx(tx, actor.userId, input.branchId);
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

    // v3-add-screens(100%): أصناف نقطة البيع المصغّرة في جدولها الصحيح.
    for (const it of input.items ?? []) {
      await tx.insert(workOrderItems).values({
        workOrderId,
        variantId: it.variantId,
        productUnitId: it.productUnitId ?? null,
        quantity: it.quantity,
        baseQuantity: it.baseQuantity,
        unitPrice: round2(money(it.unitPrice)).toFixed(2),
        discountAmount: it.discountAmount ? round2(money(it.discountAmount)).toFixed(2) : "0.00",
        total: round2(money(it.total)).toFixed(2),
      });
    }

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

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشغل غير موجود" });
  return rows[0];
}

/** عزل الفرع: أي عملية مال على أمر الشغل تُجبر فرع الموظّف (غير المدير). يُمرَّر actor.role من الراوتر. */
function assertWorkOrderBranch(wo: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(wo.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "أمر الشغل لا يخصّ فرعك" });
  }
}

/** Move RECEIVED → IN_PROGRESS: consume materials from stock (OUT movements) + snapshot unitCost. */
export async function startWorkOrder(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status !== "RECEIVED") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن بدء أمر ليس في حالة الاستلام" });

    const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
    // Deterministic lock order: ascending variantId.
    mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));

    // Batch-load all variant costs in one query instead of N queries inside the loop.
    const variantIds = mats.map((m) => Number(m.variantId));
    const costRows = variantIds.length > 0
      ? await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice })
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds))
      : [];
    const costMap = new Map(costRows.map((v) => [Number(v.id), v.costPrice]));

    let materialsCost = new Decimal(0);
    for (const m of mats) {
      // Snapshot unit cost from variant.costPrice at consumption.
      const unitCost = round2(money(costMap.get(Number(m.variantId)) ?? "0"));
      const lineCost = round2(unitCost.times(m.baseQuantity));
      materialsCost = materialsCost.plus(lineCost);
      await tx.update(workOrderMaterials).set({ unitCost: unitCost.toFixed(2) }).where(eq(workOrderMaterials.id, Number(m.id)));
      await applyMovement(tx, {
        variantId: Number(m.variantId),
        branchId: Number(wo.branchId),
        baseQuantity: m.baseQuantity,
        movementType: "OUT",
        referenceType: "WORK_ORDER",
        referenceId: workOrderId,
        createdBy: actor.userId,
      });
    }
    materialsCost = round2(materialsCost);

    await tx
      .update(workOrders)
      .set({ status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) })
      .where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) };
  });
}

/** IN_PROGRESS → READY (no stock change). */
export async function markWorkOrderReady(workOrderId: number, actor?: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    if (actor) assertWorkOrderBranch(wo, actor);
    if (wo.status !== "IN_PROGRESS") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس قيد التنفيذ" });
    await tx.update(workOrders).set({ status: "READY" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "READY" };
  });
}

export interface DeliverWorkOrderInput {
  workOrderId: number;
  payment?: { amount: string; method: PaymentMethod } | null;
}

/** READY → DELIVERED: create invoice (sourceType=WORKORDER) + optional payment + SALE entry + AR adjust. */
export async function deliverWorkOrder(input: DeliverWorkOrderInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للتسليم" });

    // Look up the base unit of the base variant for the invoice line.
    const baseUnit = (
      await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(eq(productUnits.variantId, Number(wo.baseVariantId)))
        .limit(1)
    )[0];

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
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشغل الآجل يتطلب عميلاً محدداً" });

    // H5: فحص حدّ الائتمان على الجزء الآجل قبل إنشاء الفاتورة (يَرمي FORBIDDEN عند التجاوز).
    const unpaidPortion = round2(salePrice.minus(totalPaid));
    if (wo.customerId && unpaidPortion.gt(0)) {
      await assertCreditLimit(tx, Number(wo.customerId), unpaidPortion, Number(wo.branchId));
    }

    // Invoice number — reuse the invoice numbering (per-branch daily seq).
    const { nextInvoiceNumber } = await import("./numbering");
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
      notes: `أمر شغل ${wo.orderNumber}: ${wo.title}`,
      createdBy: actor.userId,
    });
    const invoiceId = extractInsertId(invRes);

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

    // اربط إيصال العربون (المُسجَّل عند الإنشاء، بلا فاتورة) + قيد PAYMENT_IN الخاص به بالفاتورة الآن.
    if (depositPaid.gt(0)) {
      const depRcpt = (await tx.select({ id: receipts.id }).from(receipts)
        .where(and(eq(receipts.workOrderId, Number(wo.id)), isNull(receipts.invoiceId))).limit(1))[0];
      if (depRcpt) {
        await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcpt.id)));
        await tx.update(accountingEntries).set({ invoiceId }).where(eq(accountingEntries.receiptId, Number(depRcpt.id)));
      }
    }

    // Optional payment receipt + PAYMENT_IN entry.
    if (paidNow.gt(0)) {
      // انسب الدفع النقدي لوردية الموظّف المفتوحة (تسوية الصندوق/Z-report).
      const shiftId = await openShiftIdTx(tx, actor.userId, Number(wo.branchId));
      if (input.payment!.method === "CASH" && shiftId == null)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "يَلزم وردية مفتوحة للدفع النقدي" });
      const rRes = await tx.insert(receipts).values({
        branchId: Number(wo.branchId),
        shiftId,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
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

    return { workOrderId: Number(wo.id), invoiceId, invoiceNumber, status };
  });
}

/** Cancel: restocks consumed materials if status was IN_PROGRESS/READY. */
export async function cancelWorkOrder(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر مُسلَّم أو مُلغى" });
    if (wo.status === "IN_PROGRESS" || wo.status === "READY") {
      const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
      mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));
      for (const m of mats) {
        await applyMovement(tx, {
          variantId: Number(m.variantId),
          branchId: Number(wo.branchId),
          baseQuantity: m.baseQuantity,
          movementType: "IN",
          referenceType: "WORK_ORDER_CANCEL",
          referenceId: workOrderId,
          createdBy: actor.userId,
        });
      }
    }
    // استرداد العربون المقبوض (إن وُجد ولم يُربَط بفاتورة): نقدٌ يخرج من الدُرج الآن ⇒ receipt(OUT)+PAYMENT_OUT
    // يعكس قيد PAYMENT_IN المُسجَّل عند الإنشاء (صافي الدفتر = صفر)، ويظهر خروجاً في Z-report يوم الإلغاء.
    // نعكس فقط ما قُبِض فعلاً (إيصال موجود) — لا نختلق استرداداً لأوامر قديمة لم تُسجِّل العربون كقيد.
    const refundD = round2(money(wo.deposit ?? "0"));
    if (refundD.gt(0)) {
      const depRcpt = (
        await tx
          .select({ amount: receipts.amount, paymentMethod: receipts.paymentMethod })
          .from(receipts)
          .where(and(eq(receipts.workOrderId, workOrderId), eq(receipts.direction, "IN"), isNull(receipts.invoiceId)))
          .limit(1)
      )[0];
      if (depRcpt) {
        const refundAmt = round2(money(depRcpt.amount));
        const refundMethod = depRcpt.paymentMethod ?? "CASH";
        const shiftId = await openShiftIdTx(tx, actor.userId, Number(wo.branchId));
        if (refundMethod === "CASH" && shiftId == null)
          throw new TRPCError({ code: "CONFLICT", message: "افتح وردية أولاً لاسترداد العربون النقدي" });
        const rRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          direction: "OUT",
          amount: toDbMoney(refundAmt),
          paymentMethod: refundMethod,
          status: "COMPLETED",
          referenceNumber: `WO-CANCEL-REFUND-${workOrderId}`,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(rRes);
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: Number(wo.branchId),
          receiptId: refundReceiptId,
          customerId: wo.customerId ?? null,
          amount: refundAmt,
          notes: `استرداد عربون أمر شغل ملغى #${workOrderId}`,
        });
      }
    }

    await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "CANCELLED" };
  });
}

// Silence "unused" hint for sumMoney import kept for parity with other services.
void sumMoney;

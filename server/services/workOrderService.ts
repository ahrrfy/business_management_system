import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import {
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  receipts,
  workOrderImages,
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
  // v3-add-screens(100%): اختياري لطلب خدمة خدمة تخصيص خالصة بلا منتج خام.
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
  // v3-add-screens(100%): صور نموذج العمل (تذهب لجدول workOrderImages).
  designImages?: Array<{ url: string; caption?: string | null; sortOrder?: number | null }>;
  /** idempotency: نقرة مزدوجة/إعادة شبكة بنفس المفتاح ⇒ طلب خدمة واحد (لا عربون نقدي مزدوج). */
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

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  return rows[0];
}

/** عزل الفرع: أي عملية مال على طلب الخدمة تُجبر فرع الموظّف (غير المدير). يُمرَّر actor.role من الراوتر. */
function assertWorkOrderBranch(wo: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(wo.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب الخدمة لا يخصّ فرعك" });
  }
}

/**
 * عزل المحطة: فني المطبعة (print_operator) ينفّذ أوامره المُسنَدة إليه فقط — لا أوامر زملائه.
 * الكاشير/المدير/الأدمن (مكتب الاستقبال) يُنفّذون أي أمر في فرعهم (مرونة تشغيلية). يُستدعى بعد
 * فحص الفرع في start/markReady. السحب (claim) هو ما يجعل أمراً «أمري» قبل التنفيذ.
 */
function assertOperatorOwns(
  wo: { assignedTo: number | string | null },
  actor: Actor & { role?: string },
) {
  if (actor.role !== "print_operator") return;
  if (wo.assignedTo == null || Number(wo.assignedTo) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "اسحب الأمر إلى قائمتك أولاً لتنفيذه" });
  }
}

/**
 * السحب الذاتي (Pull/Claim): يضبط assignedTo = المستخدم الحالي على أمرٍ **في الطابور الوارد**
 * (RECEIVED) غير مُسنَد (أو مُسنَد له سلفاً ⇒ idempotent). لا يسحب أمر زميلٍ آخر (لا «سرقة»).
 * لا أثر مالي/مخزني — مجرّد إسناد. إعادة الإسناد القسرية تبقى للمدير عبر `assign`.
 */
export async function claimWorkOrder(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status !== "RECEIVED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن سحب أمر إلا وهو في الطابور الوارد" });
    if (wo.assignedTo != null && Number(wo.assignedTo) !== actor.userId)
      throw new TRPCError({ code: "CONFLICT", message: "الأمر مسحوبٌ بالفعل لمنفّذ آخر" });
    await tx.update(workOrders).set({ assignedTo: actor.userId }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, assignedTo: actor.userId };
  });
}

/** Move RECEIVED → IN_PROGRESS: consume materials from stock (OUT movements) + snapshot unitCost. */
export async function startWorkOrder(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    assertOperatorOwns(wo, actor);
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
      .set({
        status: "IN_PROGRESS",
        materialsCost: materialsCost.toFixed(2),
        // شَريحة #4: ختم بدء التَنفيذ بالـDB clock (لا client clock — يَضمن مَرجعاً واحداً
        // لِكل المُستهلِكين بَلا انجراف ساعات الفروع).
        workStartedAt: sql`NOW()`,
        // إعادة بدء (مَنطق نَظري — التَدفّق الحالي لا يَدعمه، لكن إن نَفّذ نِظام pause/resume
        // في المُستقبل نُصفّر workSeconds هُنا بَدل تَجميع جُزئي).
        workSeconds: null,
      })
      .where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) };
  });
}

/** IN_PROGRESS → READY (no stock change).
 *  يَحسب زَمن التَنفيذ كَـ TIMESTAMPDIFF(SECOND, workStartedAt, NOW()) على DB clock
 *  ⇒ لا انجراف ولا اعتماد على عَميل. لو workStartedAt = NULL (أَوامر قَديمة قبل الهجرة)
 *  يَبقى workSeconds = NULL ولا يَكسر شَيئاً (الواجهة تَتعامل مع NULL بِفقاطِع رَمادية). */
export async function markWorkOrderReady(workOrderId: number, actor?: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    if (actor) { assertWorkOrderBranch(wo, actor); assertOperatorOwns(wo, actor); }
    if (wo.status !== "IN_PROGRESS") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس قيد التنفيذ" });
    await tx
      .update(workOrders)
      .set({
        status: "READY",
        // GREATEST(...,0) حِماية: لو ساعة DB رُجِعَت بَين start و markReady (نَدراً) لا نَعطي سالباً.
        workSeconds: sql`GREATEST(TIMESTAMPDIFF(SECOND, ${workOrders.workStartedAt}, NOW()), 0)`,
      })
      .where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "READY" };
  });
}

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
        const shiftId = await openShiftIdTx(tx, actor.userId, Number(wo.branchId), "RECEPTION");
        if (refundMethod === "CASH" && shiftId == null)
          throw new TRPCError({ code: "CONFLICT", message: "افتح وردية أولاً لاسترداد العربون النقدي" });
        const rRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          direction: "OUT",
          amount: toDbMoney(refundAmt),
          paymentMethod: refundMethod,
          // cashBucket='DRAWER' للاسترداد النقدي ⇒ يَخصم من تسوية الدرج/Z-report (مرآة العربون عند القبض).
          cashBucket: refundMethod === "CASH" ? "DRAWER" : null,
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
          notes: `استرداد عربون طلب خدمة ملغى #${workOrderId}`,
        });
      }
    }

    await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "CANCELLED" };
  });
}

// Silence "unused" hint for sumMoney import kept for parity with other services.
void sumMoney;

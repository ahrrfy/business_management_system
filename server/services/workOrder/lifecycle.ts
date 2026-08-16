// دورة تنفيذ الأمر: سحب ذاتي (claim) ← بدء التنفيذ (يستهلك المواد) ← جاهز (بلا تغيير مخزون).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { branchStock, customers, products, productVariants, workOrderMaterials, workOrders } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { applyMovement } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2 } from "../money";
import { readOpeningWindowState } from "../openingModeService";
import { type Actor, requireDb, withTx } from "../tx";
import { flowNotify } from "../whatsapp";
import { assertOperatorOwns, assertWorkOrderBranch, loadWorkOrder } from "./helpers";

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

    // ترتيب القفل الحاكم مع الشراء/WAVG: branchStock ثم productVariants، وكلاهما تصاعدي. نضمن
    // وجود صفّ الرصيد أولاً لأن FOR UPDATE لا يقفل صفاً مفقوداً، ثم نحجز لقطة التكلفة حتى الترحيل.
    const variantIds = Array.from(new Set(mats.map((m) => Number(m.variantId)))).sort((a, b) => a - b);
    if (variantIds.length > 0) {
      await tx
        .insert(branchStock)
        .values(variantIds.map((variantId) => ({ variantId, branchId: Number(wo.branchId), quantity: 0 })))
        .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });
      await tx
        .select({ id: branchStock.id })
        .from(branchStock)
        .where(and(eq(branchStock.branchId, Number(wo.branchId)), inArray(branchStock.variantId, variantIds)))
        .orderBy(asc(branchStock.variantId))
        .for("update");
    }
    const infoRows = variantIds.length > 0
      ? await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice, isConsignment: products.isConsignment })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, variantIds))
          .orderBy(asc(productVariants.id))
          .for("update")
      : [];
    if (infoRows.length !== variantIds.length) {
      throw new TRPCError({ code: "NOT_FOUND", message: "إحدى مواد أمر الشغل غير موجودة" });
    }
    if (infoRows.some((v) => v.isConsignment)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "بضاعة الأمانة لا تُستهلك كمادة في أمر شغل — استبدلها بمادة مملوكة للمكتبة",
      });
    }
    const costMap = new Map(infoRows.map((v) => [Number(v.id), v.costPrice]));

    // وضع الافتتاح (قرار المالك ١٠/٨): أثناء النافذة الفعّالة يُسمح باستهلاك مواد صنفٍ **غير مُفتتَح**
    // بالسالب حتى يُجرَد افتتاحياً — وإلا توقّف كاشير التنفيذ إذ لا مواد مجرودة بعد. الحُرّاس الصنفية
    // تبقى: تكلفة>0 (سلامة COGS) + سقف السطر + غير مُفتتَح (openedAt IS NULL يُفحص داخل applyMovement).
    // الأمانة مرفوضة من أمر الشغل كله قبل الوصول إلى هذه الرخصة.
    const opening = await readOpeningWindowState(tx);

    // لقطة تكلفة كل سطر (قد تتكرّر الأصناف) + **تجميع الكمية لكل صنف** قبل فحص السقف والحركة —
    // مرآةً لمسار البيع: حركةٌ واحدة لكل صنف بترتيب variantId (منع deadlock)، والسقف على الإجمالي لا
    // على السطر (Codex P2: صفّان مكرّران بـ100 لصنفٍ واحد كانا يتجاوزان سقف 100 فيهبط الرصيد −200).
    let materialsCost = new Decimal(0);
    const aggregated = new Map<number, number>();
    for (const m of mats) {
      const vid = Number(m.variantId);
      const unitCost = round2(money(costMap.get(vid) ?? "0"));
      const lineCost = round2(unitCost.times(m.baseQuantity));
      materialsCost = materialsCost.plus(lineCost);
      await tx.update(workOrderMaterials).set({ unitCost: unitCost.toFixed(2) }).where(eq(workOrderMaterials.id, Number(m.id)));
      aggregated.set(vid, (aggregated.get(vid) ?? 0) + m.baseQuantity);
    }
    materialsCost = round2(materialsCost);

    const sortedVariantIds = Array.from(aggregated.keys()).sort((a, b) => a - b);
    for (const vid of sortedVariantIds) {
      const qty = aggregated.get(vid)!;
      if (qty <= 0) continue;
      const unitCost = round2(money(costMap.get(vid) ?? "0"));
      const allowNegativeUnopened =
        opening.active && unitCost.gt(0) && qty <= opening.maxQty;
      try {
        await applyMovement(tx, {
          variantId: vid,
          branchId: Number(wo.branchId),
          baseQuantity: qty,
          movementType: "OUT",
          referenceType: "WORK_ORDER",
          referenceId: workOrderId,
          createdBy: actor.userId,
          // Codex P2: وسم الحركة عند السماح بالسالب في وضع الافتتاح (مرآة مسار البيع) — أثرٌ دائم
          // يُبيّن أن الحركة المخزنية السالبة صُرّح بها بالنافذة المؤقّتة حتى بعد إغلاقها.
          notes: allowNegativeUnopened ? "وضع الافتتاح — استهلاك مادة أمر شغل مسموح بالسالب لصنف غير مُفتتَح" : undefined,
          allowNegativeUnopened,
        });
      } catch (e) {
        // إثراء رسالة الرفض أثناء نافذة الافتتاح: يشرح لماذا لم يُسمح باستهلاك المادة بالسالب.
        if (e instanceof TRPCError && e.code === "CONFLICT" && e.message.includes("المخزون غير كافٍ") && opening.active) {
          const hint = !unitCost.gt(0)
            ? "بدء التنفيذ بالسالب في وضع الافتتاح يتطلّب تكلفة مُدخلة للمادة — أدخِل تكلفتها أولاً"
            : qty > opening.maxQty
              ? `كمية المادة تتجاوز سقف السطر السالب في وضع الافتتاح (${opening.maxQty} وحدة أساس)`
              : "المادة مُفتتَحة (مجرودة) — رصيدها مثبّت والاستهلاك فوقه يخضع للفحص الصارم";
          throw new TRPCError({ code: "CONFLICT", message: `${e.message} — ${hint}` });
        }
        throw e;
      }
    }

    if (materialsCost.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        dedupeKey: `WO-WIP-CONSUME:${workOrderId}`,
        branchId: Number(wo.branchId),
        cost: materialsCost,
        amount: materialsCost,
        notes: `تحويل مواد أمر الشغل ${wo.orderNumber} إلى إنتاج تحت التشغيل`,
        postingIntent: createPostingIntent("ADJUST_WIP_CONSUME", "ADJUST", [debitLine("WORK_IN_PROGRESS", materialsCost), creditLine("INVENTORY", materialsCost)], { roleDebits: { WORK_IN_PROGRESS: materialsCost }, roleCredits: { INVENTORY: materialsCost } }),
        postingSourceComponents: { roleDebits: { WORK_IN_PROGRESS: materialsCost }, roleCredits: { INVENTORY: materialsCost } },
      });
    }

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
  const result = await withTx(async (tx) => {
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
    return {
      workOrderId,
      status: "READY" as const,
      branchId: Number(wo.branchId),
      customerId: wo.customerId != null ? Number(wo.customerId) : null,
      orderNumber: wo.orderNumber,
    };
  });

  // إشعار «طلبك جاهز» (T4.2، خلف مفتاح flowOrderReady) — خارج المعاملة تماماً وبعد نجاحها فقط،
  // محمي بذاته (flowNotify لا يرمي) + غلاف دفاعيّ هنا. **لا يُفشِل الانتقال أبداً** (القاعدة الحاكمة،
  // راجع server/services/whatsapp/flowNotify.ts).
  try {
    await notifyOrderReady(result);
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), workOrderId: result.workOrderId },
      "workOrder: تعذّر إرسال إشعار طلبك جاهز — تُجوهل",
    );
  }

  return { workOrderId: result.workOrderId, status: result.status };
}

/** يجلب هاتف/اسم عميل الأمر (إن عُرف) ويستدعي flowNotify — لا شيء إن لا عميل/لا هاتف. */
async function notifyOrderReady(params: { workOrderId: number; branchId: number; customerId: number | null; orderNumber: string }): Promise<void> {
  if (params.customerId == null) return;
  const db = requireDb();
  const cust = (
    await db.select({ name: customers.name, phone: customers.phone }).from(customers).where(eq(customers.id, params.customerId)).limit(1)
  )[0];
  if (!cust?.phone) return;
  await flowNotify({
    flowKey: "flowOrderReady",
    branchId: params.branchId,
    toPhoneE164: cust.phone,
    customerId: params.customerId,
    templateName: "order_ready",
    bodyParams: [cust.name, params.orderNumber],
    dedupeKey: `WO_READY:${params.workOrderId}`,
  });
}

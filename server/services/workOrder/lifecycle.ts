// دورة تنفيذ الأمر: سحب ذاتي (claim) ← بدء التنفيذ (يستهلك المواد) ← جاهز (بلا تغيير مخزون).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { branchStock, customers, products, productVariants, users, workOrderMaterials, workOrders } from "../../../drizzle/schema";
import { logger } from "../../logger";
import { canCrossBranches } from "../../lib/branchAuthority";
import { hasModuleAccess } from "@shared/permissions";
import { logAuditTx } from "../auditService";
import { recordWorkOrderEvent } from "../workOrderEvents";
import { applyMovement } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2 } from "../money";
import { readOpeningWindowState } from "../openingModeService";
import { type Actor, requireDb, withTx } from "../tx";
import { flowNotify } from "../whatsapp";
import { assertNoBlockingTask, assertOperatorOwns, assertWorkOrderBranch, loadWorkOrder } from "./helpers";

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
    // Idempotency: مُسحَبٌ سلفاً لنفس الفنّيّ ⇒ لا نُدرج أثراً مكرّراً في auditLogs.
    const alreadyClaimed = wo.assignedTo != null && Number(wo.assignedTo) === actor.userId;
    await tx.update(workOrders).set({ assignedTo: actor.userId }).where(eq(workOrders.id, workOrderId));
    if (!alreadyClaimed) {
      // تدقيقُ SEED للـEvent Store الاحتياطيّ (auditLogs) — يجعل `workOrderRouter.timeline`
      // يُظهر السحبَ بجانب إعادة الإسناد والإفراج والإلغاء (كانت تكتب logAuditTx وحدها).
      await logAuditTx(
        tx,
        { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never },
        {
          action: "workOrder.claim",
          entityType: "workOrder",
          entityId: workOrderId,
          oldValue: { assignedTo: null },
          newValue: { assignedTo: actor.userId, statusAtClaim: wo.status },
        },
      );
      // Slice 6 (٢٨/٨/٢٦): dual-write إلى workOrderEvents — سجلٌّ منظَّم بأعمدة مُنمَّطة
      // (fromStatus/toStatus قابلة للفلترة والفهرسة). `eventKey=wo:<id>:CLAIMED` أحاديٌّ
      // بحكم التصميم — CLAIMED مرّةً واحدةً لكلّ أمر (idempotency على مستوى القاعدة).
      await recordWorkOrderEvent(tx, {
        workOrderId,
        eventType: "CLAIMED",
        fromStatus: wo.status,
        toStatus: wo.status,
        actorUserId: actor.userId,
        branchId: actor.branchId ?? Number(wo.branchId),
        payload: { assignedTo: actor.userId },
      });
    }
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
    // ش٢ (١٩/٨): لا دينارَ خامةٍ يُستهلَك على تصميمٍ لم يُقرّه العميل. **قبل قفل `branchStock`**
    // عمداً ⇒ يفشل مغلقاً بلا حركةِ مخزونٍ ولا قيدٍ ولا صفٍّ مُدرَج.
    await assertNoBlockingTask(tx, workOrderId, "start");

    const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
    // Deterministic lock order: ascending variantId.
    mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));

    // ترتيب القفل الحاكم مع الشراء/WAVG: productVariants ثم branchStock، وكلاهما تصاعدي. نضمن
    // وجود صفّ الرصيد أولاً لأن FOR UPDATE لا يقفل صفاً مفقوداً، ثم نحجز لقطة التكلفة حتى الترحيل.
    const variantIds = Array.from(new Set(mats.map((m) => Number(m.variantId)))).sort((a, b) => a - b);
    await lockInventoryVariants(tx, variantIds);
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
        /**
         * ش٣ (١٩/٨) — **موتُ اليتيم**: البدء يُثبّت المنفّذ إن لم يكن مُسنَداً.
         *
         * كان `startWorkOrder` لا يكتب `assignedTo` إطلاقاً، و`assertOperatorOwns` تمرّ بصمتٍ
         * لكلّ من ليس `print_operator` ⇒ كاشيرٌ يسحب البطاقة في الكانبان فتُخصَم المواد ويبقى
         * `assignedTo=NULL`. وبعدها: `claim` يشترط RECEIVED فيرفض، و`markReady` يرفض كلّ فنّيّ
         * لأنّه غير مُسنَد، والأمر لا يظهر في أيٍّ من قائمتَي المحطّة — **مواد مخصومة وقيد WIP
         * قائم وأمرٌ لا يراه منفّذٌ واحد**.
         *
         * `COALESCE` لا إسنادٌ مطلق: لا يسرق أمراً مُسنَداً لفنّيٍّ سحبه.
         */
        assignedTo: sql`COALESCE(${workOrders.assignedTo}, ${actor.userId})`,
      })
      .where(eq(workOrders.id, workOrderId));
    // تدقيقُ SEED للـEvent Store الاحتياطيّ — انتقالُ RECEIVED→IN_PROGRESS كان يُخصَم المخزون
    // ويكتب قيدَ WIP لكن يبقى بلا أثرٍ زمنيّ في `workOrderRouter.timeline` (ثغرة #5 من تدقيق ٢٨/٨).
    // materialsCost في newValue لأنّه رقمُ الاستهلاك المصمَّت (يُعزّز الأثر الماليّ حين يبحث المشرف).
    await logAuditTx(
      tx,
      { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never },
      {
        action: "workOrder.start",
        entityType: "workOrder",
        entityId: workOrderId,
        oldValue: { status: "RECEIVED" },
        newValue: { status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) },
      },
    );
    // Slice 6 dual-write: STARTED أحاديٌّ (RECEIVED → IN_PROGRESS مرّةً واحدةً لكلّ أمر).
    await recordWorkOrderEvent(tx, {
      workOrderId,
      eventType: "STARTED",
      fromStatus: "RECEIVED",
      toStatus: "IN_PROGRESS",
      actorUserId: actor.userId,
      branchId: actor.branchId ?? Number(wo.branchId),
      payload: { materialsCost: materialsCost.toFixed(2) },
    });
    return { workOrderId, status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) };
  });
}

export interface ReassignWorkOrderInput {
  workOrderId: number;
  /** `null` = إعادةٌ إلى الطابور العامّ. */
  assignedTo: number | null;
  /** **إلزاميّ بعد بدء التنفيذ** — المواد مستهلَكة والمؤقّت يعمل. */
  reason?: string | null;
}

/**
 * **نقلُ الإسناد** (ش٣، ١٩/٨) — كان `db.update` عارياً **خارج أيّ معاملة** في الراوتر.
 *
 * وثلاثةُ فروقٍ جوهرية:
 *  ① داخل `withTx` تحت قفل الصفّ (`loadWorkOrder`) ⇒ لا تعارضَ مع بدءٍ أو تسليمٍ متزامن.
 *  ② **الأهلية بالوحدة لا بالدور الخامّ**: كان يشترط `role === "print_operator"` حرفياً،
 *     والأدوارُ تُحلّ عبر `permissionsOverride` ⇒ فنّيٌّ بدورٍ مخصّص مؤهَّلٍ فعلاً كان يُرفَض،
 *     ومَن مُنح الوحدة بدورٍ آخر لا يُسنَد إليه شيء.
 *  ③ **سببٌ إلزاميّ بعد البدء**، وتدقيقٌ يحمل `oldValue` — بلا هذين يصير النقل صامتاً فلا
 *     يعرف المشرف مِمَّن نُقل الأمر ولا لماذا، والمواد مخصومةٌ على حساب من بدأه.
 */
export async function reassignWorkOrder(
  input: ReassignWorkOrderInput,
  actor: Actor & { role?: string; isOwner?: boolean },
) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير فني أمر منتهٍ" });
    }

    const reason = input.reason?.trim() || null;
    if (wo.status === "IN_PROGRESS" && (!reason || reason.length < 3)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الأمر قيد التنفيذ والمواد مخصومة — اكتب سبب النقل (يُسجَّل باسمك)",
      });
    }

    if (input.assignedTo != null) {
      const u = (
        await tx
          .select({
            id: users.id, isActive: users.isActive, branchId: users.branchId,
            role: users.role, isOwner: users.isOwner, permissionsOverride: users.permissionsOverride,
          })
          .from(users)
          .where(eq(users.id, input.assignedTo))
          .limit(1)
      )[0];
      if (!u || !u.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير موجود أو معطّل" });
      if (!hasModuleAccess(u.role, (u.permissionsOverride as never) ?? null, "workorders", "FULL")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يملك هذا الموظف صلاحية أوامر الشغل — اختر منفّذاً آخر أو امنحه الصلاحية",
        });
      }
      // عابرُ الفروع وحده يُستثنى (`canCrossBranches` لا شرطٌ منسوخ). الموظف بلا فرع مشترك.
      if (
        !canCrossBranches({ role: u.role, isOwner: u.isOwner })
        && u.branchId != null
        && Number(u.branchId) !== Number(wo.branchId)
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إسناد الطلب لموظفٍ من فرعٍ آخر" });
      }
    }

    const previous = wo.assignedTo != null ? Number(wo.assignedTo) : null;
    await tx.update(workOrders).set({ assignedTo: input.assignedTo }).where(eq(workOrders.id, Number(wo.id)));
    await logAuditTx(
      tx,
      { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never },
      {
        action: "workOrder.assign",
        entityType: "workOrder",
        entityId: Number(wo.id),
        // ⭐ `oldValue` — بلا «مِمَّن» يصير سجلُّ النقل نصفَ حقيقة.
        oldValue: { assignedTo: previous },
        newValue: { assignedTo: input.assignedTo, reason, statusAtMove: wo.status },
      },
    );
    return { ok: true as const, workOrderId: Number(wo.id), assignedTo: input.assignedTo, previous };
  });
}

/**
 * **طريقُ خروجِ الفنّي** (ش٣): يُعيد أمراً سحبه ولم يبدأه إلى الطابور بنفسه — بلا انتظار مدير.
 * وبعد البدء **يُرفَض**: المواد مستهلَكة والمؤقّت يعمل، فالانسحابُ الصامت يخلق يتيماً جديداً؛
 * والمخرجُ المشروع نقلٌ بسببٍ مُسجَّل.
 */
export async function releaseWorkOrder(workOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.assignedTo == null) return { ok: true as const, workOrderId, alreadyFree: true as const };
    if (Number(wo.assignedTo) !== Number(actor.userId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الأمر مُسنَدٌ لغيرك — النقل من صلاحية المدير" });
    }
    if (wo.status !== "RECEIVED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا تُعيده إلى الطابور بعد بدء التنفيذ — انقله لفنّيّ آخر بسببٍ مُسجَّل من المدير",
      });
    }
    await tx.update(workOrders).set({ assignedTo: null }).where(eq(workOrders.id, workOrderId));
    await logAuditTx(
      tx,
      { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never },
      {
        action: "workOrder.release",
        entityType: "workOrder",
        entityId: workOrderId,
        oldValue: { assignedTo: Number(wo.assignedTo) },
        newValue: { assignedTo: null },
      },
    );
    return { ok: true as const, workOrderId, alreadyFree: false as const };
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
    // ونسخةُ تصميمٍ جديدة تُفتَح **أثناء** التنفيذ تمنع الوسم جاهزاً: ما بُني على النسخة
    // المُبطَلة ليس ما وافق عليه العميل.
    await assertNoBlockingTask(tx, workOrderId, "ready");
    await tx
      .update(workOrders)
      .set({
        status: "READY",
        // GREATEST(...,0) حِماية: لو ساعة DB رُجِعَت بَين start و markReady (نَدراً) لا نَعطي سالباً.
        workSeconds: sql`GREATEST(TIMESTAMPDIFF(SECOND, ${workOrders.workStartedAt}, NOW()), 0)`,
      })
      .where(eq(workOrders.id, workOrderId));
    // تدقيقُ SEED للـEvent Store الاحتياطيّ — IN_PROGRESS→READY كان الطلب «يتيه»: الفنّي أعلن
    // الجاهزيّة، العميل تلقّى واتساب، لكن `workOrderRouter.timeline` لا يعرض السطر (لأنّ الأثر
    // كان يُدهَس بعمود status عند التسليم). بلاغ المالك ٢٨/٨/٢٦.
    //
    // ⚠️ **Actor اختياريّ** — يُستدعى داخلياً بلا سياقٍ من مسارات flowNotify. الفابركة `userId: 0`
    // كانت خطأً P1 (Codex #851): `auditLogs.userId` FK إلى `users.id`، وحين لا يوجد مستخدمٌ
    // بمعرّف 0، الإدراج يفشل ويُرجع الانتقال كلّه. `userId` FK nullable — نمرّر `ctx.user`
    // كـundefined فيصير null قانونياً. `branchId` من أمر الشغل مصدرُ حقيقةٍ لا اجتهاد.
    const auditCtx: Parameters<typeof logAuditTx>[1] = actor
      ? { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never }
      : { user: undefined as never, req: undefined as never };
    await logAuditTx(
      tx,
      auditCtx,
      {
        action: "workOrder.markReady",
        entityType: "workOrder",
        entityId: workOrderId,
        oldValue: { status: "IN_PROGRESS" },
        newValue: { status: "READY", branchId: Number(wo.branchId) },
      },
    );
    // Slice 6 dual-write: MARKED_READY أحاديٌّ. actor اختياريّ (نفس النمط أعلاه).
    await recordWorkOrderEvent(tx, {
      workOrderId,
      eventType: "MARKED_READY",
      fromStatus: "IN_PROGRESS",
      toStatus: "READY",
      actorUserId: actor?.userId ?? null,
      branchId: actor?.branchId ?? Number(wo.branchId),
    });
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
  // رقمٌ واحدٌ للزبون (١٩/٨): كان يقرأ `customers.phone` وحده ويعود مبكّراً عند خلوّه،
  // بينما عمود `whatsapp` قائمٌ ومُنشئُ المحادثة يشتقّ رقمَه بـCOALESCE نفسه
  // (`workOrderRouter.ts:215`) ⤇ عميلُ واتسابٍ رقمُه في العمود المخصّص **لا يصله إشعار الجاهزية
  // إطلاقاً**، وإن اختلف الرقمان هبط ردُّه في محادثةٍ ثانية. الاشتقاق موحَّدٌ الآن.
  const cust = (
    await db
      .select({
        name: customers.name,
        phone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      })
      .from(customers)
      .where(eq(customers.id, params.customerId))
      .limit(1)
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

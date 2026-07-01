// دورة تنفيذ الأمر: سحب ذاتي (claim) ← بدء التنفيذ (يستهلك المواد) ← جاهز (بلا تغيير مخزون).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq, inArray, sql } from "drizzle-orm";
import { productVariants, workOrderMaterials, workOrders } from "../../../drizzle/schema";
import { applyMovement } from "../inventoryService";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
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

/**
 * تحرير **بنود** أمر الشغل (المواد) — إضافةً وحذفاً وتغييرَ كمّية، قبل التسليم.
 *
 * لماذا (بلاغ المالك ١٧/٨/٢٦): «الزبائن مزاجهم متقلّب… يعدّلون على طلباتهم وفواتيرهم كثيراً»،
 * ولم يكن في النظام **أيّ** مسارٍ لإضافة منتجٍ لأمر شغلٍ أو حذفه: `updateWorkOrder` يعدّل
 * العنوان والسعر والموعد فقط، وعلَّق الأمر صراحةً بأنّ «الكمية/المواد خارج النطاق… تغييرها بعد
 * بدء التنفيذ يستلزم عكس حركة مخزون — مؤجَّل عمداً». هذا الملف يرفع ذلك التأجيل بعكسٍ صحيح.
 *
 * ⭐ العقد **تصريحيّ لا تفاضليّ**: يرسل النداء **القائمة المطلوبة كاملةً**، والخدمة تشتقّ الفرق.
 *    هذا ليس ترفاً في التصميم — هو ما يجعل العملية **idempotent بطبيعتها**: إرسال القائمة نفسها
 *    مرّتين (نقرةٌ مزدوجة، إعادة إرسالٍ على شبكةٍ متذبذبة) يُنتج فرقاً = صفر ⇒ لا حركة مخزون
 *    مكرّرة ولا قيدَ مكرّر. ومسار الاستقبال بالذات يعمل على شبكة جوّالٍ متقطّعة.
 *
 * الأثر المالي يتبع **حالة الأمر**، لأنّ لحظة الاستهلاك هي `startWorkOrder`:
 *   · `RECEIVED` (لم يبدأ): المواد بياناتٌ محضة (`unitCost="0"`، بلا حركة مخزون) ⇒ التحرير
 *     إعادةُ كتابة صفوفٍ فقط. صفر أثر على المخزون والدفتر. وهي الحالة الغالبة عملياً.
 *   · `IN_PROGRESS`/`READY` (استُهلكت المواد وتُرحّلت WIP): كل فرقٍ يقابله **حركة مخزون معاكسة**
 *     (زيادة ⇒ استهلاك إضافيّ OUT، نقص ⇒ إعادةٌ للرفّ IN) + قيد ADJUST مُكمِّل يصحّح
 *     `WORK_IN_PROGRESS` مقابل `INVENTORY` بفرق التكلفة، و`materialsCost` يُعاد حسابه.
 *   · `DELIVERED`/`CANCELLED`: مرفوض (الفاتورة صدرت أو الأمر أُغلق).
 *
 * ثوابت مستنسَخة من `startWorkOrder` عمداً (لا تُبسَّط):
 *   · ترتيب القفل: `productVariants` ثمّ `branchStock`، تصاعدياً بـvariantId — منع deadlock مع
 *     الشراء/WAVG والبيع.
 *   · تجميع الكمية لكل صنف قبل الحركة (صفّان لنفس الصنف = حركةٌ واحدة).
 *   · بضاعة الأمانة مرفوضة مادةً (حصّة المودِع لا تُستهلك في إنتاجنا).
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  products,
  productVariants,
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import { createPostingIntent, signedPostingLines } from "../accounting/postingEngine";
import { applyMovement } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import type { WorkOrderMaterialInput } from "./types";

/** نفس شكل مواد الإنشاء عمداً (`{variantId, baseQuantity}`) — عقدٌ واحد للإنشاء والتحرير. */
export type { WorkOrderMaterialInput } from "./types";

export interface SetWorkOrderMaterialsInput {
  workOrderId: number;
  /** القائمة **المطلوبة كاملةً** بعد التعديل (لا الفرق) — قائمةٌ فارغة تعني «بلا مواد». */
  materials: WorkOrderMaterialInput[];
}

export interface SetWorkOrderMaterialsResult {
  workOrderId: number;
  /** هل مسّ هذا التعديل المخزون/الدفتر فعلاً (أي كان الأمر قيد التنفيذ وتغيّر شيء)؟ */
  stockAdjusted: boolean;
  materialsCost: string;
  added: Array<{ variantId: number; baseQuantity: number }>;
  removed: Array<{ variantId: number; baseQuantity: number }>;
  changed: Array<{ variantId: number; from: number; to: number }>;
}

/** يجمع الكميات لكل صنف — صفّان لنفس الصنف سطرٌ واحدٌ منطقيّاً (مرآة `startWorkOrder`). */
function aggregate(rows: Array<{ variantId: number | string; baseQuantity: number }>): Map<number, number> {
  const map = new Map<number, number>();
  for (const r of rows) {
    const vid = Number(r.variantId);
    map.set(vid, (map.get(vid) ?? 0) + Number(r.baseQuantity));
  }
  return map;
}

export async function setWorkOrderMaterials(
  input: SetWorkOrderMaterialsInput,
  actor: Actor & { role?: string },
): Promise<SetWorkOrderMaterialsResult> {
  return withTx(async (tx) => {
    for (const m of input.materials) {
      if (!Number.isInteger(m.baseQuantity) || m.baseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "كمية المادة يجب أن تكون عدداً صحيحاً موجباً" });
      }
      if (!Number.isInteger(m.variantId) || m.variantId <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "صنف المادة غير صالح" });
      }
    }

    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status === "DELIVERED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الأمر مُسلَّم وصدرت فاتورته — عالِج الفرق بمرتجعٍ أو بفاتورةٍ جديدة، لا بتعديل بنوده",
      });
    }
    if (wo.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُعدَّل بنود أمرٍ ملغى" });
    }
    // المواد لم تُستهلَك بعد إلّا بعد البدء ⇒ الأثر المخزنيّ/الدفتريّ مشروطٌ بذلك وحده.
    const consumed = wo.status === "IN_PROGRESS" || wo.status === "READY";

    const currentRows = await tx
      .select({ id: workOrderMaterials.id, variantId: workOrderMaterials.variantId, baseQuantity: workOrderMaterials.baseQuantity, unitCost: workOrderMaterials.unitCost })
      .from(workOrderMaterials)
      .where(eq(workOrderMaterials.workOrderId, input.workOrderId));

    const currentQty = aggregate(currentRows);
    const desiredQty = aggregate(input.materials);
    // لقطة التكلفة المحفوظة وقت الاستهلاك — لا تُعاد قراءتها من `costPrice` الحيّ للأصناف
    // القائمة، وإلّا حرّك تغيّرُ WAVG بين البدء والتعديل قيمةَ WIP بلا أيّ حركةٍ فعلية.
    const snapshotCost = new Map<number, Decimal>();
    for (const r of currentRows) {
      if (!snapshotCost.has(Number(r.variantId))) snapshotCost.set(Number(r.variantId), round2(money(r.unitCost ?? "0")));
    }

    const touchedIds = Array.from(
      new Set(Array.from(currentQty.keys()).concat(Array.from(desiredQty.keys()))),
    ).sort((a, b) => a - b);
    const added: SetWorkOrderMaterialsResult["added"] = [];
    const removed: SetWorkOrderMaterialsResult["removed"] = [];
    const changed: SetWorkOrderMaterialsResult["changed"] = [];
    for (const vid of touchedIds) {
      const from = currentQty.get(vid) ?? 0;
      const to = desiredQty.get(vid) ?? 0;
      if (from === to) continue;
      if (from === 0) added.push({ variantId: vid, baseQuantity: to });
      else if (to === 0) removed.push({ variantId: vid, baseQuantity: from });
      else changed.push({ variantId: vid, from, to });
    }
    const hasDelta = added.length > 0 || removed.length > 0 || changed.length > 0;

    // ✅ idempotency طبيعيّة: نفس القائمة مرّتين ⇒ فرقٌ صفر ⇒ خروجٌ نظيف بلا حركةٍ ولا قيد.
    if (!hasDelta) {
      return {
        workOrderId: input.workOrderId,
        stockAdjusted: false,
        materialsCost: round2(money(wo.materialsCost ?? "0")).toFixed(2),
        added, removed, changed,
      };
    }

    // الأصناف المطلوبة يجب أن تكون موجودةً وغير أمانة — الفحص على القائمة المطلوبة كلّها
    // (لا المضافة وحدها) كي لا يمرّ صنفٌ صار أمانةً بعد إضافته سابقاً.
    const desiredIds = Array.from(desiredQty.keys()).sort((a, b) => a - b);
    const costMap = new Map<number, Decimal>();
    if (desiredIds.length) {
      await lockInventoryVariants(tx, consumed ? touchedIds : desiredIds);
      // ترتيب القفل الحاكم مع الشراء/WAVG والبيع: productVariants ثمّ branchStock، تصاعدياً.
      // نضمن وجود صفّ الرصيد أولاً لأنّ FOR UPDATE لا يقفل صفاً مفقوداً.
      if (consumed) {
        const lockIds = touchedIds;
        await tx
          .insert(branchStock)
          .values(lockIds.map((variantId) => ({ variantId, branchId: Number(wo.branchId), quantity: 0 })))
          .onDuplicateKeyUpdate({ set: { variantId: sql`${branchStock.variantId}` } });
        await tx
          .select({ id: branchStock.id })
          .from(branchStock)
          .where(and(eq(branchStock.branchId, Number(wo.branchId)), inArray(branchStock.variantId, lockIds)))
          .orderBy(asc(branchStock.variantId))
          .for("update");
      }
      const infoRows = await tx
        .select({ id: productVariants.id, costPrice: productVariants.costPrice, isConsignment: products.isConsignment })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, desiredIds))
        .orderBy(asc(productVariants.id));
      if (infoRows.length !== desiredIds.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "إحدى المواد المطلوبة غير موجودة" });
      }
      if (infoRows.some((v) => v.isConsignment)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "بضاعة الأمانة لا تُستهلك كمادة في أمر شغل — استبدلها بمادة مملوكة للمكتبة",
        });
      }
      for (const v of infoRows) costMap.set(Number(v.id), round2(money(v.costPrice ?? "0")));
    }

    // ── الأثر المخزنيّ/الدفتريّ — فقط بعد بدء التنفيذ ──
    let costDelta = new Decimal(0);
    if (consumed) {
      for (const vid of touchedIds) {
        const from = currentQty.get(vid) ?? 0;
        const to = desiredQty.get(vid) ?? 0;
        const delta = to - from;
        if (delta === 0) continue;
        // تكلفة الوحدة: لقطة الاستهلاك للأصناف القائمة (لا تتغيّر بتغيّر WAVG)، والتكلفة
        // الحيّة للصنف المضاف حديثاً (هي لحظة استهلاكه الفعلية).
        const unitCost = snapshotCost.get(vid) ?? costMap.get(vid) ?? new Decimal(0);
        costDelta = costDelta.plus(round2(unitCost.times(delta)));
        await applyMovement(tx, {
          variantId: vid,
          branchId: Number(wo.branchId),
          baseQuantity: Math.abs(delta),
          // زيادة ⇒ استهلاكٌ إضافيّ من الرفّ؛ نقص ⇒ مادةٌ لم تُستعمَل تعود للرفّ.
          movementType: delta > 0 ? "OUT" : "IN",
          referenceType: "WORK_ORDER",
          referenceId: input.workOrderId,
          createdBy: actor.userId,
          notes: `تعديل بنود أمر الشغل ${wo.orderNumber}`,
        });
      }
      costDelta = round2(costDelta);
      if (!costDelta.isZero()) {
        // قيدٌ **مُكمِّل** لا بديل: يصحّح WIP مقابل المخزون بفرق التكلفة وحده. بلا `dedupeKey`
        // لأنّ التعديلات المتعدّدة على الأمر نفسه مشروعة، والحماية من التكرار تأتي من كون
        // العقد تصريحياً (إعادة الإرسال ⇒ فرقٌ صفر ⇒ لا نصل هنا أصلاً).
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: Number(wo.branchId),
          cost: costDelta,
          amount: costDelta,
          createdBy: actor.userId,
          notes: `تعديل مواد أمر الشغل ${wo.orderNumber} — فرق تحويل إلى إنتاج تحت التشغيل`,
          // `signedPostingLines` لا `debitLine` مباشرةً: حذفُ مادةٍ يعطي فرقاً **سالباً**،
          // ومحرّك الترحيل يرفض مبلغاً سالباً على سطرٍ مباشر (أمسكه الاختبار) — العكس يُعبَّر
          // عنه بقلب الطرفين لا بإشارةٍ سالبة. نفس نمط عكس استحقاق الأمانة في `returnService`.
          postingIntent: createPostingIntent(
            "ADJUST_WIP_CONSUME",
            "ADJUST",
            signedPostingLines("WORK_IN_PROGRESS", "INVENTORY", costDelta),
            { roleDebits: { WORK_IN_PROGRESS: costDelta }, roleCredits: { INVENTORY: costDelta } },
          ),
          postingSourceComponents: { roleDebits: { WORK_IN_PROGRESS: costDelta }, roleCredits: { INVENTORY: costDelta } },
        });
      }
    }

    // ── إعادة كتابة الصفوف إلى القائمة المطلوبة ──
    // لقطة التكلفة تُحفظ للأصناف المستهلَكة فقط؛ ما لم يبدأ بعدُ يبقى "0" ويأخذ لقطته عند البدء
    // (`startWorkOrder` يكتبها) — فلا نُثبّت تكلفةً لمادةٍ لم تُستهلَك.
    await tx.delete(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, input.workOrderId));
    for (const vid of desiredIds) {
      await tx.insert(workOrderMaterials).values({
        workOrderId: input.workOrderId,
        variantId: vid,
        baseQuantity: desiredQty.get(vid)!,
        unitCost: consumed
          ? (snapshotCost.get(vid) ?? costMap.get(vid) ?? new Decimal(0)).toFixed(2)
          : "0",
      });
    }

    const newMaterialsCost = consumed
      ? round2(money(wo.materialsCost ?? "0").plus(costDelta))
      : round2(money(wo.materialsCost ?? "0"));
    await tx
      .update(workOrders)
      .set({
        ...(consumed ? { materialsCost: newMaterialsCost.toFixed(2) } : {}),
        // وسم التعديل — يغذّي التمييز البصريّ «مُعدَّلة» في الشاشات (طلب المالك ١٧/٨).
        // العدّاد يزيد ذرّياً في SQL (لا قراءة‑ثمّ‑كتابة) فلا يضيع تعديلٌ متزامن.
        materialsEditedAt: sql`NOW()`,
        materialsEditedBy: actor.userId,
        materialsEditCount: sql`${workOrders.materialsEditCount} + 1`,
      })
      .where(eq(workOrders.id, input.workOrderId));

    return {
      workOrderId: input.workOrderId,
      stockAdjusted: consumed,
      materialsCost: newMaterialsCost.toFixed(2),
      added, removed, changed,
    };
  });
}

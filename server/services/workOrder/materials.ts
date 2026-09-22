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
 *   · ترتيب القفل: `products` ثمّ `productVariants` ثمّ `branchStock`، تصاعدياً — منع deadlock مع
 *     الشراء/WAVG والبيع.
 *   · تجميع الكمية لكل صنف قبل الحركة (صفّان لنفس الصنف = حركةٌ واحدة).
 *   · بضاعة الأمانة مرفوضة مادةً (حصّة المودِع لا تُستهلك في إنتاجنا).
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import {
  workOrderMaterials,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { createPostingIntent, signedPostingLines } from "../accounting/postingEngine";
import { applyMovement, applyValuedInboundMovement } from "../inventoryService";
import { assertStockedOwnedMaterials } from "../inventory/materialEligibility";
import { postEntry } from "../ledgerService";
import { money, round2 } from "../money";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";
import type { WorkOrderMaterialInput } from "./types";
import { recordWorkOrderEvent } from "../workOrderEvents";
import type { ApprovedWorkOrderControl } from "./update";

/** نفس شكل مواد الإنشاء عمداً (`{variantId, baseQuantity}`) — عقدٌ واحد للإنشاء والتحرير. */
export type { WorkOrderMaterialInput } from "./types";

export interface SetWorkOrderMaterialsInput {
  workOrderId: number;
  expectedVersion?: number;
  reason?: string;
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

export async function setWorkOrderMaterialsInTx(
  tx: Tx,
  input: SetWorkOrderMaterialsInput,
  actor: Actor & { role?: string },
  control: ApprovedWorkOrderControl = {},
): Promise<SetWorkOrderMaterialsResult> {
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 3 || reason.length > 500) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب تعديل المواد مطلوب (3-500 محرف)" });
    }
    if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "نسخة أمر الشغل المتوقعة مطلوبة" });
    }
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
    if (Number(wo.version) !== Number(input.expectedVersion)) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر أمر الشغل منذ فتحه — حدّث الصفحة ثم أعد المحاولة" });
    }
    if (wo.invoiceId != null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "صدرت فاتورة لهذا الأمر — لا تعدّل المواد بعد الفوترة" });
    }
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
    if (consumed && control.approvedControlRequestId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "تعديل المواد بعد بدء التنفيذ يتطلب طلباً واعتماد مديرٍ آخر",
      });
    }

    const currentRows = await tx
      .select({
        id: workOrderMaterials.id,
        variantId: workOrderMaterials.variantId,
        baseQuantity: workOrderMaterials.baseQuantity,
        isBaseMaterial: workOrderMaterials.isBaseMaterial,
        unitCost: workOrderMaterials.unitCost,
      })
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

    // 0363 — الصنف الأساس المادي ليس سطراً اختيارياً في وصفة الأمر: هو البضاعة التي ستظهر
    // على فاتورة التسليم. حذفُه من المواد مع إبقائه في رأس الأمر كان يفوتر منتجاً بلا خصم مخزون.
    // اللقطة الثلاثية تميّز الخدمة من المادي؛ NULL على أمر تاريخي يعني أن الحقيقة غير موثوقة،
    // لذلك يفشل التحرير مغلقاً بدلاً من تخمين تصنيف اليوم أو أول وحدة حالية.
    const baseVariantId = wo.baseVariantId == null ? null : Number(wo.baseVariantId);
    const baseBaseQuantity = wo.baseBaseQuantity == null ? null : Number(wo.baseBaseQuantity);
    const markedBaseRows = currentRows.filter((row) => row.isBaseMaterial === true);
    if (baseVariantId != null && wo.baseConsumesInventory == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تعديل مواد أمر الشغل ${wo.orderNumber}`,
          why: "الأمر تاريخي ويحمل صنفاً أساسياً بلا لقطة موثوقة لوحدته وكمّيته وهل يستهلك مخزوناً؛ وتحرير مواده قد يحذف بضاعةً ستُفوتر بلا خصم",
          doThis: "أنشئ أمراً جديداً من الصنف والوحدة الصحيحين، أو نفّذ تصحيحاً إدارياً موثّقاً للأمر التاريخي قبل تعديل مواده",
        }),
      });
    }
    if (wo.baseConsumesInventory === true) {
      const marked = markedBaseRows[0];
      if (
        baseVariantId == null ||
        !Number.isInteger(baseBaseQuantity) ||
        Number(baseBaseQuantity) <= 0 ||
        markedBaseRows.length !== 1 ||
        Number(marked?.variantId ?? 0) !== baseVariantId ||
        Number(marked?.baseQuantity ?? 0) < Number(baseBaseQuantity)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر تعديل مواد أمر الشغل ${wo.orderNumber}`,
            why: "سطر الصنف الأساس المادي لا يطابق لقطة الإنشاء: يجب أن يوجد سطر حاكم واحد للصنف نفسه وبكمية لا تقل عن الحصة الأساسية",
            doThis: "أوقف التعديل واطلب من المدير تصحيح سلامة الأمر أولاً؛ لا تحذف السطر ولا تستبدله يدوياً",
          }),
        });
      }
      const desiredBaseQuantity = desiredQty.get(baseVariantId) ?? 0;
      if (desiredBaseQuantity < Number(baseBaseQuantity)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: `تعذّر حذف أو تخفيض الصنف الأساس من أمر الشغل ${wo.orderNumber}`,
            why: `الكمية الأساسية الملزمة ${baseBaseQuantity} وحدة أساس، والقائمة المعدّلة تُبقي ${desiredBaseQuantity} فقط؛ وهذا يفوتر الصنف الأساس من دون إخراجه كاملاً من المخزون`,
            doThis: `أبقِ الصنف رقم ${baseVariantId} بكمية لا تقل عن ${baseBaseQuantity}، وعدّل المواد الإضافية وحدها؛ ولتغيير الصنف الأساس أنشئ أمراً جديداً موثّق الوحدة`,
          }),
        });
      }
    } else if (markedBaseRows.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر تعديل مواد أمر الشغل ${wo.orderNumber}`,
          why: "الأمر مصنّف خدمةً بلا استهلاك للصنف الأساس، لكنه يحمل سطر مادة موسوماً كأساس مادي؛ الحالتان متناقضتان",
          doThis: "أوقف التعديل واطلب تصحيح الأمر قبل المتابعة كي لا يُخصم مخزون خدمة أو تُفوتر بضاعة بلا حركة",
        }),
      });
    }

    // التحرير يثبت أهلية كل مادة ستبقى بلا نقصان، حتى لو كان الطلب idempotent. أمّا مادةٌ
    // تُخفّض بعد الاستهلاك (جزئياً أو كلياً) فلا نمنع عكسها إن عُطّلت؛ نقفلها للحركة ونسمح
    // بالخمول فقط، ثم نتحقق أدناه أنها ما زالت مخزنية مملوكة كي يكون عكس الحركة وWIP حقيقياً.
    const desiredIds = Array.from(desiredQty.keys()).sort((a, b) => a - b);
    const reducedIds = consumed
      ? touchedIds.filter(
          (variantId) =>
            (desiredQty.get(variantId) ?? 0) < (currentQty.get(variantId) ?? 0),
        )
      : [];
    const materialInfo = await assertStockedOwnedMaterials(
      tx,
      consumed ? touchedIds : desiredIds,
      "مادة أمر الشغل",
      { allowInactiveVariantIds: reducedIds },
    );

    // ✅ idempotency طبيعيّة: نفس القائمة مرّتين ⇒ فرقٌ صفر ⇒ خروجٌ نظيف بلا حركةٍ ولا قيد.
    if (!hasDelta) {
      return {
        workOrderId: input.workOrderId,
        stockAdjusted: false,
        materialsCost: round2(money(wo.materialsCost ?? "0")).toFixed(2),
        added, removed, changed,
      };
    }

    const costMap = new Map<number, Decimal>(
      Array.from(materialInfo, ([id, material]) => [
        id,
        round2(money(material.costPrice)),
      ]),
    );
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
        const lineCostDelta = round2(unitCost.times(delta));
        costDelta = costDelta.plus(lineCostDelta);
        if (delta > 0) {
          await applyMovement(tx, {
            variantId: vid,
            branchId: Number(wo.branchId),
            baseQuantity: delta,
            movementType: "OUT",
            referenceType: "WORK_ORDER",
            referenceId: input.workOrderId,
            createdBy: actor.userId,
            // allowBackorder يخص البيع؛ زيادة مواد أمر بدأ يجب أن تحترم الرصيد
            // والحجوزات دائماً.
            respectProductBackorder: false,
            notes: `تعديل بنود أمر الشغل ${wo.orderNumber}`,
          });
        } else {
          // المادة المخفَّضة تعود بالقيمة التي خرجت بها عند البدء، لا بتكلفة اليوم.
          // الحركة والقيمة وWAVG تُحدَّث تحت mutex الصنف وكل أرصدته في primitive واحدة.
          await applyValuedInboundMovement(tx, {
            variantId: vid,
            branchId: Number(wo.branchId),
            baseQuantity: -delta,
            historicalValue: lineCostDelta.abs(),
            referenceType: "WORK_ORDER",
            referenceId: input.workOrderId,
            createdBy: actor.userId,
            notes: `تعديل بنود أمر الشغل ${wo.orderNumber}`,
          });
        }
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
        isBaseMaterial: wo.baseConsumesInventory === true && vid === baseVariantId,
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

    await recordWorkOrderEvent(tx, {
      workOrderId: input.workOrderId,
      eventType: "MATERIALS_UPDATED",
      payload: {
        added,
        removed,
        changed,
        stockAdjusted: consumed,
        materialsCost: newMaterialsCost.toFixed(2),
        reason,
        controlRequestId: control.approvedControlRequestId ?? null,
      },
      actorUserId: actor.userId,
      branchId: Number(wo.branchId),
      seq: control.approvedControlRequestId != null
        ? `control-${control.approvedControlRequestId}`
        : `v${Number(input.expectedVersion)}`,
    });

    return {
      workOrderId: input.workOrderId,
      stockAdjusted: consumed,
      materialsCost: newMaterialsCost.toFixed(2),
      added, removed, changed,
    };
}

export async function setWorkOrderMaterials(
  input: SetWorkOrderMaterialsInput,
  actor: Actor & { role?: string },
): Promise<SetWorkOrderMaterialsResult> {
  return withTx((tx) => setWorkOrderMaterialsInTx(tx, input, actor));
}

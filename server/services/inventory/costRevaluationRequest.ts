/**
 * إعادة تقييم تكلفة المخزون — المسار المحكوم لتصحيح `productVariants.costPrice`.
 *
 * ## لماذا وُجد هذا الملف
 *
 * `costPrice` مصدر الحقيقة الوحيد لثلاثة أشياء معاً: تقييم المخزون في الميزانية
 * (`SUM(quantity × costPrice)` حيّاً)، وتكلفة البضاعة المباعة (لقطةٌ منه لحظة البيع)،
 * وبوّابة البيع تحت التكلفة. وتعديلُه يدوياً على صنفٍ **له رصيد** يحرّك أصل المخزون فوراً
 * ⇒ تتحرّك حقوق الملكية (وهي الرصيد المُكمِّل) بلا سطرٍ مقابلٍ في قائمة الدخل ولا قيدٍ في
 * الدفتر ولا حارس إقفال فترة (تدقيق ٢٧/٧، البندان H3/H4).
 *
 * فأُغلق المسار اليدويّ إغلاقاً تامّاً في [`costRevaluation.ts`](../costRevaluation.ts)
 * — وهو الصواب، لكنّه ترك النظام **بلا أيّ طريقٍ** لتصحيح تكلفةٍ أُدخلت خطأً على صنفٍ قائم:
 * لا الاستلام يصلح (يخلق كمّيةً وذمّةَ مورّد)، ولا الجرد (يصحّح الكمّية لا التكلفة).
 * هذا الملف هو الطريق.
 *
 * ## العقد
 *
 * مستندٌ صريح لا تعديلٌ صامت: **غرضٌ محاسبيّ** يحدّد الحساب المقابل + **سببٌ مكتوب** +
 * **لقطة كميّات** لحظة الطلب. يعتمده مديرٌ ثانٍ (فصل المهام، مرآة `adjustmentApproval.ts`)،
 * وعند الاعتماد فقط:
 *   ١) تُحدَّث التكلفة، و٢) يُرحَّل قيد `ADJUST` بقيمة `Δالتكلفة × الكمية` **لكل فرعٍ** له رصيد.
 *
 * ومن (٢) يأتي حارس الفترة مجّاناً: `postEntry` يستدعي `assertPeriodOpen` ⇒ لا إعادة تقييمٍ
 * في فترةٍ مقفلة، وهو ما كان غائباً عن كل مسارات التكلفة (H5).
 *
 * ⚠️ **التكلفة عمودٌ على المتغيّر لا على الفرع** — إعادة تقييمها تمسّ رصيد **كل** الفروع.
 * لذلك لا يطلبها مديرُ فرعٍ إلّا إن كان الرصيد محصوراً في فرعه (`assertBranchAuthority`).
 */
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import { costRevaluationApprovalTrigger } from "@shared/approvalTriggers";
import { appErrorMessage } from "@shared/errors";
import { variantDescriptor } from "@shared/variantDisplay";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  branches,
  costRevaluationRequests,
  costUpdateWaveItems,
  costUpdateWaves,
  productVariants,
  products,
  users,
} from "../../../drizzle/schema";
import { canCrossBranches } from "../../lib/branchAuthority";
import { extractInsertId } from "../../lib/insertId";
import { isBundleVariant, isServiceVariant } from "../inventoryService";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import {
  loadBranchQuantitySnapshot,
  lockAndCheckCostRevaluationSnapshot,
  parseBranchQuantitySnapshot,
  postLockedCostRevaluation,
  totalBranchQuantity,
  type BranchQuantitySnapshot,
  type CostRevaluationPurpose,
} from "./costRevaluationPosting";

export type { BranchQuantitySnapshot, CostRevaluationPurpose } from "./costRevaluationPosting";

/** أقلّ طول سببٍ مقبول — نفس عتبة حارس السبب في `catalogRouter.assertCostChangeReasonOrThrow`. */
const MIN_REASON_LENGTH = 10;

export interface RequestCostRevaluationInput {
  variantId: number;
  newCost: string;
  purpose: CostRevaluationPurpose;
  reason: string;
}

export interface RequestCostRevaluationResult {
  requestId: number;
  oldCost: string;
  newCost: string;
  expectedQuantity: number;
  expectedValueDelta: string;
}

export interface ApproveCostRevaluationResult {
  requestId: number;
  variantId: number;
  oldCost: string;
  newCost: string;
  /** عدد قيود ADJUST المُرحَّلة — واحدٌ لكل فرعٍ له رصيد (صفرٌ إن لا رصيد لأحد). */
  postedEntries: number;
  totalValueDelta: string;
}

/**
 * الطلب نفسه مستندٌ فرعيّ حتى عندما تكون لقطة المخزون صفرية. لا تكفي سلطة صفوف
 * `branchStock`: قد لا توجد صفوف أصلاً، وعندها يجب أن يبقى القرار في فرع المنشئ.
 */
function assertRequestBranchAuthority(
  requestBranchId: number,
  actor: Actor & { isOwner?: boolean | null },
  verb: string,
): void {
  if (canCrossBranches(actor)) return;
  if (Number(actor.branchId) !== Number(requestBranchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر ${verb} طلب إعادة التقييم`,
        why: `الطلب تابعٌ لفرعٍ آخر (${requestBranchId}) لا فرعك (${actor.branchId ?? "غير محدَّد"})، ومدير الفرع محظور من العبور بين الفروع`,
        doThis: `افتح الطلب من فرعه الأصليّ، أو اطلب من المالك ${verb}ه من نفس الشاشة`,
      }),
    });
  }
}

/** يُنشئ طلب إعادة تقييمٍ معلَّقاً — **بلا تغيير تكلفةٍ ولا قيد** حتى الاعتماد. */
export async function requestCostRevaluation(
  input: RequestCostRevaluationInput,
  actor: Actor & { isOwner?: boolean | null },
): Promise<RequestCostRevaluationResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب إعادة التقييم",
        why: `سبب إعادة التقييم إلزاميّ (${MIN_REASON_LENGTH} محارف على الأقلّ)، والقيمة المُرسَلة ${reason.length} محرفاً؛ هو المستند الوحيد لحركة قيمةٍ بلا نقد`,
        doThis: "اكتب سبباً واضحاً في «سبب إعادة التقييم» (فاتورةُ خطأ، هبوطٌ سوقيّ، تصحيحُ تكلفةٍ قديمة…) ثمّ أعد الحفظ",
      }),
    });
  }
  const newCost = round2(money(input.newCost));
  if (newCost.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر فتح طلب إعادة التقييم",
        why: `التكلفة الجديدة يجب ألّا تكون سالبة، والقيمة المُرسَلة ${newCost.toString()}`,
        doThis: "أدخل تكلفةً موجبة أو صفراً في «التكلفة الجديدة» ثمّ أعد الحفظ",
      }),
    });
  }

  const result = await withTx(async (tx) => {
    const v = (
      await tx
        .select({
          id: productVariants.id,
          costPrice: productVariants.costPrice,
          sku: productVariants.sku,
          isConsignment: products.isConsignment,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, input.variantId))
        .for("update")
        .limit(1)
    )[0];
    if (!v) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: `المتغيّر رقم ${input.variantId} غير موجود أو أُزيل`,
          doThis: "اختر صنفاً/متغيّراً موجوداً من قائمة المنتجات",
        }),
      });
    }

    // بضاعة الأمانة ليست أصلاً لدينا (مستبعدةٌ من أصل المخزون) ⇒ «حصّة المودِع» ليست إعادة تقييم.
    if (v.isConsignment) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: "الصنف بضاعة الأمانة، وبضاعة الأمانة مستبعدةٌ من أصل المخزون فلا تُعاد تقييمُها",
          doThis: "عدِّل حصّة المودِع من شاشة «سندات الأمانة» أو «الجرد الدوري للأمانة»",
        }),
      });
    }
    // مرآة حرّاس تسوية المخزون: لا نُنشئ طلباً يستحيل اعتماده.
    if (await isBundleVariant(tx, input.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: "الصنف بكج (مركّب)، وتكلفته مشتقّةٌ من مكوّناته لا مخزَّنة",
          doThis: "افتح طلب إعادة التقييم على المكوّن الذي تغيّرت تكلفته، وطاقة البكج تُشتقّ منه تلقائياً",
        }),
      });
    }
    if (await isServiceVariant(tx, input.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: "الصنف خدميّ (بلا مخزون)، فلا قيمةَ مخزنيّةً تُعاد تقييمها",
          doThis: "استعمل هذه الشاشة للأصناف المخزنية فقط، وللأصناف الخدميّة عدّل السعر/التكلفة من «تعديل المنتج»",
        }),
      });
    }

    const oldCost = round2(money(v.costPrice ?? "0"));
    if (newCost.equals(oldCost)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: `التكلفة الجديدة (${newCost.toFixed(2)}) تساوي الحالية — لا شيء يُعاد تقييمه`,
          doThis: "أدخل تكلفةً مختلفة عن الحاليّة، أو ألغِ الطلب إن لم تكن التكلفة تحتاج تعديلاً",
        }),
      });
    }
    // هبوط القيمة نزولٌ بحكم تعريفه؛ الصعود بحجّة الهبوط يخلق ربحاً بحسابٍ مقابلٍ خاطئ.
    if (input.purpose === "IMPAIRMENT" && newCost.gt(oldCost)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: `هبوط القيمة لا يرفع التكلفة: القيمة الجديدة (${newCost.toFixed(2)}) أعلى من الحاليّة (${oldCost.toFixed(2)})؛ رفعُها بحجّة الهبوط يخلق ربحاً بحسابٍ مقابلٍ خاطئ`,
          doThis: "غيّر الغرض إلى «تصحيح تكلفة خاطئة» إن كان الرفع مقصوداً، أو خفّض التكلفة إن كان هبوطاً حقيقياً",
        }),
      });
    }

    const rows = await loadBranchQuantitySnapshot(tx, input.variantId);
    if (
      !canCrossBranches(actor) &&
      rows.some((row) => Number(row.branchId) !== Number(actor.branchId))
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر طلب إعادة تقييم التكلفة",
          why: "التكلفة عامّة ولهذا الصنف رصيدٌ في فرعٍ آخر",
          doThis: "اطلب من الإدارة العامة فتح طلب إعادة التقييم",
        }),
      });
    }

    const quantity = totalBranchQuantity(rows);
    const valueDelta = round2(newCost.minus(oldCost).times(quantity));

    // طلبٌ معلَّقٌ واحدٌ لكل متغيّر: طلبان معلَّقان يحسبان أثرهما من نفس التكلفة القديمة، فاعتمادُ
    // الثاني بعد الأوّل يُرحّل فرقاً محسوباً على أساسٍ زال. (الاعتماد يرفضه أيضاً بفحص الانحراف،
    // لكن المنع عند الطلب أوضح للمستخدم من رفضٍ متأخّر.)
    const openOne = (
      await tx
        .select({ id: costRevaluationRequests.id })
        .from(costRevaluationRequests)
        .where(
          and(
            eq(costRevaluationRequests.variantId, input.variantId),
            eq(costRevaluationRequests.status, "PENDING_APPROVAL"),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (openOne) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: `لهذا الصنف طلب إعادة تقييمٍ معلَّق (#${openOne.id})؛ فتحُ ثانٍ يجعل الطلبين يحسبان أثرهما من نفس التكلفة القديمة، فيُرحَّل عند اعتماد الثاني فرقٌ محسوب على أساسٍ زال`,
          doThis: `افتح شاشة «طلبات إعادة تقييم التكلفة»، احسم الطلب #${openOne.id} (اعتماداً أو رفضاً) ثمّ أعد فتح طلبك`,
        }),
      });
    }

    const openWave = (
      await tx
        .select({ id: costUpdateWaves.id })
        .from(costUpdateWaveItems)
        .innerJoin(
          costUpdateWaves,
          eq(costUpdateWaves.id, costUpdateWaveItems.waveId),
        )
        .where(
          and(
            eq(costUpdateWaveItems.variantId, input.variantId),
            eq(costUpdateWaves.status, "PENDING_APPROVAL"),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (openWave) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر فتح طلب إعادة التقييم",
          why: `الصنف مشمول في موجة تكلفة معلقة (#${openWave.id})؛ فتح طلب فردي موازٍ يجعل مستندين يتنافسان على التكلفة نفسها`,
          doThis: `احسم موجة التكلفة #${openWave.id} أولاً، ثم أنشئ طلباً جديداً إن بقي التصحيح مطلوباً`,
        }),
      });
    }

    const res = await tx.insert(costRevaluationRequests).values({
      variantId: input.variantId,
      branchId: Number(actor.branchId ?? rows[0]?.branchId ?? 1),
      oldCost: toDbMoney(oldCost),
      newCost: toDbMoney(newCost),
      purpose: input.purpose,
      reason,
      expectedQuantity: quantity,
      branchQuantities: rows,
      expectedValueDelta: toDbMoney(valueDelta),
      status: "PENDING_APPROVAL",
      createdBy: actor.userId,
    });

    return {
      requestId: extractInsertId(res),
      oldCost: oldCost.toFixed(2),
      newCost: newCost.toFixed(2),
      expectedQuantity: quantity,
      expectedValueDelta: valueDelta.toFixed(2),
    };
  });
  await autoDecideForActiveOwner(actor, {
    kind: "inventory.costRevaluation.approve",
    id: result.requestId,
    reason,
  });
  return result;
}

/** يفرض فصل المهام (المُعتمِد ≠ المُنشئ إلّا admin) — مرآة `adjustmentApproval.assertApprover`. */
function assertIndependentInventoryReviewer(createdBy: number | null, actor: Actor, verb: string): void {
  if (actor.role !== "admin" && createdBy != null && Number(createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر ${verb} إعادة التقييم`,
        why: `أنت من طلبتها بنفسك، وفصل المهام يمنعك من ${verb} إعادة تقييمٍ فتحتها بنفسك`,
        doThis: `اطلب من مديرٍ آخر أو من المالك ${verb} الطلب من شاشة «طلبات إعادة تقييم التكلفة»`,
      }),
    });
  }
}

/**
 * يعتمد طلباً معلَّقاً: يحدّث التكلفة ويُرحّل قيد `ADJUST` لكل فرعٍ له رصيد.
 *
 * الترتيب مقصود — `productVariants` هو mutex الحاكم ثمّ `branchStock`، مطابقاً لكل
 * حركة/WAVG؛ فلا تتجزّأ أقفال الفروع قبل حسم ملكية الصنف.
 */
export async function approveCostRevaluation(
  id: number,
  actor: Actor & { isOwner?: boolean | null },
): Promise<ApproveCostRevaluationResult> {
  return withTx(async (tx) => {
    const r = (
      await tx
        .select()
        .from(costRevaluationRequests)
        .where(eq(costRevaluationRequests.id, id))
        .for("update")
        .limit(1)
    )[0];
    if (!r) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why: `طلب إعادة التقييم رقم ${id} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «طلبات إعادة تقييم التكلفة» واختر طلباً قائماً من القائمة الحاليّة",
        }),
      });
    }
    assertRequestBranchAuthority(Number(r.branchId), actor, "اعتماد");
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why: `الطلب ليس في انتظار الموافقة — حالته الحاليّة ${r.status}`,
          doThis: "حدّث شاشة «طلبات إعادة تقييم التكلفة» لترى القرار الحاليّ",
        }),
      });
    }
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: costRevaluationApprovalTrigger("APPROVE"),
      subject: `إعادة تقييم تكلفة (طلب ${id})`,
      legacy: () =>
        assertIndependentInventoryReviewer(r.createdBy != null ? Number(r.createdBy) : null, actor, "اعتماد"),
    });

    const variantId = Number(r.variantId);
    const checked = await lockAndCheckCostRevaluationSnapshot(tx, {
      variantId,
      expectedOldCost: money(r.oldCost).toFixed(2),
      expectedBranchQuantities: parseBranchQuantitySnapshot(r.branchQuantities),
      actor,
      authorityVerb: "اعتماد",
    });
    if (!checked.ok) {
      const why =
        checked.reason === "COST_DRIFT"
          ? `تغيّرت تكلفة الصنف منذ الطلب (كانت ${money(r.oldCost).toFixed(2)}، الآن ${checked.actual?.cost ?? "غير متاحة"})`
          : checked.reason === "QUANTITY_DRIFT"
            ? `تغيّرت كميّات الصنف منذ الطلب (كانت ${totalBranchQuantity(parseBranchQuantitySnapshot(r.branchQuantities))}، الآن ${totalBranchQuantity(checked.actual?.branchQuantities ?? [])})`
            : checked.message;
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why,
          doThis: "ارفض الطلب وافتح طلباً جديداً على التكلفة والأرصدة الحالية",
        }),
      });
    }

    const posted = await postLockedCostRevaluation(tx, checked.target, {
      newCost: money(r.newCost).toFixed(2),
      purpose: r.purpose as CostRevaluationPurpose,
      reason: r.reason,
      actor,
      requestedBy: r.createdBy != null ? Number(r.createdBy) : null,
      sourceType: "REQUEST",
      sourceId: id,
    });

    await tx
      .update(costRevaluationRequests)
      .set({ status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() })
      .where(eq(costRevaluationRequests.id, id));

    return {
      requestId: id,
      variantId,
      oldCost: checked.target.oldCost.toFixed(2),
      newCost: money(r.newCost).toFixed(2),
      postedEntries: posted.postedEntries,
      totalValueDelta: posted.totalValueDelta,
    };
  });
}

/** يرفض طلباً معلَّقاً — بلا أيّ أثرٍ على التكلفة أو الدفتر. */
export async function rejectCostRevaluation(
  id: number,
  actor: Actor,
  reason?: string | null,
): Promise<{ requestId: number }> {
  return withTx(async (tx) => {
    const r = (
      await tx
        .select({
          id: costRevaluationRequests.id,
          branchId: costRevaluationRequests.branchId,
          status: costRevaluationRequests.status,
          createdBy: costRevaluationRequests.createdBy,
        })
        .from(costRevaluationRequests)
        .where(eq(costRevaluationRequests.id, id))
        .for("update")
        .limit(1)
    )[0];
    if (!r) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر رفض إعادة التقييم",
          why: `طلب إعادة التقييم رقم ${id} غير موجود أو أُزيل`,
          doThis: "افتح شاشة «طلبات إعادة تقييم التكلفة» واختر طلباً قائماً من القائمة الحاليّة",
        }),
      });
    }
    assertRequestBranchAuthority(Number(r.branchId), actor, "رفض");
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر رفض إعادة التقييم",
          why: `الطلب ليس في انتظار الموافقة — حالته الحاليّة ${r.status}`,
          doThis: "حدّث شاشة «طلبات إعادة تقييم التكلفة» لترى القرار الحاليّ",
        }),
      });
    }
    assertIndependentInventoryReviewer(r.createdBy != null ? Number(r.createdBy) : null, actor, "رفض");
    await tx
      .update(costRevaluationRequests)
      .set({ status: "REJECTED", approvedBy: actor.userId, approvedAt: new Date(), rejectionReason: reason?.trim() || null })
      .where(eq(costRevaluationRequests.id, id));
    return { requestId: id };
  });
}

export interface CostRevaluationRow {
  id: number;
  variantId: number;
  variantLabel: string;
  productName: string;
  branchId: number;
  branchName: string | null;
  oldCost: string;
  newCost: string;
  purpose: CostRevaluationPurpose;
  reason: string;
  expectedQuantity: number;
  expectedValueDelta: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  createdBy: number;
  createdByName: string | null;
  approvedBy: number | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
}

/**
 * سجلّ إعادة التقييم — تقرير الشريحة (المبدأ الماليّ §٥: كل حركةِ قيمةٍ يلزمها تقريرٌ يُظهرها
 * مربوطةً بمستندها وفاعلها). `scopedBranchId` يأتي من الراوتر: مدير الفرع يرى طلبات فرعه.
 */
export async function listCostRevaluations(
  /** `order: "ASC"` = الأقدم أوّلاً لصندوق القرارات — القصّ بالأحدث يُسقط أكثر الطلبات تأخّراً. */
  filter: { status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED"; branchId?: number | null; limit?: number; order?: "ASC" | "DESC" },
  _actor: Actor,
): Promise<CostRevaluationRow[]> {
  return withTx(async (tx) => {
    const conds = [];
    if (filter.status) conds.push(eq(costRevaluationRequests.status, filter.status));
    if (filter.branchId != null) conds.push(eq(costRevaluationRequests.branchId, filter.branchId));
    const rows = await tx
      .select({
        id: costRevaluationRequests.id,
        variantId: costRevaluationRequests.variantId,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        color: productVariants.color,
        size: productVariants.size,
        variantKind: productVariants.variantKind,
        productName: products.name,
        branchId: costRevaluationRequests.branchId,
        branchName: branches.name,
        oldCost: costRevaluationRequests.oldCost,
        newCost: costRevaluationRequests.newCost,
        purpose: costRevaluationRequests.purpose,
        reason: costRevaluationRequests.reason,
        expectedQuantity: costRevaluationRequests.expectedQuantity,
        expectedValueDelta: costRevaluationRequests.expectedValueDelta,
        status: costRevaluationRequests.status,
        createdBy: costRevaluationRequests.createdBy,
        createdByName: users.name,
        approvedBy: costRevaluationRequests.approvedBy,
        approvedAt: costRevaluationRequests.approvedAt,
        rejectionReason: costRevaluationRequests.rejectionReason,
        createdAt: costRevaluationRequests.createdAt,
      })
      .from(costRevaluationRequests)
      .innerJoin(productVariants, eq(productVariants.id, costRevaluationRequests.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(branches, eq(branches.id, costRevaluationRequests.branchId))
      .leftJoin(users, eq(users.id, costRevaluationRequests.createdBy))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(filter.order === "ASC" ? asc(costRevaluationRequests.id) : desc(costRevaluationRequests.id))
      .limit(Math.min(Math.max(filter.limit ?? 100, 1), 200));

    return rows.map((r) => ({
      id: Number(r.id),
      variantId: Number(r.variantId),
      variantLabel: variantDescriptor(r) || r.sku || `#${r.variantId}`,
      productName: r.productName ?? "",
      branchId: Number(r.branchId),
      branchName: r.branchName ?? null,
      oldCost: money(r.oldCost ?? 0).toFixed(2),
      newCost: money(r.newCost ?? 0).toFixed(2),
      purpose: r.purpose as CostRevaluationPurpose,
      reason: r.reason ?? "",
      expectedQuantity: Number(r.expectedQuantity ?? 0),
      expectedValueDelta: money(r.expectedValueDelta ?? 0).toFixed(2),
      status: r.status as "PENDING_APPROVAL" | "APPROVED" | "REJECTED",
      createdBy: Number(r.createdBy),
      createdByName: r.createdByName ?? null,
      approvedBy: r.approvedBy != null ? Number(r.approvedBy) : null,
      approvedAt: r.approvedAt ?? null,
      rejectionReason: r.rejectionReason ?? null,
      createdAt: r.createdAt,
    }));
  });
}

/** يقرأ حالة صنفٍ قبل الطلب: التكلفة الحالية وكميّاته لكل فرع — تُعرَض في نموذج الطلب. */
export async function getCostRevaluationPreview(
  variantId: number,
  actor: Actor & { isOwner?: boolean | null },
): Promise<{
  variantId: number;
  costPrice: string;
  isConsignment: boolean;
  branches: Array<{ branchId: number; branchName: string | null; quantity: number }>;
  totalQuantity: number;
}> {
  return withTx(async (tx) => {
    const v = (
      await tx
        .select({ costPrice: productVariants.costPrice, isConsignment: products.isConsignment })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, variantId))
        .limit(1)
    )[0];
    if (!v) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّرت قراءة معاينة التكلفة",
          why: `المتغيّر رقم ${variantId} غير موجود أو أُزيل`,
          doThis: "اختر صنفاً/متغيّراً موجوداً من قائمة المنتجات",
        }),
      });
    }
    const allRows = await loadBranchQuantitySnapshot(tx, variantId);
    const rows = canCrossBranches(actor)
      ? allRows
      : allRows.filter((r) => Number(r.branchId) === Number(actor.branchId));
    const names = rows.length
      ? await tx
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(inArray(branches.id, rows.map((r) => r.branchId)))
      : [];
    const nameOf = new Map(names.map((b) => [Number(b.id), b.name as string | null]));
    return {
      variantId,
      costPrice: money(v.costPrice ?? 0).toFixed(2),
      isConsignment: !!v.isConsignment,
      branches: rows.map((r) => ({ branchId: r.branchId, branchName: nameOf.get(r.branchId) ?? null, quantity: r.quantity })),
      totalQuantity: totalBranchQuantity(rows),
    };
  });
}

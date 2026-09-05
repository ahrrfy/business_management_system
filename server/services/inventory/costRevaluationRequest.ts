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
import { costRevaluationApprovalTrigger } from "@shared/approvalTriggers";
import { appErrorMessage } from "@shared/errors";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  branchStock,
  branches,
  costRevaluationRequests,
  productVariants,
  products,
  users,
} from "../../../drizzle/schema";
import { canCrossBranches } from "../../lib/branchAuthority";
import { extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { isBundleVariant, isServiceVariant } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";

export type CostRevaluationPurpose = "CORRECTION" | "IMPAIRMENT";

/** أقلّ طول سببٍ مقبول — نفس عتبة حارس السبب في `catalogRouter.assertCostChangeReasonOrThrow`. */
const MIN_REASON_LENGTH = 10;

export interface BranchQuantitySnapshot {
  branchId: number;
  quantity: number;
}

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
 * لقطة الكمية المملوكة لكل فرع. تُقرأ مقفولةً عند الاعتماد كي لا تتحرّك بين حساب القيمة
 * وترحيل القيد. تُستثنى الأصفار: لا قيمة لها في القيد ولا في المقارنة.
 */
async function loadBranchQuantities(
  tx: Parameters<typeof postEntry>[0],
  variantId: number,
  lock: boolean,
): Promise<BranchQuantitySnapshot[]> {
  const base = tx
    .select({ branchId: branchStock.branchId, quantity: branchStock.quantity })
    .from(branchStock)
    .where(eq(branchStock.variantId, variantId));
  const rows = lock ? await base.for("update") : await base;
  return rows
    .map((r) => ({ branchId: Number(r.branchId), quantity: Number(r.quantity ?? 0) }))
    .filter((r) => r.quantity !== 0)
    .sort((a, b) => a.branchId - b.branchId);
}

function totalOf(rows: BranchQuantitySnapshot[]): number {
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

function sameSnapshot(a: BranchQuantitySnapshot[], b: BranchQuantitySnapshot[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.branchId === b[i].branchId && row.quantity === b[i].quantity);
}

function parseSnapshot(raw: unknown): BranchQuantitySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({
      branchId: Number((r as BranchQuantitySnapshot)?.branchId),
      quantity: Number((r as BranchQuantitySnapshot)?.quantity),
    }))
    .filter((r) => Number.isFinite(r.branchId) && Number.isFinite(r.quantity))
    .sort((a, b) => a.branchId - b.branchId);
}

/**
 * التكلفة عامّةٌ لكل الفروع ⇒ إعادة تقييمها تمسّ أصل كل فرعٍ له رصيد. مديرُ الفرع (لا يعبُر
 * الفروع بقرار المالك) لا يطلبها ولا يعتمدها إلّا إن كان الرصيد كلُّه في فرعه — وإلّا لكتب
 * على ميزانية فرعٍ آخر من حيث لا يراه أحد.
 */
function assertBranchAuthority(
  rows: BranchQuantitySnapshot[],
  actor: Actor & { isOwner?: boolean | null },
  verb: string,
): void {
  if (canCrossBranches(actor)) return;
  const foreign = rows.filter((r) => Number(r.branchId) !== Number(actor.branchId));
  if (foreign.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر ${verb} إعادة تقييم التكلفة`,
        why: `التكلفة عامّة لكل الفروع، ولهذا الصنف رصيدٌ في فرعٍ آخر (${foreign.map((f) => f.branchId).join("، ")}) لا فرعك (${actor.branchId ?? "غير محدَّد"})، وإعادة تقييمه هنا تُحرّك ميزانية فرعٍ لا تراه`,
        doThis: "اطلب من المالك أو من مديرٍ يعبر الفروع اعتماد الطلب من شاشة «طلبات إعادة تقييم التكلفة»",
      }),
    });
  }
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

  return withTx(async (tx) => {
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

    const rows = await loadBranchQuantities(tx, input.variantId, false);
    assertBranchAuthority(rows, actor, "طلب");

    const quantity = totalOf(rows);
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
    const variant = (
      await tx
        .select({
          costPrice: productVariants.costPrice,
          isConsignment: products.isConsignment,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(productVariants.id, variantId))
        .for("update")
        .limit(1)
    )[0];
    if (!variant) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why: `المتغيّر رقم ${variantId} غير موجود أو أُزيل بعد إنشاء الطلب`,
          doThis: "ارفض الطلب مع سببٍ صريح من نفس الشاشة",
        }),
      });
    }
    if (variant.isConsignment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why: "صار الصنف بضاعة أمانة بعد إنشاء الطلب، وبضاعة الأمانة مستبعدةٌ من أصل المخزون",
          doThis: "ارفض الطلب من نفس الشاشة، وعدِّل حصّة المودِع من «سندات الأمانة» أو «الجرد الدوري للأمانة»",
        }),
      });
    }
    const liveRows = await loadBranchQuantities(tx, variantId, true);
    assertBranchAuthority(liveRows, actor, "اعتماد");

    // انحراف التكلفة: قيمة القيد تُحسب من الفرق، فلو تحرّكت التكلفة منذ الطلب (استلامٌ غيّر WAVG
    // مثلاً) لرحّلنا فرقاً محسوباً على أساسٍ زال — والنتيجة تكلفةٌ نهائية صحيحة بقيدٍ خاطئ.
    const liveCost = round2(money(variant.costPrice ?? "0"));
    const snapCost = round2(money(r.oldCost));
    if (!liveCost.equals(snapCost)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why: `تغيّرت تكلفة الصنف منذ الطلب (كانت ${snapCost.toFixed(2)}، الآن ${liveCost.toFixed(2)})؛ اعتمادُه يُرحّل فرقاً محسوباً على أساسٍ زال`,
          doThis: "ارفض الطلب وافتح طلباً جديداً على التكلفة الحاليّة من نفس الشاشة",
        }),
      });
    }
    // انحراف الكمّية: نفس السبب — الأثر = Δالتكلفة × الكمية.
    const snapRows = parseSnapshot(r.branchQuantities);
    if (!sameSnapshot(snapRows, liveRows)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد إعادة التقييم",
          why: `تغيّرت كميّات الصنف منذ الطلب (كانت ${totalOf(snapRows)}، الآن ${totalOf(liveRows)})؛ الأثر = Δالتكلفة × الكمية، ومع تغيّر الكميّة يصير القيد كاذباً`,
          doThis: "ارفض الطلب وافتح طلباً جديداً بالأرصدة الحاليّة من نفس الشاشة",
        }),
      });
    }

    const newCost = round2(money(r.newCost));
    const perUnitDelta = round2(newCost.minus(liveCost));

    await tx
      .update(productVariants)
      .set({ costPrice: toDbMoney(newCost) })
      .where(eq(productVariants.id, variantId));

    // أثرٌ مُدقَّقٌ مُهيكَل على حقلٍ ماليٍّ حسّاس — داخل المعاملة فيرتدّ التعديل إن فشل السجلّ.
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId ?? null,
      action: "product.costRevaluation",
      entityType: "productVariant",
      entityId: String(variantId),
      oldValue: { costPrice: liveCost.toFixed(2) },
      newValue: {
        costPrice: newCost.toFixed(2),
        purpose: r.purpose,
        reason: r.reason,
        requestId: id,
        requestedBy: r.createdBy != null ? Number(r.createdBy) : null,
      },
    });

    // قيدٌ لكل فرعٍ له رصيد: أصل المخزون يُقرأ لكل فرعٍ على حدة، فقيدٌ واحدٌ بالمجموع كان يُحمّل
    // فرعَ المُعتمِد أثرَ فروعٍ أخرى. صفر رصيدٍ ⇒ صفر قيد (تصحيح تكلفةٍ لصنفٍ نفد لا يمسّ أصلاً).
    let postedEntries = 0;
    let totalDelta = new Decimal(0);
    for (const row of liveRows) {
      const delta = round2(perUnitDelta.times(row.quantity));
      if (delta.isZero()) continue;
      const gain = delta.isPositive();
      const abs = delta.abs();
      const postingSourceComponents = gain
        ? { roleDebits: { INVENTORY: abs }, roleCredits: { OTHER_REVENUE: abs } }
        : { roleDebits: { LOSSES: abs }, roleCredits: { INVENTORY: abs } };
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: row.branchId,
        // مرآة تسوية المخزون: cost سالبٌ للربح (تكلفةٌ تنخفض) وprofit موقَّعٌ بالاتجاه، وamount صفر (بلا نقد).
        cost: delta.neg(),
        profit: delta,
        amount: money(0),
        dedupeKey: `COST_REVAL:${id}:${row.branchId}`,
        notes: `إعادة تقييم تكلفة (طلب #${id}، ${r.purpose === "IMPAIRMENT" ? "هبوط قيمة" : "تصحيح تكلفة"}) — ${r.reason}`,
        postingIntent: gain
          ? createPostingIntent(
            "ADJUST_INVENTORY_GAIN",
            "ADJUST",
            [debitLine("INVENTORY", abs), creditLine("OTHER_REVENUE", abs)],
            { roleDebits: { INVENTORY: abs }, roleCredits: { OTHER_REVENUE: abs } },
          )
          : createPostingIntent(
            "ADJUST_INVENTORY_LOSS",
            "ADJUST",
            [debitLine("LOSSES", abs), creditLine("INVENTORY", abs)],
            { roleDebits: { LOSSES: abs }, roleCredits: { INVENTORY: abs } },
          ),
        postingSourceComponents,
      });
      postedEntries += 1;
      totalDelta = totalDelta.plus(delta);
    }

    await tx
      .update(costRevaluationRequests)
      .set({ status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() })
      .where(eq(costRevaluationRequests.id, id));

    return {
      requestId: id,
      variantId,
      oldCost: liveCost.toFixed(2),
      newCost: newCost.toFixed(2),
      postedEntries,
      totalValueDelta: round2(totalDelta).toFixed(2),
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
        color: productVariants.color,
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
      variantLabel: r.color || r.sku || `#${r.variantId}`,
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
    const allRows = await loadBranchQuantities(tx, variantId, false);
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
      totalQuantity: totalOf(rows),
    };
  });
}

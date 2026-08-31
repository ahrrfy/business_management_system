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
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  branches,
  costRevaluationRequests,
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
  assertCostRevaluationBranchAuthority,
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
      message: `لا يمكن ${verb} طلب إعادة تقييم تابعٍ لفرعٍ آخر.`,
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
      message: `سبب إعادة التقييم إلزاميّ (${MIN_REASON_LENGTH} محارف على الأقلّ) — هو المستند الوحيد لحركة قيمةٍ بلا نقد.`,
    });
  }
  const newCost = round2(money(input.newCost));
  if (newCost.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "التكلفة الجديدة لا تكون سالبة" });
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
        .for("update")
        .limit(1)
    )[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });

    // بضاعة الأمانة ليست أصلاً لدينا (مستبعدةٌ من أصل المخزون) ⇒ «حصّة المودِع» ليست إعادة تقييم.
    if (v.isConsignment) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "بضاعة الأمانة لا تُعاد تقييمها — حصّة المودِع تُعدَّل من مسار الأمانة نفسه",
      });
    }
    // مرآة حرّاس تسوية المخزون: لا نُنشئ طلباً يستحيل اعتماده.
    if (await isBundleVariant(tx, input.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "تكلفة البكج مشتقّةٌ من مكوّناته لا مخزَّنةً — أعد تقييم المكوّن نفسه",
      });
    }
    if (await isServiceVariant(tx, input.variantId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المنتج الخِدميّ لا مخزون له — لا قيمة تُعاد تقييمها",
      });
    }

    const oldCost = round2(money(v.costPrice ?? "0"));
    if (newCost.equals(oldCost)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "التكلفة الجديدة تساوي الحالية — لا شيء يُعاد تقييمه" });
    }
    // هبوط القيمة نزولٌ بحكم تعريفه؛ الصعود بحجّة الهبوط يخلق ربحاً بحسابٍ مقابلٍ خاطئ.
    if (input.purpose === "IMPAIRMENT" && newCost.gt(oldCost)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "هبوط القيمة لا يرفع التكلفة — استعمل «تصحيح تكلفة خاطئة» إن كان رفعاً مقصوداً",
      });
    }

    const rows = await loadBranchQuantitySnapshot(tx, input.variantId, false);
    assertCostRevaluationBranchAuthority(rows, actor, "طلب");

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
        .limit(1)
    )[0];
    if (openOne) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `لهذا الصنف طلب إعادة تقييمٍ معلَّق (#${openOne.id}) — احسمه أوّلاً`,
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
function assertApprover(createdBy: number | null, actor: Actor, verb: string): void {
  if (actor.role !== "admin" && createdBy != null && Number(createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `لا يجوز ${verb} إعادة تقييمٍ طلبتها بنفسك — يلزم مديرٌ آخر (فصل المهام).`,
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
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "طلب إعادة التقييم غير موجود" });
    assertRequestBranchAuthority(Number(r.branchId), actor, "اعتماد");
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب إعادة التقييم ليس في انتظار الموافقة" });
    }
    assertApprover(r.createdBy != null ? Number(r.createdBy) : null, actor, "اعتماد");

    const variantId = Number(r.variantId);
    const checked = await lockAndCheckCostRevaluationSnapshot(tx, {
      variantId,
      expectedOldCost: money(r.oldCost).toFixed(2),
      expectedBranchQuantities: parseBranchQuantitySnapshot(r.branchQuantities),
      actor,
      authorityVerb: "اعتماد",
    });
    if (!checked.ok) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `${checked.message.replace("منذ إنشاء المستند", "منذ الطلب")} — أعد الطلب على الأساس الجديد`,
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
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "طلب إعادة التقييم غير موجود" });
    assertRequestBranchAuthority(Number(r.branchId), actor, "رفض");
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب إعادة التقييم ليس في انتظار الموافقة" });
    }
    assertApprover(r.createdBy != null ? Number(r.createdBy) : null, actor, "رفض");
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
  filter: { status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED"; branchId?: number | null; limit?: number },
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
      .orderBy(desc(costRevaluationRequests.id))
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
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
    const allRows = await loadBranchQuantitySnapshot(tx, variantId, false);
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

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
import Decimal from "decimal.js";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
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
    .where(and(eq(branchStock.variantId, variantId), ne(branchStock.quantity, 0)));
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
      message: `التكلفة عامّة لكل الفروع، ولهذا الصنف رصيدٌ في فرعٍ آخر — لا يمكن ${verb} إعادة تقييمه إلّا من الإدارة.`,
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
 * الترتيب مقصود — قفل `branchStock` ثمّ `productVariants` هو نفس ترتيب قفل مسار الشراء/WAVG
 * وتسوية المخزون، فلا حلقةَ انتظارٍ متبادل بينها.
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
    if (r.status !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "طلب إعادة التقييم ليس في انتظار الموافقة" });
    }
    assertApprover(r.createdBy != null ? Number(r.createdBy) : null, actor, "اعتماد");

    const variantId = Number(r.variantId);
    const liveRows = await loadBranchQuantities(tx, variantId, true);
    assertBranchAuthority(liveRows, actor, "اعتماد");

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
    if (!variant) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
    if (variant.isConsignment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "صار الصنف بضاعة أمانة بعد الطلب — ارفض الطلب بدل اعتماده",
      });
    }

    // انحراف التكلفة: قيمة القيد تُحسب من الفرق، فلو تحرّكت التكلفة منذ الطلب (استلامٌ غيّر WAVG
    // مثلاً) لرحّلنا فرقاً محسوباً على أساسٍ زال — والنتيجة تكلفةٌ نهائية صحيحة بقيدٍ خاطئ.
    const liveCost = round2(money(variant.costPrice ?? "0"));
    const snapCost = round2(money(r.oldCost));
    if (!liveCost.equals(snapCost)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `تغيّرت تكلفة الصنف منذ الطلب (كانت ${snapCost.toFixed(2)}، الآن ${liveCost.toFixed(2)}) — أعد الطلب على الأساس الجديد`,
      });
    }
    // انحراف الكمّية: نفس السبب — الأثر = Δالتكلفة × الكمية.
    const snapRows = parseSnapshot(r.branchQuantities);
    if (!sameSnapshot(snapRows, liveRows)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `تغيّرت كميّات الصنف منذ الطلب (كانت ${totalOf(snapRows)}، الآن ${totalOf(liveRows)}) — أعد الطلب بالأرصدة الحالية`,
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
        .select({ id: costRevaluationRequests.id, status: costRevaluationRequests.status, createdBy: costRevaluationRequests.createdBy })
        .from(costRevaluationRequests)
        .where(eq(costRevaluationRequests.id, id))
        .for("update")
        .limit(1)
    )[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "طلب إعادة التقييم غير موجود" });
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
  _actor: Actor,
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
    const rows = await loadBranchQuantities(tx, variantId, false);
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

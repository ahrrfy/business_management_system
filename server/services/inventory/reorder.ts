/**
 * تنبيهات إعادة الطلب (نفاد مبكّر للقرطاسية) — شريحة «بند 7».
 *
 * يستغلّ عمودَي `productVariants.minStock`/`reorderPoint` القائمَين في المخطط:
 * - listReorderAlerts: كل (متغيّر × فرع) رصيده الأساس ≤ حدّ الطلب (reorderPoint > 0) والمنتج
 *   والمتغيّر نشطان — مرتّبة بالأشدّ نقصاً (نسبة الرصيد إلى الحدّ تصاعدياً). لا تُعاد التكلفة
 *   (لا تسريب هامش الربح لأدوار القراءة).
 * - setReorderThresholds: تحديث العتبتين بتحقّق (أعداد صحيحة ≥ 0، minStock ≤ reorderPoint).
 * - createReorderDraft: مسودة أمر شراء (status=DRAFT) بإعادة استعمال purchaseService.createPurchaseOrder
 *   حرفياً (لا إعادة كتابة للمنطق) — سعر السطر = آخر تكلفة للمتغيّر، والوحدة = الوحدة الأساس.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  branches,
  branchStock,
  productUnits,
  productVariants,
  products,
  suppliers,
  variantBranchThresholds,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchaseService";
import { withTx, type Actor } from "../tx";

/**
 * قراءةُ العتبة الفعّالة لكل (متغيّر × فرع) عبر COALESCE(override, variant-default).
 * تُستعمَل داخل استعلامات الجرد الحيّ وتنبيهات إعادة الطلب — القارئُ العامّ (dashboard/reports)
 * يبقى على الافتراض حتى يُطلَب توسيعُه بشريحةٍ لاحقة (تقرير المراجعة P1-#4، ٢٥/٨).
 */
export function effectiveReorderPointSql() {
  return sql<number>`COALESCE(${variantBranchThresholds.reorderPoint}, ${productVariants.reorderPoint}, 0)`;
}

export function effectiveMinStockSql() {
  return sql<number>`COALESCE(${variantBranchThresholds.minStock}, ${productVariants.minStock}, 0)`;
}

export interface ReorderAlertRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  variantName: string | null;
  color: string | null;
  size: string | null;
  branchId: number;
  branchName: string;
  /** الرصيد الحالي بالوحدة الأساس (قد يكون سالباً — خدمات الطباعة allowNegative). */
  quantity: number;
  minStock: number;
  reorderPoint: number;
  /** override فرعيّ مفعَّل على هذا الصفّ (شارةُ «مخصّص لهذا الفرع» في الشاشة). */
  overrideActive: boolean;
  /** الكمية المقترحة للطلب = reorderPoint×2 − الرصيد الحالي، لا تقلّ عن 1. */
  suggestedQty: number;
}

export interface ListReorderAlertsInput {
  /** null/undefined = كل الفروع (للأدمن)؛ رقم = فرع محدّد. العزل يفرضه الراوتر. */
  branchId?: number | null;
  limit?: number;
  offset?: number;
}

export async function listReorderAlerts(input: ListReorderAlertsInput = {}): Promise<ReorderAlertRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);

  // ⭐ P1-#4 (٢٥/٨): العتبة الفعّالة = override فرعيّ إن وُجد وإلّا الافتراض المخزَّن على المتغيّر.
  // القارئ الأصليّ كان يعتمد على `productVariants.reorderPoint` وحده ⇒ الفرع سريع الدوران والبطيء
  // يتلقّيان نفس التنبيه. LEFT JOIN على override تحت شرط (variantId, branchId) — فالمقارنة تصير على
  // العتبة الفعّالة لكلّ صفّ (variant × branch). لا هجرةَ بيانات: الأعمدة القائمة على المتغيّر تبقى
  // كما هي (توافقٌ كامل مع كلّ الشاشات القارئة للافتراض).
  const effectiveReorder = effectiveReorderPointSql();
  const effectiveMin = effectiveMinStockSql();
  const conds = [
    sql`${effectiveReorder} > 0`,
    sql`${branchStock.quantity} <= ${effectiveReorder}`,
    eq(productVariants.isActive, true),
    eq(products.isActive, true),
  ];
  if (input.branchId != null) conds.push(eq(branchStock.branchId, input.branchId));

  const rows = await db
    .select({
      variantId: branchStock.variantId,
      productId: productVariants.productId,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      branchId: branchStock.branchId,
      branchName: branches.name,
      quantity: branchStock.quantity,
      minStock: effectiveMin,
      reorderPoint: effectiveReorder,
      // فلَم override موجود؟ (`true` = عتبةٌ فرعيّة سائدة؛ `false` = الافتراضُ العامّ من المتغيّر).
      // مفيدةٌ في الشاشة لعرض شارةٍ صريحة «مخصّص لهذا الفرع» بدل ادّعاء أنّ الكلّ من نفس القيمة.
      overrideActive: sql<number>`CASE WHEN ${variantBranchThresholds.id} IS NOT NULL THEN 1 ELSE 0 END`,
    })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(branches, eq(branches.id, branchStock.branchId))
    // شرطُ الاتّحاد على (variantId, branchId) في ON — وضعُه في WHERE يُلغي معنى LEFT (يُسقط الصفوف
    // NULL) ⇒ لا نرى إلّا ما له override؛ ما لا override له لا يظهر أبداً وإن كان تحت الحدّ الافتراضيّ.
    .leftJoin(
      variantBranchThresholds,
      and(
        eq(variantBranchThresholds.variantId, branchStock.variantId),
        eq(variantBranchThresholds.branchId, branchStock.branchId),
      ),
    )
    .where(and(...conds))
    // الأشدّ نقصاً أولاً: نسبة الرصيد إلى حدّ الطلب تصاعدياً (رصيد سالب ⇒ نسبة سالبة ⇒ الصدارة).
    // كسر التعادل بمعرّف الصف لترتيب حتمي (ترقيم صفحات مستقرّ).
    .orderBy(asc(sql`(${branchStock.quantity} / ${effectiveReorder})`), asc(branchStock.id))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => {
    const reorderPoint = Number(r.reorderPoint ?? 0);
    const quantity = Number(r.quantity);
    return {
      variantId: Number(r.variantId),
      productId: Number(r.productId),
      productName: r.productName,
      sku: r.sku,
      variantName: r.variantName,
      color: r.color,
      size: r.size,
      branchId: Number(r.branchId),
      branchName: r.branchName,
      quantity,
      minStock: Number(r.minStock ?? 0),
      reorderPoint,
      overrideActive: Number(r.overrideActive) === 1,
      // الكميات أعداد صحيحة عادية (لا أموال) ⇒ حساب int مباشر مشروع (§٥).
      suggestedQty: Math.max(1, reorderPoint * 2 - quantity),
    };
  });
}

/**
 * عدد صفوف (متغيّر × فرع) البالغة حدّ إعادة الطلب — مؤشّر إعادة الطلب الحيّ (استباقيّ).
 * نفس شروط listReorderAlerts لكن COUNT بلا جلب صفوف ⇒ خفيفٌ للاستدعاء المتكرّر في رأس شاشة المخزون.
 */
export async function countReorderAlerts(input: { branchId?: number | null } = {}): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  // نفس منطقُ `listReorderAlerts`: العتبةُ الفعّالةُ لا الافتراضُ العام. القارئان يتحرّكان معاً.
  const effectiveReorder = effectiveReorderPointSql();
  const conds = [
    sql`${effectiveReorder} > 0`,
    sql`${branchStock.quantity} <= ${effectiveReorder}`,
    eq(productVariants.isActive, true),
    eq(products.isActive, true),
  ];
  if (input.branchId != null) conds.push(eq(branchStock.branchId, input.branchId));

  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(branchStock)
    .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(
      variantBranchThresholds,
      and(
        eq(variantBranchThresholds.variantId, branchStock.variantId),
        eq(variantBranchThresholds.branchId, branchStock.branchId),
      ),
    )
    .where(and(...conds));
  return Number(rows[0]?.c ?? 0);
}

export interface SetReorderThresholdsInput {
  variantId: number;
  minStock: number;
  reorderPoint: number;
}

export async function setReorderThresholds(input: SetReorderThresholdsInput) {
  const { variantId, minStock, reorderPoint } = input;
  if (!Number.isInteger(minStock) || minStock < 0 || !Number.isInteger(reorderPoint) || reorderPoint < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "العتبتان يجب أن تكونا عددين صحيحين غير سالبين" });
  }
  if (minStock > reorderPoint) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الحد الأدنى لا يصحّ أن يتجاوز حدّ إعادة الطلب",
    });
  }
  return withTx(async (tx) => {
    const v = (
      await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .for("update")
        .limit(1)
    )[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
    await tx.update(productVariants).set({ minStock, reorderPoint }).where(eq(productVariants.id, variantId));
    return { variantId, minStock, reorderPoint };
  });
}

/* ==================== override فرعيّ للعتبات (P1-#4، ٢٥/٨) ==================== */

export interface SetBranchThresholdsInput {
  variantId: number;
  branchId: number;
  /** NULL ⇒ ورث الافتراضَ من المتغيّر لهذا الحقل بعينه. */
  minStock: number | null;
  reorderPoint: number | null;
}

/**
 * كتابةُ override للفرع — upsert على (variantId, branchId). NULL في كلا الحقلَين تعني «لا override
 * محسوسٌ» — تُعامَل كطلبِ إزالة (نمسح الصفّ) كي لا يبقى override فارغٌ يُربك القارئ. تمرير حقلٍ واحد
 * فقط مسموح: الآخرُ يبقى NULL فيرث الافتراض العام.
 */
export async function setBranchThresholds(input: SetBranchThresholdsInput, actor: Actor): Promise<{
  variantId: number;
  branchId: number;
  minStock: number | null;
  reorderPoint: number | null;
  cleared: boolean;
}> {
  const { variantId, branchId } = input;
  const min = input.minStock;
  const reorder = input.reorderPoint;
  for (const [name, value] of [["minStock", min] as const, ["reorderPoint", reorder] as const]) {
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `${name} يجب أن تكون عدداً صحيحاً غير سالب` });
    }
  }
  if (min != null && reorder != null && min > reorder) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الحد الأدنى لا يصحّ أن يتجاوز حدّ إعادة الطلب",
    });
  }
  return withTx(async (tx) => {
    const v = (
      await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .limit(1)
    )[0];
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "المتغيّر غير موجود" });
    const b = (
      await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, branchId))
        .limit(1)
    )[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    // إن كان كلا الحقلَين NULL ⇒ حذف الصفّ (نظافةُ الجدول: override فارغٌ لا معنى تشغيليّ له).
    if (min == null && reorder == null) {
      await tx
        .delete(variantBranchThresholds)
        .where(
          and(
            eq(variantBranchThresholds.variantId, variantId),
            eq(variantBranchThresholds.branchId, branchId),
          ),
        );
      return { variantId, branchId, minStock: null, reorderPoint: null, cleared: true };
    }

    // upsert عبر ON DUPLICATE KEY UPDATE — قيدُ التفرّد (uq_vbt_variant_branch) يحوّل السباق إلى تحديث.
    await tx
      .insert(variantBranchThresholds)
      .values({ variantId, branchId, minStock: min, reorderPoint: reorder, updatedBy: actor.userId })
      .onDuplicateKeyUpdate({
        set: { minStock: min, reorderPoint: reorder, updatedBy: actor.userId },
      });
    return { variantId, branchId, minStock: min, reorderPoint: reorder, cleared: false };
  });
}

/** مسحُ override للفرع — يعيده إلى وراثة الافتراض العام. أوسع API من `set(null,null)` تصريحياً. */
export async function clearBranchThresholds(input: { variantId: number; branchId: number }) {
  return withTx(async (tx) => {
    await tx
      .delete(variantBranchThresholds)
      .where(
        and(
          eq(variantBranchThresholds.variantId, input.variantId),
          eq(variantBranchThresholds.branchId, input.branchId),
        ),
      );
    return { variantId: input.variantId, branchId: input.branchId, cleared: true as const };
  });
}

/** قراءةُ overrides المخصّصة لفرعٍ (اختيارياً بمتغيّر) — للشاشة الإدارية. */
export async function listBranchThresholds(input: { branchId?: number | null; variantId?: number | null }) {
  const db = getDb();
  if (!db) return [];
  const conds = [];
  if (input.branchId != null) conds.push(eq(variantBranchThresholds.branchId, input.branchId));
  if (input.variantId != null) conds.push(eq(variantBranchThresholds.variantId, input.variantId));
  const rows = await db
    .select({
      id: variantBranchThresholds.id,
      variantId: variantBranchThresholds.variantId,
      branchId: variantBranchThresholds.branchId,
      minStock: variantBranchThresholds.minStock,
      reorderPoint: variantBranchThresholds.reorderPoint,
      updatedBy: variantBranchThresholds.updatedBy,
      updatedAt: variantBranchThresholds.updatedAt,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      branchName: branches.name,
      /** الافتراض العامّ للمقارنة — الشاشة تُظهر الفرق. */
      defaultMinStock: productVariants.minStock,
      defaultReorderPoint: productVariants.reorderPoint,
    })
    .from(variantBranchThresholds)
    .innerJoin(productVariants, eq(productVariants.id, variantBranchThresholds.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(branches, eq(branches.id, variantBranchThresholds.branchId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(products.name), asc(productVariants.sku), asc(branches.id))
    .limit(500);
  return rows.map((r) => ({
    id: Number(r.id),
    variantId: Number(r.variantId),
    branchId: Number(r.branchId),
    branchName: r.branchName,
    productName: r.productName,
    sku: r.sku,
    variantName: r.variantName,
    minStock: r.minStock == null ? null : Number(r.minStock),
    reorderPoint: r.reorderPoint == null ? null : Number(r.reorderPoint),
    defaultMinStock: r.defaultMinStock == null ? null : Number(r.defaultMinStock),
    defaultReorderPoint: r.defaultReorderPoint == null ? null : Number(r.defaultReorderPoint),
    updatedBy: r.updatedBy == null ? null : Number(r.updatedBy),
    updatedAt: r.updatedAt,
  }));
}

export interface CreateReorderDraftInput {
  supplierId: number;
  branchId: number;
  lines: Array<{ variantId: number; quantity: number }>;
}

/**
 * مسودة أمر شراء من تنبيهات إعادة الطلب — تفويض كامل لـcreatePurchaseOrder (idempotency/الترقيم/
 * التحقّق المالي كلّها هناك داخل withTx واحدة). هنا فقط: تحقّق المدخلات + إيجاد الوحدة الأساس
 * وآخر تكلفة لكل متغيّر لبناء أسطر الأمر.
 */
export async function createReorderDraft(input: CreateReorderDraftInput, actor: Actor) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا أسطر في المسودة — اختر صنفاً واحداً على الأقل" });
  const seen = new Set<number>();
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الطلب يجب أن تكون عدداً صحيحاً موجباً" });
    }
    if (seen.has(l.variantId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "صنف مكرّر في المسودة — ادمج كميته في سطر واحد" });
    }
    seen.add(l.variantId);
  }

  const sup = (
    await db
      .select({ id: suppliers.id, isActive: suppliers.isActive })
      .from(suppliers)
      .where(eq(suppliers.id, input.supplierId))
      .limit(1)
  )[0];
  if (!sup) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
  if (sup.isActive === false) throw new TRPCError({ code: "BAD_REQUEST", message: "المورّد معطَّل — فعّله أولاً أو اختر مورّداً آخر" });

  const variantIds = input.lines.map((l) => l.variantId);
  const variantRows = await db
    .select({ id: productVariants.id, costPrice: productVariants.costPrice })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
  const costByVariant = new Map(variantRows.map((v) => [Number(v.id), v.costPrice]));

  // الوحدة الأساس لكل متغيّر: isBaseUnit أولاً، وإلا أي وحدة نشطة معاملها 1 (بيانات مستوردة قديمة).
  const unitRows = await db
    .select({
      id: productUnits.id,
      variantId: productUnits.variantId,
      conversionFactor: productUnits.conversionFactor,
      isBaseUnit: productUnits.isBaseUnit,
    })
    .from(productUnits)
    .where(and(inArray(productUnits.variantId, variantIds), eq(productUnits.isActive, true)));
  const baseUnitByVariant = new Map<number, number>();
  for (const u of unitRows) {
    const vid = Number(u.variantId);
    if (u.isBaseUnit) {
      baseUnitByVariant.set(vid, Number(u.id));
    } else if (!baseUnitByVariant.has(vid) && Number(u.conversionFactor) === 1) {
      baseUnitByVariant.set(vid, Number(u.id));
    }
  }

  const items = input.lines.map((l) => {
    const cost = costByVariant.get(l.variantId);
    if (cost == null) throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${l.variantId} غير موجود` });
    const productUnitId = baseUnitByVariant.get(l.variantId);
    if (productUnitId == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا وحدة أساس نشطة للمتغيّر ${l.variantId} — أكمل وحدات المنتج أولاً` });
    }
    return {
      variantId: l.variantId,
      productUnitId,
      quantity: String(l.quantity), // كمية بالوحدة الأساس (معامل 1) ⇒ baseQuantity = quantity.
      unitPrice: String(cost ?? "0"), // آخر تكلفة (سياسة التكلفة المعتمدة) — سعر تقديري قابل للتعديل في المشتريات.
    };
  });

  const res = await createPurchaseOrder(
    {
      supplierId: input.supplierId,
      branchId: input.branchId,
      status: "DRAFT",
      items,
      notes: "مسودة تلقائية من تنبيهات إعادة الطلب",
    },
    actor,
  );
  return { purchaseOrderId: res.purchaseOrderId, poNumber: "poNumber" in res ? res.poNumber : undefined };
}

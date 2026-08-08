// قراءات الجرد: القائمة، الترويسة، المتابعة الحية (بلا تسريب expectedQty/التكلفة)، والعدّادات.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { escLike } from "../../lib/sqlLike";
import {
  branches,
  branchStock,
  categories,
  inventoryMovements,
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import {
  assertBranchAccess,
  chunk,
  loadSessionHeader,
  loadStocktakeProgress,
  loadStocktakeProgressMap,
  type DbLike,
} from "./internal";

const SCOPE_FALLBACK_LABEL: Record<string, string> = {
  FULL: "جرد شامل للفرع",
  MOVING: "الأصناف المتحركة",
  CATEGORY: "حسب الفئة",
  MANUAL: "أصناف مختارة",
};

function scopeLabelOf(scopeType: string, scopeDetail: string | null): string {
  try {
    const d = JSON.parse(scopeDetail ?? "");
    if (d && typeof d.label === "string" && d.label) return d.label;
  } catch {
    /* تفاصيل قديمة/فارغة ⇒ التسمية الافتراضية */
  }
  return SCOPE_FALLBACK_LABEL[scopeType] ?? scopeType;
}

export interface ListStocktakesOpts {
  status?: "COUNTING" | "REVIEW" | "APPROVED" | "CANCELLED";
  branchId?: number;
  limit?: number;
  offset?: number;
}

export async function listStocktakeSessions(opts: ListStocktakesOpts = {}) {
  const db = requireDb();
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.status) conds.push(eq(stocktakeSessions.status, opts.status));
  if (opts.branchId) conds.push(eq(stocktakeSessions.branchId, opts.branchId));

  const rows = await db
    .select({
      id: stocktakeSessions.id,
      code: stocktakeSessions.code,
      name: stocktakeSessions.name,
      branchId: stocktakeSessions.branchId,
      branchName: branches.name,
      scopeType: stocktakeSessions.scopeType,
      scopeDetail: stocktakeSessions.scopeDetail,
      sessionType: stocktakeSessions.sessionType,
      status: stocktakeSessions.status,
      createdAt: stocktakeSessions.createdAt,
      createdByName: users.name,
      submittedAt: stocktakeSessions.submittedAt,
      approvedAt: stocktakeSessions.approvedAt,
    })
    .from(stocktakeSessions)
    .leftJoin(branches, eq(stocktakeSessions.branchId, branches.id))
    .leftJoin(users, eq(stocktakeSessions.createdBy, users.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(stocktakeSessions.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  const ids = rows.map((r) => Number(r.id));
  const progressMap = await loadStocktakeProgressMap(db, ids);

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    branchId: Number(r.branchId),
    branchName: r.branchName ?? "—",
    scopeType: r.scopeType,
    scopeLabel: scopeLabelOf(r.scopeType, r.scopeDetail),
    status: r.status,
    itemCount: progressMap.get(Number(r.id))?.total ?? 0,
    countedCount: progressMap.get(Number(r.id))?.counted ?? 0,
    createdAt: r.createdAt,
    createdByName: r.createdByName ?? "—",
    submittedAt: r.submittedAt,
    approvedAt: r.approvedAt,
  }));
}

/** نشاط كل عدّاد داخل قائمة الجرد المشتركة؛ counted هو ما أدخله فعلياً ولا توجد حصة ملكية. */
async function loadAssignmentProgress(db: DbLike, sessionId: number) {
  const asg = await db
    .select({
      id: stocktakeAssignments.id,
      name: stocktakeAssignments.name,
      method: stocktakeAssignments.method,
      userId: stocktakeAssignments.userId,
      zone: stocktakeAssignments.zone,
      status: stocktakeAssignments.status,
      lastActivityAt: stocktakeAssignments.lastActivityAt,
      submittedAt: stocktakeAssignments.submittedAt,
      removedAt: stocktakeAssignments.removedAt,
      removalReason: stocktakeAssignments.removalReason,
    })
    .from(stocktakeAssignments)
    .where(eq(stocktakeAssignments.sessionId, sessionId))
    .orderBy(asc(stocktakeAssignments.id));

  const counted = await db
    .select({
      assignmentId: stocktakeCounts.assignmentId,
      c: sql<number>`COUNT(DISTINCT ${stocktakeCounts.variantId})`,
    })
    .from(stocktakeCounts)
    .where(and(eq(stocktakeCounts.sessionId, sessionId), inArray(stocktakeCounts.kind, ["FIRST", "RECOUNT"])))
    .groupBy(stocktakeCounts.assignmentId);
  const countedByAsg = new Map(counted.map((r) => [Number(r.assignmentId), Number(r.c)]));

  return asg.map((a) => ({
    id: Number(a.id),
    name: a.name,
    method: a.method,
    userId: a.userId == null ? null : Number(a.userId),
    zone: a.zone,
    status: a.status,
    // A worker has no product quota in the open shared count.
    total: 0,
    counted: countedByAsg.get(Number(a.id)) ?? 0,
    lastActivityAt: a.lastActivityAt,
    submittedAt: a.submittedAt,
    removedAt: a.removedAt,
    removalReason: a.removalReason,
  }));
}

export async function getStocktakeSession(sessionId: number, opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
  const assignments = await loadAssignmentProgress(db, sessionId);
  const { total, counted } = await loadStocktakeProgress(db, sessionId);
  return {
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchId: Number(s.branchId),
      branchName: s.branchName ?? "—",
      scopeType: s.scopeType,
      scopeLabel: scopeLabelOf(s.scopeType, s.scopeDetail),
      status: s.status,
      blind: !!s.blind,
      thresholdPct: String(s.thresholdPct),
      thresholdValue: String(s.thresholdValue),
      dualThreshold: String(s.dualThreshold),
      directUnderThreshold: !!s.directUnderThreshold,
      waNotify: !!s.waNotify,
      dupPolicy: s.dupPolicy,
      notes: s.notes,
      createdAt: s.createdAt,
      createdByName: s.createdByName ?? "—",
      submittedAt: s.submittedAt,
      firstSign: s.firstSignBy ? { byName: s.firstSignByName ?? "—", at: s.firstSignAt } : null,
      approved: s.approvedBy ? { byName: s.approvedByName ?? "—", at: s.approvedAt } : null,
      cancelled: s.cancelledAt ? { byName: s.cancelledByName ?? "—", at: s.cancelledAt } : null,
    },
    assignments,
    progress: { total, counted },
  };
}

/**
 * شاشة المتابعة الحية — بلا expectedQty ولا تكاليف (تصل لدور warehouse).
 * `opts.q` (عقد مع الواجهة): حين محددة تُستبدل recentCounts بالعدّات المطابقة
 * (LIKE على اسم المنتج أو sku أو اسم المتغيّر، حتى 50، الأحدث أولاً) بدل آخر 20.
 * وفي الحالتين كل عنصر يحمل `baseUnit` (اسم وحدة الأساس) كي تعرض الشاشة «139 رزمة».
 */
export async function monitorStocktakeSession(
  sessionId: number,
  opts: { restrictBranchId?: number | null; q?: string } = {}
) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
  const assignments = await loadAssignmentProgress(db, sessionId);
  const progress = await loadStocktakeProgress(db, sessionId);

  const q = opts.q?.trim() ?? "";
  // تهريب محارف LIKE من مدخل المستخدم — «%» المُدخلة تطابق نصاً لا كل شيء.
  const likePattern = `%${escLike(q)}%`;
  const recentWhere = q
    ? and(
        eq(stocktakeCounts.sessionId, sessionId),
        or(
          sql`${products.name} LIKE ${likePattern} ESCAPE '!'`,
          sql`${productVariants.sku} LIKE ${likePattern} ESCAPE '!'`,
          sql`${productVariants.variantName} LIKE ${likePattern} ESCAPE '!'`
        )
      )
    : eq(stocktakeCounts.sessionId, sessionId);
  const recentRaw = await db
    .select({
      id: stocktakeCounts.id,
      variantId: stocktakeCounts.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      baseUnit: productUnits.unitName,
      qty: stocktakeCounts.qty,
      kind: stocktakeCounts.kind,
      byName: stocktakeCounts.countedByName,
      at: stocktakeCounts.countedAt,
    })
    .from(stocktakeCounts)
    .innerJoin(productVariants, eq(stocktakeCounts.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, and(eq(productUnits.variantId, stocktakeCounts.variantId), eq(productUnits.isBaseUnit, true)))
    .where(recentWhere)
    .orderBy(desc(stocktakeCounts.countedAt), desc(stocktakeCounts.id))
    .limit(q ? 50 : 20);
  // عدّة وحدات أساس لصنف (شذوذ بيانات) = صفوف مكرّرة من الـjoin ⇒ أول صف لكل عدّة يفوز.
  const seenCountIds = new Set<number>();
  const recent = recentRaw.filter((r) => {
    const id = Number(r.id);
    if (seenCountIds.has(id)) return false;
    seenCountIds.add(id);
    return true;
  });

  // إعادات العدّ المعلّقة — تفصيلية (الشاشة تعرضها لافتةً بأسبابها).
  const pendingItems = await db
    .select({
      variantId: stocktakeItems.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      reason: stocktakeItems.recountReason,
      requestedByName: users.name,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(users, eq(stocktakeItems.recountRequestedBy, users.id))
    .where(and(eq(stocktakeItems.sessionId, sessionId), eq(stocktakeItems.recountStatus, "PENDING")));

  // التعارضات المفتوحة (VERIFY مخالف بلا فصل) — مع العدّ الأول المقابل لعرض «زيد 510 / كرار 498».
  const conflictVerifies = await db
    .select({
      variantId: stocktakeCounts.variantId,
      qty2: stocktakeCounts.qty,
      by2: stocktakeCounts.countedByName,
      productName: products.name,
      variantName: productVariants.variantName,
    })
    .from(stocktakeCounts)
    .innerJoin(productVariants, eq(stocktakeCounts.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(stocktakeCounts.sessionId, sessionId),
        eq(stocktakeCounts.isConflict, true),
        sql`${stocktakeCounts.resolvedPick} IS NULL`
      )
    );
  const conflictFirsts = conflictVerifies.length
    ? await db
        .select({ variantId: stocktakeCounts.variantId, qty: stocktakeCounts.qty, byName: stocktakeCounts.countedByName })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, sessionId),
            inArray(stocktakeCounts.variantId, conflictVerifies.map((c) => Number(c.variantId))),
            eq(stocktakeCounts.kind, "FIRST")
          )
        )
    : [];
  const firstByVariant = new Map(conflictFirsts.map((f) => [Number(f.variantId), f]));
  const labelOf = (p: string | null, v: string | null) => (v ? `${p} — ${v}` : String(p ?? ""));

  return {
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchId: Number(s.branchId),
      branchName: s.branchName ?? "—",
      scopeType: s.scopeType,
      scopeLabel: scopeLabelOf(s.scopeType, s.scopeDetail),
      status: s.status,
      blind: !!s.blind,
      waNotify: !!s.waNotify,
      dupPolicy: s.dupPolicy,
      createdAt: s.createdAt,
      createdByName: s.createdByName ?? "—",
      submittedAt: s.submittedAt,
    },
    assignments: assignments.map((a) => ({
      id: a.id,
      name: a.name,
      method: a.method,
      userId: a.userId,
      zone: a.zone,
      status: a.status,
      total: a.total,
      counted: a.counted,
      lastActivityAt: a.lastActivityAt,
      removedAt: a.removedAt,
      removalReason: a.removalReason,
    })),
    progress,
    recentCounts: recent.map((r) => ({
      variantId: Number(r.variantId),
      variantLabel: labelOf(r.productName, r.variantName),
      qty: r.qty,
      kind: r.kind,
      byName: r.byName,
      at: r.at,
      baseUnit: r.baseUnit ?? null,
    })),
    pendingRecounts: pendingItems.map((p) => ({
      variantId: Number(p.variantId),
      variantLabel: labelOf(p.productName, p.variantName),
      reason: p.reason ?? "—",
      requestedByName: p.requestedByName ?? "—",
    })),
    conflicts: conflictVerifies.map((c) => ({
      variantId: Number(c.variantId),
      variantLabel: labelOf(c.productName, c.variantName),
      qty1: firstByVariant.get(Number(c.variantId))?.qty ?? 0,
      by1: firstByVariant.get(Number(c.variantId))?.byName ?? "—",
      qty2: c.qty2,
      by2: c.by2,
    })),
  };
}

/**
 * كشف المنتجات التي لم يصل لها عدّ فعّال بعد (FIRST/RECOUNT).
 * المخرج تشغيلي وآمن لدور المخزن: لا expectedQty ولا تكلفة ولا رصيد دفتري.
 * يُستعمل لتوجيه فرق الجرد وللطباعة/التصدير أثناء بقاء الجلسة COUNTING.
 */
export async function getStocktakeRemainingItems(
  sessionId: number,
  opts: {
    restrictBranchId?: number | null;
    q?: string;
    assignmentId?: number;
    limit?: number;
    offset?: number;
  } = {},
) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);

  const q = opts.q?.trim() ?? "";
  const likePattern = `%${escLike(q)}%`;
  const effectiveCount = alias(stocktakeCounts, "stk_remaining_effective_count");
  const filters = [eq(stocktakeItems.sessionId, sessionId), isNull(effectiveCount.id)];
  if (opts.assignmentId != null) filters.push(eq(stocktakeItems.assignmentId, opts.assignmentId));
  if (q) {
    filters.push(
      or(
        sql`${products.name} LIKE ${likePattern} ESCAPE '!'`,
        sql`${productVariants.sku} LIKE ${likePattern} ESCAPE '!'`,
        sql`${productVariants.variantName} LIKE ${likePattern} ESCAPE '!'`,
        sql`EXISTS (
          SELECT 1 FROM ${productUnits} AS stk_remaining_unit
          WHERE stk_remaining_unit.variantId = ${stocktakeItems.variantId}
            AND stk_remaining_unit.barcode LIKE ${likePattern} ESCAPE '!'
        )`,
        sql`EXISTS (
          SELECT 1
          FROM ${productUnitBarcodes} AS stk_remaining_alias
          INNER JOIN ${productUnits} AS stk_remaining_alias_unit
            ON stk_remaining_alias_unit.id = stk_remaining_alias.productUnitId
          WHERE stk_remaining_alias_unit.variantId = ${stocktakeItems.variantId}
            AND stk_remaining_alias.barcode LIKE ${likePattern} ESCAPE '!'
        )`,
        sql`${stocktakeAssignments.name} LIKE ${likePattern} ESCAPE '!'`,
        sql`${stocktakeAssignments.zone} LIKE ${likePattern} ESCAPE '!'`,
      )!,
    );
  }
  const where = and(...filters);
  const [{ total = 0 } = { total: 0 }] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(stocktakeItems)
    .leftJoin(
      effectiveCount,
      and(
        eq(effectiveCount.sessionId, stocktakeItems.sessionId),
        eq(effectiveCount.variantId, stocktakeItems.variantId),
        inArray(effectiveCount.kind, ["FIRST", "RECOUNT"]),
      ),
    )
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(stocktakeAssignments, eq(stocktakeItems.assignmentId, stocktakeAssignments.id))
    .where(where);

  const rows = await db
    .select({
      variantId: stocktakeItems.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      barcode: sql<string | null>`(
        SELECT stk_base_unit.barcode FROM ${productUnits} AS stk_base_unit
        WHERE stk_base_unit.variantId = ${stocktakeItems.variantId}
        ORDER BY stk_base_unit.isBaseUnit DESC, stk_base_unit.id ASC
        LIMIT 1
      )`,
      baseUnit: sql<string | null>`(
        SELECT stk_base_unit.unitName FROM ${productUnits} AS stk_base_unit
        WHERE stk_base_unit.variantId = ${stocktakeItems.variantId}
        ORDER BY stk_base_unit.isBaseUnit DESC, stk_base_unit.id ASC
        LIMIT 1
      )`,
      assignmentId: stocktakeAssignments.id,
      assignmentName: stocktakeAssignments.name,
      zone: stocktakeAssignments.zone,
    })
    .from(stocktakeItems)
    .leftJoin(
      effectiveCount,
      and(
        eq(effectiveCount.sessionId, stocktakeItems.sessionId),
        eq(effectiveCount.variantId, stocktakeItems.variantId),
        inArray(effectiveCount.kind, ["FIRST", "RECOUNT"]),
      ),
    )
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(stocktakeAssignments, eq(stocktakeItems.assignmentId, stocktakeAssignments.id))
    .where(where)
    .orderBy(asc(stocktakeAssignments.name), asc(stocktakeAssignments.zone), asc(products.name), asc(productVariants.id))
    .limit(Math.min(Math.max(opts.limit ?? 500, 1), 10_000))
    .offset(Math.max(opts.offset ?? 0, 0));

  // الوحدات تُقرأ باستعلام scalar مرتب، لذلك يبقى كل منتج صفاً واحداً وتظل pagination دقيقة.
  const items = rows.map((r) => ({
      variantId: Number(r.variantId),
      productName: String(r.productName ?? ""),
      variantName: r.variantName,
      sku: r.sku,
      barcode: r.barcode ?? null,
      baseUnit: r.baseUnit ?? null,
      assignmentId: Number(r.assignmentId),
      assignmentName: r.assignmentName,
      zone: r.zone,
    }));

  return {
    assignmentMode: "SHARED" as const,
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchName: s.branchName ?? "—",
      status: s.status,
    },
    total: Number(total),
    items,
  };
}

/* ─────────── معاينة النطاق (Wizard الإنشاء) — تعكس منطق resolveScope حرفياً بلا كتابة. ─────────── */

export interface PreviewScopeInput {
  branchId: number;
  sessionType: "NORMAL" | "OPENING";
  scopeType: "FULL" | "MOVING" | "CATEGORY";
  movingDays?: number;
  categoryIds?: number[];
}

export interface PreviewScopeResult {
  /** عدد المتغيّرات الفعليّ الذي ستنشأ به الجلسة (بعد استبعاد المُفتتَح في OPENING). */
  variantCount: number;
  /** عدد المنتجات الأمّ المميّزة ضمن هذا النطاق (لعرض «X منتج × Y متغيّر»). */
  productCount: number;
  /** OPENING فقط: عدد المتغيّرات المستبعَدة من النطاق لأنّها مُفتتَحة سلفاً (openedAt≠NULL). */
  excludedOpened: number;
  /** OPENING فقط: عدد الأصناف المستبعَدة لأنّها من بضاعة الأمانة (لا تُفتتَح إلا بسند إيداع). */
  excludedConsignment: number;
  /** OPENING فقط: عدد الأصناف المستبعَدة لأنّها بكج (تُجرَد عبر مكوّناتها). */
  excludedBundle: number;
}

/**
 * يعكس منطق `resolveScope` في create.ts للـFULL/MOVING/CATEGORY حرفياً بلا آثار جانبيّة.
 * الغرض: العدّاد في معالج الإنشاء (Wizard) يعرض ما ستُنشأ به الجلسة فعلياً — لا `branchStock.length`
 * (الذي يعدّ فقط ما له صفّ رصيد سابق في الفرع، فيُخفي كلّ الأصناف التي لم تُلامَس بحركة بعد ولا يعكس
 * أبداً نطاق OPENING الحقيقيّ). دالة قراءة صرفة: بلا throw على CATEGORY فارغة (تُرجع 0).
 */
export async function previewScope(input: PreviewScopeInput): Promise<PreviewScopeResult> {
  const db = requireDb();
  const isOpening = input.sessionType === "OPENING";

  // في OPENING نستبعد البكج والأمانة (كلاهما استبعاد تصميميّ من resolveScope + create.ts).
  // في NORMAL نستبعد البكج فقط.
  const notBundleCond = eq(products.isBundle, false);
  const scopeCond = isOpening
    ? and(notBundleCond, eq(products.isConsignment, false))!
    : notBundleCond;

  // (١) استعلام أصناف النطاق الخام (قبل استبعاد المُفتتَح لـOPENING).
  let variantIds: number[] = [];
  let productIds: number[] = [];

  if (input.scopeType === "FULL") {
    const rows = await db
      .select({ id: productVariants.id, productId: productVariants.productId })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(eq(productVariants.isActive, true), eq(products.isActive, true), scopeCond));
    variantIds = rows.map((r) => Number(r.id));
    productIds = rows.map((r) => Number(r.productId));
  } else if (input.scopeType === "MOVING") {
    const days = input.movingDays ?? 30;
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await db
      .selectDistinct({ id: inventoryMovements.variantId, productId: productVariants.productId })
      .from(inventoryMovements)
      .innerJoin(productVariants, eq(inventoryMovements.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(inventoryMovements.branchId, input.branchId),
          gte(inventoryMovements.createdAt, since),
          eq(productVariants.isActive, true),
          scopeCond,
        ),
      );
    variantIds = rows.map((r) => Number(r.id));
    productIds = rows.map((r) => Number(r.productId));
  } else {
    // CATEGORY
    const catIds = (input.categoryIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
    if (!catIds.length) {
      return { variantCount: 0, productCount: 0, excludedOpened: 0, excludedConsignment: 0, excludedBundle: 0 };
    }
    const rows = await db
      .select({ id: productVariants.id, productId: productVariants.productId })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          inArray(products.categoryId, catIds),
          eq(productVariants.isActive, true),
          eq(products.isActive, true),
          scopeCond,
        ),
      );
    variantIds = rows.map((r) => Number(r.id));
    productIds = rows.map((r) => Number(r.productId));
  }

  // (٢) OPENING: استبعاد المُفتتَح مسبقاً (openedAt≠NULL) — يطابق create.ts:290-315.
  let excludedOpened = 0;
  if (isOpening && variantIds.length) {
    const openedSet = new Set<number>();
    for (const part of chunk(variantIds)) {
      const rows = await db
        .select({ variantId: branchStock.variantId })
        .from(branchStock)
        .where(
          and(
            eq(branchStock.branchId, input.branchId),
            inArray(branchStock.variantId, part),
            isNotNull(branchStock.openedAt),
          ),
        );
      for (const r of rows) openedSet.add(Number(r.variantId));
    }
    excludedOpened = openedSet.size;
    if (excludedOpened) {
      const filtered = variantIds.filter((v) => !openedSet.has(v));
      // إعادة حساب productIds بعد الفلترة (نأخذ فقط productIds التي بقي لها متغيّر).
      const keptSet = new Set(filtered);
      productIds = productIds.filter((_, i) => keptSet.has(variantIds[i]));
      variantIds = filtered;
    }
  }

  // (٣) OPENING: عدّادات مقياس شفافيّة — كم استُبعد بسبب الأمانة/البكج؟ استعلام قصير ينفَّذ فقط
  // عند OPENING لكيلا يُثقل الـwizard في NORMAL.
  let excludedConsignment = 0;
  let excludedBundle = 0;
  if (isOpening) {
    // نحسب من فضاء المرشّحات القبل-حصر (بلا isBundle/isConsignment) بنفس فلتر النطاق.
    // للـFULL: كل متغيّر نشط لمنتج نشط بكج/أمانة.
    if (input.scopeType === "FULL") {
      const [rBundle] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(and(eq(productVariants.isActive, true), eq(products.isActive, true), eq(products.isBundle, true)));
      excludedBundle = Number(rBundle?.c ?? 0);
      const [rCons] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(
          and(
            eq(productVariants.isActive, true),
            eq(products.isActive, true),
            eq(products.isConsignment, true),
            eq(products.isBundle, false),
          ),
        );
      excludedConsignment = Number(rCons?.c ?? 0);
    }
    // للـCATEGORY/MOVING العدّاد مساوي 0 (الاستبعاد داخل الفلتر أصلاً — لا نحسب مسبَق-استبعاد
    // مضلِّل عبر فضاءٍ أوسع). المفتاح: `excludedOpened` هو المؤشّر الأهمّ للمستخدم.
  }

  const uniqueProducts = new Set(productIds).size;
  return {
    variantCount: variantIds.length,
    productCount: uniqueProducts,
    excludedOpened,
    excludedConsignment,
    excludedBundle,
  };
}

/** عدّادات بطاقة لوحة التحكم/القائمة. */
export async function getStocktakeStats(opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const conds = (status: "COUNTING" | "REVIEW") => {
    const cs = [eq(stocktakeSessions.status, status)];
    if (opts.restrictBranchId != null) cs.push(eq(stocktakeSessions.branchId, opts.restrictBranchId));
    return and(...cs);
  };
  const countingRow = (await db.select({ c: sql<number>`COUNT(*)` }).from(stocktakeSessions).where(conds("COUNTING")))[0];
  const reviewRow = (await db.select({ c: sql<number>`COUNT(*)` }).from(stocktakeSessions).where(conds("REVIEW")))[0];
  return { counting: Number(countingRow?.c ?? 0), review: Number(reviewRow?.c ?? 0) };
}

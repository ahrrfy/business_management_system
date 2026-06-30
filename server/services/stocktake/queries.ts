// قراءات الجرد: القائمة، الترويسة، المتابعة الحية (بلا تسريب expectedQty/التكلفة)، والعدّادات.
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { escLike } from "../../lib/sqlLike";
import {
  branches,
  products,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { assertBranchAccess, loadSessionHeader, type DbLike } from "./internal";

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
  const itemCountMap = new Map<number, number>();
  const countedMap = new Map<number, number>();
  if (ids.length) {
    const itemCounts = await db
      .select({ sessionId: stocktakeItems.sessionId, c: sql<number>`COUNT(*)` })
      .from(stocktakeItems)
      .where(inArray(stocktakeItems.sessionId, ids))
      .groupBy(stocktakeItems.sessionId);
    for (const r of itemCounts) itemCountMap.set(Number(r.sessionId), Number(r.c));
    const counted = await db
      .select({ sessionId: stocktakeCounts.sessionId, c: sql<number>`COUNT(DISTINCT ${stocktakeCounts.variantId})` })
      .from(stocktakeCounts)
      .where(inArray(stocktakeCounts.sessionId, ids))
      .groupBy(stocktakeCounts.sessionId);
    for (const r of counted) countedMap.set(Number(r.sessionId), Number(r.c));
  }

  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    branchId: Number(r.branchId),
    branchName: r.branchName ?? "—",
    scopeType: r.scopeType,
    scopeLabel: scopeLabelOf(r.scopeType, r.scopeDetail),
    status: r.status,
    itemCount: itemCountMap.get(Number(r.id)) ?? 0,
    countedCount: countedMap.get(Number(r.id)) ?? 0,
    createdAt: r.createdAt,
    createdByName: r.createdByName ?? "—",
    submittedAt: r.submittedAt,
    approvedAt: r.approvedAt,
  }));
}

/** تقدّم كل تكليف: إجمالي أصنافه + المعدود منها (من أي عامل — VERIFY يُحتسب عدّاً). */
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
    })
    .from(stocktakeAssignments)
    .where(eq(stocktakeAssignments.sessionId, sessionId))
    .orderBy(asc(stocktakeAssignments.id));

  const totals = await db
    .select({ assignmentId: stocktakeItems.assignmentId, c: sql<number>`COUNT(*)` })
    .from(stocktakeItems)
    .where(eq(stocktakeItems.sessionId, sessionId))
    .groupBy(stocktakeItems.assignmentId);
  const totalMap = new Map(totals.map((r) => [Number(r.assignmentId), Number(r.c)]));

  const counted = await db
    .select({
      assignmentId: stocktakeItems.assignmentId,
      c: sql<number>`COUNT(DISTINCT ${stocktakeCounts.variantId})`,
    })
    .from(stocktakeItems)
    .innerJoin(
      stocktakeCounts,
      and(eq(stocktakeCounts.sessionId, stocktakeItems.sessionId), eq(stocktakeCounts.variantId, stocktakeItems.variantId))
    )
    .where(eq(stocktakeItems.sessionId, sessionId))
    .groupBy(stocktakeItems.assignmentId);
  const countedByAsg = new Map(counted.map((r) => [Number(r.assignmentId), Number(r.c)]));

  return asg.map((a) => ({
    id: Number(a.id),
    name: a.name,
    method: a.method,
    userId: a.userId == null ? null : Number(a.userId),
    zone: a.zone,
    status: a.status,
    total: totalMap.get(Number(a.id)) ?? 0,
    counted: countedByAsg.get(Number(a.id)) ?? 0,
    lastActivityAt: a.lastActivityAt,
    submittedAt: a.submittedAt,
  }));
}

export async function getStocktakeSession(sessionId: number, opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
  const assignments = await loadAssignmentProgress(db, sessionId);
  const total = assignments.reduce((acc, a) => acc + a.total, 0);
  const counted = assignments.reduce((acc, a) => acc + a.counted, 0);
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
      zone: a.zone,
      status: a.status,
      total: a.total,
      counted: a.counted,
      lastActivityAt: a.lastActivityAt,
    })),
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

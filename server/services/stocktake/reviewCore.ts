// محرّك المراجعة: إعادة الحساب الكامل (٦ استعلامات بلا N+1) + الحدود + الإجماليات + الحواجز.
// المعادلات حرفياً من العقد §٢ (docs/stocktake-contract.md).
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  branchStock,
  inventoryMovements,
  products,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  users,
} from "../../../drizzle/schema";
// INV-001: signedMoveQty (وadjustSignedDelta) في inventoryService — مصدر واحد للإشارة يستعمله
// الكاردكس والجرد معاً ⇒ لا تَباعُد في حساب الرصيد المُوقَّع.
import { signedMoveQty } from "../inventoryService";
import { money, toDbMoney } from "../money";
import { requireDb } from "../tx";
import { chunk, loadSessionHeader, type DbLike } from "./internal";

/** تسمية عربية لنوع حركة المخزون (لعرض «حركة بعد العدّ»). */
const MOVE_LABEL: Record<string, string> = {
  IN: "إدخال",
  OUT: "إخراج",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
  ADJUST: "تسوية",
};

interface CountRow {
  id: number;
  variantId: number;
  kind: "FIRST" | "RECOUNT" | "VERIFY";
  qty: number;
  countedByName: string;
  countedAt: Date;
  isConflict: boolean;
  resolvedPick: "FIRST" | "VERIFY" | null;
}

export interface ReviewRow {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  baseUnit: string | null;
  zone: string | null;
  assignmentName: string;
  expectedQty: number;
  rawCount: number | null;
  kindUsed: "FIRST" | "RECOUNT" | null;
  countedByName: string | null;
  countedAt: Date | null;
  recount: { status: "PENDING" | "DONE"; reason: string | null; requestedByName: string | null; qty2: number | null } | null;
  verify: { qty: number; byName: string; at: Date; match: boolean } | null;
  conflict: { qty1: number | null; by1: string | null; qty2: number; by2: string; resolvedPick: "FIRST" | "VERIFY" | null } | null;
  movesAfter: { type: string; qty: number; ref: string; at: Date }[];
  netAfter: number;
  adjustedCount: number | null;
  bookNow: number;
  diff: number | null;
  value: string | null;
  pct: number | null;
  withinThreshold: boolean;
  overThreshold: boolean;
  requiresDualSign: boolean;
  decision: {
    action: "ADJUST" | "KEEP";
    reason: string;
    note: string | null;
    decidedByName: string | null;
    autoApplied: boolean;
  } | null;
  /** داخلي للاعتماد (لا يظهر في عقد الواجهة لكنه غير ضار). */
  unitCost: string;
  decidedBy: number | null;
  openConflict: boolean;
}

/**
 * تحميل بيانات المراجعة وحسابها — ٦ استعلامات مجمّعة (بلا N+1):
 * ١ الجلسة+الأسماء، ٢ الأصناف+التسميات، ٣ العدّات، ٤ أرصدة الآن، ٥ الحركات اللاحقة، ٦ القرارات.
 * المعادلات حرفياً من العقد §٢ (مصدرها jrd-data.jsx):
 *   rawCount = آخر RECOUNT وإلا FIRST (مع resolvedPick عند تعارض VERIFY)
 *   adjustedCount = rawCount + netAfter (عند autoAdjust)
 *   diff = adjustedCount − bookNow ، value = diff × unitCost(لقطة) ، pct = |diff|/expectedQty×100
 */
async function loadReviewCore(db: DbLike, sessionId: number, autoAdjust: boolean) {
  // (١) الجلسة.
  const s = await loadSessionHeader(db, sessionId);
  const branchId = Number(s.branchId);

  // (٢) الأصناف + المتغيّر/المنتج/الوحدة الأساس/التكليف/طالب إعادة العدّ.
  const requester = alias(users, "stkRecountReq");
  const itemRows = await db
    .select({
      variantId: stocktakeItems.variantId,
      expectedQty: stocktakeItems.expectedQty,
      unitCost: stocktakeItems.unitCost,
      recountStatus: stocktakeItems.recountStatus,
      recountReason: stocktakeItems.recountReason,
      recountRequestedByName: requester.name,
      assignmentName: stocktakeAssignments.name,
      zone: stocktakeAssignments.zone,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      baseUnit: productUnits.unitName,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, and(eq(productUnits.variantId, stocktakeItems.variantId), eq(productUnits.isBaseUnit, true)))
    .innerJoin(stocktakeAssignments, eq(stocktakeItems.assignmentId, stocktakeAssignments.id))
    .leftJoin(requester, eq(stocktakeItems.recountRequestedBy, requester.id))
    .where(eq(stocktakeItems.sessionId, sessionId))
    .orderBy(asc(stocktakeItems.id));
  // عدّة وحدات أساس لمتغيّر = صفوف مكرّرة من الـjoin ⇒ أول صف يفوز.
  const items: typeof itemRows = [];
  const seenVariants = new Set<number>();
  for (const r of itemRows) {
    const v = Number(r.variantId);
    if (seenVariants.has(v)) continue;
    seenVariants.add(v);
    items.push(r);
  }

  // (٣) كل العدّات مرتّبة زمنياً.
  const countRowsRaw = await db
    .select({
      id: stocktakeCounts.id,
      variantId: stocktakeCounts.variantId,
      kind: stocktakeCounts.kind,
      qty: stocktakeCounts.qty,
      countedByName: stocktakeCounts.countedByName,
      countedAt: stocktakeCounts.countedAt,
      isConflict: stocktakeCounts.isConflict,
      resolvedPick: stocktakeCounts.resolvedPick,
    })
    .from(stocktakeCounts)
    .where(eq(stocktakeCounts.sessionId, sessionId))
    .orderBy(asc(stocktakeCounts.countedAt), asc(stocktakeCounts.id));
  const countsByVariant = new Map<number, CountRow[]>();
  for (const c of countRowsRaw) {
    const v = Number(c.variantId);
    const list = countsByVariant.get(v) ?? [];
    list.push({
      id: Number(c.id),
      variantId: v,
      kind: c.kind,
      qty: c.qty,
      countedByName: c.countedByName,
      countedAt: c.countedAt,
      isConflict: !!c.isConflict,
      resolvedPick: c.resolvedPick ?? null,
    });
    countsByVariant.set(v, list);
  }

  // (٤) أرصدة الآن (bookNow) لكل أصناف الجلسة.
  const variantIds = items.map((r) => Number(r.variantId));
  const stockNow = new Map<number, number>();
  for (const part of chunk(variantIds)) {
    const rows = await db
      .select({ variantId: branchStock.variantId, quantity: branchStock.quantity })
      .from(branchStock)
      .where(and(eq(branchStock.branchId, branchId), inArray(branchStock.variantId, part)));
    for (const r of rows) stockNow.set(Number(r.variantId), r.quantity);
  }

  // (٥) الحركات بعد العدّ: حركات الفرع على الأصناف المعدودة منذ أقدم عدّ، ثم تُرشَّح
  // لكل صنف بعد لحظة عدّه الفعّال. تُستبعد تسويات هذه الجلسة نفسها (STOCKTAKE:<id>)
  // كي لا يلوّث الاعتماد السابق إعادة الحساب (idempotency/التقرير).
  const countedVariantIds = Array.from(countsByVariant.keys());
  let minCountedAt: Date | null = null;
  for (const list of Array.from(countsByVariant.values())) {
    for (const c of list) {
      if (!minCountedAt || c.countedAt < minCountedAt) minCountedAt = c.countedAt;
    }
  }
  type MoveRow = {
    variantId: number;
    movementType: string;
    quantity: number;
    referenceType: string | null;
    referenceId: number | null;
    notes: string | null;
    createdAt: Date;
  };
  const movesByVariant = new Map<number, MoveRow[]>();
  if (countedVariantIds.length && minCountedAt) {
    for (const part of chunk(countedVariantIds)) {
      const rows = await db
        .select({
          variantId: inventoryMovements.variantId,
          movementType: inventoryMovements.movementType,
          quantity: inventoryMovements.quantity,
          referenceType: inventoryMovements.referenceType,
          referenceId: inventoryMovements.referenceId,
          notes: inventoryMovements.notes,
          createdAt: inventoryMovements.createdAt,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.branchId, branchId),
            inArray(inventoryMovements.variantId, part),
            gt(inventoryMovements.createdAt, minCountedAt)
          )
        )
        .orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.id));
      for (const m of rows) {
        if (m.referenceType === "STOCKTAKE" && Number(m.referenceId) === sessionId) continue; // تسوية الجلسة نفسها
        const v = Number(m.variantId);
        const list = movesByVariant.get(v) ?? [];
        list.push({ ...m, variantId: v, referenceId: m.referenceId == null ? null : Number(m.referenceId) });
        movesByVariant.set(v, list);
      }
    }
  }

  // (٦) القرارات + اسم المقرِّر.
  const decisionRows = await db
    .select({
      variantId: stocktakeDecisions.variantId,
      action: stocktakeDecisions.action,
      finalQty: stocktakeDecisions.finalQty,
      diffQty: stocktakeDecisions.diffQty,
      value: stocktakeDecisions.value,
      reason: stocktakeDecisions.reason,
      note: stocktakeDecisions.note,
      decidedBy: stocktakeDecisions.decidedBy,
      decidedByName: users.name,
      autoApplied: stocktakeDecisions.autoApplied,
    })
    .from(stocktakeDecisions)
    .leftJoin(users, eq(stocktakeDecisions.decidedBy, users.id))
    .where(eq(stocktakeDecisions.sessionId, sessionId));
  const decisionMap = new Map(decisionRows.map((d) => [Number(d.variantId), d]));

  // ── الحساب لكل صنف ──
  const thresholdPct = money(String(s.thresholdPct));
  const thresholdValue = money(String(s.thresholdValue));
  const dualThreshold = money(String(s.dualThreshold));
  const directUnderThreshold = !!s.directUnderThreshold;

  const rows: ReviewRow[] = items.map((it) => {
    const v = Number(it.variantId);
    const cs = countsByVariant.get(v) ?? [];
    const firsts = cs.filter((c) => c.kind === "FIRST");
    const recounts = cs.filter((c) => c.kind === "RECOUNT");
    const verifies = cs.filter((c) => c.kind === "VERIFY");
    const first = firsts.length ? firsts[firsts.length - 1] : null;
    const recount = recounts.length ? recounts[recounts.length - 1] : null;
    const verify = verifies.length ? verifies[verifies.length - 1] : null;

    // العدّ الفعّال: RECOUNT الأحدث يحلّ محل الجميع؛ وإلا FIRST (أو VERIFY إن فُصل التعارض لصالحه).
    let used: CountRow | null = null;
    let kindUsed: "FIRST" | "RECOUNT" | null = null;
    if (recount) {
      used = recount;
      kindUsed = "RECOUNT";
    } else if (first) {
      if (verify && verify.isConflict && verify.resolvedPick === "VERIFY") used = verify;
      else used = first;
      kindUsed = "FIRST";
    }
    const rawCount = used ? used.qty : null;

    // تعارض مفتوح = VERIFY مخالف بلا فصل وبلا RECOUNT لاحق (العدّ الثالث يمسح التعارض).
    const openConflict = !!(verify && verify.isConflict && !verify.resolvedPick && !recount);
    const conflict = verify && verify.isConflict
      ? {
          qty1: first ? first.qty : null,
          by1: first ? first.countedByName : null,
          qty2: verify.qty,
          by2: verify.countedByName,
          resolvedPick: verify.resolvedPick,
        }
      : null;
    const verifyObj = verify
      ? { qty: verify.qty, byName: verify.countedByName, at: verify.countedAt, match: first ? verify.qty === first.qty : false }
      : null;
    const recountObj = it.recountStatus
      ? {
          status: it.recountStatus,
          reason: it.recountReason,
          requestedByName: it.recountRequestedByName,
          qty2: recount ? recount.qty : null,
        }
      : null;

    // الحركات بعد لحظة العدّ الفعّال (الإشارة حسب نوع الحركة — تطابق inventoryService).
    const allMoves = used ? (movesByVariant.get(v) ?? []).filter((m) => m.createdAt > used!.countedAt) : [];
    const movesAfter = allMoves.map((m) => ({
      type: MOVE_LABEL[m.movementType] ?? m.movementType,
      qty: signedMoveQty(m.movementType, m.quantity, m.notes),
      ref: m.referenceType ? `${m.referenceType}${m.referenceId != null ? `#${m.referenceId}` : ""}` : "—",
      at: m.createdAt,
    }));
    const netAfter = movesAfter.reduce((acc, m) => acc + m.qty, 0);

    const adjustedCount = rawCount == null ? null : rawCount + (autoAdjust ? netAfter : 0);
    const bookNow = stockNow.get(v) ?? 0;
    const diff = adjustedCount == null ? null : adjustedCount - bookNow;
    const unitCost = String(it.unitCost ?? "0");
    const valueDec = diff == null ? null : money(unitCost).times(diff);
    const value = valueDec == null ? null : toDbMoney(valueDec);
    // النسبة الخام للمقارنة بالحدّ (التقريب للعرض فقط — تقريبها قبل المقارنة يُمرّر 5.004% كـ«ضمن 5%»).
    const pctRaw = diff == null || it.expectedQty === 0 ? null : money(Math.abs(diff)).div(it.expectedQty).times(100);
    const pct = pctRaw == null ? null : pctRaw.toDecimalPlaces(2).toNumber();
    // «ضمن الحد»: pct≤حد النسبة (يُعفى إن تعذّر حسابه expectedQty=0 — كنموذج jrd-data) و|القيمة|≤حد القيمة.
    const pctOk = pctRaw == null || pctRaw.lte(thresholdPct);
    const valueOk = valueDec != null && valueDec.abs().lte(thresholdValue);
    const withinThreshold = diff != null && pctOk && valueOk;
    const overThreshold = diff != null && diff !== 0 && !withinThreshold;
    const requiresDualSign = valueDec != null && valueDec.abs().gt(dualThreshold);

    const d = decisionMap.get(v);
    const decision = d
      ? {
          action: d.action,
          reason: d.reason,
          note: d.note,
          decidedByName: d.decidedBy == null ? null : (d.decidedByName ?? "—"),
          autoApplied: !!d.autoApplied,
        }
      : null;

    return {
      variantId: v,
      productName: String(it.productName ?? ""),
      variantName: it.variantName,
      sku: it.sku,
      baseUnit: it.baseUnit,
      zone: it.zone,
      assignmentName: it.assignmentName,
      expectedQty: it.expectedQty,
      rawCount,
      kindUsed,
      countedByName: used ? used.countedByName : null,
      countedAt: used ? used.countedAt : null,
      recount: recountObj,
      verify: verifyObj,
      conflict,
      movesAfter,
      netAfter,
      adjustedCount,
      bookNow,
      diff,
      value,
      pct,
      withinThreshold,
      overThreshold,
      requiresDualSign,
      decision,
      unitCost,
      decidedBy: d?.decidedBy == null ? null : Number(d.decidedBy),
      openConflict,
    };
  });

  return { s, rows, directUnderThreshold };
}

/** هل سيُسوّى الصف عند الاعتماد؟ (قرار ADJUST صريح، أو تلقائي ضمن الحد عند directUnderThreshold). */
function willAdjust(row: ReviewRow, directUnderThreshold: boolean): boolean {
  if (row.diff == null || row.diff === 0) return false;
  if (row.decision) return row.decision.action === "ADJUST";
  return row.withinThreshold && directUnderThreshold;
}

function buildTotals(rows: ReviewRow[]) {
  let counted = 0;
  let matched = 0;
  let over = 0;
  let short = 0;
  let overThr = 0;
  let netValue = money(0);
  let shortValue = money(0);
  let overValue = money(0);
  for (const r of rows) {
    if (r.diff == null) continue;
    counted++;
    if (r.diff === 0) matched++;
    else if (r.diff > 0) {
      over++;
      overValue = overValue.plus(money(r.value ?? 0));
    } else {
      short++;
      shortValue = shortValue.plus(money(r.value ?? 0));
    }
    if (r.overThreshold) overThr++;
    netValue = netValue.plus(money(r.value ?? 0));
  }
  return {
    total: rows.length,
    counted,
    matched,
    over,
    short,
    overThr,
    netValue: toDbMoney(netValue),
    shortValue: toDbMoney(shortValue),
    overValue: toDbMoney(overValue),
  };
}

/** معاينة القيد الدفتري: عجز/زيادة لما سيُسوّى فعلاً (KEEP لا يدخل القيد). */
function buildLedgerPreview(rows: ReviewRow[], directUnderThreshold: boolean) {
  let shortExpense = money(0);
  let overGain = money(0);
  for (const r of rows) {
    if (!willAdjust(r, directUnderThreshold)) continue;
    const v = money(r.value ?? 0);
    if ((r.diff ?? 0) < 0) shortExpense = shortExpense.plus(v.abs());
    else overGain = overGain.plus(v);
  }
  return { shortExpense: toDbMoney(shortExpense), overGain: toDbMoney(overGain) };
}

function buildBarriers(
  rows: ReviewRow[],
  s: Awaited<ReturnType<typeof loadSessionHeader>>,
  directUnderThreshold: boolean,
  viewerId?: number
) {
  const notCounted = rows.filter((r) => r.rawCount == null).length;
  const pendingRecounts = rows.filter((r) => r.recount?.status === "PENDING").length;
  const openConflicts = rows.filter((r) => r.openConflict).length;
  // يحتاج قراراً صريحاً: يتجاوز الحد دائماً؛ وكل فرق ≠0 عندما تكون التسوية المباشرة معطّلة.
  const undecidedOverThreshold = rows.filter((r) => {
    if (r.diff == null || r.diff === 0 || r.decision) return false;
    if (r.recount?.status === "PENDING" || r.openConflict) return false; // محسوبة في حاجزها
    return r.overThreshold || !directUnderThreshold;
  }).length;
  const requiresDualSign = rows.some((r) => r.requiresDualSign && willAdjust(r, directUnderThreshold));
  const firstSigned = s.firstSignBy != null;
  const canApprove =
    s.status === "REVIEW" && pendingRecounts === 0 && openConflicts === 0 && undecidedOverThreshold === 0;
  const canFinalApprove =
    canApprove &&
    (!requiresDualSign || (firstSigned && viewerId != null && Number(s.firstSignBy) !== Number(viewerId)));
  return { notCounted, pendingRecounts, openConflicts, undecidedOverThreshold, requiresDualSign, firstSigned, canApprove, canFinalApprove };
}

function buildReviewSession(s: Awaited<ReturnType<typeof loadSessionHeader>>) {
  return {
    id: Number(s.id),
    code: s.code,
    name: s.name,
    branchId: Number(s.branchId),
    branchName: s.branchName ?? "—",
    status: s.status,
    blind: !!s.blind,
    thresholdPct: String(s.thresholdPct),
    thresholdValue: String(s.thresholdValue),
    dualThreshold: String(s.dualThreshold),
    directUnderThreshold: !!s.directUnderThreshold,
    dupPolicy: s.dupPolicy,
    createdAt: s.createdAt,
    createdByName: s.createdByName ?? "—",
    submittedAt: s.submittedAt,
    firstSign: s.firstSignBy ? { byName: s.firstSignByName ?? "—", at: s.firstSignAt } : null,
    approved: s.approvedBy ? { byName: s.approvedByName ?? "—", at: s.approvedAt } : null,
  };
}

/** مخرج شاشة المراجعة — العقد §٤ حرفياً. الصفوف لا تتضمن أسراراً إضافية للمدير+. */
export async function computeStocktakeReview(
  sessionId: number,
  opts: { autoAdjust?: boolean; viewerId?: number } = {}
) {
  const db = requireDb();
  const autoAdjust = opts.autoAdjust ?? true;
  const { s, rows, directUnderThreshold } = await loadReviewCore(db, sessionId, autoAdjust);
  return {
    session: buildReviewSession(s),
    rows: rows.map(({ decidedBy: _db2, openConflict: _oc, ...pub }) => pub),
    totals: buildTotals(rows),
    barriers: buildBarriers(rows, s, directUnderThreshold, opts.viewerId),
    ledgerPreview: buildLedgerPreview(rows, directUnderThreshold),
  };
}


// تصدير داخلي للحزمة فقط (يستهلكه reviewActions/finalize/report) — لا يُعاد تصديره من البرميل
// stocktakeService.ts ⇒ يبقى خارج الواجهة العامة.
export { loadReviewCore, willAdjust, buildReviewSession };

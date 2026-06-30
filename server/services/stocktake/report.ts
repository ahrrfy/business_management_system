// مخرجات الجرد النهائية: المحضر (مرجعه القرارات المثبَّتة للمعتمدة) وقوائم العدّ الورقية العمياء.
import type Decimal from "decimal.js";
import { and, asc, eq } from "drizzle-orm";
import {
  products,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeDecisions,
  stocktakeItems,
  users,
} from "../../../drizzle/schema";
import { money, toDbMoney } from "../money";
import { requireDb } from "../tx";
import { assertBranchAccess, loadSessionHeader } from "./internal";
import { buildReviewSession, loadReviewCore, willAdjust, type ReviewRow } from "./reviewCore";

/**
 * بيانات المحضر النهائي. للجلسة المعتمدة المرجع هو «القرارات المثبَّتة» (finalQty/diffQty/value
 * كُتبت لحظة الاعتماد) لا إعادة الحساب الحيّ — لأن التسوية نفسها صفّرت الفروق الحيّة بعد التنفيذ.
 */
export async function getStocktakeReport(sessionId: number) {
  const db = requireDb();
  const { s, rows, directUnderThreshold } = await loadReviewCore(db, sessionId, true);
  const approved = s.status === "APPROVED";

  // قرارات مخزّنة (المرجع بعد الاعتماد).
  const stored = await db
    .select({
      variantId: stocktakeDecisions.variantId,
      action: stocktakeDecisions.action,
      finalQty: stocktakeDecisions.finalQty,
      diffQty: stocktakeDecisions.diffQty,
      value: stocktakeDecisions.value,
      reason: stocktakeDecisions.reason,
      note: stocktakeDecisions.note,
      autoApplied: stocktakeDecisions.autoApplied,
      decidedByName: users.name,
      decidedBy: stocktakeDecisions.decidedBy,
    })
    .from(stocktakeDecisions)
    .leftJoin(users, eq(stocktakeDecisions.decidedBy, users.id))
    .where(eq(stocktakeDecisions.sessionId, sessionId));
  const storedMap = new Map(stored.map((d) => [Number(d.variantId), d]));

  const reportRows = rows.map(({ decidedBy: _db2, openConflict: _oc, ...r }) => {
    const d = storedMap.get(r.variantId);
    if (approved && d) {
      // قيم لحظة الاعتماد هي الحقيقة التاريخية للمحضر.
      return {
        ...r,
        adjustedCount: d.finalQty ?? r.adjustedCount,
        diff: d.diffQty ?? r.diff,
        value: d.value == null ? r.value : String(d.value),
        decision: {
          action: d.action,
          reason: d.reason,
          note: d.note,
          decidedByName: d.decidedBy == null ? null : (d.decidedByName ?? "—"),
          autoApplied: !!d.autoApplied,
        },
      };
    }
    return r;
  });

  // إجماليات المحضر: من القيم المعروضة نفسها (المخزّنة للمعتمدة، الحيّة للمعاينة).
  let counted = 0;
  let matched = 0;
  let over = 0;
  let short = 0;
  let netValue = money(0);
  let shortValue = money(0);
  let overValue = money(0);
  for (const r of reportRows) {
    if (r.diff == null) continue;
    counted++;
    const v = money(r.value ?? 0);
    if (r.diff === 0) matched++;
    else if (r.diff > 0) {
      over++;
      overValue = overValue.plus(v);
    } else {
      short++;
      shortValue = shortValue.plus(v);
    }
    netValue = netValue.plus(v);
  }

  // تحليل الانكماش حسب السبب: التسويات المنفَّذة فقط (action=ADJUST و diff≠0).
  const shrinkMap = new Map<string, { count: number; value: Decimal }>();
  for (const r of reportRows) {
    if (!r.decision || r.decision.action !== "ADJUST" || r.diff == null || r.diff === 0) continue;
    const key = r.decision.reason;
    const agg = shrinkMap.get(key) ?? { count: 0, value: money(0) };
    agg.count += 1;
    agg.value = agg.value.plus(money(r.value ?? 0));
    shrinkMap.set(key, agg);
  }

  // قيد الدفتر: عجز/زيادة المسوّى فعلاً (يطابق dedupeKey STOCKTAKE:<id>:SHORT/:OVER).
  let shortExpense = money(0);
  let overGain = money(0);
  for (const r of reportRows) {
    const adjusted = r.decision ? r.decision.action === "ADJUST" : !approved && willAdjust(r as unknown as ReviewRow, directUnderThreshold);
    if (!adjusted || r.diff == null || r.diff === 0) continue;
    const v = money(r.value ?? 0);
    if (r.diff < 0) shortExpense = shortExpense.plus(v.abs());
    else overGain = overGain.plus(v);
  }

  return {
    session: buildReviewSession(s),
    rows: reportRows,
    totals: {
      total: reportRows.length,
      counted,
      matched,
      over,
      short,
      netValue: toDbMoney(netValue),
      shortValue: toDbMoney(shortValue),
      overValue: toDbMoney(overValue),
    },
    shrinkage: Array.from(shrinkMap.entries()).map(([reason, agg]) => ({
      reason,
      count: agg.count,
      value: toDbMoney(agg.value),
    })),
    ledger: { shortExpense: toDbMoney(shortExpense), overGain: toDbMoney(overGain) },
  };
}

/** قوائم العدّ الورقية — عمياء بالكامل: صنف/باركود/وحدة فقط، بلا expectedQty ولا تكلفة. */
export async function getStocktakeCountSheets(sessionId: number, opts: { restrictBranchId?: number | null } = {}) {
  const db = requireDb();
  const s = await loadSessionHeader(db, sessionId);
  assertBranchAccess(Number(s.branchId), opts.restrictBranchId);

  const asg = await db
    .select({
      id: stocktakeAssignments.id,
      name: stocktakeAssignments.name,
      method: stocktakeAssignments.method,
      zone: stocktakeAssignments.zone,
    })
    .from(stocktakeAssignments)
    .where(eq(stocktakeAssignments.sessionId, sessionId))
    .orderBy(asc(stocktakeAssignments.id));

  const itemRows = await db
    .select({
      assignmentId: stocktakeItems.assignmentId,
      variantId: stocktakeItems.variantId,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      barcode: productUnits.barcode,
      baseUnit: productUnits.unitName,
    })
    .from(stocktakeItems)
    .innerJoin(productVariants, eq(stocktakeItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, and(eq(productUnits.variantId, stocktakeItems.variantId), eq(productUnits.isBaseUnit, true)))
    .where(eq(stocktakeItems.sessionId, sessionId))
    .orderBy(asc(products.name), asc(productVariants.id));

  const byAssignment = new Map<number, { productName: string; variantName: string | null; sku: string; barcode: string | null; baseUnit: string | null }[]>();
  const dedup = new Set<number>();
  for (const r of itemRows) {
    const v = Number(r.variantId);
    if (dedup.has(v)) continue; // ازدواج محتمل من join وحدات الأساس
    dedup.add(v);
    const aId = Number(r.assignmentId);
    const list = byAssignment.get(aId) ?? [];
    list.push({
      productName: String(r.productName ?? ""),
      variantName: r.variantName,
      sku: r.sku,
      barcode: r.barcode,
      baseUnit: r.baseUnit,
    });
    byAssignment.set(aId, list);
  }

  return {
    session: {
      id: Number(s.id),
      code: s.code,
      name: s.name,
      branchName: s.branchName ?? "—",
      blind: !!s.blind,
      status: s.status,
      createdAt: s.createdAt,
      createdByName: s.createdByName ?? "—",
    },
    sheets: asg.map((a) => ({
      assignment: { id: Number(a.id), name: a.name, method: a.method, zone: a.zone },
      items: byAssignment.get(Number(a.id)) ?? [],
    })),
  };
}

// الذكاء التشغيلي: اقتراحات الجرد الدوري ABC ومؤشر دقة المخزون IRA (من الجلسات المعتمدة).
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  branches,
  branchStock,
  inventoryMovements,
  products,
  productVariants,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { utcTodayStart } from "../businessDay";
import { money, toDbMoney } from "../money";
import { requireDb } from "../tx";

/** دوريّات الجرد الدوري ABC (README §٧). */
const ABC_FREQ_DAYS = { A: 30, B: 90, C: 180 } as const;
const ABC_FREQ_LABEL = { A: "شهرياً", B: "فصلياً", C: "نصف سنوياً" } as const;

export interface CycleSuggestionRow {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  abc: "A" | "B" | "C";
  freqDays: number;
  freqLabel: string;
  lastCountedAt: Date | null;
  /** أيام التأخر عن الدورية؛ null = لم يُجرد قط (الأكثر استحقاقاً). */
  daysOver: number | null;
  /** قيمة الاستهلاك السنوية (OUT×التكلفة) — تُحجب عن دور warehouse في الراوتر. */
  annualValue: string;
}

/**
 * اقتراحات الجرد الدوري ABC: قيمة استهلاك OUT آخر ٣٦٥ يوماً × costPrice، ترتيب تنازلي،
 * أول ٢٠٪ من الأصناف A (شهرياً) وثاني ٣٠٪ B (فصلياً) والباقي C (نصف سنوياً).
 * المستحق: lastCountedAt أقدم من الدورية أو NULL.
 */
export async function getCycleSuggestions(opts: { branchId?: number | null } = {}): Promise<CycleSuggestionRow[]> {
  const db = requireDb();
  const branchId = opts.branchId ?? null;
  const since = new Date(Date.now() - 365 * 86_400_000);

  // (١) كل المتغيّرات الفعّالة بأسمائها وتكلفتها.
  const variants = await db
    .select({
      variantId: productVariants.id,
      productName: products.name,
      variantName: productVariants.variantName,
      sku: productVariants.sku,
      costPrice: productVariants.costPrice,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(eq(productVariants.isActive, true), eq(products.isActive, true)));

  // (٢) استهلاك OUT آخر سنة (مجمّع — لا N+1).
  const outConds = [eq(inventoryMovements.movementType, "OUT"), gte(inventoryMovements.createdAt, since)];
  if (branchId != null) outConds.push(eq(inventoryMovements.branchId, branchId));
  const outRows = await db
    .select({ variantId: inventoryMovements.variantId, q: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)` })
    .from(inventoryMovements)
    .where(and(...outConds))
    .groupBy(inventoryMovements.variantId);
  const outMap = new Map(outRows.map((r) => [Number(r.variantId), String(r.q ?? "0")]));

  // (٣) آخر جرد معتمد لكل متغيّر (فرع محدد، أو الأحدث عبر الفروع).
  const lcConds = branchId != null ? [eq(branchStock.branchId, branchId)] : [];
  const lcRows = await db
    .select({ variantId: branchStock.variantId, last: sql<Date | null>`MAX(${branchStock.lastCountedAt})` })
    .from(branchStock)
    .where(lcConds.length ? and(...lcConds) : undefined)
    .groupBy(branchStock.variantId);
  const lastMap = new Map(lcRows.map((r) => [Number(r.variantId), r.last]));

  // ترتيب تنازلي بقيمة الاستهلاك ثم تصنيف بالعدد: أول ٢٠٪ A، ثاني ٣٠٪ B، الباقي C.
  const valued = variants.map((v) => ({
    variantId: Number(v.variantId),
    productName: String(v.productName ?? ""),
    variantName: v.variantName,
    sku: v.sku,
    annualValue: money(outMap.get(Number(v.variantId)) ?? 0).times(money(String(v.costPrice ?? "0"))),
  }));
  valued.sort((a, b) => b.annualValue.comparedTo(a.annualValue));
  const n = valued.length;
  const aCut = Math.ceil(n * 0.2);
  const bCut = Math.ceil(n * 0.5);

  const now = Date.now();
  const out: CycleSuggestionRow[] = [];
  valued.forEach((v, idx) => {
    const abc: "A" | "B" | "C" = idx < aCut ? "A" : idx < bCut ? "B" : "C";
    const freqDays = ABC_FREQ_DAYS[abc];
    const lastRaw = lastMap.get(v.variantId) ?? null;
    const last = lastRaw ? new Date(lastRaw) : null;
    const days = last ? Math.floor((now - last.getTime()) / 86_400_000) : null;
    const due = days == null ? true : days > freqDays;
    if (!due) return;
    out.push({
      variantId: v.variantId,
      productName: v.productName,
      variantName: v.variantName,
      sku: v.sku,
      abc,
      freqDays,
      freqLabel: ABC_FREQ_LABEL[abc],
      lastCountedAt: last,
      daysOver: days == null ? null : days - freqDays,
      annualValue: toDbMoney(v.annualValue),
    });
  });
  // الأكثر تأخراً أولاً؛ «لم يُجرد قط» في الصدارة.
  out.sort((a, b) => (b.daysOver ?? Number.MAX_SAFE_INTEGER) - (a.daysOver ?? Number.MAX_SAFE_INTEGER));
  return out;
}

export interface IraStatsResult {
  branches: { branchId: number; name: string; months: { ym: string; ira: number | null }[] }[];
  workers: { name: string; accuracy: number; counts: number }[];
}

/**
 * مؤشر دقة المخزون IRA — من الجلسات المعتمدة فعلياً:
 * شهرياً (آخر ٦ أشهر) لكل فرع: matched/counted من stocktakeDecisions.diffQty=0،
 * ودقة كل عامل بإسناد كل صنف معدود لصاحب العدّ الفعّال (RECOUNT الأحدث وإلا FIRST/فصل التعارض).
 */
export async function getIraStats(): Promise<IraStatsResult> {
  const db = requireDb();
  // أول الشهر قبل ٥ أشهر بـUTC (النافذة = ٦ أشهر شاملةً الحاليّ). البناء بـDate.UTC حتميّ ومستقلّ
  // عن منطقة عملية Node (تدقيق ١٧/٧، #٧) — كان setDate/setHours/setMonth المحليّة تَنزاح على غير TZ=UTC.
  const now = utcTodayStart();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

  const sessions = await db
    .select({
      id: stocktakeSessions.id,
      branchId: stocktakeSessions.branchId,
      branchName: branches.name,
      approvedAt: stocktakeSessions.approvedAt,
    })
    .from(stocktakeSessions)
    .leftJoin(branches, eq(stocktakeSessions.branchId, branches.id))
    .where(and(eq(stocktakeSessions.status, "APPROVED"), gte(stocktakeSessions.approvedAt, monthStart)));

  const ymOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const months: string[] = [];
  {
    const cur = new Date(monthStart);
    for (let i = 0; i < 6; i++) {
      months.push(ymOf(cur));
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  }

  const sessionIds = sessions.map((r) => Number(r.id));
  const sessionMeta = new Map(
    sessions.map((r) => [
      Number(r.id),
      { branchId: Number(r.branchId), branchName: r.branchName ?? "—", ym: r.approvedAt ? ymOf(new Date(r.approvedAt)) : null },
    ])
  );

  type Agg = { matched: number; counted: number };
  const branchMonthly = new Map<number, { name: string; byYm: Map<string, Agg> }>();
  const workerAgg = new Map<string, Agg>();

  if (sessionIds.length) {
    const decisions = await db
      .select({ sessionId: stocktakeDecisions.sessionId, variantId: stocktakeDecisions.variantId, diffQty: stocktakeDecisions.diffQty })
      .from(stocktakeDecisions)
      .where(inArray(stocktakeDecisions.sessionId, sessionIds));

    const counts = await db
      .select({
        sessionId: stocktakeCounts.sessionId,
        variantId: stocktakeCounts.variantId,
        kind: stocktakeCounts.kind,
        countedByName: stocktakeCounts.countedByName,
        countedAt: stocktakeCounts.countedAt,
        id: stocktakeCounts.id,
        isConflict: stocktakeCounts.isConflict,
        resolvedPick: stocktakeCounts.resolvedPick,
      })
      .from(stocktakeCounts)
      .where(inArray(stocktakeCounts.sessionId, sessionIds))
      .orderBy(asc(stocktakeCounts.countedAt), asc(stocktakeCounts.id));

    // صاحب العدّ الفعّال لكل (جلسة×صنف) — نفس قاعدة rawCount في المراجعة.
    const effOwner = new Map<string, string>();
    {
      const grouped = new Map<string, typeof counts>();
      for (const c of counts) {
        const k = `${Number(c.sessionId)}:${Number(c.variantId)}`;
        const list = grouped.get(k) ?? [];
        list.push(c);
        grouped.set(k, list);
      }
      for (const [k, list] of Array.from(grouped.entries())) {
        const firsts = list.filter((c) => c.kind === "FIRST");
        const recounts = list.filter((c) => c.kind === "RECOUNT");
        const verifies = list.filter((c) => c.kind === "VERIFY");
        const first = firsts[firsts.length - 1];
        const recount = recounts[recounts.length - 1];
        const verify = verifies[verifies.length - 1];
        let owner: string | undefined;
        if (recount) owner = recount.countedByName;
        else if (first) {
          owner = verify && verify.isConflict && verify.resolvedPick === "VERIFY" ? verify.countedByName : first.countedByName;
        }
        if (owner) effOwner.set(k, owner);
      }
    }

    for (const d of decisions) {
      const meta = sessionMeta.get(Number(d.sessionId));
      if (!meta || !meta.ym) continue;
      const matched = d.diffQty === 0 ? 1 : 0;

      let bm = branchMonthly.get(meta.branchId);
      if (!bm) {
        bm = { name: meta.branchName, byYm: new Map() };
        branchMonthly.set(meta.branchId, bm);
      }
      const agg = bm.byYm.get(meta.ym) ?? { matched: 0, counted: 0 };
      agg.matched += matched;
      agg.counted += 1;
      bm.byYm.set(meta.ym, agg);

      const owner = effOwner.get(`${Number(d.sessionId)}:${Number(d.variantId)}`);
      if (owner) {
        const w = workerAgg.get(owner) ?? { matched: 0, counted: 0 };
        w.matched += matched;
        w.counted += 1;
        workerAgg.set(owner, w);
      }
    }
  }

  // كل الفروع الفعّالة تظهر (حتى بلا بيانات — ira=null) ليكتمل اتجاه البطاقة.
  const allBranches = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(eq(branches.isActive, true))
    .orderBy(asc(branches.id));

  return {
    branches: allBranches.map((b) => {
      const bm = branchMonthly.get(Number(b.id));
      return {
        branchId: Number(b.id),
        name: b.name,
        months: months.map((ym) => {
          const agg = bm?.byYm.get(ym);
          const ira =
            agg && agg.counted > 0
              ? money(agg.matched).div(agg.counted).times(100).toDecimalPlaces(1).toNumber()
              : null;
          return { ym, ira };
        }),
      };
    }),
    workers: Array.from(workerAgg.entries())
      .map(([name, w]) => ({
        name,
        accuracy: w.counted > 0 ? money(w.matched).div(w.counted).times(100).toDecimalPlaces(1).toNumber() : 0,
        counts: w.counted,
      }))
      .sort((a, b) => b.accuracy - a.accuracy),
  };
}

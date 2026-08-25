/**
 * لقطاتُ تقييم المخزون عند إقفال الفترة (P1-#2، ٢٥/٨).
 *
 * مساعدٌ خفيفٌ يُوحّد الالتقاطَ والقراءة من `inventoryValuationSnapshots`. الحاجةُ الأصليّة:
 * `approveMonthClose` يُقفل الفترة ماليّاً لكنّ تقييمَ المخزون يبقى حيّاً — حركةٌ بعد الإقفال
 * تُغيّر رقمَ الميزانية بأثرٍ رجعيّ. اللقطةُ تجمّد الرقمَ الذي دخل الميزانية عند الاعتماد
 * فيبقى قابلاً للاستنساخ لاحقاً.
 *
 * التصميم:
 *   - عمليةُ الالتقاط ذرّيّة داخل نفس معاملة `approveMonthClose` — لا لقطةٌ بلا قفل ولا العكس.
 *   - القراءةُ تتّبع أولوية: (١) لقطةٌ COMPANY للفترة، (٢) عند غيابها ترجع الحالةَ الحيّة
 *     (fallback شفّاف للفترات ما قبل هذه الهجرة).
 *
 * ⚠️ لا تعديلَ للقطةٍ مكتوبة: أيّ تصحيحٍ يستلزم إلغاءَ إقفال الفترة (revision جديد) — لقطةٌ
 * جديدة تُنسَخ للفترة الجديدة، والقديمة تبقى للسجلّ التدقيقيّ.
 */
import { and, eq } from "drizzle-orm";
import {
  financialPeriods,
  inventoryValuationSnapshots,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { readInventoryValuation, type InventoryValuation } from "./valuation";

export interface CaptureSnapshotArgs {
  /** الفترة المُقفَلة التي تُلتقط اللقطة لها. */
  periodLockId: number;
  /** تاريخُ نهاية الفترة (الأصلُ الذي تُمثّله اللقطة). */
  cutoffDate: string;
  /** المُعتمِد — يُشغّل الالتقاط. */
  capturedBy: number;
}

export interface CapturedSnapshotResult {
  snapshotId: number;
  totalValue: string;
  stockValue: string;
  inTransitValue: string;
}

/**
 * يلتقط لقطةَ تقييمٍ على مستوى الشركة (`scopeKey='COMPANY'`) للفترة المُمَرَّرة.
 * يُستدعى داخل معاملة إقفال الشهر ⇒ فشلٌ في القراءة أو الكتابة يُلغي الإقفال كاملاً.
 */
export async function captureCompanyValuationSnapshot(
  tx: Tx,
  args: CaptureSnapshotArgs,
): Promise<CapturedSnapshotResult> {
  // MySQL يعامل NULL في UNIQUE على أنه «متمايز»، فقيدُ (periodLockId, scopeKey, branchId) لا
  // يمنع لقطتَين COMPANY لنفس الفترة (branchId=NULL). نفحص تطبيقياً بنفس المعاملة قبل الإدراج
  // كي لا نتلقّى صفَّين. اختبارٌ صريح يُثبت الرفض.
  const [existing] = await tx
    .select({ id: inventoryValuationSnapshots.id })
    .from(inventoryValuationSnapshots)
    .where(
      and(
        eq(inventoryValuationSnapshots.periodLockId, args.periodLockId),
        eq(inventoryValuationSnapshots.scopeKey, "COMPANY"),
      ),
    )
    .limit(1);
  if (existing) {
    throw new Error(
      `لقطةُ تقييمٍ COMPANY موجودةٌ سلفاً للفترة #${args.periodLockId} — لا تُلتقط ثانيةً (revision جديد يُنشئ periodLockId جديداً).`,
    );
  }
  const valuation: InventoryValuation = await readInventoryValuation(tx);
  // stockValue = totalValue − inTransitValue (يحفظ الثابت المحاسبيّ صراحةً).
  const totalNum = Number(valuation.total);
  const inTransitNum = Number(valuation.inTransitTotal);
  const stockNum = (totalNum - inTransitNum).toFixed(2);
  const res = await tx.insert(inventoryValuationSnapshots).values({
    periodLockId: args.periodLockId,
    cutoffDate: args.cutoffDate,
    capturedBy: args.capturedBy,
    scopeKey: "COMPANY",
    branchId: null,
    totalValue: valuation.total,
    stockValue: stockNum,
    inTransitValue: valuation.inTransitTotal,
    branchesJson: JSON.stringify(valuation.branches),
  });
  return {
    snapshotId: extractInsertId(res),
    totalValue: valuation.total,
    stockValue: stockNum,
    inTransitValue: valuation.inTransitTotal,
  };
}

export interface SnapshotBranch {
  branchId: number;
  value: string;
  inTransitValue?: string;
}

export interface HistoricalValuation {
  source: "SNAPSHOT" | "LIVE";
  cutoffDate: string;
  totalValue: string;
  stockValue: string;
  inTransitValue: string;
  branches: SnapshotBranch[];
  capturedAt?: Date;
  capturedBy?: number;
}

/**
 * يُعيد التقييمَ كما كان في تاريخٍ معيّن: لقطةُ COMPANY للفترة التي تحمل نفس `cutoffDate` إن
 * وُجدت (SNAPSHOT)، وإلّا يُقدَّر بالحالة الحيّة (LIVE) — بحيث تستمرّ الفترات ما قبل هذه
 * الهجرة بالعمل بلا انهيار. المستدعي يرى المصدرَ صراحةً كي لا يُقدّم LIVE على أنّه تاريخيّ.
 */
export async function readValuationAt(
  tx: Tx,
  cutoffDate: string,
): Promise<HistoricalValuation> {
  const [snap] = await tx
    .select()
    .from(inventoryValuationSnapshots)
    .where(
      and(
        eq(inventoryValuationSnapshots.cutoffDate, cutoffDate),
        eq(inventoryValuationSnapshots.scopeKey, "COMPANY"),
      ),
    )
    .limit(1);
  if (snap) {
    const branches = snap.branchesJson
      ? (JSON.parse(snap.branchesJson) as SnapshotBranch[])
      : [];
    return {
      source: "SNAPSHOT",
      cutoffDate: String(snap.cutoffDate),
      totalValue: String(snap.totalValue),
      stockValue: String(snap.stockValue),
      inTransitValue: String(snap.inTransitValue),
      branches,
      capturedAt: snap.capturedAt,
      capturedBy: snap.capturedBy == null ? undefined : Number(snap.capturedBy),
    };
  }
  // Fallback: لا لقطةَ ⇒ نُعيد الحالةَ الحيّة موسومةً بـLIVE (لا لبس على القارئ).
  const live = await readInventoryValuation(tx);
  return {
    source: "LIVE",
    cutoffDate,
    totalValue: live.total,
    stockValue: (Number(live.total) - Number(live.inTransitTotal)).toFixed(2),
    inTransitValue: live.inTransitTotal,
    branches: live.branches,
  };
}

/**
 * يبحث عن لقطة الفترة بمعرّفها الداخليّ — للاستدعاء من الشاشات التي تعرف periodLockId مباشرةً
 * (مثل شاشة الميزانية المفتوحة من قائمة الإقفال). يشمل معلومات الفترة الأصليّة.
 */
export async function readValuationForPeriod(
  tx: Tx,
  periodLockId: number,
): Promise<(HistoricalValuation & { periodLockId: number; closeMonth: string | null }) | null> {
  const [row] = await tx
    .select({
      snap: inventoryValuationSnapshots,
      period: financialPeriods,
    })
    .from(inventoryValuationSnapshots)
    .innerJoin(financialPeriods, eq(financialPeriods.id, inventoryValuationSnapshots.periodLockId))
    .where(
      and(
        eq(inventoryValuationSnapshots.periodLockId, periodLockId),
        eq(inventoryValuationSnapshots.scopeKey, "COMPANY"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const branches = row.snap.branchesJson
    ? (JSON.parse(row.snap.branchesJson) as SnapshotBranch[])
    : [];
  return {
    source: "SNAPSHOT",
    cutoffDate: String(row.snap.cutoffDate),
    totalValue: String(row.snap.totalValue),
    stockValue: String(row.snap.stockValue),
    inTransitValue: String(row.snap.inTransitValue),
    branches,
    capturedAt: row.snap.capturedAt,
    capturedBy: row.snap.capturedBy == null ? undefined : Number(row.snap.capturedBy),
    periodLockId,
    closeMonth: row.period.closeMonth,
  };
}


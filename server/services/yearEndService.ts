/**
 * إقفال سنوي + رولوفر Retained Earnings — المرحلة ٦ (١٩/٦/٢٦).
 *
 * المنطق:
 * - closeYear(year, branchId?, closedBy):
 *    ١. يحسب totals السنة من accountingEntries (revenue/cogs/expenses).
 *    ٢. يكتب lockPeriod(cutoffDate = Dec 31 من السنة) ⇒ منع تعديل صامت لاحقاً.
 *    ٣. ينشر قيد ADJUST واحد (Retained Earnings carry-over) بـdedupeKey = YEAR_CLOSE:<year>:<branchId|0>
 *       ⇒ amount = netProfit، يظهر في GL السنة الجديدة كـopening balance منطقي.
 *    ٤. يحفظ yearEndSnapshot بكل الأرقام + رابط للقيد + snapshotData JSON كنسخة احتياطية.
 *
 * idempotency: UNIQUE(year, branchId) على yearEndSnapshots + UNIQUE(dedupeKey) على
 * accountingEntries ⇒ استدعاء closeYear مرتين لنفس السنة مرفوض.
 *
 * فتح الإقفال: لا fn — يلزم تدخل admin يدوي (unlockLatestPeriod + DELETE snapshot).
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { accountingEntries, financialPeriods, yearEndSnapshots } from "../../drizzle/schema";
import { extractInsertId } from "../lib/insertId";
import type { Tx } from "../db";
import { money, round2, toDbMoney } from "./money";
import { postEntry } from "./ledgerService";
import { lockPeriod } from "./periodLockService";

export interface CloseYearInput {
  year: number; // مثل 2025
  branchId?: number | null; // null = إقفال على مستوى الشركة (مجموع كل الفروع)
  closedBy: number;
}

export interface CloseYearResult {
  snapshotId: number;
  retainedEarningsEntryId: number | null;
  periodLockId: number;
  year: number;
  branchId: number | null;
  totalRevenue: string;
  totalCogs: string;
  totalExpenses: string;
  netProfit: string;
}

/** يحسب أرقام السنة من dedicated SELECT — لا يخرّب القيود.
 *  revenue/cogs من SALE+RETURN (RETURN بقيم سالبة فتُطرَح طبيعياً عبر SUM).
 *  expenses من PAYMENT_OUT (مصاريف نقدية) + INTERNAL_USE + WASTAGE (مصاريف مخزنية بالكلفة). */
async function computeYearTotals(tx: Tx, year: number, branchId: number | null): Promise<{
  revenue: Decimal; cogs: Decimal; expenses: Decimal;
}> {
  const branchFilter = branchId != null ? sql`AND branchId = ${branchId}` : sql``;
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const rows = await tx.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN entryType IN ('SALE','RETURN') THEN CAST(revenue AS DECIMAL(15,2)) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN entryType IN ('SALE','RETURN') THEN CAST(cost AS DECIMAL(15,2)) ELSE 0 END), 0) AS cogs,
      COALESCE(SUM(CASE WHEN entryType = 'PAYMENT_OUT' AND invoiceId IS NULL AND supplierId IS NULL THEN CAST(amount AS DECIMAL(15,2)) ELSE 0 END), 0) AS cashExpenses,
      COALESCE(SUM(CASE WHEN entryType IN ('INTERNAL_USE','WASTAGE') THEN CAST(cost AS DECIMAL(15,2)) ELSE 0 END), 0) AS stockExpenses,
      COALESCE(SUM(CASE WHEN entryType = 'EXCHANGE_FEE' THEN CAST(cost AS DECIMAL(15,2)) ELSE 0 END), 0) AS exchangeFee,
      COALESCE(SUM(CASE WHEN entryType = 'EXCHANGE_FX_DIFF' THEN CAST(amount AS DECIMAL(15,2)) ELSE 0 END), 0) AS exchangeFx
    FROM accountingEntries
    WHERE entryDate >= ${start}
      AND entryDate <= ${end}
    ${branchFilter}
  `);
  const data = (((rows as any)[0] ?? rows) as Array<any>) ?? [];
  const r = data[0] ?? {};
  return {
    revenue: money(String(r.revenue ?? "0")),
    cogs: money(String(r.cogs ?? "0")),
    // exchange-house: + عمولات الصيرفة (مصروف) − صافي فرق الصرف (مكسب يَخفض المصروف/خسارة تَرفعه).
    expenses: money(String(r.cashExpenses ?? "0"))
      .plus(money(String(r.stockExpenses ?? "0")))
      .plus(money(String(r.exchangeFee ?? "0")))
      .minus(money(String(r.exchangeFx ?? "0"))),
  };
}

export async function closeYear(tx: Tx, input: CloseYearInput): Promise<CloseYearResult> {
  const { year, closedBy } = input;
  const branchId = input.branchId ?? null;
  if (year < 2020 || year > 2100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "السنة خارج النطاق المعقول" });
  }

  // اقفال مكرّر؟ UNIQUE(year, branchId) سيرفع DUP_ENTRY — نلتقطها بصياغة TRPCError مفهومة.
  const existing = await tx
    .select({ id: yearEndSnapshots.id })
    .from(yearEndSnapshots)
    .where(
      branchId != null
        ? and(eq(yearEndSnapshots.year, year), eq(yearEndSnapshots.branchId, branchId))
        : and(eq(yearEndSnapshots.year, year), sql`${yearEndSnapshots.branchId} IS NULL`),
    )
    .limit(1);
  if (existing[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `السنة ${year}${branchId != null ? ` للفرع ${branchId}` : ""} مُقفَلة سابقاً (snapshot #${existing[0].id})`,
    });
  }

  // ١. احسب الإجماليات
  const { revenue, cogs, expenses } = await computeYearTotals(tx, year, branchId);
  const netProfit = round2(revenue.minus(cogs).minus(expenses));

  // ٢. قفل الفترة (cutoffDate = Dec 31)
  // #closing-2 (تدقيق التثبيت): كان lockPeriod يرفض cutoffDate ≤ قفل قائم ⇒ إقفال شهر ديسمبر
  // (أو أحدث) بنفس نمط الإقفال الشهري يمنع إقفال السنة كاملاً (تصادم مصيري). الحلّ: إن كان
  // القفل النشط يغطّي بالفعل ${year}-12-31، نعيد استعمال معرّفه ولا نُنشئ قفلاً جديداً — الفترة
  // مُقفَلة أصلاً بالمعنى المطلوب.
  const cutoffDate = `${year}-12-31`;
  const existingCovering = await tx
    .select({ id: financialPeriods.id, cutoffDate: financialPeriods.cutoffDate })
    .from(financialPeriods)
    .where(and(eq(financialPeriods.status, "LOCKED"), gte(financialPeriods.cutoffDate, cutoffDate)))
    .orderBy(desc(financialPeriods.cutoffDate))
    .limit(1);
  const periodLock = existingCovering[0]
    ? { id: existingCovering[0].id }
    : await lockPeriod(tx, {
        cutoffDate,
        lockedBy: closedBy,
        notes: `إقفال سنة ${year}${branchId != null ? ` (فرع ${branchId})` : ""}`,
      });

  // ٣. قيد Retained Earnings (يحفظ الـnetProfit في الدفتر السنة التالية كـopening conceptually).
  //    دلالة محاسبية: ADJUST بـrevenue=netProfit، profit=netProfit، amount=|netProfit|.
  //    entryDate = Jan 1 السنة التالية ⇒ يقع خارج الفترة المُقفَلة (المقفول حتى Dec 31).
  const rolloverDate = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));
  let retainedEarningsEntryId: number | null = null;
  if (!netProfit.isZero()) {
    // postEntry لا يعيد insertId — نستعمل SELECT بـdedupeKey بعد الإدراج.
    const dedupeKey = `YEAR_CLOSE:${year}:${branchId ?? 0}`;
    await postEntry(tx, {
      entryType: "ADJUST",
      dedupeKey,
      branchId,
      revenue: netProfit,
      profit: netProfit,
      amount: netProfit.abs(),
      entryDate: rolloverDate,
      notes: `Retained Earnings rollover من السنة ${year}${branchId != null ? ` فرع ${branchId}` : ""}`,
    });
    // اقرأ الـid للربط في snapshot
    const found = await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, dedupeKey))
      .limit(1);
    retainedEarningsEntryId = found[0]?.id != null ? Number(found[0].id) : null;
  }

  // ٤. snapshot
  const snapshotData = JSON.stringify({
    closedAt: rolloverDate.toISOString(),
    method: "automatic-year-end",
    branchScope: branchId != null ? "single-branch" : "company-wide",
  });
  const snapRes = await tx.insert(yearEndSnapshots).values({
    year,
    branchId,
    closedBy,
    totalRevenue: toDbMoney(revenue),
    totalCogs: toDbMoney(cogs),
    totalExpenses: toDbMoney(expenses),
    netProfit: toDbMoney(netProfit),
    retainedEarningsEntryId,
    snapshotData,
  });
  const snapshotId = extractInsertId(snapRes);

  return {
    snapshotId,
    retainedEarningsEntryId,
    periodLockId: periodLock.id,
    year,
    branchId,
    totalRevenue: revenue.toFixed(2),
    totalCogs: cogs.toFixed(2),
    totalExpenses: expenses.toFixed(2),
    netProfit: netProfit.toFixed(2),
  };
}

/** قائمة الإقفالات السابقة (للعرض في الواجهة). */
export async function listSnapshots(tx: Tx, filters: { year?: number; branchId?: number | null } = {}) {
  const where = [];
  if (filters.year != null) where.push(eq(yearEndSnapshots.year, filters.year));
  if (filters.branchId !== undefined) {
    where.push(filters.branchId === null ? sql`${yearEndSnapshots.branchId} IS NULL` : eq(yearEndSnapshots.branchId, filters.branchId));
  }
  const rows = await tx
    .select()
    .from(yearEndSnapshots)
    .where(where.length ? and(...where) : sql`1=1`)
    .orderBy(sql`${yearEndSnapshots.year} DESC, ${yearEndSnapshots.branchId} ASC`);
  return rows;
}

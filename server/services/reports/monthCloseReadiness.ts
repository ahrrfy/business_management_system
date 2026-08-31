// جاهزية الإقفال الشهري (ش٥ من docs/double-entry-p2-plan-2026-08-11.md).
//
// حزمة الإقفال (`monthlyClosePack.ts`) تعرض ولا تُقفِل: لا شيء يمنع إقفال شهرٍ فيه ورديةٌ مفتوحة
// أو سندٌ معلَّق. هذه الوحدة تُنتج **قائمة الجاهزية** التي تحكم زرّ الإقفال.
//
// تصنيف المالك (١١/٨) — عقدٌ لا اجتهاد:
//   🔴 يحجب: وردياتٌ مفتوحة · سنداتٌ بانتظار الاعتماد.
//   🟡 تنبيهٌ فقط: جلسات جردٍ نشطة · طلبات تسوية مخزونٍ معلّقة · فجوات الدفتر المزدوج.
//
// **للقراءة فقط.** فرضُ الحجز مسؤولية `closeMonth` في الراوتر، ويُعيد استدعاء هذه الوحدة
// خادمياً تحت المعاملة — لا يُصدَّق ادّعاء الواجهة (وإلّا فتح طلبٌ مُلفَّقٌ بابَ الإقفال).
//
// الرواتب حاصرٌ ثالث على مستوى الشركة: وجود موظفٍ مستحقّ بلا مسيّر معتمد ومؤرّخ بنهاية الشهر يمنع الإقفال.
// **لماذا لا تشمل انحراف المطابقات:** دوالّ `reconcileService` غير مُنطَّقةٍ بشهرٍ ولا بفرع (تمسح
// كل الأطراف)، فإقحامُها في فحصٍ مُنطَّقٍ بهما يُنتج بنداً لا يعني ما يقوله. تُضاف في ش٤ حين
// تُنطَّق بحقّ عبر `reconcileDoubleEntry`.
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  commissionRunLines,
  commissionRuns,
  cashDailyReconciliations,
  employeeAdvanceRepaymentRequests,
  employeeTerminations,
  employees,
  journalEntries,
  payrollItems,
  payrollRuns,
  receipts,
  shifts,
  stockAdjustmentRequests,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { receiptCashEventAtSql } from "../cash/cashEventAt";
import { getCommissionPayrollReadiness } from "../commissions/payrollReadiness";
import { money } from "../money";
import { getPurchaseMonthCloseBlockersTx } from "../purchase/monthCloseBlockers";

export type ReadinessStatus = "OK" | "BLOCK" | "WARN";

export interface ReadinessItem {
  key: string;
  label: string;
  /** OK حين العدّ صفر؛ وإلّا BLOCK أو WARN بحسب تصنيف المالك. */
  status: ReadinessStatus;
  count: number;
  detail: string;
}

export interface MonthCloseReadinessInput {
  /** الشهر بصيغة YYYY-MM. */
  month: string;
  /** فرعٌ بعينه، أو null لكل الفروع. */
  branchId?: number | null;
}

export interface MonthCloseReadinessResult {
  month: string;
  period: { from: string; to: string };
  /** هل يوجد بندٌ واحدٌ على الأقلّ حاجز؟ زرّ الإقفال يتبع هذه القيمة. */
  blocked: boolean;
  items: ReadinessItem[];
}

/** [أول الشهر، آخر يومه] — نفس منطق monthlyClosePack.monthRange (مصدر تاريخٍ واحد). */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** اليوم التالي لـ`to` — الحدّ الأعلى الحصريّ لمقارنات timestamp (sargable، لا DATE() على العمود). */
function nextDay(to: string): string {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** منتصف ليل اليوم التالي بتوقيت بغداد (UTC+03)، لا منتصف ليل UTC. */
export function baghdadMonthUpperExclusive(to: string): Date {
  return new Date(`${nextDay(to)}T00:00:00+03:00`);
}

type QueryExecutor = NonNullable<ReturnType<typeof getDb>> | Tx;

async function countOf(
  db: QueryExecutor | null,
  table: any,
  where: SQL | undefined,
): Promise<number> {
  if (!db) return 0;
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(table)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}

/** قراءة حاجزٍ حيّة داخل معاملة الاعتماد مع قفل الصفوف المطابقة، لا لقطة MVCC قديمة. */
async function lockedCountOf(
  tx: Tx,
  table: any,
  where: SQL | undefined,
): Promise<number> {
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(where)
    .for("update");
  return rows.length;
}

/**
 * أيام المطابقة المطلوبة التي لا تملك شهادة أصلاً. لا تكفي حركة اليوم وحدها: إذا بقي في
 * الخزينة رصيد مرحّل غير صفري في يوم هادئ، فغياب شهادة «لا نشاط/الرصيد ما زال باليد» فجوة
 * عهدة حقيقية. لذلك نولّد أيام الشهر لكل فرع ونطلب الشهادة عند نشاط نقدي أو رصيد خزينة EOD.
 * الصف الموجود بحالة غير مغلقة يُحسب في الاستعلام المنطّق أعلاه، فنستبعده هنا كي لا يُعد مرتين.
 */
async function countMissingDailyCashReconciliations(
  db: QueryExecutor | null,
  from: string,
  to: string,
  branchId: number | null,
): Promise<number> {
  if (!db) return 0;
  const branch = branchId == null ? sql`` : sql`WHERE b.id = ${branchId}`;
  const cashEventAt = receiptCashEventAtSql("r");
  const treasuryCashEventAt = receiptCashEventAtSql("tr");
  const result = await db.execute(sql`
    WITH RECURSIVE calendar AS (
      SELECT CAST(${from} AS DATE) AS businessDate
      UNION ALL
      SELECT DATE_ADD(businessDate, INTERVAL 1 DAY)
      FROM calendar
      WHERE businessDate < CAST(${to} AS DATE)
    ), branchDays AS (
      SELECT b.id AS branchId, calendar.businessDate
      FROM branches b
      CROSS JOIN calendar
      ${branch}
    )
    SELECT COUNT(*) AS n
    FROM branchDays requiredCashDays
    LEFT JOIN cashDailyReconciliations c
      ON c.branchId = requiredCashDays.branchId
     AND c.businessDate = requiredCashDays.businessDate
    LEFT JOIN cashMissedDailyCountExceptions missed
      ON missed.branchId = requiredCashDays.branchId
     AND missed.businessDate = requiredCashDays.businessDate
     AND missed.missedDailyCountExceptionStatus = 'APPROVED'
    LEFT JOIN cashDailyReconciliations carry
      ON carry.id = missed.carryForwardReconciliationId
     AND carry.branchId = missed.branchId
     AND carry.businessDate = missed.carryForwardBusinessDate
     AND carry.cashDailyReconciliationStatus = 'CLOSED'
     AND carry.version = missed.carryForwardVersion
     AND carry.evidenceHash = missed.carryForwardEvidenceHash
    WHERE c.id IS NULL
      AND (missed.id IS NULL OR carry.id IS NULL)
      AND (
        EXISTS (
          SELECT 1
          FROM receipts r
          WHERE r.branchId = requiredCashDays.branchId
            AND r.paymentMethod = 'CASH'
            AND r.receiptApprovalStatus = 'APPROVED'
            AND r.receiptStatus IN ('COMPLETED', 'REVERSED')
            AND ${cashEventAt} >= requiredCashDays.businessDate
            AND ${cashEventAt} < DATE_ADD(requiredCashDays.businessDate, INTERVAL 1 DAY)
        )
        OR EXISTS (
          SELECT 1
          FROM shifts s
          WHERE s.branchId = requiredCashDays.branchId
            AND s.openedAt >= requiredCashDays.businessDate
            AND s.openedAt < DATE_ADD(requiredCashDays.businessDate, INTERVAL 1 DAY)
        )
        OR ABS(COALESCE((
          SELECT SUM(CASE WHEN tr.direction = 'IN' THEN tr.amount ELSE -tr.amount END)
          FROM receipts tr
          WHERE tr.branchId = requiredCashDays.branchId
            AND tr.cashBucket = 'TREASURY'
            AND tr.paymentMethod = 'CASH'
            AND tr.receiptApprovalStatus = 'APPROVED'
            AND tr.receiptStatus IN ('COMPLETED', 'REVERSED')
            AND ${treasuryCashEventAt} < DATE_ADD(requiredCashDays.businessDate, INTERVAL 1 DAY)
        ), 0)) > 0.005
      )
  `);
  const rows = ((result as any)?.[0] ?? result) as Array<{ n?: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * طلب صرفٍ معلّق لا يحجب شهر الاعتراف إذا أثبتت السلسلة كاملةً أن أصله/مصروفه رُحّل استحقاقياً.
 * الفحص fail-closed: JSON أو مصدر أو مبلغ أو قيد أو profile/role ناقص ⇒ لا يدخل هذا العدّ ويبقى BLOCK.
 */
async function countRecognizedAccruedSettlements(
  db: QueryExecutor | null,
  to: string,
  branchId: number | null,
): Promise<number> {
  if (!db) return 0;
  const branch = branchId == null ? sql`` : sql`AND pr.branchId = ${branchId}`;
  const result = await db.execute(sql`
    SELECT COUNT(*) AS n
    FROM (
      SELECT r.*,
        SUBSTRING(r.internalNote, CHAR_LENGTH('@SYSTEM_PAYMENT_REQUEST:') + 1) AS payload
      FROM receipts r
      WHERE r.receiptApprovalStatus = 'PENDING_APPROVAL'
        AND r.voucherNumber IS NOT NULL
        AND COALESCE(r.voucherDate, DATE(r.createdAt)) <= ${to}
        AND r.internalNote LIKE '@SYSTEM_PAYMENT_REQUEST:%'
        AND JSON_VALID(SUBSTRING(r.internalNote, CHAR_LENGTH('@SYSTEM_PAYMENT_REQUEST:') + 1))
    ) pr
    LEFT JOIN doubleEntrySettings des ON des.id = 1
    WHERE 1 = 1 ${branch}
      AND (
        (
          JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.kind')) = 'TERMINATION_SETTLEMENT'
          AND pr.referenceNumber REGEXP '^TERM-SETTLEMENT-[1-9][0-9]*(-REPAY-[1-9][0-9]*)?-A[1-9][0-9]*$'
          AND pr.referenceNumber = CASE
            WHEN JSON_EXTRACT(pr.payload, '$.originReturnEventId') IS NULL
              OR JSON_TYPE(JSON_EXTRACT(pr.payload, '$.originReturnEventId')) = 'NULL'
            THEN CONCAT(
              'TERM-SETTLEMENT-',
              JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.terminationId')),
              '-A',
              JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.attempt'))
            )
            ELSE CONCAT(
              'TERM-SETTLEMENT-',
              JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.terminationId')),
              '-REPAY-',
              JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.originReturnEventId')),
              '-A',
              JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.attempt'))
            )
          END
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.expectedAmount')) AS DECIMAL(15,2)) = pr.amount
          AND EXISTS (
            SELECT 1
            FROM employeeTerminations et
            INNER JOIN payrollAccountingEvents pae
              ON pae.id = et.recognitionEventId
             AND pae.terminationId = et.id
             AND pae.payrollAccountingEventKind = 'EOS_SETTLEMENT'
            INNER JOIN accountingEntries ae ON ae.id = pae.accountingEntryId
            INNER JOIN payrollObligations po
              ON po.terminationId = et.id
             AND po.payrollObligationKind = 'SALARY_NET'
            WHERE et.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.terminationId')) AS UNSIGNED)
              AND et.employeeId = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.employeeId')) AS UNSIGNED)
              AND et.recognizedAt IS NOT NULL AND et.recognitionReversedAt IS NULL
              AND et.settlementSnapshotHash = JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.settlementSnapshotHash'))
              AND po.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.obligationId')) AS UNSIGNED)
              AND po.branchIdSnapshot = pr.branchId
              AND po.originalAmount = pr.amount
              AND ae.entryType = 'ADJUST' AND ae.branchId = pr.branchId
              AND (
                COALESCE(des.mode, 'OFF') = 'OFF'
                OR EXISTS (
                  SELECT 1 FROM journalEntries je
                  WHERE je.entryId = ae.id AND je.cycleId = des.shadowCycleId
                    AND je.status = 'POSTED' AND je.postingProfile = 'ADJUST_EOS_SETTLEMENT'
                    AND (SELECT COALESCE(SUM(jl.credit - jl.debit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'ACCRUED_SALARY') = pr.amount
                )
              )
          )
        )
        OR (
          JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.kind')) = 'PURCHASE_SHIPPING'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.expectedAmount')) AS DECIMAL(15,2)) = pr.amount
          AND EXISTS (
            SELECT 1 FROM purchaseOrders po
            INNER JOIN expenses e ON e.receiptId = pr.id AND e.expenseStatus = 'ACTIVE'
              AND e.expenseCategory = 'TRANSPORT' AND e.branchId = pr.branchId AND e.amount = pr.amount
            INNER JOIN accountingEntries ae
              ON ae.dedupeKey = CONCAT('PURCHASE_SHIPPING_ACCRUAL:', po.id, ':', JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.requestToken')))
             AND ae.entryType = 'ADJUST' AND ae.purchaseOrderId = po.id AND ae.branchId = pr.branchId AND ae.amount = pr.amount
            WHERE po.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.purchaseOrderId')) AS UNSIGNED)
              AND po.branchId = pr.branchId
              AND po.shippingCost + po.customsCost = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.sourceShippingTotal')) AS DECIMAL(15,2))
              AND (
                COALESCE(des.mode, 'OFF') = 'OFF'
                OR EXISTS (
                  SELECT 1 FROM journalEntries je
                  WHERE je.entryId = ae.id AND je.cycleId = des.shadowCycleId AND je.status = 'POSTED'
                    AND je.postingProfile = 'ADJUST_EXPENSE_ACCRUAL'
                    AND (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'OPERATING_EXPENSE') = pr.amount
                    AND (SELECT COALESCE(SUM(jl.credit - jl.debit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'ACCRUED_EXPENSES') = pr.amount
                )
              )
          )
        )
        OR (
          JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.kind')) = 'ASSET_MAINTENANCE'
          AND EXISTS (
            SELECT 1 FROM assetMaintenance am
            INNER JOIN fixedAssets fa ON fa.id = am.assetId
            INNER JOIN expenses e ON e.receiptId = pr.id AND e.expenseStatus = 'ACTIVE'
              AND e.expenseCategory = 'MAINTENANCE' AND e.branchId = pr.branchId AND e.amount = pr.amount
            INNER JOIN accountingEntries ae
              ON ae.dedupeKey = CONCAT('ASSET_MAINT_ACCRUAL:', am.id)
             AND ae.entryType = 'ADJUST' AND ae.branchId = pr.branchId AND ae.amount = pr.amount
            WHERE am.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.maintenanceId')) AS UNSIGNED)
              AND am.assetId = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.assetId')) AS UNSIGNED)
              AND fa.branchId = pr.branchId AND am.cost = pr.amount
              AND (
                COALESCE(des.mode, 'OFF') = 'OFF'
                OR EXISTS (
                  SELECT 1 FROM journalEntries je
                  WHERE je.entryId = ae.id AND je.cycleId = des.shadowCycleId AND je.status = 'POSTED'
                    AND je.postingProfile = 'ADJUST_EXPENSE_ACCRUAL'
                    AND (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'OPERATING_EXPENSE') = pr.amount
                    AND (SELECT COALESCE(SUM(jl.credit - jl.debit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'ACCRUED_EXPENSES') = pr.amount
                )
              )
          )
        )
        OR (
          JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.kind')) = 'ASSET_ACQUISITION'
          AND EXISTS (
            SELECT 1 FROM fixedAssets fa
            INNER JOIN accountingEntries ae
              ON ae.dedupeKey = CONCAT('ASSET_ACCRUAL:', fa.id)
             AND ae.entryType = 'ADJUST' AND ae.branchId = pr.branchId AND ae.amount = pr.amount
            WHERE fa.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(pr.payload, '$.assetId')) AS UNSIGNED)
              AND fa.branchId = pr.branchId AND fa.purchaseValue = pr.amount
              AND fa.supplierId IS NULL AND fa.isActive = TRUE AND fa.assetStatus NOT IN ('disposed', 'retired')
              AND (
                COALESCE(des.mode, 'OFF') = 'OFF'
                OR EXISTS (
                  SELECT 1 FROM journalEntries je
                  WHERE je.entryId = ae.id AND je.cycleId = des.shadowCycleId AND je.status = 'POSTED'
                    AND je.postingProfile = 'ADJUST_FIXED_ASSET_ACCRUAL'
                    AND (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'FIXED_ASSETS') = pr.amount
                    AND (SELECT COALESCE(SUM(jl.credit - jl.debit), 0) FROM journalLines jl WHERE jl.journalId = je.id AND jl.role = 'ACCRUED_EXPENSES') = pr.amount
                )
              )
          )
        )
      )
  `);
  const rows = ((result as any)?.[0] ?? result) as Array<{
    n?: number | string;
  }>;
  return Number(rows[0]?.n ?? 0);
}

function mk(
  key: string,
  label: string,
  count: number,
  severity: Exclude<ReadinessStatus, "OK">,
  detail: string,
): ReadinessItem {
  return {
    key,
    label,
    count,
    status: count > 0 ? severity : "OK",
    detail: count > 0 ? detail : "لا شيء معلَّق",
  };
}

export async function getMonthCloseReadiness(
  input: MonthCloseReadinessInput,
  options?: { tx?: Tx; lockBlockers?: boolean },
): Promise<MonthCloseReadinessResult> {
  const { from, to } = monthRange(input.month);
  const branchId = input.branchId ?? null;
  const db = options?.tx ?? getDb();

  const withBranch = (col: SQL | undefined, branchCol: any): SQL | undefined =>
    branchId == null ? col : (and(col, eq(branchCol, branchId)) as SQL);

  const openShiftWhere = withBranch(
    and(
      eq(shifts.status, "OPEN"),
      lt(shifts.openedAt, baghdadMonthUpperExclusive(to)),
    ) as SQL,
    shifts.branchId,
  );
  const pendingVoucherWhere = withBranch(
    and(
      eq(receipts.approvalStatus, "PENDING_APPROVAL"),
      isNotNull(receipts.voucherNumber),
      sql`COALESCE(${receipts.voucherDate}, DATE(${receipts.createdAt})) <= ${to}`,
    ) as SQL,
    receipts.branchId,
  );
  const pendingCustodyWhere = withBranch(
    and(
      eq(receipts.direction, "IN"),
      eq(receipts.paymentMethod, "CASH"),
      eq(receipts.cashBucket, "TREASURY"),
      eq(receipts.status, "PENDING"),
      eq(receipts.approvalStatus, "APPROVED"),
      or(like(receipts.referenceNumber, "CD-%"), like(receipts.referenceNumber, "CH-%")),
      lt(receipts.createdAt, baghdadMonthUpperExclusive(to)),
    ) as SQL,
    receipts.branchId,
  );
  const unclosedDailyCashWhere = withBranch(
    and(
      gte(cashDailyReconciliations.businessDate, from),
      lte(cashDailyReconciliations.businessDate, to),
      ne(cashDailyReconciliations.status, "CLOSED"),
    ) as SQL,
    cashDailyReconciliations.branchId,
  );

  // في الاعتماد: القفلان الحاجزان قراءتان حاليتان FOR UPDATE داخل tx نفسها.
  // في شاشة الجاهزية/إنشاء الطلب: تبقى القراءة الخفيفة العادية بلا أقفال.
  const openShifts =
    options?.tx && options.lockBlockers
      ? await lockedCountOf(options.tx, shifts, openShiftWhere)
      : await countOf(db, shifts, openShiftWhere);
  const allPendingVouchers =
    options?.tx && options.lockBlockers
      ? await lockedCountOf(options.tx, receipts, pendingVoucherWhere)
      : await countOf(db, receipts, pendingVoucherWhere);
  const accruedSettlementPending = await countRecognizedAccruedSettlements(
    db,
    to,
    branchId,
  );
  const pendingVouchers = Math.max(
    0,
    allPendingVouchers - accruedSettlementPending,
  );
  const pendingCustody =
    options?.tx && options.lockBlockers
      ? await lockedCountOf(options.tx, receipts, pendingCustodyWhere)
      : await countOf(db, receipts, pendingCustodyWhere);
  const unclosedDailyCash =
    options?.tx && options.lockBlockers
      ? await lockedCountOf(options.tx, cashDailyReconciliations, unclosedDailyCashWhere)
      : await countOf(db, cashDailyReconciliations, unclosedDailyCashWhere);
  const missingDailyCash = await countMissingDailyCashReconciliations(db, from, to, branchId);
  const unresolvedDailyCash = unclosedDailyCash + missingDailyCash;
  const pendingAdvanceRepaymentWhere = withBranch(
    and(
      eq(employeeAdvanceRepaymentRequests.status, "PENDING"),
      sql`${employeeAdvanceRepaymentRequests.transactionDate} <= ${to}`,
    ) as SQL,
    employeeAdvanceRepaymentRequests.branchId,
  );
  const pendingAdvanceRepayments =
    options?.tx && options.lockBlockers
      ? await lockedCountOf(
          options.tx,
          employeeAdvanceRepaymentRequests,
          pendingAdvanceRepaymentWhere,
        )
      : await countOf(
          db,
          employeeAdvanceRepaymentRequests,
          pendingAdvanceRepaymentWhere,
        );

  // الرواتب شركة-واحدة لا فرع-واحد (uq_payroll_period): إن وُجد شخص مستحق للأجر في الفترة فلا
  // يُقفَل الشهر قبل اعتماد مسيّره استحقاقياً. المسودة لا تكفي، والدفع ليس شرطاً؛ حتى صافي الصفر
  // يُعتمد ويُبصم بلا إيصال. نتجاهل branchId عمداً لأن قفل الشهر عام ولأن بنود المسيّر تحمل لقطة فرعها.
  const activeEmployeeWhere = and(
    sql`(${employees.hireDate} IS NULL OR ${employees.hireDate} <= ${to})`,
    sql`(${employees.terminationDate} IS NULL OR ${employees.terminationDate} >= ${from})`,
    or(eq(employees.isActive, true), isNotNull(employees.terminationDate)),
    sql`(${employees.employmentStatus} <> 'terminated' OR ${employees.terminationDate} IS NOT NULL)`,
  ) as SQL;
  const payrollRunWhere = eq(payrollRuns.period, input.month) as SQL;
  const employeeRows =
    options?.tx && options.lockBlockers
      ? await options.tx
          .select({ id: employees.id })
          .from(employees)
          .where(activeEmployeeWhere)
          .for("update")
      : db
        ? await db
            .select({ id: employees.id })
            .from(employees)
            .where(activeEmployeeWhere)
        : [];
  const terminationCoverageWhere = and(
    eq(employeeTerminations.status, "completed"),
    isNotNull(employeeTerminations.recognizedAt),
    isNotNull(employeeTerminations.settlementSnapshotHash),
    isNull(employeeTerminations.recognitionReversedAt),
    sql`DATE_FORMAT(${employeeTerminations.lastDay}, '%Y-%m') = ${input.month}`,
  ) as SQL;
  const terminationCoverageRows =
    options?.tx && options.lockBlockers
      ? await options.tx
          .select({ employeeId: employeeTerminations.employeeId })
          .from(employeeTerminations)
          .where(terminationCoverageWhere)
          .for("update")
      : db
        ? await db
            .select({ employeeId: employeeTerminations.employeeId })
            .from(employeeTerminations)
            .where(terminationCoverageWhere)
        : [];
  const commissionRunWhere = and(
    eq(commissionRuns.period, input.month),
    eq(commissionRuns.status, "approved"),
  ) as SQL;
  const commissionRunRows =
    options?.tx && options.lockBlockers
      ? await options.tx
          .select({
            id: commissionRuns.id,
            status: commissionRuns.status,
            payrollRunId: commissionRuns.payrollRunId,
          })
          .from(commissionRuns)
          .where(eq(commissionRuns.period, input.month))
          .for("update")
      : db
        ? await db
            .select({
              id: commissionRuns.id,
              status: commissionRuns.status,
              payrollRunId: commissionRuns.payrollRunId,
            })
            .from(commissionRuns)
            .where(eq(commissionRuns.period, input.month))
        : [];
  const commissionArtifactReadiness = db
    ? await getCommissionPayrollReadiness(db, input.month)
    : {
        required: false,
        eligibleEmployeeCount: 0,
        runId: null,
        status: null,
        ready: true,
      };
  const commissionRows =
    options?.tx && options.lockBlockers
      ? await options.tx
          .select({
            employeeId: commissionRunLines.employeeId,
            commissionAmount: commissionRunLines.commissionAmount,
            payrollRunId: commissionRuns.payrollRunId,
          })
          .from(commissionRunLines)
          .innerJoin(
            commissionRuns,
            eq(commissionRunLines.runId, commissionRuns.id),
          )
          .where(commissionRunWhere)
          .for("update")
      : db
        ? await db
            .select({
              employeeId: commissionRunLines.employeeId,
              commissionAmount: commissionRunLines.commissionAmount,
              payrollRunId: commissionRuns.payrollRunId,
            })
            .from(commissionRunLines)
            .innerJoin(
              commissionRuns,
              eq(commissionRunLines.runId, commissionRuns.id),
            )
            .where(commissionRunWhere)
        : [];
  const payrollSelect = {
    id: payrollRuns.id,
    status: payrollRuns.status,
    revisionNo: payrollRuns.revisionNo,
    accrualDate: payrollRuns.accrualDate,
    legalPolicyHash: payrollRuns.legalPolicyHash,
    approvalSnapshotHash: payrollRuns.approvalSnapshotHash,
  };
  const payrollRows =
    options?.tx && options.lockBlockers
      ? await options.tx
          .select(payrollSelect)
          .from(payrollRuns)
          .where(payrollRunWhere)
          .for("update")
      : db
        ? await db
            .select(payrollSelect)
            .from(payrollRuns)
            .where(payrollRunWhere)
        : [];
  const approvedRun = payrollRows.find(
    (run) =>
      (run.status === "approved" || run.status === "paid") &&
      run.accrualDate === to,
  );
  const payrollItemWhere = approvedRun
    ? (and(
        eq(payrollItems.runId, Number(approvedRun.id)),
        eq(payrollItems.revisionNo, Number(approvedRun.revisionNo)),
      ) as SQL)
    : undefined;
  const payrollItemRows =
    !approvedRun || !payrollItemWhere
      ? []
      : options?.tx && options.lockBlockers
        ? await options.tx
            .select({
              employeeId: payrollItems.employeeId,
              snapshotHash: payrollItems.snapshotHash,
              commission: payrollItems.commission,
            })
            .from(payrollItems)
            .where(payrollItemWhere)
            .for("update")
        : db
          ? await db
              .select({
                employeeId: payrollItems.employeeId,
                snapshotHash: payrollItems.snapshotHash,
                commission: payrollItems.commission,
              })
              .from(payrollItems)
              .where(payrollItemWhere)
          : [];
  const terminationCoveredIds = new Set(
    terminationCoverageRows.map((row) => Number(row.employeeId)),
  );
  const eligibleIds = new Set(
    employeeRows
      .map((row) => Number(row.id))
      .filter((employeeId) => !terminationCoveredIds.has(employeeId)),
  );
  for (const row of commissionRows) {
    if (money(row.commissionAmount).gt(0)) {
      eligibleIds.add(Number(row.employeeId));
    }
  }
  const snapshottedIds = new Set(
    payrollItemRows.map((row) => Number(row.employeeId)),
  );
  const missingEmployeeIds = Array.from(eligibleIds).filter(
    (id) => !snapshottedIds.has(id),
  );
  // المولّد يضم عمداً موظفاً غير مستحق للأجر العادي إذا كانت له عمولة معتمدة للشهر؛ هذا بند صحيح
  // لا «موظف زائد». أما أي زائد بلا عمولة فيعني لقطة منجرفة ويظل حاجزاً.
  const unexpectedEmployeeIds = Array.from(snapshottedIds).filter(
    (id) => !eligibleIds.has(id),
  );
  const payrollCommissionByEmployee = new Map(
    payrollItemRows.map((row) => [
      Number(row.employeeId),
      money(row.commission),
    ]),
  );
  const approvedCommissionByEmployee = new Map<
    number,
    ReturnType<typeof money>
  >();
  for (const row of commissionRows) {
    const employeeId = Number(row.employeeId);
    approvedCommissionByEmployee.set(
      employeeId,
      (approvedCommissionByEmployee.get(employeeId) ?? money(0)).plus(
        row.commissionAmount,
      ),
    );
  }
  const commissionRunUnresolved = commissionRunRows.some(
    (run) =>
      run.status !== "approved" ||
      run.payrollRunId == null ||
      approvedRun == null ||
      Number(run.payrollRunId) !== Number(approvedRun.id),
  );
  const commissionLinkComplete =
    !commissionRunUnresolved &&
    commissionRows.every(
      (row) =>
        approvedRun != null &&
        Number(row.payrollRunId) === Number(approvedRun.id),
    ) &&
    Array.from(approvedCommissionByEmployee).every(([employeeId, amount]) =>
      (payrollCommissionByEmployee.get(employeeId) ?? money(0)).eq(amount),
    );
  const snapshotHashesComplete =
    !!approvedRun?.legalPolicyHash &&
    !!approvedRun?.approvalSnapshotHash &&
    payrollItemRows.every(
      (row) =>
        typeof row.snapshotHash === "string" && row.snapshotHash.length === 64,
    );
  const payrollCoverageComplete =
    missingEmployeeIds.length === 0 &&
    unexpectedEmployeeIds.length === 0 &&
    commissionLinkComplete &&
    payrollItemRows.length === snapshottedIds.size;
  const payrollExpected =
    eligibleIds.size > 0 ||
    commissionRunRows.length > 0 ||
    commissionArtifactReadiness.required;
  const payrollAccrued =
    !payrollExpected ||
    (commissionArtifactReadiness.ready &&
      !!approvedRun &&
      payrollCoverageComplete &&
      snapshotHashesComplete);
  const payrollBlockCount = payrollAccrued ? 0 : 1;
  const payrollDetail = !payrollExpected
    ? "لا موظفون مستحقون للأجر في هذه الفترة."
    : commissionArtifactReadiness.required && commissionArtifactReadiness.runId == null
      ? `تشغيلة عمولات ${input.month} مفقودة مع وجود ${commissionArtifactReadiness.eligibleEmployeeCount} موظف ذي خطة فعالة؛ احتسبها واعتمدها قبل إقفال الشركة.`
      : commissionArtifactReadiness.required && commissionArtifactReadiness.status === "draft"
        ? `تشغيلة عمولات ${input.month} ما تزال مسودة؛ يجب اعتمادها وربطها بنسخة المسيّر قبل الإقفال.`
        : commissionRunRows.some((run) => run.status === "draft")
          ? `تشغيلة عمولات ${input.month} ما تزال مسودة؛ يجب اعتمادها وربطها بنسخة المسيّر قبل الإقفال.`
      : commissionRunUnresolved
        ? `تشغيلة عمولات ${input.month} غير محسومة في نسخة المسيّر المعتمدة؛ أعد توليد/اعتماد المسيّر.`
        : payrollRows.some((run) => run.status === "draft")
          ? `مسيّر ${input.month} ما يزال مسوّدة — اعتمد الاستحقاق قبل إقفال الشركة.`
          : approvedRun && !snapshotHashesComplete
            ? `مسيّر ${input.month} معتمد لكن بصمة السياسة/الاعتماد أو بصمات بنوده ناقصة؛ أعده للمسودة وولّده ثم اعتمده مجدداً.`
            : approvedRun && !payrollCoverageComplete
              ? `لقطة مسيّر ${input.month} لا تغطي الموظفين المستحقين حالياً: ${missingEmployeeIds.length} غير مشمول و${unexpectedEmployeeIds.length} غير مستحق ضمن اللقطة؛ أعد التوليد والاعتماد.`
              : payrollRows.some(
                    (run) => run.status === "approved" || run.status === "paid",
                  )
                ? `مسيّر ${input.month} لا يحمل تاريخ الاستحقاق المدني الصحيح ${to}.`
                : `يوجد ${employeeRows.length} موظفاً مستحقاً ولا يوجد مسيّر استحقاق معتمد للشهر.`;

  // التحذيرات لا تحجب الإقفال؛ تُقرأ من المنفّذ نفسه لضمان لقطة متّسقة بلا أقفال إضافية.
  const activeStocktakes = await countOf(
    db,
    stocktakeSessions,
    withBranch(
      inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]) as SQL,
      stocktakeSessions.branchId,
    ),
  );
  const pendingAdjustments = await countOf(
    db,
    stockAdjustmentRequests,
    withBranch(
      eq(stockAdjustmentRequests.status, "PENDING_APPROVAL") as SQL,
      stockAdjustmentRequests.branchId,
    ),
  );
  const ledgerGaps = await countOf(
    db,
    journalEntries,
    withBranch(
      // عمود DATE بنمط Date في drizzle ⇒ تُمرَّر كائنات Date لا نصوصاً.
      and(
        eq(journalEntries.status, "UNMAPPED"),
        gte(journalEntries.entryDate, new Date(`${from}T00:00:00Z`)),
        lte(journalEntries.entryDate, new Date(`${to}T00:00:00Z`)),
      ) as SQL,
      journalEntries.branchId,
    ),
  );
  const purchaseBlockers = await getPurchaseMonthCloseBlockersTx(db as Tx, {
    branchId,
    cutoffDate: to,
  });

  const items: ReadinessItem[] = [
    mk(
      "openShifts",
      "ورديات مفتوحة",
      openShifts,
      "BLOCK",
      `${openShifts} وردية ما زالت مفتوحة — أغلقها قبل الإقفال (نقدها لم يُعَدّ).`,
    ),
    mk(
      "pendingVouchers",
      "سندات بانتظار الاعتماد",
      pendingVouchers,
      "BLOCK",
      `${pendingVouchers} سنداً معلَّقاً بتاريخٍ داخل الشهر أو قبله — اعتمادها بعد القفل يتعذّر.`,
    ),
    mk(
      "pendingCashCustody",
      "عهد نقد بانتظار الاستلام",
      pendingCustody,
      "BLOCK",
      `${pendingCustody} عهدة نقد خرجت من درج ولم تُعدّ وتدخل الخزينة بعد.`,
    ),
    mk(
      "unclosedDailyCashReconciliations",
      "مطابقات نقد يومية غير مغلقة",
      unresolvedDailyCash,
      "BLOCK",
      `${unresolvedDailyCash} يوم نشاط نقدي بلا شهادة مغلقة (${missingDailyCash} بلا جرد، ${unclosedDailyCash} بفرق أو غير معتمد).`,
    ),
    mk(
      "pendingAdvanceRepayments",
      "طلبات سداد أو إعادة سلف معلّقة",
      pendingAdvanceRepayments,
      "BLOCK",
      `${pendingAdvanceRepayments} طلب سداد/إعادة سلفة معلّق بتاريخ حركة داخل الشهر أو قبله؛ احسمه قبل الإقفال كي لا يُرحّل قيده لاحقاً إلى فترة مقفلة.`,
    ),
    mk(
      "payrollAccrual",
      "استحقاق الرواتب الشهري",
      payrollBlockCount,
      "BLOCK",
      payrollDetail,
    ),
    mk(
      "ACCRUED_SETTLEMENT_PENDING",
      "طلبات تسوية استحقاقات مثبتة",
      accruedSettlementPending,
      "WARN",
      `${accruedSettlementPending} طلب صرف معلّقاً لأصل/مصروف مُعترف به استحقاقياً؛ لا يحجب شهر الاعتراف، وتبقى تسويته النقدية واجبة التتبّع.`,
    ),
    mk(
      "activeStocktakes",
      "جلسات جرد نشطة",
      activeStocktakes,
      "WARN",
      `${activeStocktakes} جلسة جردٍ لم تُعتمَد بعد — لن تُحتسَب فروقُها في هذا الشهر.`,
    ),
    mk(
      "pendingStockAdjustments",
      "طلبات تسوية مخزون معلّقة",
      pendingAdjustments,
      "WARN",
      `${pendingAdjustments} طلب تسويةٍ بانتظار الاعتماد.`,
    ),
    mk(
      "ledgerGaps",
      "فجوات الدفتر المزدوج",
      ledgerGaps,
      "WARN",
      `${ledgerGaps} حدثاً ماليّاً بلا قيدٍ مزدوج في هذا الشهر (نوعٌ غير مُخطَّط بعد).`,
    ),
  ];

  items.push(
    ...purchaseBlockers.map((blocker) => ({
      key: blocker.code,
      label: blocker.message,
      status: "BLOCK" as const,
      count: blocker.count,
      detail: `${blocker.message} (${blocker.count}).`,
    })),
  );

  return {
    month: input.month,
    period: { from, to },
    blocked: items.some((i) => i.status === "BLOCK"),
    items,
  };
}

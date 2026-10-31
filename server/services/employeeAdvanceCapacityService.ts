import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import {
  commissionRunLines,
  commissionRuns,
  employeeAdvances,
  employeeLoanRequests,
  employeePenalties,
  employees,
  employeeSpotBonuses,
  leaveRequests,
  payrollItems,
  payrollRuns,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { baghdadToday } from "./businessDay";
import { getEmployeeStatement } from "./hr/employeeStatement";
import { money, round2, toDbMoney } from "./money";
import {
  computeLegalComponents,
  getPayrollLegalSettings,
} from "./payrollLegalService";
import { countDaysWithin } from "./payroll/helpers";
import { assertPeriodOpen } from "./periodLockService";
import { withTx } from "./tx";

export interface EmployeeAdvanceCapacity {
  employeeId: number;
  branchId: number;
  period: string;
  asOf: string;
  earnedCompensation: string;
  approvedAdditions: string;
  mandatoryDeductions: string;
  existingSalaryAdvances: string;
  otherEmployeeDeductions: string;
  reservedRequests: string;
  maxAvailable: string;
  blocked: boolean;
  blockers: string[];
}

export interface CapacityOptions {
  employeeId: number;
  scopedBranchId?: number | null;
  period?: string;
  asOf?: string;
  excludeRequestId?: number;
  lock?: boolean;
}

const ZERO = new Decimal(0);

function assertPeriod(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر احتساب حد السلفة",
        why: "شهر السلفة غير صالح",
        doThis: "أعد المحاولة بشهر بصيغة YYYY-MM",
      }),
    });
  }
  return value;
}

/**
 * مصدر الحقيقة لحد السلفة الشهري. يعتمد الأجر المكتسب حتى اليوم، ويحجز الطلبات
 * المعلقة والمعتمدة، ويُعاد تشغيله تحت قفل الموظف لحظة الصرف.
 */
export async function getEmployeeAdvanceCapacityTx(
  tx: Tx,
  options: CapacityOptions,
): Promise<EmployeeAdvanceCapacity> {
  const asOf = options.asOf ?? baghdadToday();
  const period = assertPeriod(options.period ?? asOf.slice(0, 7));
  if (asOf.slice(0, 7) !== period) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر احتساب حد السلفة",
        why: "السلف التشغيلية تُمنح للشهر الجاري فقط",
        doThis: "اختر الشهر الجاري وأعد المحاولة",
      }),
    });
  }

  let employeeQuery = tx
    .select({
      id: employees.id,
      branchId: employees.branchId,
      isActive: employees.isActive,
      employmentStatus: employees.employmentStatus,
      salary: employees.salary,
    })
    .from(employees)
    .where(eq(employees.id, options.employeeId));
  const employeeRows = options.lock
    ? await employeeQuery.for("update").limit(1)
    : await employeeQuery.limit(1);
  const employee = employeeRows[0];
  if (
    !employee ||
    (options.scopedBranchId != null &&
      Number(employee.branchId) !== Number(options.scopedBranchId))
  ) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر احتساب حد السلفة",
        why: "الموظف غير موجود ضمن نطاق فرعك",
        doThis: "أعد فتح بطاقة الموظف من الفرع الصحيح",
      }),
    });
  }
  if (!employee.isActive || employee.employmentStatus !== "active") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "السلفة غير متاحة",
        why: "الموظف ليس على رأس العمل بحالة نشطة",
        doThis: "راجع الحالة الوظيفية قبل إنشاء طلب سلفة",
      }),
    });
  }

  await assertPeriodOpen(tx, new Date(`${period}-01T12:00:00.000Z`));

  let runQuery = tx
    .select({ id: payrollRuns.id, status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.period, period));
  const runRows = options.lock
    ? await runQuery.for("update").limit(1)
    : await runQuery.limit(1);
  const run = runRows[0];
  const blockers: string[] = [];
  if (run && (run.status === "approved" || run.status === "paid")) {
    blockers.push(
      run.status === "paid"
        ? "تم دفع راتب هذا الشهر"
        : "تم اعتماد مسيّر راتب هذا الشهر",
    );
  }

  const statement = await getEmployeeStatement({
    employeeId: options.employeeId,
    period,
    scopedBranchId: options.scopedBranchId,
    tx,
    employmentEndOverride: asOf,
  });
  if (!statement) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر احتساب حد السلفة",
        why: "تعذّر تحميل كشف الأجر المكتسب للموظف",
        doThis: "راجع بيانات التوظيف والحضور ثم أعد المحاولة",
      }),
    });
  }
  if (statement.needsHealing || statement.totals.openDays > 0) {
    blockers.push("توجد بصمات حضور مفتوحة أو غير محسومة حتى اليوم");
  }
  const statementEarnedCompensation = money(statement.expectedEarnedGrossWages);

  const bonusRows = await tx
    .select({ amount: employeeSpotBonuses.amount })
    .from(employeeSpotBonuses)
    .where(
      and(
        eq(employeeSpotBonuses.employeeId, options.employeeId),
        eq(employeeSpotBonuses.status, "APPROVED"),
        eq(employeeSpotBonuses.disbursementType, "PAYROLL_ADDITION"),
        or(
          isNull(employeeSpotBonuses.payrollRunId),
          run?.status === "draft"
            ? eq(employeeSpotBonuses.payrollRunId, Number(run.id))
            : undefined,
        ),
        sql`DATE_FORMAT(CONVERT_TZ(${employeeSpotBonuses.approvedAt}, '+00:00', '+03:00'), '%Y-%m') = ${period}`,
      ),
    );
  const [commissionRun] = await tx
    .select({ id: commissionRuns.id })
    .from(commissionRuns)
    .where(
      and(
        eq(commissionRuns.period, period),
        eq(commissionRuns.status, "approved"),
      ),
    )
    .limit(1);
  const commissionRows = commissionRun
    ? await tx
        .select({ amount: commissionRunLines.commissionAmount })
        .from(commissionRunLines)
        .where(
          and(
            eq(commissionRunLines.runId, Number(commissionRun.id)),
            eq(commissionRunLines.employeeId, options.employeeId),
          ),
        )
    : [];
  const approvedSpotBonuses = round2(
    bonusRows.reduce((sum, row) => sum.plus(money(row.amount)), ZERO),
  );
  const approvedCommissions = round2(
    commissionRows.reduce((sum, row) => sum.plus(money(row.amount)), ZERO),
  );

  /*
   * كشف الموظف يعيد fixedPay للراتب الثابت/المعفى قبل خصم الإجازة بلا راتب، بينما
   * generatePayroll يضيف المكافأة الفورية إلى gross ثم يطوي الإجازة في deductions؛
   * العمولة تبقى عموداً مستقلاً لا تستهلكه الإجازة. نكرر تركيب التوليد حرفياً داخل
   * نافذة الخدمة حتى asOf، أما مسارا الحضور والساعي فاستبعدا الإجازة من الأجر أصلاً.
   */
  const fixedPayPath =
    statement.dueBasis === "fixedSalary" || statement.dueBasis === "exempt";
  let earnedLeaveDeduction = ZERO;
  if (fixedPayPath) {
    const unpaidLeaves = await tx
      .select({
        from: leaveRequests.fromDate,
        to: leaveRequests.toDate,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.employeeId, options.employeeId),
          eq(leaveRequests.paid, false),
          eq(leaveRequests.status, "approved"),
          sql`${leaveRequests.fromDate} <= ${statement.to} AND ${leaveRequests.toDate} >= ${statement.from}`,
        ),
      );
    const unpaidLeaveDays = countDaysWithin(
      unpaidLeaves.map((leave) => ({
        from: String(leave.from),
        to: String(leave.to),
      })),
      statement.from,
      statement.to,
    );
    const activeServiceDays = countDaysWithin(
      [{ from: statement.from, to: statement.to }],
      statement.from,
      statement.to,
    );
    const grossSubjectToLeave = round2(
      statementEarnedCompensation.plus(approvedSpotBonuses),
    );
    const fullyOnUnpaidLeave =
      activeServiceDays > 0 && unpaidLeaveDays >= activeServiceDays;
    const dailyRate = round2(money(employee.salary ?? 0).div(30));
    earnedLeaveDeduction = fullyOnUnpaidLeave
      ? grossSubjectToLeave
      : unpaidLeaveDays > 0
        ? Decimal.min(
            round2(dailyRate.times(unpaidLeaveDays)),
            grossSubjectToLeave,
          )
        : ZERO;
  }
  const wageLeaveDeduction = Decimal.min(
    statementEarnedCompensation,
    earnedLeaveDeduction,
  );
  const spotBonusLeaveDeduction = Decimal.min(
    approvedSpotBonuses,
    Decimal.max(0, earnedLeaveDeduction.minus(wageLeaveDeduction)),
  );
  const earnedCompensation = round2(
    Decimal.max(0, statementEarnedCompensation.minus(wageLeaveDeduction)),
  );
  const approvedAdditions = round2(
    approvedSpotBonuses.plus(approvedCommissions),
  );

  const penaltyRows = await tx
    .select({ amount: employeePenalties.deductionAmount })
    .from(employeePenalties)
    .where(
      and(
        eq(employeePenalties.employeeId, options.employeeId),
        eq(employeePenalties.status, "APPROVED"),
        isNull(employeePenalties.payrollRunId),
        sql`DATE_FORMAT(${employeePenalties.decisionDate}, '%Y-%m') = ${period}`,
      ),
    );
  const penalties = round2(
    penaltyRows.reduce((sum, row) => sum.plus(money(row.amount)), ZERO),
  );
  const legalSettings = await getPayrollLegalSettings(tx);
  const legalGrossBeforeLeave = round2(
    money(statement.livePayrollComponents.gross).plus(approvedSpotBonuses),
  );
  /*
   * generatePayroll يجعل basic للشهريّ أساس الحضور/الراتب وحده، وgross يضيف
   * المخصصات والمكافأة الفورية، بينما overtime والعمولة خارج الوعاء. للساعيّ
   * gross (ومن ضمنه المكافأة) هو basic أيضاً. خصم الإجازة يُطرح من الوعاءين
   * بالمقدار نفسه تماماً كما في التوليد.
   */
  const legalBasicBeforeLeave =
    statement.employee.payType === "monthly"
      ? money(statement.livePayrollComponents.basic)
      : legalGrossBeforeLeave;
  const legal = computeLegalComponents(legalSettings, {
    basic: Decimal.max(0, legalBasicBeforeLeave.minus(earnedLeaveDeduction)),
    gross: Decimal.max(0, legalGrossBeforeLeave.minus(earnedLeaveDeduction)),
    dailyRate: round2(legalBasicBeforeLeave.div(30)),
  });
  const legalDeductions = round2(
    legal.socialSecurityEmployee.plus(legal.incomeTax),
  );
  // approvedAdditions إفصاحٌ عن كامل الإضافات المعتمدة؛ الجزء الذي استهلكته الإجازة
  // من المكافأة يُحجز هنا كي يبقى العقد الحسابي ظاهراً ولا تتحول المكافأة إلى سلفة متاحة.
  const requiredBeforeDraft = round2(
    legalDeductions.plus(spotBonusLeaveDeduction),
  );

  const [draftItem] =
    run?.status === "draft"
      ? await tx
          .select({
            deductions: payrollItems.deductions,
            advanceDeduction: payrollItems.advanceDeduction,
          })
          .from(payrollItems)
          .where(
            and(
              eq(payrollItems.runId, Number(run.id)),
              eq(payrollItems.employeeId, options.employeeId),
            ),
          )
          .limit(1)
      : [];
  const draftNonAdvance = draftItem
    ? Decimal.max(
        0,
        round2(
          money(draftItem.deductions)
            .minus(money(draftItem.advanceDeduction))
            // جزء الإجازة الذي استهلك الأجر خُفض من earnedCompensation أعلاه. أما الجزء
            // الذي استهلك المكافأة فيبقى استقطاعاً مقابل approvedAdditions المعلنة.
            .minus(wageLeaveDeduction),
        ),
      )
    : ZERO;
  // خصومات المسودة قد تحتوي القانوني والعقوبات التي رُبطت بها. العقوبات الجديدة غير
  // المربوطة تُضاف فوق الأكبر من المسودة/القانوني، لا تدخل max فتضيع من الحجز.
  const mandatoryDeductions = round2(
    Decimal.max(requiredBeforeDraft, draftNonAdvance).plus(penalties),
  );

  let advanceQuery = tx
    .select({
      sourceType: employeeAdvances.sourceType,
      payrollPeriod: employeeAdvances.payrollPeriod,
      remaining: employeeAdvances.remaining,
      monthlyDeduction: employeeAdvances.monthlyDeduction,
    })
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.employeeId, options.employeeId),
        eq(employeeAdvances.status, "ACTIVE"),
      ),
    )
    .orderBy(employeeAdvances.id);
  const activeAdvances = options.lock
    ? await advanceQuery.for("update")
    : await advanceQuery;
  let existingSalaryAdvances = ZERO;
  let otherEmployeeDeductions = ZERO;
  for (const advance of activeAdvances) {
    if (advance.sourceType === "SALARY_ADVANCE") {
      if (advance.payrollPeriod === period) {
        existingSalaryAdvances = existingSalaryAdvances.plus(
          money(advance.remaining),
        );
      } else if (
        advance.payrollPeriod != null &&
        advance.payrollPeriod < period
      ) {
        blockers.push(
          `توجد سلفة راتبية غير مسوّاة من شهر ${advance.payrollPeriod}`,
        );
      }
    } else if (advance.sourceType === "OTHER_DEDUCTION") {
      otherEmployeeDeductions = otherEmployeeDeductions.plus(
        Decimal.min(
          money(advance.remaining),
          advance.monthlyDeduction == null
            ? money(advance.remaining)
            : money(advance.monthlyDeduction),
        ),
      );
    } else {
      blockers.push(
        "توجد ذمة تاريخية غير مصنفة؛ طابق مصدرها قبل منح سلفة شهرية جديدة",
      );
      otherEmployeeDeductions = otherEmployeeDeductions.plus(
        money(advance.remaining),
      );
    }
  }
  existingSalaryAdvances = round2(existingSalaryAdvances);
  otherEmployeeDeductions = round2(otherEmployeeDeductions);

  const requestConditions = [
    eq(employeeLoanRequests.employeeId, options.employeeId),
    or(
      eq(employeeLoanRequests.payrollPeriod, period),
      isNull(employeeLoanRequests.payrollPeriod),
    ),
    inArray(employeeLoanRequests.status, ["PENDING", "APPROVED"]),
  ];
  if (options.excludeRequestId != null) {
    requestConditions.push(
      sql`${employeeLoanRequests.id} <> ${options.excludeRequestId}`,
    );
  }
  let requestQuery = tx
    .select({
      amount: employeeLoanRequests.amount,
      payrollPeriod: employeeLoanRequests.payrollPeriod,
    })
    .from(employeeLoanRequests)
    .where(and(...requestConditions))
    .orderBy(employeeLoanRequests.id);
  const reservedRows = options.lock
    ? await requestQuery.for("update")
    : await requestQuery;
  let reservedRequests = ZERO;
  for (const row of reservedRows) {
    if (row.payrollPeriod == null) {
      blockers.push(
        "يوجد طلب سلفة تاريخي غير مصنف؛ ألغِه أو أعد تقديمه للشهر الجاري",
      );
      continue;
    }
    reservedRequests = reservedRequests.plus(money(row.amount));
  }
  reservedRequests = round2(reservedRequests);

  const preAdvanceNet = round2(
    earnedCompensation
      .plus(approvedAdditions)
      .minus(mandatoryDeductions)
      .minus(otherEmployeeDeductions),
  );
  const maxAvailable = blockers.length
    ? ZERO
    : round2(
        Decimal.max(
          0,
          preAdvanceNet.minus(existingSalaryAdvances).minus(reservedRequests),
        ),
      );

  return {
    employeeId: options.employeeId,
    branchId: Number(employee.branchId),
    period,
    asOf,
    earnedCompensation: toDbMoney(earnedCompensation),
    approvedAdditions: toDbMoney(approvedAdditions),
    mandatoryDeductions: toDbMoney(mandatoryDeductions),
    existingSalaryAdvances: toDbMoney(existingSalaryAdvances),
    otherEmployeeDeductions: toDbMoney(otherEmployeeDeductions),
    reservedRequests: toDbMoney(reservedRequests),
    maxAvailable: toDbMoney(maxAvailable),
    blocked: blockers.length > 0,
    blockers: Array.from(new Set(blockers)),
  };
}

export function assertAdvanceWithinCapacity(
  amount: Decimal,
  capacity: EmployeeAdvanceCapacity,
): void {
  const maximum = money(capacity.maxAvailable);
  if (capacity.blocked || amount.gt(maximum)) {
    const reason = capacity.blockers[0]
      ? capacity.blockers.join("، ")
      : `المبلغ المطلوب (${toDbMoney(amount)} د.ع) يتجاوز الحد المتاح (${capacity.maxAvailable} د.ع)`;
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "لا يمكن تسجيل أو صرف السلفة",
        why: reason,
        doThis:
          "خفّض المبلغ إلى الحد المتاح الظاهر في الحقل، أو عالج الحضور والاستقطاعات ثم أعد المحاولة",
      }),
    });
  }
}

/** معاينة قراءة للواجهة؛ القرار النهائي يُعاد دائماً داخل معاملة الطلب/الصرف مع lock=true. */
export async function getEmployeeAdvanceCapacity(
  options: Omit<CapacityOptions, "lock">,
): Promise<EmployeeAdvanceCapacity> {
  return withTx((tx) =>
    getEmployeeAdvanceCapacityTx(tx, { ...options, lock: false }),
  );
}

import { and, eq, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { auditLogs, employees } from "../../../drizzle/schema";
import { withTx, type Actor, type MaybeScopedActor } from "../tx";
import { round2 } from "../money";

export interface AccrueMonthlyLeaveResult {
  month: string;
  employeesAccrued: number;
  daysPerEmployee: string;
  totalDaysAccrued: string;
}

/**
 * احتساب وتدوير رصيد الإجازات السنوية الشهري لجميع الموظفين المستحقين
 * وفق المادة 67 من قانون العمل العراقي رقم 37 لسنة 2015:
 * (20 يوماً سنوياً = 20 / 12 = 1.67 يوماً لكل شهر خدمة).
 */
export async function accrueMonthlyLeave(
  arg1: string | MaybeScopedActor,
  arg2?: MaybeScopedActor | { month: string },
): Promise<AccrueMonthlyLeaveResult> {
  let month: string;
  let actor: MaybeScopedActor;

  if (typeof arg1 === "string") {
    month = arg1;
    actor = arg2 as MaybeScopedActor;
  } else {
    actor = arg1;
    month = (arg2 as { month: string }).month;
  }

  const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!monthRegex.test(month)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "صيغة الشهر غير صالحة",
        why: `الشهر المُدخل (${month}) لا يطابق الصيغة المطلوبة YYYY-MM`,
        doThis: "حدد شهراً صالحاً مثل 2026-09",
      }),
    });
  }

  return withTx(async (tx) => {
    // 1. فحص عدم التكرار (Idempotency Guard) بالاستعلام عن auditLogs
    const [existing] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "leave.accrueMonth"),
          eq(auditLogs.entityId, month),
        ),
      )
      .limit(1)
      .for("update");

    if (existing) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تم احتساب إجازات هذا الشهر مسبقاً",
          why: `تم تدوير واحتساب رصيد الإجازات السنوية لشهر (${month}) بالفعل ومسجّل في سجل التدقيق #${existing.id}`,
          doThis: "لا يمكن إعادة احتساب نفس الشهر مرتين منعاً لازدواج أرصدة الإجازات",
        }),
      });
    }

    // 2. حساب قيمة الاستحقاق الشهري (20 / 12 = 1.67 يوماً)
    const accrualDays = round2(new Decimal(20).div(12)); // 1.67

    // 3. تحديد آخر يوم في الشهر لفحص تاريخ التعيين
    const [yearStr, monthStr] = month.split("-");
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);
    const lastDayNum = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
    const monthLastDay = `${month}-${String(lastDayNum).padStart(2, "0")}`;

    // 4. جلب وقفل الموظفين المستحقين النشطين
    // الشروط: employmentStatus = 'active' AND isActive = true AND hireDate <= monthLastDay
    const eligibleEmployees = await tx
      .select({
        id: employees.id,
        branchId: employees.branchId,
        annualLeaveBalance: employees.annualLeaveBalance,
      })
      .from(employees)
      .where(
        and(
          eq(employees.employmentStatus, "active"),
          eq(employees.isActive, true),
          lte(employees.hireDate, monthLastDay),
        ),
      )
      .for("update");

    if (eligibleEmployees.length > 0) {
      await tx
        .update(employees)
        .set({
          annualLeaveBalance: sql`${employees.annualLeaveBalance} + ${accrualDays.toString()}`,
        })
        .where(
          and(
            eq(employees.employmentStatus, "active"),
            eq(employees.isActive, true),
            lte(employees.hireDate, monthLastDay),
          ),
        );
    }

    const totalDaysAccrued = accrualDays.mul(eligibleEmployees.length);

    // 5. توثيق العملية في سجل التدقيق auditLogs
    await tx.insert(auditLogs).values({
      action: "leave.accrueMonth",
      entityType: "leaveAccrual",
      entityId: month,
      userId: actor?.userId ?? null,
      branchId: actor?.branchId ?? null,
      newValue: {
        month,
        employeesAccrued: eligibleEmployees.length,
        daysPerEmployee: accrualDays.toString(),
        totalDaysAccrued: totalDaysAccrued.toString(),
        employeeIds: eligibleEmployees.map((e) => e.id),
      },
    });

    return {
      month,
      employeesAccrued: eligibleEmployees.length,
      daysPerEmployee: accrualDays.toString(),
      totalDaysAccrued: totalDaysAccrued.toString(),
    };
  });
}

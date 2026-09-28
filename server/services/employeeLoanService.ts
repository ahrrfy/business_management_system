import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { employeeAdvances, employeeLoanRequests, employees } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { money, round2, toDbMoney } from "./money";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type LoanRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "DISBURSED";

export interface RequestLoanInput {
  employeeId: number;
  amount: string | number;
  installmentsCount?: number;
  monthlyDeduction?: string | number;
  reason?: string | null;
}

/** تقديم طلب سلفة / قرض (ذاتي عبر التطبيق أو من الموظف). */
export async function requestEmployeeLoan(
  actor: MaybeScopedActor,
  input: RequestLoanInput,
) {
  return withTx(async (tx) => {
    const [emp] = await tx
      .select({
        id: employees.id,
        branchId: employees.branchId,
        salary: employees.salary,
        employmentStatus: employees.employmentStatus,
      })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!emp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر رفع طلب السلفة",
          why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
          doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
        }),
      });
    }

    if (emp.employmentStatus !== "active") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن تقديم طلب سلفة",
          why: `الموظف بحالة وظيفية (${emp.employmentStatus}) ولا يمارس عمله الفعلي`,
          doThis: "يجب أن يكون الموظف على رأس عمله بحالة نشطة لطلب السلف",
        }),
      });
    }

    const amount = money(input.amount);
    if (amount.lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "مبلغ السلفة غير صحيح",
          why: "يجب أن يكون مبلغ السلفة المطلوب أكبر من صفر",
          doThis: "أدخل مبلغ سلفة صالحاً وموجباً",
        }),
      });
    }

    const installments = Math.max(1, input.installmentsCount ?? 1);
    const monthlyDeduction = input.monthlyDeduction != null
      ? money(input.monthlyDeduction)
      : round2(amount.div(installments));

    // التحقق القانوني (المادة 51 من قانون العمل العراقي): الاستقطاع الشهري لا يتجاوز 20% من الراتب الأساس
    const salary = money(emp.salary ?? 0);
    if (salary.gt(0)) {
      const maxMonthlyAllowed = round2(salary.times(0.20));
      if (monthlyDeduction.gt(maxMonthlyAllowed)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "مخالفة السقف القانوني لسداد السلف",
            why: `القسط الشهري (${monthlyDeduction.toString()} د.ع) يتجاوز سقف 20% من الراتب الأساس (${maxMonthlyAllowed.toString()} د.ع) بموجب المادة 51 من قانون العمل العراقي`,
            doThis: "قم بزيادة عدد أشهر الأقساط لتخفيض القسط الشهري ضمن السقف المسموح به",
          }),
        });
      }
    }

    const branchId = emp.branchId ?? actor.branchId;
    if (!branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تسجيل طلب السلفة",
          why: "لم يتم تحديد الفرع المسؤول عن الصرف المالي",
          doThis: "تأكد من ارتباط الموظف بفرع عمل معتمد",
        }),
      });
    }

    const [res] = await tx.insert(employeeLoanRequests).values({
      employeeId: input.employeeId,
      branchId,
      amount: toDbMoney(amount),
      installmentsCount: installments,
      monthlyDeduction: toDbMoney(monthlyDeduction),
      reason: input.reason?.trim() || null,
      status: "PENDING",
      createdById: actor.userId,
    });

    return { id: res.insertId, status: "PENDING" };
  });
}

/** مراجعة طلب السلفة (اعتماد أو رفض) من قبل الإدارة. */
export async function reviewEmployeeLoanRequest(
  actor: MaybeScopedActor,
  input: { id: number; action: "APPROVE" | "REJECT"; rejectionReason?: string },
) {
  return withTx(async (tx) => {
    const [lr] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, input.id))
      .limit(1);

    if (!lr) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر مراجعة طلب السلفة",
          why: "طلب السلفة المطلوب غير موجود في سجلات النظام",
          doThis: "تحقّق من رقم الطلب وأعد المحاولة من قائمة السلف",
        }),
      });
    }

    if (lr.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن مراجعة طلب السلفة",
          why: `طلب السلفة ليس بحالة معلقة (${lr.status}) بل تم البت فيه مسبقاً`,
          doThis: "يمكن مراجعة واعتماد الطلبات المعلقة (PENDING) فقط",
        }),
      });
    }

    if (lr.createdById === actor.userId && actor.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد السلفة",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمقدم طلب السلفة اعتماده بنفسه",
          doThis: "اطلب من مدير الفرع أو المسؤول المالي مراجعة واعتماد الطلب",
        }),
      });
    }

    const newStatus: LoanRequestStatus = input.action === "APPROVE" ? "APPROVED" : "REJECTED";

    await tx
      .update(employeeLoanRequests)
      .set({
        status: newStatus,
        reviewedById: actor.userId,
        reviewedAt: sql`NOW()`,
        rejectionReason: input.action === "REJECT" ? input.rejectionReason?.trim() || "مرفوض من الإدارة" : null,
      })
      .where(eq(employeeLoanRequests.id, input.id));

    return { id: input.id, status: newStatus };
  });
}

/** صرف السلفة المعتمدة وإنشاء سجل السلفة الفعالة رسمياً. */
export async function disburseEmployeeLoan(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    const [lr] = await tx
      .select()
      .from(employeeLoanRequests)
      .where(eq(employeeLoanRequests.id, id))
      .limit(1);

    if (!lr) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر صرف السلفة",
          why: "طلب السلفة المطلوب غير موجود في النظام",
          doThis: "تحقّق من رقم الطلب وأعد فتح القائمة",
        }),
      });
    }

    if (lr.status !== "APPROVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن صرف السلفة",
          why: `حالة السلفة الحالية هي (${lr.status}) ولم تعتمدها الإدارة بعد`,
          doThis: "يجب اعتماد طلب السلفة أولاً قبل التمكن من صرفها",
        }),
      });
    }

    // إنشاء سجل سلفة فعال في employeeAdvances
    const [advRes] = await tx.insert(employeeAdvances).values({
      employeeId: lr.employeeId,
      branchId: lr.branchId,
      amount: lr.amount,
      remaining: lr.amount,
      monthlyDeduction: lr.monthlyDeduction,
      status: "ACTIVE",
      note: `سلفة مصروفة بناءً على طلب رقم #${lr.id}${lr.reason ? ` — ${lr.reason}` : ""}`,
      createdBy: actor.userId,
    });

    const advanceId = advRes.insertId;

    await tx
      .update(employeeLoanRequests)
      .set({
        status: "DISBURSED",
        advanceId,
      })
      .where(eq(employeeLoanRequests.id, id));

    return { id, advanceId, status: "DISBURSED" };
  });
}

/** استعلام طلبات سلف الموظف. */
export async function listEmployeeLoans(employeeId: number) {
  const db = requireDb();
  return db
    .select()
    .from(employeeLoanRequests)
    .where(eq(employeeLoanRequests.employeeId, employeeId))
    .orderBy(desc(employeeLoanRequests.createdAt));
}

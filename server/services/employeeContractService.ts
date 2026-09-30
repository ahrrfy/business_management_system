import { and, desc, eq, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { employeeContracts, employees } from "../../drizzle/schema";
import { getDb } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { baghdadToday } from "./businessDay";
import { money, toDbMoney } from "./money";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type ContractType = "FIXED_TERM" | "INDEFINITE" | "PROBATION" | "SEASONAL";
export type ContractStatus = "DRAFT" | "ACTIVE" | "RENEWED" | "TERMINATED" | "EXPIRED";

export interface CreateContractInput {
  employeeId: number;
  contractType: ContractType;
  contractNumber?: string | null;
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  jobTitle?: string | null;
  basicSalary?: string | number | null;
  allowances?: string | number | null;
  terms?: string | null;
  fileUrl?: string | null;
}

/** إنشاء عقد عمل جديد (مسودة). */
export async function createEmployeeContract(
  actor: MaybeScopedActor,
  input: CreateContractInput,
) {
  return withTx(async (tx) => {
    const [emp] = await tx
      .select({ id: employees.id, branchId: employees.branchId })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!emp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل العقد",
          why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
          doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
        }),
      });
    }

    // التحقق من فترة التجربة: لا تتجاوز 3 أشهر (المادة 33 من قانون العمل العراقي)
    if (input.probationEndDate) {
      const start = new Date(input.startDate);
      const probEnd = new Date(input.probationEndDate);
      const diffDays = Math.ceil((probEnd.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 93) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "فترة التجربة غير صالحة قانونياً",
            why: "تتجاوز 3 أشهر (90 يوماً) بالمخالفة للمادة 33 من قانون العمل العراقي رقم 37 لسنة 2015",
            doThis: "عدّل تاريخ نهاية التجربة ليكون بحد أقصى 90 يوماً من تاريخ بدء العقد",
          }),
        });
      }
    }

    const [res] = await tx.insert(employeeContracts).values({
      employeeId: input.employeeId,
      branchId: emp.branchId,
      contractType: input.contractType,
      contractNumber: input.contractNumber?.trim() || null,
      startDate: input.startDate,
      endDate: input.endDate || null,
      probationEndDate: input.probationEndDate || null,
      jobTitle: input.jobTitle?.trim() || null,
      basicSalary: input.basicSalary != null ? toDbMoney(money(input.basicSalary)) : null,
      allowances: input.allowances != null ? toDbMoney(money(input.allowances)) : "0.00",
      terms: input.terms?.trim() || null,
      fileUrl: input.fileUrl || null,
      status: "DRAFT",
      createdById: actor.userId,
    });

    return { id: res.insertId, status: "DRAFT" };
  });
}

/** اعتماد عقد العمل وتفعيله (Maker-Checker). */
export async function approveEmployeeContract(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    const [c] = await tx
      .select()
      .from(employeeContracts)
      .where(eq(employeeContracts.id, id))
      .for("update")
      .limit(1);

    if (!c) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد العقد",
          why: "العقد المطلوب غير موجود في سجلات الموظفين",
          doThis: "تحقّق من رقم العقد وأعد المحاولة من قائمة العقود",
        }),
      });
    }

    if (actor.branchId != null && c.branchId != null && c.branchId !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد العقد",
          why: "العقد يتبع فرعاً آخر خارج نطاق صلاحيتك",
          doThis: "تحقّق من فرع الموظف أو راجع الإدارة المركزية",
        }),
      });
    }

    if (c.status !== "DRAFT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن اعتماد العقد",
          why: `حالة العقد الحالية هي (${c.status}) وليست مسودة قيد التدقيق`,
          doThis: "يمكن اعتماد وتفعيل العقود المسجلة بحالة مسودة فقط",
        }),
      });
    }

    if (c.createdById === actor.userId && actor.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد العقد",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمنشئ العقد اعتماده بنفسه منعاً لتعارض المصالح",
          doThis: "اطلب من مدير آخر أو مسؤول الصلاحيات مراجعة واعتماد العقد",
        }),
      });
    }

    // 1) وسم أي عقود نشطة سابقة للموظف كـ RENEWED
    await tx
      .update(employeeContracts)
      .set({ status: "RENEWED" })
      .where(
        and(
          eq(employeeContracts.employeeId, c.employeeId),
          eq(employeeContracts.status, "ACTIVE"),
          sql`${employeeContracts.id} != ${id}`,
        ),
      );

    // 2) تفعيل العقد الحالي
    await tx
      .update(employeeContracts)
      .set({
        status: "ACTIVE",
        approvedById: actor.userId,
        approvedAt: sql`NOW()`,
      })
      .where(eq(employeeContracts.id, id));

    // 3) مزامنة بطاقة الموظف (الراتب، المسمى الوظيفي، البدلات)
    const empUpdate: Record<string, any> = {};
    if (c.basicSalary != null) {
      empUpdate.salary = toDbMoney(money(c.basicSalary));
    }
    if (c.jobTitle != null && c.jobTitle.trim() !== "") {
      empUpdate.position = c.jobTitle.trim();
    }
    if (c.allowances != null) {
      empUpdate.allowances = toDbMoney(money(c.allowances));
    }
    if (Object.keys(empUpdate).length > 0) {
      await tx
        .update(employees)
        .set(empUpdate)
        .where(eq(employees.id, c.employeeId));
    }

    return { id, status: "ACTIVE" };
  });
}

export interface RenewContractInput {
  id: number;
  startDate?: string;
  endDate?: string | null;
  basicSalary?: string | number | null;
  allowances?: string | number | null;
  jobTitle?: string | null;
  terms?: string | null;
  contractNumber?: string | null;
}

/** تجديد عقد عمل سارٍ أو منتهٍ مع إنشاء عقد جديد ومزامنة بطاقة الموظف. */
export async function renewEmployeeContract(
  actor: MaybeScopedActor,
  input: RenewContractInput,
) {
  return withTx(async (tx) => {
    const [old] = await tx
      .select()
      .from(employeeContracts)
      .where(eq(employeeContracts.id, input.id))
      .for("update")
      .limit(1);

    if (!old) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تجديد العقد",
          why: "العقد المطلوب تجديده غير موجود",
          doThis: "تحقّق من رقم العقد وأعد المحاولة",
        }),
      });
    }

    if (actor.branchId != null && old.branchId != null && old.branchId !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح بتجديد العقد",
          why: "العقد يتبع فرعاً آخر خارج نطاق صلاحيتك",
          doThis: "تحقّق من فرع الموظف أو راجع الإدارة المركزية",
        }),
      });
    }

    if (old.status !== "ACTIVE" && old.status !== "EXPIRED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن تجديد هذا العقد",
          why: `حالة العقد الحالية (${old.status}) لا تسمح بالتجديد (يُشترط أن يكون سارياً أو منتهياً)`,
          doThis: "اختر عقداً سارياً أو منتهي الصلاحية لتجديده",
        }),
      });
    }

    // وسم العقد القديم كمجدد
    await tx
      .update(employeeContracts)
      .set({ status: "RENEWED" })
      .where(eq(employeeContracts.id, old.id));

    // وسم أي عقود نشطة أخرى لنفس الموظف كـ RENEWED
    await tx
      .update(employeeContracts)
      .set({ status: "RENEWED" })
      .where(
        and(
          eq(employeeContracts.employeeId, old.employeeId),
          eq(employeeContracts.status, "ACTIVE"),
          sql`${employeeContracts.id} != ${old.id}`,
        ),
      );

    const startDate = input.startDate || old.endDate || baghdadToday();
    const newBasicSalary = input.basicSalary != null ? toDbMoney(money(input.basicSalary)) : old.basicSalary;
    const newAllowances = input.allowances != null ? toDbMoney(money(input.allowances)) : old.allowances;
    const newJobTitle = input.jobTitle?.trim() || old.jobTitle;

    const [res] = await tx.insert(employeeContracts).values({
      employeeId: old.employeeId,
      branchId: old.branchId,
      contractType: old.contractType,
      contractNumber: input.contractNumber?.trim() || (old.contractNumber ? `${old.contractNumber}-R` : null),
      startDate,
      endDate: input.endDate || null,
      probationEndDate: null,
      jobTitle: newJobTitle,
      basicSalary: newBasicSalary,
      allowances: newAllowances,
      terms: input.terms?.trim() || old.terms,
      status: "ACTIVE",
      createdById: actor.userId,
      approvedById: actor.userId,
      approvedAt: sql`NOW()`,
    });

    const empUpdate: Record<string, any> = {};
    if (newBasicSalary != null) empUpdate.salary = newBasicSalary;
    if (newJobTitle != null && newJobTitle.trim() !== "") empUpdate.position = newJobTitle.trim();
    if (newAllowances != null) empUpdate.allowances = newAllowances;

    if (Object.keys(empUpdate).length > 0) {
      await tx.update(employees).set(empUpdate).where(eq(employees.id, old.employeeId));
    }

    return { oldContractId: old.id, newContractId: res.insertId, status: "ACTIVE" };
  });
}

/** إنهاء عقد عمل سارٍ مع توثيق سبب وتاريخ الإنهاء. */
export async function terminateEmployeeContract(
  actor: MaybeScopedActor,
  id: number,
  reason?: string | null,
) {
  return withTx(async (tx) => {
    const [c] = await tx
      .select()
      .from(employeeContracts)
      .where(eq(employeeContracts.id, id))
      .for("update")
      .limit(1);

    if (!c) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إنهاء العقد",
          why: "العقد المطلوب غير موجود",
          doThis: "تحقّق من رقم العقد",
        }),
      });
    }

    if (actor.branchId != null && c.branchId != null && c.branchId !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح بإنهاء العقد",
          why: "العقد يتبع فرعاً آخر خارج نطاق صلاحيتك",
          doThis: "تحقّق من فرع الموظف أو راجع الإدارة المركزية",
        }),
      });
    }

    if (c.status !== "ACTIVE") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن إنهاء هذا العقد",
          why: `حالة العقد الحالية هي (${c.status}) ولا يمكن إنهاء عقد غير سارٍ`,
          doThis: "يمكن إنهاء العقود السارية فقط",
        }),
      });
    }

    const todayStr = baghdadToday();
    const updatedTerms = reason?.trim()
      ? `${c.terms || ""}\n[تم الإنهاء بتاريخ ${todayStr}: ${reason.trim()}]`.trim()
      : c.terms;

    await tx
      .update(employeeContracts)
      .set({
        status: "TERMINATED",
        endDate: todayStr,
        terms: updatedTerms,
      })
      .where(eq(employeeContracts.id, id));

    return { id, status: "TERMINATED" };
  });
}

/** استعلام عقود الموظف مع دعم عزل الفروع. */
export async function listEmployeeContracts(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const conds = [eq(employeeContracts.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(eq(employeeContracts.branchId, scopedBranchId));
  }
  return db
    .select()
    .from(employeeContracts)
    .where(and(...conds))
    .orderBy(desc(employeeContracts.startDate));
}

/** تنبيهات انتهاء فترة التجربة (خلال 15 يوماً القادمة) لاتخاذ قرار التثبيت أو إنهاء التجربة مع دعم عزل الفروع. */
export async function getProbationAlerts(
  withinDays: number = 15,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const todayStr = baghdadToday();
  const targetDate = new Date(`${todayStr}T00:00:00Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + withinDays);
  const targetDateStr = targetDate.toISOString().slice(0, 10);

  const conds = [
    eq(employees.isActive, true),
    eq(employeeContracts.status, "ACTIVE"),
    sql`${employeeContracts.probationEndDate} IS NOT NULL`,
    lte(employeeContracts.probationEndDate, targetDateStr),
  ];
  if (scopedBranchId != null) {
    conds.push(eq(employeeContracts.branchId, scopedBranchId));
  }

  const rows = await db
    .select({
      id: employeeContracts.id,
      employeeId: employeeContracts.employeeId,
      employeeName: sql<string>`CONCAT(${employees.firstName}, ' ', ${employees.lastName})`,
      jobTitle: employeeContracts.jobTitle,
      startDate: employeeContracts.startDate,
      probationEndDate: employeeContracts.probationEndDate,
      status: employeeContracts.status,
    })
    .from(employeeContracts)
    .innerJoin(employees, eq(employeeContracts.employeeId, employees.id))
    .where(and(...conds))
    .orderBy(employeeContracts.probationEndDate);

  return rows.map((r) => {
    const isExpired = r.probationEndDate! < todayStr;
    const diffDays = Math.ceil(
      (new Date(r.probationEndDate!).getTime() - new Date(todayStr).getTime()) / (1000 * 60 * 60 * 24),
    );
    return {
      ...r,
      isExpired,
      daysRemaining: diffDays,
      message: isExpired
        ? "انتهت فترة التجربة القانونية — يلزم تثبيت الموظف أو اتخاذ قرار إداري"
        : `تنتهي فترة التجربة بعد ${diffDays} أيام`,
    };
  });
}

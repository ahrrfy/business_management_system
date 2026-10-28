import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { auditLogs, employeeContracts, employees, type EmployeeContract } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { withTx, type MaybeScopedActor } from "./tx";
import { baghdadToday } from "./businessDay";
import { money, toDbMoney } from "./money";
import { canCrossBranches } from "../lib/branchAuthority";
import { assertHrBranch, lockHrEmployeeTx, resolveHrActorTx } from "./hr/resourceScope";
import { wageProfileOf } from "./hr/wageProfile";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type ContractType = "FIXED_TERM" | "INDEFINITE" | "PROBATION" | "SEASONAL";
export type ContractStatus = "DRAFT" | "ACTIVE" | "RENEWED" | "TERMINATED" | "EXPIRED";

function validateContractDates(input: { startDate: string; endDate?: string | null; probationEndDate?: string | null }): void {
  const realDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1000-01-01" &&
    Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!realDay(input.startDate) || (input.endDate != null && !realDay(input.endDate)) ||
    (input.probationEndDate != null && !realDay(input.probationEndDate)) ||
    (input.endDate != null && input.endDate < input.startDate) ||
    (input.probationEndDate != null && input.probationEndDate < input.startDate)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
      what: "تواريخ العقد غير صالحة",
      why: "يلزم تاريخ تقويمي صحيح، ولا يجوز أن تسبق النهاية أو نهاية التجربة تاريخ البداية",
      doThis: "صحّح تاريخ بداية العقد ونهايته ثم أعد الحفظ أو الاعتماد",
    }) });
  }
}

function displayedContractStatus(c: Pick<EmployeeContract, "status" | "approvedAt" | "startDate">) {
  return c.status === "DRAFT" && c.approvedAt != null
    ? (c.startDate > baghdadToday() ? "SCHEDULED" : "DUE")
    : c.status;
}

/** All contract writes share employee -> contract lock order, including lazy activation. */
async function lockEmployeeContractTx(tx: Tx, actor: MaybeScopedActor, id: number) {
  const [probe] = await tx.select({ employeeId: employeeContracts.employeeId }).from(employeeContracts).where(eq(employeeContracts.id, id)).limit(1);
  if (!probe) return undefined;
  await lockHrEmployeeTx(tx, actor, probe.employeeId);
  const [contract] = await tx.select().from(employeeContracts).where(eq(employeeContracts.id, id)).for("update").limit(1);
  if (contract) assertHrBranch(actor, contract.branchId);
  return contract;
}

/** The employee row is locked before this shared activation path changes wage fields. */
async function activateEmployeeContractTx(tx: Tx, c: EmployeeContract): Promise<boolean> {
  const [before] = await tx.select().from(employees).where(eq(employees.id, c.employeeId)).for("update").limit(1);
  const [newer] = await tx.select({ id: employeeContracts.id }).from(employeeContracts).where(and(
    eq(employeeContracts.employeeId, c.employeeId), eq(employeeContracts.status, "ACTIVE"),
    sql`${employeeContracts.id} != ${c.id}`,
    sql`(${employeeContracts.startDate} > ${c.startDate} OR (${employeeContracts.startDate} = ${c.startDate} AND ${employeeContracts.id} > ${c.id}))`,
  )).for("update").limit(1);
  if (newer) return false;
  await tx.update(employeeContracts).set({ status: "RENEWED" }).where(and(
    eq(employeeContracts.employeeId, c.employeeId), eq(employeeContracts.status, "ACTIVE"), sql`${employeeContracts.id} != ${c.id}`,
  ));
  await tx.update(employeeContracts).set({ status: "ACTIVE" }).where(eq(employeeContracts.id, c.id));
  const update: Partial<typeof employees.$inferInsert> = {};
  if (c.basicSalary != null) update.salary = toDbMoney(money(c.basicSalary));
  if (c.allowances != null) update.allowances = toDbMoney(money(c.allowances));
  if (c.jobTitle?.trim()) update.position = c.jobTitle.trim();
  if (Object.keys(update).length) await tx.update(employees).set(update).where(eq(employees.id, c.employeeId));
  await tx.insert(auditLogs).values({ action: "employeeContract.activate", entityType: "employeeContract", entityId: String(c.id), userId: c.approvedById, branchId: c.branchId, oldValue: { wage: wageProfileOf(before ?? {}) }, newValue: { employeeId: c.employeeId, effectiveDate: c.startDate, status: "ACTIVE", salary: c.basicSalary, allowances: c.allowances } });
  return true;
}

/** Called from payroll and the scoped HR list; never advances an agreement ahead of today. */
export async function applyDueEmployeeContracts(tx: Tx, asOf: string, employeeId?: number): Promise<number> {
  const effectiveThrough = asOf < baghdadToday() ? asOf : baghdadToday();
  const candidates = await tx.select().from(employeeContracts).where(and(
    eq(employeeContracts.status, "DRAFT"), isNotNull(employeeContracts.approvedById), isNotNull(employeeContracts.approvedAt),
    lte(employeeContracts.startDate, effectiveThrough), ...(employeeId == null ? [] : [eq(employeeContracts.employeeId, employeeId)]),
  )).orderBy(employeeContracts.employeeId, employeeContracts.startDate, employeeContracts.id);
  let applied = 0;
  for (const candidate of candidates) {
    try {
      const reviewer = await resolveHrActorTx(tx, { userId: candidate.approvedById! }, "hrEnterprise.contracts.approve");
      const c = await lockEmployeeContractTx(tx, reviewer, candidate.id);
      if (!c || c.status !== "DRAFT" || c.approvedAt == null || c.approvedById !== candidate.approvedById) continue;
      const employee = await lockHrEmployeeTx(tx, reviewer, c.employeeId, c.branchId);
      if (c.createdById === reviewer.userId && !canCrossBranches(reviewer)) continue;
      if (employee.employmentStatus === "terminated") continue;
      if (c.endDate != null && c.endDate < baghdadToday()) {
        continue;
      }
      if (await activateEmployeeContractTx(tx, c)) applied++;
    } catch (error) {
      if (error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) continue;
      throw error;
    }
  }
  return applied;
}

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
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.contracts.create");
    const emp = await lockHrEmployeeTx(tx, currentActor, input.employeeId);
    validateContractDates(input);

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
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.contracts.approve");
    const c = await lockEmployeeContractTx(tx, currentActor, id);

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

    if (c.status !== "DRAFT" || c.approvedAt != null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن اعتماد العقد",
          why: `حالة العقد الحالية هي (${c.status}) وليست مسودة قيد التدقيق`,
          doThis: "يمكن اعتماد وتفعيل العقود المسجلة بحالة مسودة فقط",
        }),
      });
    }

    if (c.createdById === currentActor.userId && !canCrossBranches(currentActor)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد العقد",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمنشئ العقد اعتماده بنفسه منعاً لتعارض المصالح",
          doThis: "اطلب من مدير آخر أو مسؤول الصلاحيات مراجعة واعتماد العقد",
        }),
      });
    }
    validateContractDates(c);

    await tx
      .update(employeeContracts)
      .set({
        approvedById: currentActor.userId,
        approvedAt: sql`NOW()`,
      })
      .where(eq(employeeContracts.id, id));
    if (c.startDate > baghdadToday()) return { id, status: "SCHEDULED" as const };
    if (!await activateEmployeeContractTx(tx, { ...c, approvedById: currentActor.userId })) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر تفعيل العقد",
        why: "يوجد عقد سارٍ بتاريخ بداية أحدث ولا يمكن استبداله بعقد أقدم",
        doThis: "راجع تواريخ العقود وأنشئ تصحيحاً بتاريخ سريان مناسب",
      }) });
    }
    return { id, status: "ACTIVE" as const };
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

/** تجديد العقد مسودة مستقلة؛ لا يمس العقد الساري أو الأجر قبل الاعتماد والسريان. */
export async function renewEmployeeContract(
  actor: MaybeScopedActor,
  input: RenewContractInput,
) {
  return withTx(async (tx) => {
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.contracts.renew");
    const old = await lockEmployeeContractTx(tx, currentActor, input.id);

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

    const startDate = input.startDate || old.endDate || baghdadToday();
    const newBasicSalary = input.basicSalary != null ? toDbMoney(money(input.basicSalary)) : old.basicSalary;
    const newAllowances = input.allowances != null ? toDbMoney(money(input.allowances)) : old.allowances;
    const newJobTitle = input.jobTitle?.trim() || old.jobTitle;
    validateContractDates({ startDate, endDate: input.endDate || null });

    const [pending] = await tx.select().from(employeeContracts).where(and(
      eq(employeeContracts.renewedFromId, old.id), eq(employeeContracts.status, "DRAFT"),
    )).for("update").limit(1);
    if (pending) {
      if (pending.startDate === startDate && pending.endDate === (input.endDate || null) &&
        pending.basicSalary === newBasicSalary && pending.allowances === newAllowances && pending.jobTitle === newJobTitle &&
        pending.terms === (input.terms?.trim() || old.terms) &&
        pending.contractNumber === (input.contractNumber?.trim() || (old.contractNumber ? `${old.contractNumber}-R` : null))) {
        return { oldContractId: old.id, newContractId: pending.id, status: displayedContractStatus(pending) };
      }
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "يوجد تجديد قيد المراجعة أو السريان لهذا العقد",
        why: "لا يمكن إنشاء تجديد آخر مختلف قبل حسم التجديد الحالي",
        doThis: "راجع مسودة التجديد الموجودة في قائمة عقود الموظف",
      }) });
    }

    const [res] = await tx.insert(employeeContracts).values({
      employeeId: old.employeeId,
      renewedFromId: old.id,
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
      status: "DRAFT",
      createdById: currentActor.userId,
    });
    await tx.insert(auditLogs).values({ action: "employeeContract.renewalDraft", entityType: "employeeContract", entityId: String(res.insertId), userId: currentActor.userId, branchId: old.branchId, newValue: { renewedFromId: old.id, effectiveDate: startDate, basicSalary: newBasicSalary, status: "DRAFT" } });
    return { oldContractId: old.id, newContractId: res.insertId, status: "DRAFT" as const };
  });
}

/** إنهاء عقد عمل سارٍ مع توثيق سبب وتاريخ الإنهاء. */
export async function terminateEmployeeContract(
  actor: MaybeScopedActor,
  id: number,
  reason?: string | null,
  cancelScheduledOnly: boolean = false,
) {
  return withTx(async (tx) => {
    const currentActor = await resolveHrActorTx(tx, actor, "hrEnterprise.contracts.terminate");
    const c = await lockEmployeeContractTx(tx, currentActor, id);

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

    const reviewedDraft = c.status === "DRAFT" && c.approvedById != null && c.approvedAt != null;
    if (cancelScheduledOnly && !reviewedDraft) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تعذّر إلغاء العقد المؤجل",
        why: "تغيّرت حالة العقد ولم يعد عقداً معتمداً بانتظار التطبيق",
        doThis: "حدّث قائمة العقود وراجع حالته قبل اختيار الإجراء المناسب",
      }) });
    }
    if (c.status !== "ACTIVE" && !reviewedDraft) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن إنهاء هذا العقد",
          why: `حالة العقد الحالية هي (${c.status}) ولا يمكن إنهاء عقد غير سارٍ`,
          doThis: "يمكن إنهاء العقود السارية فقط",
        }),
      });
    }
    if (reviewedDraft && !reason?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
        what: "يلزم سبب لإلغاء العقد المؤجل",
        why: "العقد يحمل اعتماداً سابقاً ويجب توثيق سبب العدول عنه",
        doThis: "اكتب سبب الإلغاء ثم أعد المحاولة",
      }) });
    }

    const todayStr = baghdadToday();
    const updatedTerms = reason?.trim()
      ? `${c.terms || ""}\n[${reviewedDraft ? "أُلغي العقد المؤجل" : "تم الإنهاء"} بتاريخ ${todayStr}: ${reason.trim()}]`.trim()
      : c.terms;

    const pending = reviewedDraft ? [] : await tx.select().from(employeeContracts).where(and(
      eq(employeeContracts.employeeId, c.employeeId), eq(employeeContracts.status, "DRAFT"),
    )).for("update");
    for (const affected of pending) assertHrBranch(currentActor, affected.branchId);
    for (const affected of [c, ...pending]) {
      const terms = affected.id === c.id ? updatedTerms : `${affected.terms || ""}\n[أُلغي التجديد أو العقد المؤجل بتاريخ ${todayStr} بإنهاء العقد #${id}: ${reason?.trim() || "إنهاء العقد الساري"}]`.trim();
      await tx.update(employeeContracts).set({ status: "TERMINATED", endDate: todayStr, terms }).where(eq(employeeContracts.id, affected.id));
    }
    await tx.insert(auditLogs).values({ action: "employeeContract.terminate", entityType: "employeeContract", entityId: String(id), userId: currentActor.userId, branchId: c.branchId, oldValue: { status: c.status, endDate: c.endDate, approvedById: c.approvedById, approvedAt: c.approvedAt }, newValue: { mode: reviewedDraft ? "CANCEL_SCHEDULED" : "TERMINATE_ACTIVE", status: "TERMINATED", effectiveDate: todayStr, reason: reason?.trim() || null, cancelledPendingContractIds: pending.map(row => row.id) } });

    return { id, status: "TERMINATED", cancelledScheduled: reviewedDraft };
  });
}

/** استعلام عقود الموظف مع دعم عزل الفروع. */
export async function listEmployeeContracts(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const conds = [eq(employeeContracts.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(eq(employeeContracts.branchId, scopedBranchId));
  }
  return withTx(async tx => {
    const [employee] = await tx.select({ id: employees.id }).from(employees).where(and(
      eq(employees.id, employeeId), ...(scopedBranchId == null ? [] : [eq(employees.branchId, scopedBranchId)]),
    )).for("update").limit(1);
    if (!employee) return [];
    await applyDueEmployeeContracts(tx, baghdadToday(), employeeId);
    const rows = await tx.select().from(employeeContracts).where(and(...conds)).orderBy(desc(employeeContracts.startDate));
    return rows.map(row => ({ ...row, displayStatus: displayedContractStatus(row) }));
  });
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

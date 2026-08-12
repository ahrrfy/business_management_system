/* ============================================================================
 * خدمة التوظيف — وحدة الموارد البشرية (server/services/recruitmentService.ts)
 * مسار التقديم: متقدّمون (jobApplicants) عبر مسارين — رابط خارجي عام يملؤه المتقدّم
 * (source=external, stage=new)، أو استمارة ورقية/أرشيف يُدخلها الموظف. تغيير المرحلة
 * والتقييم لاحقاً. لا مبالغ مالية هنا ⇒ بلا money.ts. قراءات عبر requireDb.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, getTableColumns, like, or } from "drizzle-orm";
import { branches, jobApplicants, jobApplicantCvFiles, jobVacancies } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { escapeLike } from "../lib/sqlLike";
import { toDateStr } from "./money";
import { extractInsertId } from "../lib/insertId";
import { resolveTargetBranch, type CompanyBranchScope } from "./companyBranchScope";
import type { Tx } from "../db";
import {
  insertPreparedJobApplicantCv,
  prepareJobApplicantCv,
  type JobApplicantCvUploadInput,
} from "./jobApplicantCvService";

const COMPANY_SCOPE: CompanyBranchScope = { branchId: null };

function vacancyScopeCondition(scope: CompanyBranchScope) {
  return scope.branchId == null ? undefined : eq(jobVacancies.branchId, scope.branchId);
}

function applicantScopeCondition(scope: CompanyBranchScope) {
  return scope.branchId == null ? undefined : eq(jobApplicants.branchId, scope.branchId);
}

function vacancyByIdCondition(id: number, scope: CompanyBranchScope) {
  const branch = vacancyScopeCondition(scope);
  return branch ? and(eq(jobVacancies.id, id), branch) : eq(jobVacancies.id, id);
}

async function lockApplicantInScope(tx: Tx, id: number, scope: CompanyBranchScope) {
  if (scope.branchId == null) {
    const [applicant] = await tx
      .select({ id: jobApplicants.id })
      .from(jobApplicants)
      .where(eq(jobApplicants.id, id))
      .for("update")
      .limit(1);
    if (!applicant) throw new TRPCError({ code: "NOT_FOUND", message: "المتقدّم غير موجود" });
    return;
  }

  // Applicant ownership is persisted independently from the optional vacancy,
  // so deletion or movement of a vacancy cannot make the applicant disappear.
  const [applicant] = await tx
    .select({ id: jobApplicants.id })
    .from(jobApplicants)
    .where(and(eq(jobApplicants.id, id), eq(jobApplicants.branchId, scope.branchId)))
    .for("update")
    .limit(1);
  if (!applicant) throw new TRPCError({ code: "NOT_FOUND", message: "المتقدّم غير موجود" });
}

export interface ApplicantFilters {
  stage?: string;
  source?: string;
  q?: string;
  vacancyId?: number;
}

export async function listApplicants(filters?: ApplicantFilters, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const conds = [];
  const branch = applicantScopeCondition(scope);
  if (branch) conds.push(branch);
  if (filters?.stage) conds.push(eq(jobApplicants.stage, filters.stage as never));
  if (filters?.source) conds.push(eq(jobApplicants.source, filters.source));
  if (filters?.vacancyId) conds.push(eq(jobApplicants.vacancyId, filters.vacancyId));
  if (filters?.q) {
    const t = `%${escapeLike(filters.q.trim())}%`;
    conds.push(
      or(
        like(jobApplicants.name, t),
        like(jobApplicants.jobTitle, t),
        like(jobApplicants.phone, t),
        like(jobApplicants.email, t),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select({ ...getTableColumns(jobApplicants), cvFileKey: jobApplicantCvFiles.publicKey })
    .from(jobApplicants)
    .leftJoin(jobVacancies, eq(jobApplicants.vacancyId, jobVacancies.id))
    .leftJoin(jobApplicantCvFiles, eq(jobApplicantCvFiles.applicantId, jobApplicants.id))
    .where(where)
    .orderBy(desc(jobApplicants.createdAt), desc(jobApplicants.id));
}

export async function getApplicant(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const branch = applicantScopeCondition(scope);
  const [a] = await db
    .select({ ...getTableColumns(jobApplicants), cvFileKey: jobApplicantCvFiles.publicKey })
    .from(jobApplicants)
    .leftJoin(jobVacancies, eq(jobApplicants.vacancyId, jobVacancies.id))
    .leftJoin(jobApplicantCvFiles, eq(jobApplicantCvFiles.applicantId, jobApplicants.id))
    .where(branch ? and(eq(jobApplicants.id, id), branch) : eq(jobApplicants.id, id))
    .limit(1);
  return a ?? null;
}

export interface ApplicantInput {
  name: string;
  jobTitle?: string | null;
  branchId?: number | null;
  vacancyId?: number | null;
  source?: string | null;
  stage?: string | null;
  phone?: string | null;
  email?: string | null;
  experience?: string | null;
  education?: string | null;
  appliedDate?: string | null;
  rating?: number | null;
  notes?: string | null;
  cv?: JobApplicantCvUploadInput | null;
}

/**
 * إنشاء متقدّم — يستعمله الموظف (source paper/archive) والاستمارة العامّة (source external).
 * يُهمَل أي مرحلة/مصدر غير معروف ويُستعاض عنه بالافتراضي (الحماية في الراوتر بـ zod).
 */
export async function createApplicant(input: ApplicantInput, scope?: CompanyBranchScope) {
  const db = requireDb();
  const name = input.name.trim();
  if (!name) throw new Error("اسم المتقدّم مطلوب");

  // ربط الوظيفة الشاغرة: عنوان الوظيفة يُؤخذ من سجلّها (مصدر موثوق) لا من المتقدّم — يمنع التزييف عبر الاستمارة العامّة.
  let vacancyId: number | null = null;
  let jobTitle: string | null = input.jobTitle?.trim() || null;
  let branchId: number | null = null;
  if (input.vacancyId != null) {
    const v = await getVacancy(input.vacancyId, scope ?? COMPANY_SCOPE);
    if (v && (scope || v.isPublished)) {
      vacancyId = v.id;
      branchId = v.branchId;
      jobTitle = v.title; // العنوان الموثوق من سجلّ الوظيفة
    } else {
      throw new TRPCError({ code: "NOT_FOUND", message: "الوظيفة غير موجودة" });
    }
  } else if (scope) {
    branchId = resolveTargetBranch(scope, input.branchId, { required: false });
  } else {
    const requestedBranchId = Number(input.branchId);
    if (!Number.isInteger(requestedBranchId) || requestedBranchId <= 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع المطلوب للتقديم العام" });
    }
    const [activeBranch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, requestedBranchId), eq(branches.isActive, true)))
      .limit(1);
    if (!activeBranch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير متاح للتقديم" });
    branchId = activeBranch.id;
  }

  // Strictly validate attacker-controlled bytes before opening the transaction.
  const preparedCv = input.cv ? prepareJobApplicantCv(input.cv) : null;
  const applicantId = await db.transaction(async (tx) => {
    const [res] = await tx.insert(jobApplicants).values({
      name,
      jobTitle,
      branchId,
      vacancyId,
      source: (input.source?.trim() || "external"),
      stage: (input.stage?.trim() || "new") as never,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      experience: input.experience?.trim() || null,
      education: input.education?.trim() || null,
      appliedDate: input.appliedDate?.trim() || toDateStr(),
      rating: input.rating != null ? Math.max(0, Math.min(5, Math.trunc(input.rating))) : 0,
      notes: input.notes?.trim() || null,
      // Public keys are generated only by the server; client-selected keys are ignored.
      cvFileKey: preparedCv?.publicKey ?? null,
    });
    const id = extractInsertId(res);
    if (preparedCv) await insertPreparedJobApplicantCv(tx, id, preparedCv);
    return id;
  });
  return getApplicant(applicantId, scope ?? COMPANY_SCOPE);
}

/** نقل المتقدّم بين مراحل المسار (جديد → مراجعة → مقابلة → مقبول/مرفوض/أرشيف). */
export async function updateStage(
  id: number,
  stage: "new" | "review" | "interview" | "accepted" | "rejected" | "archived",
  scope: CompanyBranchScope = COMPANY_SCOPE,
) {
  await withTx(async (tx) => {
    await lockApplicantInScope(tx, id, scope);
    await tx.update(jobApplicants).set({ stage }).where(eq(jobApplicants.id, id));
  });
  return getApplicant(id, scope);
}

/** ضبط التقييم المبدئي (٠–٥ نجوم). */
export async function setRating(id: number, rating: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const r = Math.max(0, Math.min(5, Math.trunc(rating)));
  await withTx(async (tx) => {
    await lockApplicantInScope(tx, id, scope);
    await tx.update(jobApplicants).set({ rating: r }).where(eq(jobApplicants.id, id));
  });
  return getApplicant(id, scope);
}

/* ============================================================================
 * الوظائف الشاغرة (jobVacancies) — يديرها HR، ويُعرَض المنشور منها على معرض /apply العام.
 * ========================================================================== */

export interface VacancyInput {
  title: string;
  department?: string | null;
  employmentType?: string | null;
  location?: string | null;
  branchId?: number | null;
  summary?: string | null;
  description?: string | null;
  requirements?: string | null;
  openings?: number | null;
  imageUrl?: string | null;
  isPublished?: boolean | null;
  sortOrder?: number | null;
}

/** الوظائف المنشورة فقط، مرتّبةً للعرض العام (المعرض). بلا حقول إدارية حسّاسة زائدة. */
export async function listOpenVacancies() {
  const db = requireDb();
  return db
    .select()
    .from(jobVacancies)
    .where(eq(jobVacancies.isPublished, true))
    .orderBy(asc(jobVacancies.sortOrder), desc(jobVacancies.createdAt), desc(jobVacancies.id));
}

/** كل الوظائف (إدارة HR) — منشورة وغير منشورة — مرتّبة للوحة الإدارة. */
export async function listVacancies(onlyPublished?: boolean, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const conds = [];
  if (onlyPublished) conds.push(eq(jobVacancies.isPublished, true));
  const branch = vacancyScopeCondition(scope);
  if (branch) conds.push(branch);
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select()
    .from(jobVacancies)
    .where(where)
    .orderBy(asc(jobVacancies.sortOrder), desc(jobVacancies.createdAt), desc(jobVacancies.id));
}

export async function getVacancy(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const [v] = await db.select().from(jobVacancies).where(vacancyByIdCondition(id, scope)).limit(1);
  return v ?? null;
}

/** عدد المتقدّمين المرتبطين بكل وظيفة — لعرضه على لوحة الإدارة. */
export async function vacancyApplicantCounts(scope: CompanyBranchScope = COMPANY_SCOPE): Promise<Record<number, number>> {
  const db = requireDb();
  const rows = await db
    .select({ vacancyId: jobApplicants.vacancyId })
    .from(jobApplicants)
    .leftJoin(jobVacancies, eq(jobApplicants.vacancyId, jobVacancies.id))
    .where(vacancyScopeCondition(scope));
  const out: Record<number, number> = {};
  for (const r of rows) {
    if (r.vacancyId != null) out[r.vacancyId] = (out[r.vacancyId] ?? 0) + 1;
  }
  return out;
}

function normalizeVacancy(input: VacancyInput) {
  const title = input.title.trim();
  if (!title) throw new Error("عنوان الوظيفة مطلوب");
  return {
    title,
    department: input.department?.trim() || null,
    employmentType: input.employmentType?.trim() || "full_time",
    location: input.location?.trim() || null,
    branchId: input.branchId ?? null,
    summary: input.summary?.trim() || null,
    description: input.description?.trim() || null,
    requirements: input.requirements?.trim() || null,
    openings: input.openings != null ? Math.max(1, Math.trunc(input.openings)) : 1,
    imageUrl: input.imageUrl?.trim() || null,
    isPublished: input.isPublished ?? false,
    sortOrder: input.sortOrder != null ? Math.trunc(input.sortOrder) : 0,
  };
}

export async function createVacancy(input: VacancyInput, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const branchId = resolveTargetBranch(scope, input.branchId, { required: false });
  const [res] = await db.insert(jobVacancies).values(normalizeVacancy({ ...input, branchId }));
  return getVacancy(extractInsertId(res), scope);
}

export async function updateVacancy(id: number, input: VacancyInput, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const existing = await getVacancy(id, scope);
  if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الوظيفة غير موجودة" });
  const branchId = resolveTargetBranch(scope, input.branchId, { required: false });
  await db.update(jobVacancies).set(normalizeVacancy({ ...input, branchId })).where(vacancyByIdCondition(id, scope));
  return getVacancy(id, scope);
}

/** نشر/إخفاء وظيفة عن المعرض العام دون حذفها. */
export async function setVacancyPublished(id: number, isPublished: boolean, scope: CompanyBranchScope = COMPANY_SCOPE) {
  const db = requireDb();
  const existing = await getVacancy(id, scope);
  if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الوظيفة غير موجودة" });
  await db.update(jobVacancies).set({ isPublished }).where(vacancyByIdCondition(id, scope));
  return getVacancy(id, scope);
}

/** حذف وظيفة. المتقدّمون المرتبطون بها يبقون (vacancyId يصبح NULL عبر ON DELETE — لكنّا نفصلهم يدوياً للأمان). */
export async function deleteVacancy(id: number, scope: CompanyBranchScope = COMPANY_SCOPE) {
  return withTx(async (tx) => {
    const [existing] = await tx
      .select({ id: jobVacancies.id })
      .from(jobVacancies)
      .where(vacancyByIdCondition(id, scope))
      .for("update")
      .limit(1);
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الوظيفة غير موجودة" });
    // افصل المتقدّمين عن الوظيفة قبل حذفها (يحفظ عنوان الوظيفة المخزّن في jobTitle ويرفع قيد المفتاح الأجنبي).
    await tx.update(jobApplicants).set({ vacancyId: null }).where(eq(jobApplicants.vacancyId, id));
    await tx.delete(jobVacancies).where(eq(jobVacancies.id, id));
    return { id };
  });
}

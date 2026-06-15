/* ============================================================================
 * خدمة التوظيف — وحدة الموارد البشرية (server/services/recruitmentService.ts)
 * مسار التقديم: متقدّمون (jobApplicants) عبر مسارين — رابط خارجي عام يملؤه المتقدّم
 * (source=external, stage=new)، أو استمارة ورقية/أرشيف يُدخلها الموظف. تغيير المرحلة
 * والتقييم لاحقاً. لا مبالغ مالية هنا ⇒ بلا money.ts. قراءات عبر requireDb.
 * ========================================================================== */
import { and, asc, desc, eq, like, or } from "drizzle-orm";
import { jobApplicants, jobVacancies } from "../../drizzle/schema";
import { requireDb } from "./tx";
import { toDateStr } from "./money";
import { extractInsertId } from "../lib/insertId";

export interface ApplicantFilters {
  stage?: string;
  source?: string;
  q?: string;
}

export async function listApplicants(filters?: ApplicantFilters) {
  const db = requireDb();
  const conds = [];
  if (filters?.stage) conds.push(eq(jobApplicants.stage, filters.stage as never));
  if (filters?.source) conds.push(eq(jobApplicants.source, filters.source));
  if (filters?.q) {
    const t = `%${filters.q.trim()}%`;
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
  return db.select().from(jobApplicants).where(where).orderBy(desc(jobApplicants.createdAt), desc(jobApplicants.id));
}

export async function getApplicant(id: number) {
  const db = requireDb();
  const [a] = await db.select().from(jobApplicants).where(eq(jobApplicants.id, id)).limit(1);
  return a ?? null;
}

export interface ApplicantInput {
  name: string;
  jobTitle?: string | null;
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
  cvFileKey?: string | null;
}

/**
 * إنشاء متقدّم — يستعمله الموظف (source paper/archive) والاستمارة العامّة (source external).
 * يُهمَل أي مرحلة/مصدر غير معروف ويُستعاض عنه بالافتراضي (الحماية في الراوتر بـ zod).
 */
export async function createApplicant(input: ApplicantInput) {
  const db = requireDb();
  const name = input.name.trim();
  if (!name) throw new Error("اسم المتقدّم مطلوب");

  // ربط الوظيفة الشاغرة: عنوان الوظيفة يُؤخذ من سجلّها (مصدر موثوق) لا من المتقدّم — يمنع التزييف عبر الاستمارة العامّة.
  let vacancyId: number | null = null;
  let jobTitle: string | null = input.jobTitle?.trim() || null;
  if (input.vacancyId != null) {
    const v = await getVacancy(input.vacancyId);
    if (v) {
      vacancyId = v.id;
      jobTitle = v.title; // العنوان الموثوق من سجلّ الوظيفة
    }
  }

  const [res] = await db.insert(jobApplicants).values({
    name,
    jobTitle,
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
    cvFileKey: input.cvFileKey?.trim() || null,
  });
  return getApplicant(extractInsertId(res));
}

/** نقل المتقدّم بين مراحل المسار (جديد → مراجعة → مقابلة → مقبول/مرفوض/أرشيف). */
export async function updateStage(
  id: number,
  stage: "new" | "review" | "interview" | "accepted" | "rejected" | "archived",
) {
  const db = requireDb();
  const [a] = await db.select().from(jobApplicants).where(eq(jobApplicants.id, id)).limit(1);
  if (!a) throw new Error("المتقدّم غير موجود");
  await db.update(jobApplicants).set({ stage }).where(eq(jobApplicants.id, id));
  return getApplicant(id);
}

/** ضبط التقييم المبدئي (٠–٥ نجوم). */
export async function setRating(id: number, rating: number) {
  const db = requireDb();
  const [a] = await db.select().from(jobApplicants).where(eq(jobApplicants.id, id)).limit(1);
  if (!a) throw new Error("المتقدّم غير موجود");
  const r = Math.max(0, Math.min(5, Math.trunc(rating)));
  await db.update(jobApplicants).set({ rating: r }).where(eq(jobApplicants.id, id));
  return getApplicant(id);
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
export async function listVacancies(onlyPublished?: boolean) {
  const db = requireDb();
  const where = onlyPublished ? eq(jobVacancies.isPublished, true) : undefined;
  return db
    .select()
    .from(jobVacancies)
    .where(where)
    .orderBy(asc(jobVacancies.sortOrder), desc(jobVacancies.createdAt), desc(jobVacancies.id));
}

export async function getVacancy(id: number) {
  const db = requireDb();
  const [v] = await db.select().from(jobVacancies).where(eq(jobVacancies.id, id)).limit(1);
  return v ?? null;
}

/** عدد المتقدّمين المرتبطين بكل وظيفة — لعرضه على لوحة الإدارة. */
export async function vacancyApplicantCounts(): Promise<Record<number, number>> {
  const db = requireDb();
  const rows = await db
    .select({ vacancyId: jobApplicants.vacancyId })
    .from(jobApplicants);
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

export async function createVacancy(input: VacancyInput) {
  const db = requireDb();
  const [res] = await db.insert(jobVacancies).values(normalizeVacancy(input));
  return getVacancy(extractInsertId(res));
}

export async function updateVacancy(id: number, input: VacancyInput) {
  const db = requireDb();
  const existing = await getVacancy(id);
  if (!existing) throw new Error("الوظيفة غير موجودة");
  await db.update(jobVacancies).set(normalizeVacancy(input)).where(eq(jobVacancies.id, id));
  return getVacancy(id);
}

/** نشر/إخفاء وظيفة عن المعرض العام دون حذفها. */
export async function setVacancyPublished(id: number, isPublished: boolean) {
  const db = requireDb();
  const existing = await getVacancy(id);
  if (!existing) throw new Error("الوظيفة غير موجودة");
  await db.update(jobVacancies).set({ isPublished }).where(eq(jobVacancies.id, id));
  return getVacancy(id);
}

/** حذف وظيفة. المتقدّمون المرتبطون بها يبقون (vacancyId يصبح NULL عبر ON DELETE — لكنّا نفصلهم يدوياً للأمان). */
export async function deleteVacancy(id: number) {
  const db = requireDb();
  const existing = await getVacancy(id);
  if (!existing) throw new Error("الوظيفة غير موجودة");
  // افصل المتقدّمين عن الوظيفة قبل حذفها (يحفظ عنوان الوظيفة المخزّن في jobTitle ويرفع قيد المفتاح الأجنبي).
  await db.update(jobApplicants).set({ vacancyId: null }).where(eq(jobApplicants.vacancyId, id));
  await db.delete(jobVacancies).where(eq(jobVacancies.id, id));
  return { id };
}

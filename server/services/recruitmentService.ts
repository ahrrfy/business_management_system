/* ============================================================================
 * خدمة التوظيف — وحدة الموارد البشرية (server/services/recruitmentService.ts)
 * مسار التقديم: متقدّمون (jobApplicants) عبر مسارين — رابط خارجي عام يملؤه المتقدّم
 * (source=external, stage=new)، أو استمارة ورقية/أرشيف يُدخلها الموظف. تغيير المرحلة
 * والتقييم لاحقاً. لا مبالغ مالية هنا ⇒ بلا money.ts. قراءات عبر requireDb.
 * ========================================================================== */
import { and, desc, eq, like, or } from "drizzle-orm";
import { jobApplicants } from "../../drizzle/schema";
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
  const [res] = await db.insert(jobApplicants).values({
    name,
    jobTitle: input.jobTitle?.trim() || null,
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

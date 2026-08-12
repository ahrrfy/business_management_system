/* ============================================================================
 * موجّه tRPC للتوظيف — وحدة الموارد البشرية (server/routers/recruitmentRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق.
 * استثناء: recruitment.submit إجراء **عام** (publicProcedure) لاستمارة التقديم
 * الخارجية — بلا مصادقة — يُنشئ متقدّماً بمصدر external ومرحلة new.
 * يُصدَّر بالاسم؛ القائد يركّبه تحت trpc.recruitment.
 * ========================================================================== */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { APPLICANT_SOURCES, APPLICANT_STAGE_KEYS, EMPLOYMENT_TYPE_KEYS } from "@shared/hr";
import { logAudit } from "../services/auditService";
import * as svc from "../services/recruitmentService";
import { protectedProcedure, publicProcedure, requireModule, router } from "../trpc";
import { companyBranchScope, resolveTargetBranch } from "../services/companyBranchScope";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const SOURCE_KEYS = APPLICANT_SOURCES.map((s) => s.key) as [string, ...string[]];

const applicantCv = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]),
    // 2MB decoded becomes at most 2,796,204 canonical base64 characters.
    base64: z.string().max(2_796_204),
  })
  .strict()
  .optional();

/** صورة الوظيفة كـ data URL مضغوط — حدّ ~٢ مليون محرف يتّسع لناتج الضغط (≤٧٠٠KB) ويردّ الإساءة. */
const vacancyImage = z.string().trim().max(2_200_000).optional();

/** حقول الوظيفة الشاغرة المشتركة (إنشاء/تعديل). */
const vacancyFields = {
  title: z.string().trim().min(1, "عنوان الوظيفة مطلوب").max(200),
  department: z.string().trim().max(120).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPE_KEYS).default("full_time"),
  location: z.string().trim().max(200).optional(),
  branchId: z.number().int().positive().nullable().optional(),
  summary: z.string().trim().max(400).optional(),
  description: z.string().trim().max(5000).optional(),
  requirements: z.string().trim().max(5000).optional(),
  openings: z.number().int().min(1).max(999).optional(),
  imageUrl: vacancyImage,
  isPublished: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
};

/** حقول استمارة التقديم/الإدخال الورقي المشتركة. */
const applicantFields = {
  name: z.string().trim().min(1, "اسم المتقدّم مطلوب").max(200),
  jobTitle: z.string().trim().max(150).optional(),
  branchId: z.number().int().positive().optional(),
  vacancyId: z.number().int().positive().optional(),
  phone: z.string().trim().max(20).optional(),
  // البريد اختياري: الفراغ يُحوَّل إلى undefined، وإن وُجد يجب أن يكون صيغة بريد صالحة.
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(120).email("بريد إلكتروني غير صالح").optional(),
  ),
  experience: z.string().trim().max(120).optional(),
  education: z.string().trim().max(200).optional(),
  // حدّ أقصى للملاحظات: يمنع تسرّب خطأ «Data too long» (عمود TEXT) وإساءة الحجم عبر الإجراء العام.
  notes: z.string().trim().max(2000).optional(),
  cv: applicantCv,
};

export const recruitmentRouter = router({
  /**
   * فلتر الوظيفة (vacancyId) فوق `recruitmentService.listApplicants` — الخدمة (خارج ملكية هذه
   * الشريحة) لا تدعمه بعد؛ يُطبَّق هنا فوق النتيجة الكاملة (`jobApplicants` تحمل العمود أصلاً).
   */
  list: hrRead
    .input(
      z
        .object({
          stage: z.enum(APPLICANT_STAGE_KEYS).optional(),
          source: z.enum(SOURCE_KEYS).optional(),
          q: z.string().optional(),
          vacancyId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) => svc.listApplicants(input, companyBranchScope(ctx.user))),

  get: hrRead.input(z.object({ id: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const a = await svc.getApplicant(input.id, companyBranchScope(ctx.user));
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "المتقدّم غير موجود" });
    return a;
  }),

  /** إدخال متقدّم من الموظف (استمارة ورقية/أرشيف، أو يدوياً برابط خارجي). */
  create: hrWrite
    .input(
      z.object({
        ...applicantFields,
        source: z.enum(SOURCE_KEYS).default("paper"),
        stage: z.enum(APPLICANT_STAGE_KEYS).default("new"),
        appliedDate: z.string().optional(),
        rating: z.number().int().min(0).max(5).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const a = await svc.createApplicant(input as svc.ApplicantInput, companyBranchScope(ctx.user));
      await logAudit(ctx, {
        action: "recruitment.create",
        entityType: "jobApplicant",
        entityId: a?.id,
        newValue: { name: a?.name, source: input.source, jobTitle: input.jobTitle ?? null },
      });
      return a;
    }),

  /** نقل المتقدّم إلى مرحلة جديدة في المسار. */
  updateStage: hrWrite
    .input(z.object({ id: z.number().int().positive(), stage: z.enum(APPLICANT_STAGE_KEYS) }))
    .mutation(async ({ input, ctx }) => {
      const a = await svc.updateStage(input.id, input.stage, companyBranchScope(ctx.user));
      await logAudit(ctx, {
        action: "recruitment.updateStage",
        entityType: "jobApplicant",
        entityId: input.id,
        newValue: { stage: input.stage },
      });
      return a;
    }),

  /** ضبط التقييم المبدئي (٠–٥). */
  setRating: hrWrite
    .input(z.object({ id: z.number().int().positive(), rating: z.number().int().min(0).max(5) }))
    .mutation(async ({ input, ctx }) => {
      const res = await svc.setRating(input.id, input.rating, companyBranchScope(ctx.user));
      await logAudit(ctx, { action: "recruitment.setRating", entityType: "applicant", entityId: input.id, newValue: { rating: input.rating } });
      return res;
    }),

  /**
   * استمارة التقديم الخارجية — إجراء **عام** (بلا مصادقة).
   * يُنشئ متقدّماً بمصدر external ومرحلة new. الحارس الأساس: الاسم مطلوب (zod).
   * إن مرّر vacancyId صالحاً، يُربَط المتقدّم بالوظيفة ويؤخذ العنوان من سجلّها (الخدمة).
   */
  submit: publicProcedure
    .input(z.object(applicantFields))
    .mutation(({ input }) =>
      svc.createApplicant({ ...input, source: "external", stage: "new" } as svc.ApplicantInput),
    ),

  /* ===================== الوظائف الشاغرة ===================== */

  /** المعرض العام: الوظائف المنشورة فقط — إجراء **عام** (بلا مصادقة) لصفحة /apply. */
  openVacancies: publicProcedure.query(() => svc.listOpenVacancies()),

  /** إدارة HR: كل الوظائف (منشورة وغير منشورة) + خيار تقييد على المنشورة. */
  vacancyList: hrRead
    .input(z.object({ onlyPublished: z.boolean().optional() }).optional())
    .query(({ input, ctx }) => svc.listVacancies(input?.onlyPublished, companyBranchScope(ctx.user))),

  vacancyGet: hrRead
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const v = await svc.getVacancy(input.id, companyBranchScope(ctx.user));
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "الوظيفة غير موجودة" });
      return v;
    }),

  /** عدّاد المتقدّمين لكل وظيفة (للوحة الإدارة). */
  vacancyCounts: hrRead.query(({ ctx }) => svc.vacancyApplicantCounts(companyBranchScope(ctx.user))),

  vacancyCreate: hrWrite
    .input(z.object(vacancyFields))
    .mutation(async ({ input, ctx }) => {
      const scope = companyBranchScope(ctx.user);
      const branchId = resolveTargetBranch(scope, input.branchId, { required: false });
      const v = await svc.createVacancy({ ...input, branchId } as svc.VacancyInput, scope);
      await logAudit(ctx, {
        action: "recruitment.vacancyCreate",
        entityType: "jobVacancy",
        entityId: v?.id,
        newValue: { title: v?.title, department: v?.department, isPublished: v?.isPublished },
      });
      return v;
    }),

  vacancyUpdate: hrWrite
    .input(z.object({ id: z.number().int().positive(), ...vacancyFields }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...rest } = input;
      const scope = companyBranchScope(ctx.user);
      const existing = await svc.getVacancy(id, scope);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "الوظيفة غير موجودة" });
      const branchId = resolveTargetBranch(scope, rest.branchId, { required: false });
      const v = await svc.updateVacancy(id, { ...rest, branchId } as svc.VacancyInput, scope);
      await logAudit(ctx, {
        action: "recruitment.vacancyUpdate",
        entityType: "jobVacancy",
        entityId: id,
        newValue: { title: v?.title, isPublished: v?.isPublished },
      });
      return v;
    }),

  vacancyPublish: hrWrite
    .input(z.object({ id: z.number().int().positive(), isPublished: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const v = await svc.setVacancyPublished(input.id, input.isPublished, companyBranchScope(ctx.user));
      await logAudit(ctx, {
        action: "recruitment.vacancyPublish",
        entityType: "jobVacancy",
        entityId: input.id,
        newValue: { isPublished: input.isPublished },
      });
      return v;
    }),

  vacancyDelete: hrWrite
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const r = await svc.deleteVacancy(input.id, companyBranchScope(ctx.user));
      await logAudit(ctx, {
        action: "recruitment.vacancyDelete",
        entityType: "jobVacancy",
        entityId: input.id,
      });
      return r;
    }),
});

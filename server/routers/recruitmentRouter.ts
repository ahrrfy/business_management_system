/* ============================================================================
 * موجّه tRPC للتوظيف — وحدة الموارد البشرية (server/routers/recruitmentRouter.ts)
 * القراءة بصلاحية hr/READ والكتابة بـ hr/FULL (requireModule). كل كتابة تُدقَّق.
 * استثناء: recruitment.submit إجراء **عام** (publicProcedure) لاستمارة التقديم
 * الخارجية — بلا مصادقة — يُنشئ متقدّماً بمصدر external ومرحلة new.
 * يُصدَّر بالاسم؛ القائد يركّبه تحت trpc.recruitment.
 * ========================================================================== */
import { z } from "zod";
import { APPLICANT_SOURCES, APPLICANT_STAGE_KEYS } from "@shared/hr";
import { logAudit } from "../services/auditService";
import * as svc from "../services/recruitmentService";
import { protectedProcedure, publicProcedure, requireModule, router } from "../trpc";

const hrRead = protectedProcedure.use(requireModule("hr", "READ"));
const hrWrite = protectedProcedure.use(requireModule("hr", "FULL"));

const SOURCE_KEYS = APPLICANT_SOURCES.map((s) => s.key) as [string, ...string[]];

/** حقول استمارة التقديم/الإدخال الورقي المشتركة. */
const applicantFields = {
  name: z.string().trim().min(1, "اسم المتقدّم مطلوب").max(200),
  jobTitle: z.string().trim().max(150).optional(),
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
};

export const recruitmentRouter = router({
  list: hrRead
    .input(
      z
        .object({
          stage: z.enum(APPLICANT_STAGE_KEYS).optional(),
          source: z.enum(SOURCE_KEYS).optional(),
          q: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => svc.listApplicants(input)),

  get: hrRead.input(z.object({ id: z.number().int().positive() })).query(({ input }) => svc.getApplicant(input.id)),

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
      const a = await svc.createApplicant(input as svc.ApplicantInput);
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
      const a = await svc.updateStage(input.id, input.stage);
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
    .mutation(({ input }) => svc.setRating(input.id, input.rating)),

  /**
   * استمارة التقديم الخارجية — إجراء **عام** (بلا مصادقة).
   * يُنشئ متقدّماً بمصدر external ومرحلة new. الحارس الأساس: الاسم مطلوب (zod).
   */
  submit: publicProcedure
    .input(z.object(applicantFields))
    .mutation(({ input }) =>
      svc.createApplicant({ ...input, source: "external", stage: "new" } as svc.ApplicantInput),
    ),
});

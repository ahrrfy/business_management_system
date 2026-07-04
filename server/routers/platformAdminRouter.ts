import { PLATFORM_ADMIN_COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "../cookies";
import { listCompanies, setCompanyActive } from "../tenancy/registry";
import {
  createProvisionRequest,
  getProvisionRequestStatus,
  listRecentProvisionRequests,
} from "../tenancy/provisionRequests";
import { signPlatformSession } from "../tenancy/platformAuth";
import { verifyPlatformAdminCredentials } from "../tenancy/platformAdminService";
import { logPlatformAudit } from "../tenancy/platformAudit";
import { platformAdminProcedure, publicProcedure, router } from "../trpc";

/**
 * إدارة الشركات (مدير المنصّة) — منفصلة تماماً عن authRouter (جلسة الشركات).
 *
 * **لا توفير فعلي من خادم الويب أبداً** — `companies.requestCreate` تكتب طلباً في طابور
 * (companyProvisionRequests) فقط؛ التوفير الفعلي (قاعدة MySQL جديدة + docker exec بصلاحية
 * root + عمليات فرعية) ينفّذه `scripts/company-provision-worker.mjs` كعملية منفصلة تماماً
 * بصلاحيات مرتفعة لا يملكها خادم الويب الحيّ إطلاقاً (راجع تعليق الجدول في controlSchema.ts).
 * هذا يحافظ على المبدأ الأصلي (توفير = عملية تشغيلية لا معالج HTTP قصير العمر) مع إتاحة
 * تشغيلها من الواجهة بدل الطرفية فقط.
 */
export const platformAdminRouter = router({
  login: publicProcedure
    .input(z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const admin = await verifyPlatformAdminCredentials(input.email, input.password);
      if (!admin) {
        // F4: محاولة دخول فاشلة تُسجَّل أيضاً (لا معرّف — البريد المُدخَل دليل من حاول).
        await logPlatformAudit(ctx, { action: "login", success: false, actorEmail: input.email.trim().toLowerCase() });
        throw new TRPCError({ code: "UNAUTHORIZED", message: "البريد أو كلمة المرور غير صحيحة" });
      }
      const token = await signPlatformSession(admin.id);
      ctx.res.cookie(PLATFORM_ADMIN_COOKIE_NAME, token, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: 1000 * 60 * 60 * 8,
      });
      await logPlatformAudit(ctx, { action: "login", success: true, platformAdminId: admin.id, actorEmail: admin.email });
      return { id: admin.id, email: admin.email, name: admin.name };
    }),

  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.platformAdmin) return null;
    const { passwordHash: _passwordHash, ...safe } = ctx.platformAdmin;
    return safe;
  }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    // F4: نُسجّل قبل مسح الكوكي (الهوية محلولة على السياق). كوكي منتهٍ ⇒ لا فاعل معلوم ⇒ نتخطّى.
    if (ctx.platformAdmin) {
      await logPlatformAudit(ctx, { action: "logout", success: true, platformAdminId: ctx.platformAdmin.id, actorEmail: ctx.platformAdmin.email });
    }
    ctx.res.clearCookie(PLATFORM_ADMIN_COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { success: true } as const;
  }),

  companies: router({
    list: platformAdminProcedure.query(() => listCompanies()),

    setActive: platformAdminProcedure
      .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        await setCompanyActive(input.id, input.isActive);
        await logPlatformAudit(ctx, {
          action: "company.setActive",
          success: true,
          platformAdminId: ctx.platformAdmin.id,
          actorEmail: ctx.platformAdmin.email,
          companyId: input.id,
          details: { isActive: input.isActive },
        });
        return { success: true } as const;
      }),

    /** ينشئ طلب توفير شركة (طابور) — لا يوفّر شيئاً فعلياً هنا. يُعيد كلمة مرور المدير
     *  الأول **مرّة واحدة فقط** (لا تُخزَّن مفكوكة التشفير بعدها). العامل المنفصل
     *  ينفّذ التوفير الفعلي لاحقاً (راجع تعليق الراوتر أعلاه). */
    requestCreate: platformAdminProcedure
      .input(
        z.object({
          code: z.string().min(2).max(40),
          name: z.string().min(1).max(255),
          adminEmail: z.string().email().max(320),
          adminUsername: z.string().max(64).optional(),
          demo: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { id, tempPassword } = await createProvisionRequest({
          code: input.code,
          name: input.name,
          adminEmail: input.adminEmail,
          adminUsername: input.adminUsername ?? "admin",
          demo: input.demo ?? false,
          requestedByAdminId: ctx.platformAdmin.id,
        });
        await logPlatformAudit(ctx, {
          action: "company.requestCreate",
          success: true,
          platformAdminId: ctx.platformAdmin.id,
          actorEmail: ctx.platformAdmin.email,
          details: { requestId: id, code: input.code, name: input.name },
        });
        return { requestId: id, tempPassword };
      }),

    /** حالة طلب توفير واحد — لاستطلاع الشاشة (بلا كلمة المرور). */
    provisionStatus: platformAdminProcedure
      .input(z.object({ requestId: z.number().int().positive() }))
      .query(({ input }) => getProvisionRequestStatus(input.requestId)),

    /** آخر طلبات التوفير — لجدول «آخر الطلبات» في الشاشة (بلا كلمات مرور). */
    provisionRequests: platformAdminProcedure.query(() => listRecentProvisionRequests()),
  }),
});

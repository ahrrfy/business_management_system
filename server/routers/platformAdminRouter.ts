import { PLATFORM_ADMIN_COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "../cookies";
import { listCompanies, setCompanyActive } from "../tenancy/registry";
import { signPlatformSession } from "../tenancy/platformAuth";
import { verifyPlatformAdminCredentials } from "../tenancy/platformAdminService";
import { logPlatformAudit } from "../tenancy/platformAudit";
import { platformAdminProcedure, publicProcedure, router } from "../trpc";

/**
 * إدارة الشركات (مدير المنصّة) — منفصلة تماماً عن authRouter (جلسة الشركات). لا
 * إنشاء شركة من هنا عمداً: التوفير عملية تشغيلية (قاعدة فعلية + مخطّط + هجرات +
 * بذرة) تناسب CLI (`pnpm company:new`) لا معالج طلب HTTP قصير العمر. هذه الشاشة
 * للعرض/التفعيل/التعطيل اليومي فقط.
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
  }),
});

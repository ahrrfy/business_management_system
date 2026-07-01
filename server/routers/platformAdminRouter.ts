import { PLATFORM_ADMIN_COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "../cookies";
import { logger } from "../logger";
import { listCompanies, setCompanyActive } from "../tenancy/registry";
import { signPlatformSession } from "../tenancy/platformAuth";
import { verifyPlatformAdminCredentials } from "../tenancy/platformAdminService";
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
        throw new TRPCError({ code: "UNAUTHORIZED", message: "البريد أو كلمة المرور غير صحيحة" });
      }
      const token = await signPlatformSession(admin.id);
      ctx.res.cookie(PLATFORM_ADMIN_COOKIE_NAME, token, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: 1000 * 60 * 60 * 8,
      });
      logger.info({ platformAdminId: admin.id }, "platform_admin.login");
      return { id: admin.id, email: admin.email, name: admin.name };
    }),

  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.platformAdmin) return null;
    const { passwordHash: _passwordHash, ...safe } = ctx.platformAdmin;
    return safe;
  }),

  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.res.clearCookie(PLATFORM_ADMIN_COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { success: true } as const;
  }),

  companies: router({
    list: platformAdminProcedure.query(() => listCompanies()),

    setActive: platformAdminProcedure
      .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        await setCompanyActive(input.id, input.isActive);
        logger.info(
          { platformAdminId: ctx.platformAdmin.id, companyId: input.id, isActive: input.isActive },
          "platform_admin.company.setActive"
        );
        return { success: true } as const;
      }),
  }),
});

import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { users } from "../../drizzle/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import { signSession } from "../auth/session";
import { getSessionCookieOptions } from "../cookies";
import { getDb } from "../db";
import { adminProcedure, publicProcedure, router } from "../trpc";

const ROLES = ["user", "admin", "manager", "cashier", "warehouse"] as const;

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    const { passwordHash: _passwordHash, ...safe } = ctx.user;
    return safe;
  }),

  login: publicProcedure
    .input(z.object({ email: z.string().email(), password: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

      const rows = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
      const user = rows[0];
      if (!user || !verifyPassword(input.password, user.passwordHash)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "البريد أو كلمة المرور غير صحيحة" });
      }
      if (!user.isActive) {
        throw new TRPCError({ code: "FORBIDDEN", message: "الحساب معطّل" });
      }

      const token = await signSession(user.id, user.role, ONE_YEAR_MS);
      ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
      await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

      return { id: user.id, name: user.name, email: user.email, role: user.role };
    }),

  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { success: true } as const;
  }),

  /** Create a new user. Admin-only; the first admin is created by the seed script. */
  register: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(6),
        name: z.string().min(1),
        role: z.enum(ROLES).default("cashier"),
        branchId: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

      const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
      if (existing.length) {
        throw new TRPCError({ code: "CONFLICT", message: "البريد الإلكتروني مستخدم مسبقاً" });
      }

      await db.insert(users).values({
        openId: `local_${nanoid()}`,
        email: input.email,
        name: input.name,
        passwordHash: hashPassword(input.password),
        role: input.role,
        loginMethod: "local",
        branchId: input.branchId,
      });
      return { success: true };
    }),
});

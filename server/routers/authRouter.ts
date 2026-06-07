import {
  COOKIE_NAME,
  PASSWORD_MIN_LEN,
  SESSION_DEFAULT_MS,
  SESSION_REMEMBER_MAX_MS,
} from "@shared/const";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../../drizzle/schema";
import { DUMMY_STORED, verifyPassword } from "../auth/password";
import { signSession } from "../auth/session";
import { getSessionCookieOptions } from "../cookies";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { changePassword as changePasswordSvc, createUser } from "../services/userService";
import { withTx } from "../services/tx";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../trpc";

const ROLES = ["user", "admin", "manager", "cashier", "warehouse"] as const;

/** قفل الحساب ضدّ التخمين: ٥ محاولات فاشلة ⇒ قفل ١٥ دقيقة. */
const LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60 * 1000;

type DbUser = typeof users.$inferSelect;

/** يزيد عدّاد الإخفاق ويقفل الحساب مؤقّتاً عند بلوغ الحدّ (للحسابات الموجودة فقط). */
async function registerFailedLogin(db: NonNullable<ReturnType<typeof getDb>>, user: DbUser) {
  const attempts = (user.failedLoginAttempts ?? 0) + 1;
  const patch =
    attempts >= LOCK_THRESHOLD
      ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
      : { failedLoginAttempts: attempts };
  await db.update(users).set(patch).where(eq(users.id, user.id)).catch(() => {});
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    const { passwordHash: _passwordHash, ...safe } = ctx.user;
    return safe;
  }),

  login: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(1).max(128),
        remember: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db)
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

      const rows = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
      const user = rows[0];

      // قفل مؤقّت بعد محاولات فاشلة متتالية.
      if (user?.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
        await logAudit(
          { user, req: ctx.req },
          { action: "auth.login.locked", entityType: "user", entityId: user.id }
        );
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "الحساب مقفل مؤقّتاً بسبب محاولات دخول فاشلة — حاول بعد قليل.",
        });
      }

      // توحيد التوقيت: عند غياب المستخدم نُشغّل scrypt على تجزّئة وهمية بدل القفز،
      // فيتساوى زمن الردّ ويُغلق تعداد المستخدمين الزمني.
      const stored = user?.passwordHash ?? DUMMY_STORED;
      const ok = verifyPassword(input.password, stored);

      // رسالة موحّدة لكل من: بريد غير موجود / كلمة خاطئة / حساب معطّل (لا تمييز جانبي).
      if (!user || !ok || !user.isActive) {
        if (user && !ok) await registerFailedLogin(db, user);
        await logAudit(
          { user: user ?? null, req: ctx.req },
          {
            action: "auth.login.failed",
            entityType: "user",
            entityId: user?.id ?? null,
            newValue: { email: input.email, reason: !user ? "no-user" : !ok ? "bad-password" : "inactive" },
          }
        );
        throw new TRPCError({ code: "UNAUTHORIZED", message: "البريد أو كلمة المرور غير صحيحة" });
      }

      const expiry = input.remember ? SESSION_REMEMBER_MAX_MS : SESSION_DEFAULT_MS;
      const token = await signSession(user.id, expiry);
      ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: expiry });

      // نجاح: حدّث آخر دخول وصفّر القفل — دون إفشال الدخول إن تعثّر التحديث.
      await db
        .update(users)
        .set({ lastSignedIn: new Date(), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id))
        .catch((e) => console.warn("[login] post-update failed:", e));

      await logAudit(
        { user, req: ctx.req },
        { action: "auth.login", entityType: "user", entityId: user.id }
      );

      return { id: user.id, name: user.name, email: user.email, role: user.role };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.user) {
      await logAudit(ctx, { action: "auth.logout", entityType: "user", entityId: ctx.user.id });
    }
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { success: true } as const;
  }),

  /** المستخدم يغيّر كلمة مروره بنفسه — يبطل بقية الجلسات ثم يُجدّد كوكي الجلسة الحالية. */
  changePassword: protectedProcedure
    .input(
      z.object({
        oldPassword: z.string().min(1).max(128),
        newPassword: z.string().min(PASSWORD_MIN_LEN).max(128),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await changePasswordSvc(ctx.user.id, input.oldPassword, input.newPassword);
      // أُبطِلت كل الجلسات (sessionsValidFrom=now) ⇒ نُصدر كوكياً جديداً كي لا يُطرَد صاحبها.
      const token = await signSession(ctx.user.id, SESSION_DEFAULT_MS);
      ctx.res.cookie(COOKIE_NAME, token, {
        ...getSessionCookieOptions(ctx.req),
        maxAge: SESSION_DEFAULT_MS,
      });
      await logAudit(ctx, {
        action: "auth.changePassword",
        entityType: "user",
        entityId: ctx.user.id,
      });
      return { success: true };
    }),

  /** إبطال كل جلسات المستخدم الحالي (تسجيل خروج من كل الأجهزة). */
  revokeMySessions: protectedProcedure.mutation(async ({ ctx }) => {
    await withTx(async (tx) => {
      await tx.update(users).set({ sessionsValidFrom: new Date() }).where(eq(users.id, ctx.user.id));
    });
    await logAudit(ctx, {
      action: "auth.revokeSessions",
      entityType: "user",
      entityId: ctx.user.id,
    });
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    return { success: true };
  }),

  /** إنشاء مستخدم جديد. للمدير فقط؛ أوّل مدير يُنشئه سكربت seed. */
  register: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(PASSWORD_MIN_LEN).max(128),
        name: z.string().min(1),
        role: z.enum(ROLES).default("cashier"),
        branchId: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const r = await createUser(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
      });
      await logAudit(ctx, {
        action: "user.create",
        entityType: "user",
        entityId: r.userId,
        newValue: { email: input.email, role: input.role, branchId: input.branchId ?? null },
      });
      return { success: true, userId: r.userId };
    }),
});

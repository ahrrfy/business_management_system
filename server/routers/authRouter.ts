import {
  COOKIE_NAME,
  PASSWORD_MIN_LEN,
  PASSWORD_POLICY_MSG,
  PASSWORD_REGEX,
  SESSION_DEFAULT_MS,
  SESSION_REMEMBER_MAX_MS,
} from "@shared/const";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../../drizzle/schema";
import { DUMMY_STORED, verifyPassword } from "../auth/password";
import { signSession } from "../auth/session";
import { getSessionCookieOptions } from "../cookies";
import { getDb } from "../db";
import { logger } from "../logger";
import { logAudit } from "../services/auditService";
import { changePassword as changePasswordSvc, createUser } from "../services/userService";
import { withTx } from "../services/tx";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../trpc";

// للتوافق الخلفي — لم يعد مستخدماً بعد أن أصبح ALL_ROLES مصدر الحقيقة
const ROLES = ["user", "admin", "manager", "cashier", "warehouse"] as const; // kept for reference only

/** قفل الحساب ضدّ التخمين: ٥ محاولات فاشلة ⇒ قفل ١٥ دقيقة. */
const LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60 * 1000;

/** عدّاد محاولات الدخول الفاشلة لكل IP — يطال المهاجم الذي يدوّر إيميلات غير موجودة. */
const IP_ATTEMPT_THRESHOLD = 20;
const IP_WINDOW_MS = 15 * 60 * 1000;
const ipAttempts = new Map<string, { count: number; firstAt: number }>();
setInterval(() => {
  const now = Date.now();
  ipAttempts.forEach((rec, ip) => {
    if (now - rec.firstAt > IP_WINDOW_MS) ipAttempts.delete(ip);
  });
}, IP_WINDOW_MS).unref?.();

function getClientIp(req: unknown): string {
  const r = req as { ip?: string; socket?: { remoteAddress?: string } } | undefined;
  return r?.ip ?? r?.socket?.remoteAddress ?? "unknown";
}

/** هاش ٦ بايت (١٢ خانة hex) محايد للهوية — يربط الأحداث بلا كشف القيمة الخام. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function recordIpFailure(ip: string): number {
  const now = Date.now();
  const rec = ipAttempts.get(ip);
  if (!rec || now - rec.firstAt > IP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, firstAt: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function clearIpFailures(ip: string): void {
  ipAttempts.delete(ip);
}

type DbUser = typeof users.$inferSelect;

/** يزيد عدّاد الإخفاق ويقفل الحساب مؤقّتاً عند بلوغ الحدّ (للحسابات الموجودة فقط). */
async function registerFailedLogin(db: NonNullable<ReturnType<typeof getDb>>, user: DbUser) {
  const attempts = (user.failedLoginAttempts ?? 0) + 1;
  const patch =
    attempts >= LOCK_THRESHOLD
      ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
      : { failedLoginAttempts: attempts };
  await db
    .update(users)
    .set(patch)
    .where(eq(users.id, user.id))
    .catch((e) => logger.warn({ err: e, userId: user.id }, "auth.login.lock_update_failed"));
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

      const ip = getClientIp(ctx.req);
      const ipHash = shortHash(ip);
      const emailHash = shortHash(input.email);

      // حدّ المحاولات بـIP: يطال المهاجم الذي يدوّر إيميلات غير موجودة.
      const ipRec = ipAttempts.get(ip);
      if (ipRec && Date.now() - ipRec.firstAt <= IP_WINDOW_MS && ipRec.count >= IP_ATTEMPT_THRESHOLD) {
        await logAudit(
          { user: user ?? null, req: ctx.req },
          {
            action: "auth.login.ip_throttled",
            entityType: "user",
            entityId: user?.id ?? null,
            newValue: { reason: "ip_rate_limit", ipHash, emailHash },
          }
        );
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "تجاوز عدد المحاولات المسموح به. الرجاء المحاولة لاحقاً.",
        });
      }

      // AUTH-01: احسب scrypt دائماً (توحيد التوقيت) قبل أي قرار، وعامِل الحساب المقفل كفشلٍ عام.
      // كان فحص القفل يَرجع مبكراً برسالة/كود مختلفين (TOO_MANY_REQUESTS «الحساب مقفل») ودون تشغيل
      // scrypt ⇒ أسرع زمناً + رسالة مميِّزة ⇒ عرّافا تعداد (وجود البريد) وقفلٍ موجَّه. الآن: القفل
      // يُعامَل كفشل اعتماد عام (نفس الرسالة + نفس التوقيت)، ويُسجَّل خادمياً للأثر فقط.
      const stored = user?.passwordHash ?? DUMMY_STORED;
      const ok = verifyPassword(input.password, stored);
      const locked = !!(user?.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now());

      // رسالة + كود موحّدان لكل فشل: بريد غير موجود / كلمة خاطئة / معطّل / مقفل (لا تمييز جانبي).
      if (!user || !ok || !user.isActive || locked) {
        if (user && locked) {
          // القفل يُسجَّل خادمياً للأثر فقط (لا يُكشَف للعميل)، ولا نزيد العدّاد أثناء نافذة القفل.
          await logAudit(
            { user, req: ctx.req },
            { action: "auth.login.locked", entityType: "user", entityId: user.id, newValue: { reason: "locked", ipHash, emailHash } }
          );
        } else {
          if (user && !ok) await registerFailedLogin(db, user);
          await logAudit(
            { user: user ?? null, req: ctx.req },
            { action: "auth.login.failed", entityType: "user", entityId: user?.id ?? null, newValue: { reason: "invalid_credentials", ipHash, emailHash } }
          );
        }
        recordIpFailure(ip);
        throw new TRPCError({ code: "UNAUTHORIZED", message: "البريد أو كلمة المرور غير صحيحة" });
      }

      // نجاح جزئي للتحقق من الكلمة ⇒ صفّر عدّاد IP لئلا يُعاقَب المستخدم الشرعي.
      clearIpFailures(ip);

      // إذا انتهت صلاحية كلمة المرور المؤقتة → ارفض الدخول برسالة صريحة
      if (user.mustChangePassword && user.tempPasswordExpiresAt) {
        const expired = new Date(user.tempPasswordExpiresAt).getTime() < Date.now();
        if (expired) {
          await logAudit(
            { user, req: ctx.req },
            { action: "auth.login.expired_temp", entityType: "user", entityId: user.id }
          );
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "انتهت صلاحية كلمة المرور المؤقتة — اطلب من المدير إعادة تعيينها.",
          });
        }
      }

      const expiry = input.remember ? SESSION_REMEMBER_MAX_MS : SESSION_DEFAULT_MS;
      // نمرّر ctx.req ⇒ يُضمَّن fp (بصمة الجهاز) في الـJWT ⇒ توكن مسروق من جهاز آخر يُرفض.
      const token = await signSession(user.id, expiry, ctx.req);
      ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: expiry });

      // نجاح: حدّث آخر دخول وصفّر القفل — دون إفشال الدخول إن تعثّر التحديث.
      await db
        .update(users)
        .set({ lastSignedIn: new Date(), failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id))
        .catch((e: unknown) =>
          logger.warn({ err: e, userId: user.id }, "auth.login.post_update_failed")
        );

      await logAudit(
        { user, req: ctx.req },
        { action: "auth.login", entityType: "user", entityId: user.id }
      );

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword ?? false,
      };
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
        newPassword: z
          .string()
          .min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG)
          .max(128)
          .regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { validFrom } = await changePasswordSvc(ctx.user.id, input.oldPassword, input.newPassword);
      // أُبطِلت كل الجلسات (sessionsValidFrom=now) ⇒ نُصدر كوكياً جديداً كي لا يُطرَد صاحبها.
      // نمرّر ctx.req ⇒ التوكن الجديد يحمل بصمة الجهاز الحالي.
      // AUTH-02: الإبطال يرفض `iat <= validFromSec`؛ لذا نُثبّت iat الكوكي الجديد أكبر
      // تماماً من حدّ الإبطال فيبقى صالحاً، بينما يُرفض أيّ توكنٍ أجنبيٍّ صُكّ في نفس الثانية
      // (يسدّ النافذة العمياء دون السماح القديم).
      // ⚠️ عمود TIMESTAMP يُقرِّب (يجبر) أجزاء الثانية لأقرب ثانية عند التخزين ⇒ قد يقفز
      // validFromSec المخزَّن ثانيةً واحدةً للأعلى مقابل floor(validFrom). لذا نضيف +2 (لا +1)
      // كي يبقى iat أكبر تماماً حتى بعد التقريب لأعلى (أمانٌ حاسمٌ ضدّ طرد صاحب الجلسة).
      const reissueIatSec = Math.floor(validFrom.getTime() / 1000) + 2;
      const token = await signSession(ctx.user.id, SESSION_DEFAULT_MS, ctx.req, reissueIatSec);
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
        password: z
          .string()
          .min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG)
          .max(128)
          .regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
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

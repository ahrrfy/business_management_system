import { PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG, PASSWORD_REGEX, USERNAME_MAX_LEN } from "@shared/const";
import { ALL_ROLES, type RoleKey } from "@shared/permissions";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  checkEmailAvailable,
  checkUsernameAvailable,
  createUser,
  deleteUser,
  generateStrongPassword,
  getUser,
  listUsers,
  resetUserPassword,
  revokeUserSessions,
  setUserActive,
  suggestUsername,
  updateUser,
} from "../services/userService";
import { getUserUsage } from "../services/entityUsage";
import { adminProcedure, protectedProcedure, router } from "../trpc";

// تحفظ tuple الـenum أنواع RoleKey الحرفية ⇒ z.infer ينتج RoleKey لا string ⇒ يُغني عن as any.
const ROLE = z.enum(ALL_ROLES as [RoleKey, ...RoleKey[]]);
const ACCESS = z.enum(["FULL", "READ", "NONE"]);
const PERM_OVERRIDE = z.record(z.string(), ACCESS).nullish();

// معرّفا الدخول. عند الإنشاء: الواجهة ترسل undefined للحقل الفارغ (مع اشتراط أحدهما عبر refine).
// عند التعديل: "" ⇒ مسح المعرّف صراحةً (الخدمة تضمن بقاء معرّف واحد على الأقل)، وغيابه ⇒ بلا تغيير.
// صيغة اسم المستخدم تُفحَص في الخدمة (رسالة عربية واضحة) — هنا الطول والاختيارية فقط.
const emailCreate = z.string().email().max(320).optional();
const usernameCreate = z.string().max(USERNAME_MAX_LEN).optional();
const emailUpdate = z.union([z.string().email().max(320), z.literal("")]).optional();
const usernameUpdate = z.union([z.string().max(USERNAME_MAX_LEN), z.literal("")]).optional();
const NEED_IDENTIFIER = "أدخل بريداً إلكترونياً أو اسم مستخدم على الأقل.";

export const userRouter = router({
  list: adminProcedure
    .input(
      z.object({
        q: z.string().optional(),
        role: z.string().optional(),
        includeInactive: z.boolean().default(false),
        limit: z.number().int().positive().max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }).optional()
    )
    .query(({ input }) => listUsers(input ?? {})),

  get: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(({ input }) => getUser(input.userId)),

  /** فحص توفّر البريد لحظياً (onBlur في الواجهة). */
  checkEmail: adminProcedure
    .input(z.object({ email: z.string().email(), excludeUserId: z.number().int().positive().optional() }))
    .query(({ input }) => checkEmailAvailable(input.email, input.excludeUserId)),

  /** فحص توفّر اسم المستخدم لحظياً (onBlur في الواجهة). */
  checkUsername: adminProcedure
    .input(z.object({ username: z.string().max(USERNAME_MAX_LEN), excludeUserId: z.number().int().positive().optional() }))
    .query(({ input }) => checkUsernameAvailable(input.username, input.excludeUserId)),

  /** يقترح اسم مستخدم متاحاً مشتقّاً من الاسم (يضمن التفرّد خادمياً). */
  suggestUsername: adminProcedure
    .input(z.object({ name: z.string().min(1).max(255) }))
    .query(({ input }) => suggestUsername(input.name).then((username) => ({ username }))),

  /** توليد كلمة مرور قوية من الخادم (أكثر أماناً من العميل). */
  generatePassword: adminProcedure
    .query(() => ({ password: generateStrongPassword() })),

  create: adminProcedure
    .input(
      z.object({
        email: emailCreate,
        username: usernameCreate,
        password: z
          .string()
          .min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG)
          .max(128)
          .regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
        name: z.string().min(1).max(255),
        role: ROLE.default("cashier"),
        customRoleId: z.number().int().positive().nullish(),
        branchId: z.number().int().positive().nullish(),
        phone: z.string().max(20).nullish(),
        jobTitle: z.string().max(120).nullish(),
        hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        permissionsOverride: PERM_OVERRIDE,
        mustChangePassword: z.boolean().default(true),
      }).refine((d) => !!(d.email || d.username), { message: NEED_IDENTIFIER, path: ["username"] })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createUser(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.create",
        entityType: "user",
        entityId: res.userId,
        newValue: { email: input.email ?? null, username: input.username ?? null, role: input.role, branchId: input.branchId ?? null, mustChangePassword: input.mustChangePassword },
      });
      return res;
    }),

  update: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        email: emailUpdate,
        username: usernameUpdate,
        role: ROLE.optional(),
        customRoleId: z.number().int().positive().nullable().optional(),
        branchId: z.number().int().positive().nullish(),
        phone: z.string().max(20).nullish(),
        jobTitle: z.string().max(120).nullish(),
        hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        permissionsOverride: PERM_OVERRIDE,
      })
    )
    .mutation(async ({ input, ctx }) => {
      // M (تدقيق ٢٣/٦/٢٦): سجلّ user.update كان newValue فقط — بلا oldValue ولا permissionsOverride.
      // ترقية مستخدم لدور أعلى أو منحه FULL على وحدة عبر override يَمرّ بلا أَثَر فروقات. الآن نَلتقط
      // قبل/بعد كاملاً (مع override) ⇒ تَدقيق فعلي للأذونات.
      const before = await getUser(input.userId);
      const res = await updateUser(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.update",
        entityType: "user",
        entityId: input.userId,
        oldValue: before
          ? {
              name: before.name,
              email: before.email,
              username: (before as { username?: string | null }).username ?? null,
              role: before.role,
              branchId: before.branchId,
              customRoleId: (before as { customRoleId?: number | null }).customRoleId ?? null,
              permissionsOverride: (before as { permissionsOverride?: unknown }).permissionsOverride ?? null,
            }
          : null,
        newValue: {
          name: input.name,
          email: input.email,
          username: input.username,
          role: input.role,
          branchId: input.branchId,
          customRoleId: input.customRoleId,
          permissionsOverride: input.permissionsOverride,
        },
      });
      return res;
    }),

  /** ملخّص ارتباطات المستخدم (لعرض النشاط + سبب منع الحذف + بيانات الكود عند المسح). */
  usage: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(({ input }) => getUserUsage(input.userId)),

  /** حذف نهائي — للنظيف فقط (يرمي رسالة عربية مفصّلة إن وُجد ارتباط). */
  delete: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deleteUser(input.userId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "user.delete", entityType: "user", entityId: input.userId });
      return res;
    }),

  setActive: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setUserActive(input.userId, input.isActive, {
        userId: ctx.user.id, branchId: ctx.user.branchId ?? 1,
      });
      await logAudit(ctx, {
        action: input.isActive ? "user.activate" : "user.deactivate",
        entityType: "user",
        entityId: input.userId,
        newValue: { isActive: input.isActive },
      });
      return res;
    }),

  resetPassword: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        newPassword: z
          .string()
          .min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG)
          .max(128)
          .regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
        mustChangePassword: z.boolean().default(true),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await resetUserPassword(
        input.userId,
        input.newPassword,
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 },
        { mustChange: input.mustChangePassword }
      );
      await logAudit(ctx, {
        action: "user.resetPassword",
        entityType: "user",
        entityId: input.userId,
        newValue: { mustChangePassword: input.mustChangePassword },
      });
      return res;
    }),

  /** إبطال كل جلسات مستخدم فوراً بلا تغيير كلمة مروره (جهاز مفقود/موظف مطرود). */
  revokeSessions: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await revokeUserSessions(input.userId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.revokeSessions",
        entityType: "user",
        entityId: input.userId,
        newValue: { revokedAt: res.revokedAt },
      });
      return res;
    }),

  /** تغيير كلمة المرور بواسطة المستخدم نفسه (من شاشة «حسابي»). */
  changePassword: protectedProcedure
    .input(
      z.object({
        oldPassword: z.string().min(1),
        newPassword: z
          .string()
          .min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG)
          .max(128)
          .regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { changePassword } = await import("../services/userService");
      const res = await changePassword(ctx.user.id, input.oldPassword, input.newPassword);
      await logAudit(ctx, { action: "user.changePassword", entityType: "user", entityId: ctx.user.id });
      return res;
    }),
});

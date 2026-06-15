import { PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG, PASSWORD_REGEX } from "@shared/const";
import { ALL_ROLES, type RoleKey } from "@shared/permissions";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  checkEmailAvailable,
  createUser,
  generateStrongPassword,
  getUser,
  listUsers,
  resetUserPassword,
  setUserActive,
  updateUser,
} from "../services/userService";
import { adminProcedure, protectedProcedure, router } from "../trpc";

// تحفظ tuple الـenum أنواع RoleKey الحرفية ⇒ z.infer ينتج RoleKey لا string ⇒ يُغني عن as any.
const ROLE = z.enum(ALL_ROLES as [RoleKey, ...RoleKey[]]);
const ACCESS = z.enum(["FULL", "READ", "NONE"]);
const PERM_OVERRIDE = z.record(z.string(), ACCESS).nullish();

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

  /** توليد كلمة مرور قوية من الخادم (أكثر أماناً من العميل). */
  generatePassword: adminProcedure
    .query(() => ({ password: generateStrongPassword() })),

  create: adminProcedure
    .input(
      z.object({
        email: z.string().email().max(320),
        password: z
          .string()
          .min(PASSWORD_MIN_LEN, PASSWORD_POLICY_MSG)
          .max(128)
          .regex(PASSWORD_REGEX, PASSWORD_POLICY_MSG),
        name: z.string().min(1).max(255),
        role: ROLE.default("cashier"),
        branchId: z.number().int().positive().nullish(),
        phone: z.string().max(20).nullish(),
        jobTitle: z.string().max(120).nullish(),
        hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        permissionsOverride: PERM_OVERRIDE,
        mustChangePassword: z.boolean().default(true),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createUser(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.create",
        entityType: "user",
        entityId: res.userId,
        newValue: { email: input.email, role: input.role, branchId: input.branchId ?? null, mustChangePassword: input.mustChangePassword },
      });
      return res;
    }),

  update: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        email: z.string().email().max(320).optional(),
        role: ROLE.optional(),
        branchId: z.number().int().positive().nullish(),
        phone: z.string().max(20).nullish(),
        jobTitle: z.string().max(120).nullish(),
        hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        permissionsOverride: PERM_OVERRIDE,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateUser(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.update",
        entityType: "user",
        entityId: input.userId,
        newValue: { name: input.name, email: input.email, role: input.role, branchId: input.branchId },
      });
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

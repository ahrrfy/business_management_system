import { PASSWORD_MIN_LEN } from "@shared/const";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  setUserActive,
  updateUser,
} from "../services/userService";
import { adminProcedure, router } from "../trpc";

const ROLE = z.enum(["user", "admin", "manager", "cashier", "warehouse"]);
const ACCESS = z.enum(["FULL", "READ", "NONE"]);
const PERM_OVERRIDE = z.record(z.string(), ACCESS).nullish();

/**
 * إدارة المستخدمين — **للمدير فقط (adminProcedure)**:
 * list/get/create/update/setActive/resetPassword. مع حواجز آخر مدير والحماية الذاتية
 * في الخدمة. لا يُعاد passwordHash في أيّ مخرَج. كل تغيير يُكتب في سجلّ التدقيق.
 */
export const userRouter = router({
  list: adminProcedure
    .input(
      z
        .object({
          q: z.string().optional(),
          role: ROLE.optional(),
          includeInactive: z.boolean().default(false),
          limit: z.number().int().positive().max(500).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(({ input }) => listUsers(input ?? {})),

  get: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(({ input }) => getUser(input.userId)),

  create: adminProcedure
    .input(
      z.object({
        email: z.string().email().max(320),
        password: z.string().min(PASSWORD_MIN_LEN).max(128),
        name: z.string().min(1).max(255),
        role: ROLE.default("cashier"),
        branchId: z.number().int().positive().nullish(),
        phone: z.string().max(20).nullish(),
        jobTitle: z.string().max(120).nullish(),
        hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        permissionsOverride: PERM_OVERRIDE,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createUser(input as any, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.create",
        entityType: "user",
        entityId: res.userId,
        newValue: { email: input.email, role: input.role, branchId: input.branchId ?? null, jobTitle: input.jobTitle ?? null },
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
      const res = await updateUser(input as any, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "user.update",
        entityType: "user",
        entityId: input.userId,
        newValue: {
          name: input.name,
          email: input.email,
          role: input.role,
          branchId: input.branchId,
          jobTitle: input.jobTitle,
        },
      });
      return res;
    }),

  setActive: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setUserActive(input.userId, input.isActive, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
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
        newPassword: z.string().min(PASSWORD_MIN_LEN).max(128),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await resetUserPassword(input.userId, input.newPassword, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
      });
      // لا نُسجّل كلمة المرور إطلاقاً — الحدث فقط.
      await logAudit(ctx, {
        action: "user.resetPassword",
        entityType: "user",
        entityId: input.userId,
      });
      return res;
    }),
});

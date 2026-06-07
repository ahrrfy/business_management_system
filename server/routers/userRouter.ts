import { PASSWORD_MIN_LEN } from "@shared/const";
import { z } from "zod";
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

/**
 * إدارة المستخدمين — **للمدير فقط (adminProcedure)**:
 * list/get/create/update/setActive/resetPassword. مع حواجز آخر مدير والحماية الذاتية
 * في الخدمة. لا يُعاد passwordHash في أيّ مخرَج.
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
      })
    )
    .mutation(({ input, ctx }) =>
      createUser(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })
    ),

  update: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        email: z.string().email().max(320).optional(),
        role: ROLE.optional(),
        branchId: z.number().int().positive().nullish(),
      })
    )
    .mutation(({ input, ctx }) =>
      updateUser(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })
    ),

  setActive: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(({ input, ctx }) =>
      setUserActive(input.userId, input.isActive, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
      })
    ),

  resetPassword: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        newPassword: z.string().min(PASSWORD_MIN_LEN).max(128),
      })
    )
    .mutation(({ input, ctx }) =>
      resetUserPassword(input.userId, input.newPassword, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
      })
    ),
});

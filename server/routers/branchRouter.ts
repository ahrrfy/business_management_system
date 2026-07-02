import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { branches } from "../../drizzle/schema";
import { getDb } from "../db";
import { createBranch, listBranchesAdmin, setBranchActive, updateBranch } from "../services/branchService";
import { logAudit } from "../services/auditService";
import { adminProcedure, protectedProcedure, router } from "../trpc";

const BRANCH_TYPES = ["MAIN", "SALES"] as const;

/** الفروع — قائمة نشطة للاختيار في الشاشات (شراء/تحويل) + إدارة كاملة (إنشاء/تعديل/تعطيل) للمدير العام. */
export const branchRouter = router({
  list: protectedProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db.select().from(branches).where(eq(branches.isActive, true)).orderBy(asc(branches.id));
  }),

  /** قائمة كاملة (تشمل المعطّلة) لشاشة الإدارة. */
  adminList: adminProcedure.query(() => listBranchesAdmin()),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        code: z.string().min(1).max(30),
        type: z.enum(BRANCH_TYPES),
        address: z.string().max(1000).nullish(),
        phone: z.string().max(20).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createBranch(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "branch.create", entityType: "branch", entityId: res.id, newValue: { name: res.name, code: res.code } });
      return res;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        code: z.string().min(1).max(30).optional(),
        type: z.enum(BRANCH_TYPES).optional(),
        address: z.string().max(1000).nullish(),
        phone: z.string().max(20).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateBranch(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "branch.update", entityType: "branch", entityId: input.id, newValue: input });
      return res;
    }),

  setActive: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setBranchActive(input.id, input.isActive, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: input.isActive ? "branch.activate" : "branch.deactivate", entityType: "branch", entityId: input.id });
      return res;
    }),
});

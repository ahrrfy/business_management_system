import { z } from "zod";
import {
  cancelExpense,
  createExpense,
  listExpenses,
} from "../services/expenseService";
import { logAudit } from "../services/auditService";
import { branchScopedProcedure, cashierProcedure, managerProcedure, router } from "../trpc";

const category = z.enum([
  "RENT",
  "UTILITIES",
  "SUPPLIES",
  "SALARY",
  "TRANSPORT",
  "MAINTENANCE",
  "MARKETING",
  "OTHER",
]);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const status = z.enum(["ACTIVE", "CANCELLED"]);

export const expenseRouter = router({
  list: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          category: category.optional(),
          status: status.optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.number().int().positive().max(1000).default(200),
        })
        .optional()
    )
    .query(async ({ input, ctx }) =>
      // عزل الفرع: غير المدير يرى مصروفات فرعه فقط.
      listExpenses({ ...(input ?? {}), ...(ctx.scopedBranchId ? { branchId: ctx.scopedBranchId } : {}) })
    ),

  create: cashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().nullish(),
        expenseDate: z.string().optional(),
        category,
        amount: z.string(),
        paymentMethod: method,
        description: z.string().nullish(),
        referenceNumber: z.string().nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createExpense(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
      await logAudit(ctx, { action: "expense.create", entityType: "expense", entityId: (res as { expenseId?: number })?.expenseId, newValue: { category: input.category, amount: input.amount } });
      return res;
    }),

  // إلغاء مصروف يعكس نقداً ⇒ مدير فأعلى.
  cancel: managerProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelExpense(input.expenseId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "expense.cancel", entityType: "expense", entityId: input.expenseId });
      return res;
    }),
});

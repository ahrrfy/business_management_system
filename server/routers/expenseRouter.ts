import { z } from "zod";
import {
  cancelExpense,
  createExpense,
  listExpenses,
} from "../services/expenseService";
import { protectedProcedure, router } from "../trpc";

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
  list: protectedProcedure
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
    .query(async ({ input }) => listExpenses(input ?? {})),

  create: protectedProcedure
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
    .mutation(({ input, ctx }) =>
      createExpense(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId })
    ),

  cancel: protectedProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      cancelExpense(input.expenseId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })
    ),
});

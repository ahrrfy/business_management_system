import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  cancelExpense,
  createExpense,
  listExpenses,
} from "../services/expenseService";
import { logAudit } from "../services/auditService";
import { ymdDate } from "../lib/schemas";
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
const recurringFreq = z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]);

export const expenseRouter = router({
  list: branchScopedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          category: category.optional(),
          status: status.optional(),
          from: ymdDate.optional(),
          to: ymdDate.optional(),
          limit: z.number().int().positive().max(1000).default(200),
        })
        .optional()
    )
    .query(async ({ input, ctx }) =>
      // عزل الفرع + عزل الموظف: غير المدير يرى مصروفات فرعه التي أنشأها هو فقط.
      listExpenses({
        ...(input ?? {}),
        ...(ctx.scopedBranchId ? { branchId: ctx.scopedBranchId } : {}),
        createdBy: ctx.scopedOwnerId,
      })
    ),

  create: cashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().nullish(),
        expenseDate: z.string().optional(),
        category,
        // STOCK لا يرسل مبلغاً (يُحتسب من الكلفة) ⇒ افتراضي "0".
        amount: z.string().default("0"),
        paymentMethod: method,
        description: z.string().nullish(),
        referenceNumber: z.string().nullish(),
        // v3-add-screens.
        payee: z.string().max(200).nullish(),
        costCenter: z.string().max(80).nullish(),
        isRecurring: z.boolean().nullish(),
        recurringFrequency: recurringFreq.nullish(),
        // production-slice: مصدر الصرف + (مع STOCK) نوعه وأصنافه المُستهلَكة.
        source: z.enum(["CASH", "STOCK"]).nullish(),
        stockReason: z.enum(["INTERNAL_USE", "WASTAGE"]).nullish(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive().nullish(),
              quantity: z.string().optional(),
              baseQuantity: z.number().int().positive().optional(),
            })
          )
          .optional(),
        // idempotency: نقرة مزدوجة على «أضف مصروفاً» ⇒ مصروف واحد.
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // F4 (تدقيق ١٤/٦/٢٦): قبل الإصلاح كان `ctx.user.branchId ?? input.branchId` يسمح
      // لكاشير بـbranchId=null أن يحقن أي input.branchId (مصروف في فرع آخر = تلويث
      // الصندوق والقيد). الآن: غير المرتفعين يُجبَرون على فرعهم؛ admin/manager
      // يحترمان input.branchId. نمط مطابق لـinventoryRouter.adjust (M1).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        branchId = Number(ctx.user.branchId);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createExpense({ ...input, branchId }, { userId: ctx.user.id, branchId, role: ctx.user.role });
          if (!(res as { idempotent?: boolean }).idempotent) {
            await logAudit(ctx, { action: "expense.create", entityType: "expense", entityId: (res as { expenseId?: number })?.expenseId, newValue: { category: input.category, amount: input.amount, payee: input.payee ?? null, branchId } });
          }
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تسجيل المصروف" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تسجيل المصروف" });
    }),

  // إلغاء مصروف يعكس نقداً ⇒ مدير فأعلى.
  cancel: managerProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await cancelExpense(input.expenseId, { userId: ctx.user.id, branchId: Number(ctx.user.branchId), role: ctx.user.role });
      await logAudit(ctx, { action: "expense.cancel", entityType: "expense", entityId: input.expenseId });
      return res;
    }),
});

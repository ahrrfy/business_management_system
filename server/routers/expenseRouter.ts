import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  approveExpense,
  cancelExpense,
  createExpense,
  getExpenseTrace,
  listExpenses,
  rejectExpense,
} from "../services/expenseService";
import { logAudit } from "../services/auditService";
import { nonNegMoneyString, ymdDate } from "../lib/schemas";
import {
  expensesCashierProcedure,
  expensesManagerProcedure,
  expensesReadProcedure,
  protectedProcedure,
  router,
} from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";

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
const status = z.enum(["PENDING_APPROVAL", "ACTIVE", "REJECTED", "CANCELLED"]);
const recurringFreq = z.enum([
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
]);

/**
 * سلطة اعتماد المصروف مشتقة من راية المالك المخزّنة لا من قالب الدور أو منح الوحدة.
 * الخدمة تعيد قراءة الراية والنشاط تحت FOR UPDATE؛ هذا الحارس المبكر يحسّن رسالة الرفض
 * ولا يُعدّ مصدراً نهائياً للسلطة.
 */
const expenseOwnerProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.isOwner !== true) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "اعتماد المصروف أو رفضه يتطلب حساب مالك نشطاً",
    });
  }
  return next({ ctx });
});

export const expenseRouter = router({
  list: expensesReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          category: category.optional(),
          status: status.optional(),
          from: ymdDate.optional(),
          to: ymdDate.optional(),
          q: z.string().trim().min(1).optional(),
          // فلترة إضافية: طريقة الدفع (مطابقة يوم البطاقات) + مصدر الصرف (نقدي/مخزون).
          paymentMethod: method.optional(),
          source: z.enum(["CASH", "STOCK"]).optional(),
          fundingKind: z
            .enum(["DRAWER", "TREASURY", "NON_CASH", "STOCK"])
            .optional(),
          createdBy: z.number().int().positive().optional(),
          shiftId: z.number().int().positive().optional(),
          amount: nonNegMoneyString.optional(),
          limit: z.number().int().positive().max(1000).default(200),
          offset: z.number().int().nonnegative().optional(),
          // S3 (٣٠/٦): cursor (id) اختياري لـkeyset — يتجاوز COUNT الكامل.
          cursor: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) =>
      // عزل الفرع + عزل الموظف: غير المدير يرى مصروفات فرعه التي أنشأها هو فقط.
      listExpenses({
        ...(input ?? {}),
        ...(ctx.scopedBranchId ? { branchId: ctx.scopedBranchId } : {}),
        createdBy: ctx.scopedOwnerId ?? input?.createdBy ?? null,
      }),
    ),

  /** تفاصيل التتبع الكاملة لمصروف واحد، بنفس عزل الفرع/المالك المطبق على القائمة. */
  trace: expensesReadProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const trace = await getExpenseTrace(input.expenseId, {
        branchId: ctx.scopedBranchId ?? undefined,
        createdBy: ctx.scopedOwnerId,
      });
      if (!trace)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "المصروف غير موجود",
        });
      return trace;
    }),

  // الموظف المخوّل يُنشئ الطلب؛ الخدمة وحدها تقرر: نثرية صغيرة ممولة من درجه
  // أو طلب اعتماد بلا أثر مالي. لا توجد صلاحية هنا تتجاوز حارس الرصيد أو المالك.
  create: expensesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().nullish(),
        expenseDate: z.string().optional(),
        category,
        // STOCK لا يرسل مبلغاً (يُحتسب من الكلفة) ⇒ افتراضي "0".
        amount: z.string().default("0"),
        paymentMethod: method,
        cashSource: z.enum(["OWN_DRAWER", "TREASURY"]).nullish(),
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
            }),
          )
          .optional(),
        // idempotency: نقرة مزدوجة على «أضف مصروفاً» ⇒ مصروف واحد.
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // F4 (تدقيق ١٤/٦/٢٦) + عزل مدير الفرع (قرار المالك ١٢/٨): كان `ctx.user.branchId ?? input.branchId`
      // يسمح بحقن أي فرع (تلويث الصندوق والقيد). المالك/الأدمن وحدهما يحترمان input.branchId؛ مدير
      // الفرع وغيره يُجبَرون على فرعهم المُسنَد. نمط مطابق لـinventoryRouter.adjust.
      const elevated = ctx.user.role === "admin";
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "لا فرع مُسنَد لهذا المستخدم",
          });
        }
        branchId = Number(ctx.user.branchId);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createExpense(
            { ...input, branchId },
            {
              userId: ctx.user.id,
              branchId,
              role: ctx.user.role,
              isOwner: ctx.user.isOwner === true,
            },
          );
          if (!(res as { idempotent?: boolean }).idempotent) {
            await logAudit(ctx, {
              action: "expense.create",
              entityType: "expense",
              entityId: (res as { expenseId?: number })?.expenseId,
              newValue: {
                category: input.category,
                amount: input.amount,
                payee: input.payee ?? null,
                branchId,
                cashSource: input.cashSource ?? null,
              },
            });
          }
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "تعذّر تسجيل المصروف",
          });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تسجيل المصروف" });
    }),

  /** زر واحد: اعتماد + تنفيذ ذرّي؛ الخدمة تعيد قراءة isOwner/isActive تحت القفل. */
  approve: expenseOwnerProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      approveExpense(input.expenseId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: ctx.user.isOwner === true,
      }),
    ),

  reject: expenseOwnerProcedure
    .input(
      z.object({
        expenseId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(1000),
      }),
    )
    .mutation(({ input, ctx }) =>
      rejectExpense(
        input.expenseId,
        {
          userId: ctx.user.id,
          branchId: Number(ctx.user.branchId ?? 0),
          role: ctx.user.role,
          isOwner: ctx.user.isOwner === true,
        },
        input.reason,
      ),
    ),

  // إلغاء مصروف يعكس نقداً ⇒ مدير فأعلى.
  cancel: expensesManagerProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم",
        });
      }
      const res = await cancelExpense(input.expenseId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "expense.cancel",
        entityType: "expense",
        entityId: input.expenseId,
      });
      return res;
    }),
});

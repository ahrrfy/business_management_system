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
  expensesGlobalProcedure,
  expensesGlobalReadProcedure,
  expensesManagerProcedure,
  expensesReadProcedure,
  ownerProcedure,
  router,
} from "../trpc";
import {
  backfillExpenseCategories,
  countUnclassifiedExpenses,
  createExpenseCategory,
  ensureDefaultExpenseCategories,
  listExpenseCategories,
  setExpenseCategoryActive,
  updateExpenseCategory,
} from "../services/expenseCategoryService";
import { EXPENSE_BUCKETS } from "@shared/expenseCategories";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  approveAccrualCorrection,
  listAccrualCorrections,
  rejectAccrualCorrection,
  requestAccrualCorrection,
  retryAccrualCorrectionRefund,
} from "../services/accounting/accrualCorrection";

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
const expenseBucket = z.enum(EXPENSE_BUCKETS);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

/**
 * فئات المصروفات المُدارة (هجرة 0203) — راوترٌ متداخل تحت `expenses.categories`.
 * الفئة تُصنِّف والدلو يُحاسِب: الدلو (ENUM) يبقى مصدر الحقيقة المحاسبيّ، وهذه الطبقة تمنح
 * المالك تصنيفاً دقيقاً يديره بنفسه بلا أي أثرٍ على الدفتر أو التقارير أو الإقفال.
 */
const expenseCategoryRouter = router({
  list: expensesGlobalReadProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }).optional())
    .query(({ input }) => listExpenseCategories({ includeInactive: input?.includeInactive })),

  /** عدد المصروفات التي ما تزال بلا فئة مُدارة — يقود ظهور زرّ المعالجة. */
  unclassifiedCount: expensesGlobalReadProcedure.query(() => countUnclassifiedExpenses()),

  create: expensesGlobalProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, "اسم الفئة مطلوب").max(100),
        bucket: expenseBucket,
        description: z.string().max(300).nullish(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await createExpenseCategory(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "expenseCategory.create",
        entityType: "expenseCategory",
        entityId: res.id,
        newValue: input,
      });
      return res;
    }),

  update: expensesGlobalProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(100).optional(),
        bucket: expenseBucket.optional(),
        description: z.string().max(300).nullish(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateExpenseCategory(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "expenseCategory.update",
        entityType: "expenseCategory",
        entityId: input.id,
        newValue: { changed: res.changed },
      });
      return { ok: true };
    }),

  setActive: expensesGlobalProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setExpenseCategoryActive(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: input.isActive ? "expenseCategory.activate" : "expenseCategory.deactivate",
        entityType: "expenseCategory",
        entityId: input.id,
      });
      return res;
    }),

  /** استعادة الكتالوج الافتراضي وترميم فئة كل دلو الاحتياطية — idempotent. */
  restoreDefaults: expensesGlobalProcedure.mutation(async ({ ctx }) => {
    const res = await ensureDefaultExpenseCategories();
    if (res.inserted.length || res.defaultsRepaired.length) {
      await logAudit(ctx, {
        action: "expenseCategory.restoreDefaults",
        entityType: "expenseCategory",
        newValue: res,
      });
    }
    return res;
  }),

  /** إسناد المصروفات القديمة بلا فئة إلى فئة دلوها الاحتياطية — الدلو نفسه لا يُمَسّ. */
  backfill: expensesGlobalProcedure.mutation(async ({ ctx }) => {
    const res = await backfillExpenseCategories();
    if (res.updated) {
      await logAudit(ctx, {
        action: "expenseCategory.backfill",
        entityType: "expense",
        newValue: res,
      });
    }
    return res;
  }),
});
const status = z.enum(["PENDING_APPROVAL", "ACTIVE", "REJECTED", "CANCELLED"]);
const recurringFreq = z.enum([
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
]);

export const expenseRouter = router({
  categories: expenseCategoryRouter,

  list: expensesReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          category: category.optional(),
          expenseCategoryId: z.number().int().positive().optional(),
          status: status.optional(),
          from: ymdDate.optional(),
          to: ymdDate.optional(),
          q: z.string().trim().min(1).optional(),
          // فلترة إضافية: طريقة الدفع (مطابقة يوم البطاقات) + مصدر الصرف (نقدي/مخزون).
          paymentMethod: method.optional(),
          source: z.enum(["CASH", "STOCK", "ACCRUAL"]).optional(),
          fundingKind: z
            .enum(["DRAWER", "TREASURY", "NON_CASH", "STOCK", "ACCRUED_UNPAID", "ACCRUED_PAID"])
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

  accrualCorrections: expensesReadProcedure
    .input(z.object({ obligationId: z.number().int().positive() }))
    .query(({ input, ctx }) => listAccrualCorrections(input.obligationId, {
      userId: ctx.user.id,
      branchId: Number(ctx.user.branchId ?? 0),
      role: ctx.user.role,
      isOwner: ctx.user.isOwner === true,
    })),

  requestAccrualCorrection: expensesManagerProcedure
    .input(
      z.object({
        obligationId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(2000),
        externalEvidenceReference: z.string().trim().min(1).max(191),
        attachmentUrl: z.string().trim().min(1).max(8_000_000),
        refundPaymentMethod: method.nullish(),
        refundCashBucket: z.enum(["DRAWER", "TREASURY"]).nullish(),
        refundReferenceNumber: z.string().trim().max(100).nullish(),
        refundCardLastFour: z.string().trim().regex(/^\d{4}$/).nullish(),
        clientRequestId: z.string().trim().min(8).max(64),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestAccrualCorrection(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: ctx.user.isOwner === true,
      }),
    ),

  approveAccrualCorrection: ownerProcedure
    .input(z.object({ correctionRequestId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      approveAccrualCorrection(input.correctionRequestId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: ctx.user.isOwner === true,
      }),
    ),

  rejectAccrualCorrection: ownerProcedure
    .input(z.object({ correctionRequestId: z.number().int().positive(), reason: z.string().trim().min(3).max(255) }))
    .mutation(({ input, ctx }) =>
      rejectAccrualCorrection(input.correctionRequestId, input.reason, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: ctx.user.isOwner === true,
      }),
    ),

  retryAccrualCorrectionRefund: expensesManagerProcedure
    .input(z.object({ correctionRequestId: z.number().int().positive(), clientRequestId: z.string().trim().min(8).max(64) }))
    .mutation(({ input, ctx }) =>
      retryAccrualCorrectionRefund(input.correctionRequestId, input.clientRequestId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: ctx.user.isOwner === true,
      }),
    ),

  // الموظف المخوّل يُنشئ الطلب؛ الخدمة وحدها تقرر: نثرية صغيرة ممولة من درجه
  // أو طلب اعتماد بلا أثر مالي. لا توجد صلاحية هنا تتجاوز حارس الرصيد أو المالك.
  create: expensesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().nullish(),
        expenseDate: z.string().optional(),
        // الدلو المحاسبيّ — يبقى في العقد للتوافق الخلفيّ (أندرويد/أوفلاين/استيراد). حين
        // تُمرَّر `expenseCategoryId` تحكم هي، وتُشتقّ منه الخدمة الدلوَ وتتجاهل هذا الحقل.
        category,
        expenseCategoryId: z.number().int().positive().nullish(),
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
  approve: ownerProcedure
    .input(z.object({ expenseId: z.number().int().positive() }))
    .mutation(({ input, ctx }) =>
      approveExpense(input.expenseId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        isOwner: ctx.user.isOwner === true,
      }),
    ),

  reject: ownerProcedure
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

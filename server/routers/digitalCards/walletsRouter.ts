// المحافظ (بلا إيداع/سحب — تلك ش٩) — راوتر البطاقات الرقمية والاشتراكات.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nonNegMoneyString, positiveMoneyString } from "../../lib/schemas";
import { walletOpsService, walletService } from "../../services/digitalCards";
import { withTx } from "../../services/tx";
import { digitalCardsAdminReadProcedure, digitalCardsManagerProcedure, router } from "../../trpc";
import { actorOf, idInput, requireDb, scopedBranchOf } from "./shared";

export const walletsRouter = router({
  list: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          providerId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          isActive: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع: غير المرتفعين يرون محافظ فرعهم فقط مهما أرسلوا.
      const scoped = scopedBranchOf(ctx);
      return walletService.listWallets(requireDb(), {
        ...(input ?? {}),
        ...(scoped != null ? { branchId: scoped } : {}),
      });
    }),

  get: digitalCardsAdminReadProcedure.input(idInput).query(async ({ input, ctx }) => {
    const wallet = await walletService.getWallet(requireDb(), input.id);
    const scoped = scopedBranchOf(ctx);
    if (scoped != null && Number(wallet.branchId) !== scoped) {
      throw new TRPCError({ code: "FORBIDDEN", message: "المحفظة تخصّ فرعاً آخر" });
    }
    return wallet;
  }),

  create: digitalCardsManagerProcedure
    .input(
      z.object({
        providerId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(120),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (scopedBranchOf(ctx) != null && input.branchId !== scopedBranchOf(ctx)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إنشاء محفظة لفرع آخر" });
      }
      return withTx((tx) => walletService.createWallet(tx, input, actorOf(ctx)));
    }),

  update: digitalCardsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(120).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletService.updateWallet(tx, input, actorOf(ctx))),
    ),

  /* ─── عمليات الرصيد (ش٩) ─────────────────────────────────────────────── */

  deposit: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        amount: positiveMoneyString,
        paymentMethod: z.enum(["CASH", "TRANSFER"]),
        /** مرجع الحوالة من كشف البنك — إلزاميّ للتحويل (نظير السحب). */
        referenceNumber: z.string().trim().max(100).nullish(),
        clientRequestId: z.string().min(8).max(80),
        notes: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.deposit(tx, input, actorOf(ctx))),
    ),

  withdraw: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        amount: positiveMoneyString,
        paymentMethod: z.enum(["CASH", "TRANSFER"]),
        /** مرجع الحوالة كما يظهر في كشف البنك — إلزاميّ للتحويل (المطابقة لا تقوم على UUID داخليّ). */
        referenceNumber: z.string().trim().max(100).nullish(),
        clientRequestId: z.string().min(8).max(80),
        notes: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.withdraw(tx, input, actorOf(ctx))),
    ),

  /** طلب تعديل — لا يمسّ الرصيد؛ يعتمده مديرٌ **آخر** (SOD). */
  requestAdjustment: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        amount: positiveMoneyString,
        direction: z.enum(["IN", "OUT"]),
        reason: z.string().min(3).max(300),
        clientRequestId: z.string().min(8).max(80),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.requestAdjustment(tx, input, actorOf(ctx))),
    ),

  approveAdjustment: digitalCardsManagerProcedure
    .input(z.object({ transactionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.approveAdjustment(tx, input, actorOf(ctx))),
    ),

  rejectAdjustment: digitalCardsManagerProcedure
    .input(z.object({ transactionId: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.rejectAdjustment(tx, input, actorOf(ctx))),
    ),

  statement: digitalCardsAdminReadProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const wallet = await walletService.getWallet(requireDb(), input.walletId);
      const scoped = scopedBranchOf(ctx);
      if (scoped != null && Number(wallet.branchId) !== scoped) {
        throw new TRPCError({ code: "FORBIDDEN", message: "المحفظة تخصّ فرعاً آخر" });
      }
      return walletOpsService.statement(requireDb(), input);
    }),

  /** المطابقة اليومية: تسجّل الفرق ولا تعدّل الرصيد. */
  reconcile: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        actualBalance: nonNegMoneyString,
        notes: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.reconcile(tx, input, actorOf(ctx))),
    ),

  reconciliations: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          walletId: z.number().int().positive().optional(),
          status: z.enum(["MATCHED", "VARIANCE_OPEN", "RESOLVED"]).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) =>
      walletOpsService.listReconciliations(requireDb(), {
        walletId: input?.walletId,
        status: input?.status,
        branchId: scopedBranchOf(ctx),
      }),
    ),

  resolveVariance: digitalCardsManagerProcedure
    .input(
      z.object({
        reconciliationId: z.number().int().positive(),
        adjustmentTransactionId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.resolveVariance(tx, input, actorOf(ctx))),
    ),

  /** خطوة واحدة للمدير الثاني: يعتمد التصحيح المطابق ويغلق فرق الرصيد ذرياً. */
  approveAndResolveVariance: digitalCardsManagerProcedure
    .input(
      z.object({
        reconciliationId: z.number().int().positive(),
        adjustmentTransactionId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.approveAndResolveVariance(tx, input, actorOf(ctx))),
    ),

  lowBalance: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    walletOpsService.lowBalanceWallets(requireDb(), scopedBranchOf(ctx)),
  ),
});

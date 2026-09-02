import { z } from "zod";
import {
  createGoodsReceipt,
  decideGoodsReceiptReversal,
  getGoodsReceipt,
  listGoodsReceipts,
  listPendingGoodsReceiptReversals,
  requestGoodsReceiptReversal,
} from "../services/purchase/goodsReceipts";
import {
  purchasesManagerProcedure,
  purchasesReadProcedure,
  purchasesWarehouseProcedure,
  router,
} from "../trpc";

const actor = (ctx: {
  user: { id: number; branchId?: number | null; role?: string };
}) => ({
  userId: ctx.user.id,
  branchId: Number(ctx.user.branchId ?? 0),
  role: ctx.user.role,
});

export const goodsReceiptsRouter = router({
  create: purchasesWarehouseProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        purchaseOrderRevisionId: z.number().int().positive(),
        expectedOrderVersion: z.number().int().positive(),
        clientRequestId: z.string().trim().min(1).max(120),
        supplierDeliveryNote: z.string().trim().max(160).nullish(),
        receivedAt: z.coerce.date().optional(),
        notes: z.string().trim().max(500).nullish(),
        lines: z
          .array(
            z.object({
              purchaseOrderItemId: z.number().int().positive(),
              acceptedBaseQuantity: z.number().int().nonnegative(),
              rejectedBaseQuantity: z.number().int().nonnegative().optional(),
              rejectionReason: z.string().trim().max(500).nullish(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(({ input, ctx }) => createGoodsReceipt(input, actor(ctx))),

  get: purchasesReadProcedure
    .input(z.object({ goodsReceiptId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getGoodsReceipt(input.goodsReceiptId, actor(ctx)),
    ),

  list: purchasesReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        purchaseOrderId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(({ input, ctx }) => listGoodsReceipts(input, actor(ctx))),

  requestReversal: purchasesWarehouseProcedure
    .input(
      z.object({
        goodsReceiptId: z.number().int().positive(),
        expectedReceiptVersion: z.number().int().positive(),
        requestKey: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(3).max(500),
        lines: z
          .array(
            z.object({
              goodsReceiptItemId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
              reason: z.string().trim().max(500).nullish(),
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestGoodsReceiptReversal(input, actor(ctx)),
    ),

  decideReversal: purchasesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: z.string().trim().min(1).max(120),
        action: z.enum(["APPROVE", "REJECT"]),
        reviewReason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      decideGoodsReceiptReversal(input, actor(ctx)),
    ),

  pendingReversals: purchasesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      listPendingGoodsReceiptReversals(input.branchId, actor(ctx)),
    ),
});

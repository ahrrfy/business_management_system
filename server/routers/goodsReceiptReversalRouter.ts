import { z } from "zod";
import {
  decideGoodsReceiptReversal,
  getGoodsReceipt,
  listGoodsReceipts,
  listPendingGoodsReceiptReversals,
  requestGoodsReceiptReversal,
} from "../services/purchase/goodsReceipts";
import { purchasesManagerProcedure, purchasesReadProcedure, router } from "../trpc";

const actor = (ctx: { user: { id: number; branchId?: number | null; role?: string } }) => ({
  userId: ctx.user.id,
  branchId: Number(ctx.user.branchId ?? 0),
  role: ctx.user.role,
});
const key = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(3).max(500);

export const goodsReceiptReversalRouter = router({
  list: purchasesReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        purchaseOrderId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(({ input, ctx }) => listGoodsReceipts(input, actor(ctx))),
  get: purchasesReadProcedure
    .input(z.object({ goodsReceiptId: z.number().int().positive() }))
    .query(({ input, ctx }) => getGoodsReceipt(input.goodsReceiptId, actor(ctx))),
  requestReversal: purchasesManagerProcedure
    .input(
      z.object({
        goodsReceiptId: z.number().int().positive(),
        expectedReceiptVersion: z.number().int().positive(),
        requestKey: key,
        reason,
        lines: z
          .array(
            z.object({
              goodsReceiptItemId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
              reason: z.string().trim().max(500).nullish(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(({ input, ctx }) => requestGoodsReceiptReversal(input, actor(ctx))),
  decideReversal: purchasesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: key,
        action: z.enum(["APPROVE", "REJECT"]),
        reviewReason: reason,
      }),
    )
    .mutation(({ input, ctx }) => decideGoodsReceiptReversal(input, actor(ctx))),
  pendingReversals: purchasesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => listPendingGoodsReceiptReversals(input.branchId, actor(ctx))),
});

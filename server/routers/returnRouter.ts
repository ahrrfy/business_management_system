import { z } from "zod";
import { returnSale } from "../services/returnService";
import { protectedProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);

export const returnRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        lines: z.array(z.object({ invoiceItemId: z.number().int().positive(), baseQuantity: z.number().int().positive() })).min(1),
        refund: z.object({ amount: z.string(), method }).optional(),
        restock: z.boolean().optional(),
      })
    )
    .mutation(({ input, ctx }) => returnSale(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),
});

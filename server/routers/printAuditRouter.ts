import { z } from "zod";
import {
  purchasesManagerProcedure,
  reportViewerProcedure,
  router,
  treasuryManagerReadProcedure,
} from "../trpc";
import { recordDocumentPrintOutcome, requestDocumentPrint } from "../services/printAuditService";

const channel = z.enum(["BROWSER", "PDF", "THERMAL", "SERVER_BRIDGE"]);
const commonRequest = {
  requestId: z.string().min(8).max(80),
  documentId: z.number().int().positive(),
  branchId: z.number().int().positive().nullable().optional(),
  channel,
  copies: z.number().int().min(1).max(20).default(1),
};
const outcomeInput = z.object({
  requestId: z.string().min(8).max(80),
  outcome: z.enum(["DIALOG_OPENED", "DISPATCHED", "FAILED"]),
  failureCode: z.string().max(80).optional(),
});

function actor(ctx: { user: { id: number; branchId?: number | null } }) {
  return { userId: ctx.user.id, branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId) };
}

export const printAuditRouter = router({
  requestPurchase: purchasesManagerProcedure
    .input(z.object({ ...commonRequest, documentType: z.literal("PURCHASE_RETURN") }))
    .mutation(({ input, ctx }) => requestDocumentPrint({ ...input, branchId: input.branchId ?? actor(ctx).branchId }, actor(ctx))),
  outcomePurchase: purchasesManagerProcedure
    .input(outcomeInput)
    .mutation(({ input, ctx }) => recordDocumentPrintOutcome(input, actor(ctx))),

  requestTreasury: treasuryManagerReadProcedure
    .input(z.object({ ...commonRequest, documentType: z.enum(["EXCHANGE_TRANSACTION", "VOUCHER"]) }))
    .mutation(({ input, ctx }) => requestDocumentPrint({ ...input, branchId: input.branchId ?? actor(ctx).branchId }, actor(ctx))),
  outcomeTreasury: treasuryManagerReadProcedure
    .input(outcomeInput)
    .mutation(({ input, ctx }) => recordDocumentPrintOutcome(input, actor(ctx))),

  requestReport: reportViewerProcedure
    .input(z.object({ ...commonRequest, documentType: z.enum(["CUSTOMER_STATEMENT", "SUPPLIER_STATEMENT"]) }))
    .mutation(({ input, ctx }) => {
      const canCrossBranches = ctx.user.role === "admin" || ctx.user.isOwner === true;
      const branchId = canCrossBranches ? (input.branchId ?? null) : Number(ctx.user.branchId);
      return requestDocumentPrint({ ...input, branchId }, actor(ctx));
    }),
  outcomeReport: reportViewerProcedure
    .input(outcomeInput)
    .mutation(({ input, ctx }) => recordDocumentPrintOutcome(input, actor(ctx))),
});

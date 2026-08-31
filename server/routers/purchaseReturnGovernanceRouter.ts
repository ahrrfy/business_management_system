import { z } from "zod";
import {
  decidePurchaseReturn,
  decidePurchaseReturnReversal,
  listPendingPurchaseReturnRequests,
  listPendingPurchaseReturnReversalRequests,
  listPurchaseReturnReversalSources,
  listPurchaseReturnSources,
  requestPurchaseReturn,
  requestPurchaseReturnReversal,
} from "../services/purchase/returnGovernance";
import { purchasesManagerProcedure, purchasesReadProcedure, router } from "../trpc";

const actor = (ctx: { user: { id: number; branchId?: number | null; role?: string } }) => ({ userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role });
const key = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(3).max(500);
const evidenceType = z.enum(["RETURN_NOTE", "SUPPLIER_ACKNOWLEDGEMENT", "DOCUMENT_IMAGE", "PDF", "EMAIL", "OTHER"]);

export const purchaseReturnGovernanceRouter = router({
  requestReturn: purchasesManagerProcedure.input(z.object({ supplierInvoiceId: z.number().int().positive(), matchRunId: z.number().int().positive(), expectedInvoiceVersion: z.number().int().positive(), requestKey: key, settlement: z.enum(["CREDIT", "CASH"]), paymentMethod: z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]), evidenceType, evidenceReference: z.string().trim().min(1).max(500), reason, lines: z.array(z.object({ matchAllocationId: z.number().int().positive(), baseQuantity: z.number().int().positive(), reason: z.string().trim().max(500).nullish() })).min(1).max(500) })).mutation(({ input, ctx }) => requestPurchaseReturn(input, actor(ctx))),
  decideReturn: purchasesManagerProcedure.input(z.object({ requestId: z.number().int().positive(), decisionKey: key, action: z.enum(["APPROVE", "REJECT"]), reviewReason: reason })).mutation(({ input, ctx }) => decidePurchaseReturn(input, actor(ctx))),
  requestReversal: purchasesManagerProcedure.input(z.object({ purchaseReturnId: z.number().int().positive(), expectedReturnVersion: z.number().int().positive(), requestKey: key, evidenceType: z.enum(["SUPPLIER_ACKNOWLEDGEMENT", "DOCUMENT_IMAGE", "PDF", "EMAIL", "SIGNED_APPROVAL", "OTHER"]), evidenceReference: z.string().trim().min(1).max(500), reason, lines: z.array(z.object({ purchaseReturnItemId: z.number().int().positive(), baseQuantity: z.number().int().positive(), reason: z.string().trim().max(500).nullish() })).min(1).max(500) })).mutation(({ input, ctx }) => requestPurchaseReturnReversal(input, actor(ctx))),
  decideReversal: purchasesManagerProcedure.input(z.object({ requestId: z.number().int().positive(), decisionKey: key, action: z.enum(["APPROVE", "REJECT"]), reviewReason: reason })).mutation(({ input, ctx }) => decidePurchaseReturnReversal(input, actor(ctx))),
  pendingReturns: purchasesManagerProcedure.input(z.object({ branchId: z.number().int().positive() })).query(({ input, ctx }) => listPendingPurchaseReturnRequests(input.branchId, actor(ctx))),
  pendingReversals: purchasesManagerProcedure.input(z.object({ branchId: z.number().int().positive() })).query(({ input, ctx }) => listPendingPurchaseReturnReversalRequests(input.branchId, actor(ctx))),
  returnSources: purchasesReadProcedure.input(z.object({ branchId: z.number().int().positive(), limit: z.number().int().positive().max(200).optional() })).query(({ input, ctx }) => listPurchaseReturnSources(input, actor(ctx))),
  reversalSources: purchasesReadProcedure.input(z.object({ branchId: z.number().int().positive(), limit: z.number().int().positive().max(200).optional() })).query(({ input, ctx }) => listPurchaseReturnReversalSources(input, actor(ctx))),
});

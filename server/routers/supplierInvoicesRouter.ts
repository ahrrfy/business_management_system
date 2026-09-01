import { z } from "zod";
import { nonNegMoneyString, positiveRateString, unitPriceString } from "../lib/schemas";
import {
  createSupplierInvoice,
  decideSupplierInvoiceApproval,
  getSupplierInvoice,
  listPendingSupplierInvoiceApprovals,
  listSupplierInvoices,
  requestSupplierInvoiceApproval,
} from "../services/purchase/supplierInvoices";
import {
  getSupplierInvoiceDraftGovernance,
  updateSupplierInvoiceDraft,
  voidSupplierInvoiceDraft,
} from "../services/purchase/supplierInvoiceRevisions";
import { runThreeWayMatch } from "../services/purchase/threeWayMatch";
import { purchasesManagerProcedure, purchasesReadProcedure, router } from "../trpc";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
const actor = (ctx: { user: { id: number; branchId?: number | null; role?: string } }) => ({
  userId: ctx.user.id,
  branchId: Number(ctx.user.branchId ?? 0),
  role: ctx.user.role,
});

export const supplierInvoicesRouter = router({
  create: purchasesManagerProcedure
    .input(z.object({
      supplierId: z.number().int().positive(),
      branchId: z.number().int().positive(),
      clientRequestId: z.string().trim().min(1).max(120),
      externalInvoiceNumber: z.string().trim().min(1).max(160),
      invoiceDate: ymd,
      dueDate: ymd.nullish(),
      currency: z.enum(["IQD", "USD"]),
      agreedRate: positiveRateString.nullish(),
      taxAmount: nonNegMoneyString.nullish(),
      discountAmount: nonNegMoneyString.nullish(),
      evidenceType: z.enum(["DOCUMENT_IMAGE", "PDF", "EMAIL", "EDI", "OTHER"]),
      evidenceReference: z.string().trim().min(1).max(500),
      lines: z.array(z.object({
        purchaseOrderRevisionItemId: z.number().int().positive(),
        description: z.string().trim().min(1).max(500),
        invoicedBaseQuantity: z.number().int().positive(),
        unitPrice: unitPriceString,
      })).min(1).max(500),
    }))
    .mutation(({ input, ctx }) => createSupplierInvoice(input, actor(ctx))),

  updateDraft: purchasesManagerProcedure
    .input(z.object({
      supplierInvoiceId: z.number().int().positive(),
      expectedVersion: z.number().int().positive(),
      requestKey: z.string().trim().min(1).max(120),
      reason: z.string().trim().min(3).max(500),
      externalInvoiceNumber: z.string().trim().min(1).max(160),
      invoiceDate: ymd,
      dueDate: ymd.nullish(),
      agreedRate: positiveRateString.nullish(),
      taxAmount: nonNegMoneyString.nullish(),
      discountAmount: nonNegMoneyString.nullish(),
      evidenceType: z.enum(["DOCUMENT_IMAGE", "PDF", "EMAIL", "EDI", "OTHER"]),
      evidenceReference: z.string().trim().min(1).max(500),
      lines: z.array(z.object({
        purchaseOrderRevisionItemId: z.number().int().positive(),
        description: z.string().trim().min(1).max(500),
        invoicedBaseQuantity: z.number().int().positive(),
        unitPrice: unitPriceString,
      })).min(1).max(500),
    }).strict())
    .mutation(({ input, ctx }) => updateSupplierInvoiceDraft(input, actor(ctx))),

  voidDraft: purchasesManagerProcedure
    .input(z.object({
      supplierInvoiceId: z.number().int().positive(),
      expectedVersion: z.number().int().positive(),
      requestKey: z.string().trim().min(1).max(120),
      reason: z.string().trim().min(3).max(500),
    }).strict())
    .mutation(({ input, ctx }) => voidSupplierInvoiceDraft(input, actor(ctx))),

  draftGovernance: purchasesReadProcedure
    .input(z.object({ supplierInvoiceId: z.number().int().positive() }))
    .query(({ input, ctx }) => getSupplierInvoiceDraftGovernance(input.supplierInvoiceId, actor(ctx))),

  get: purchasesReadProcedure
    .input(z.object({ supplierInvoiceId: z.number().int().positive() }))
    .query(({ input, ctx }) => getSupplierInvoice(input.supplierInvoiceId, actor(ctx))),

  list: purchasesReadProcedure
    .input(z.object({ branchId: z.number().int().positive(), supplierId: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).optional() }))
    .query(({ input, ctx }) => listSupplierInvoices(input, actor(ctx))),

  runMatch: purchasesManagerProcedure
    .input(z.object({
      supplierInvoiceId: z.number().int().positive(),
      expectedInvoiceVersion: z.number().int().positive(),
      matchKey: z.string().trim().min(1).max(160),
      allocations: z.array(z.object({
        supplierInvoiceLineId: z.number().int().positive(),
        goodsReceiptItemId: z.number().int().positive(),
        matchedBaseQuantity: z.number().int().positive(),
      })).min(1).max(1000),
    }))
    .mutation(({ input, ctx }) => runThreeWayMatch(input, actor(ctx))),

  requestApproval: purchasesManagerProcedure
    .input(z.object({
      supplierInvoiceId: z.number().int().positive(),
      expectedInvoiceVersion: z.number().int().positive(),
      requestKey: z.string().trim().min(1).max(120),
      kind: z.enum(["POST_INVOICE", "REVERSE_INVOICE"]),
      matchRunId: z.number().int().positive().nullish(),
      reason: z.string().trim().min(3).max(500),
      evidenceType: z.enum(["DOCUMENT_IMAGE", "PDF", "EMAIL", "SIGNED_APPROVAL", "OTHER"]).nullish(),
      evidenceReference: z.string().trim().max(500).nullish(),
    }))
    .mutation(({ input, ctx }) => requestSupplierInvoiceApproval(input, actor(ctx))),

  decideApproval: purchasesManagerProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      decisionKey: z.string().trim().min(1).max(120),
      action: z.enum(["APPROVE", "REJECT"]),
      reviewReason: z.string().trim().min(3).max(500),
    }))
    .mutation(({ input, ctx }) => decideSupplierInvoiceApproval(input, actor(ctx))),

  pendingApprovals: purchasesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => listPendingSupplierInvoiceApprovals(input.branchId, actor(ctx))),
});

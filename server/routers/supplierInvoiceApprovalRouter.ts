import { z } from "zod";
import {
  decideSupplierInvoiceApproval,
  getSupplierInvoice,
  listPendingSupplierInvoiceApprovals,
  listSupplierInvoices,
  requestSupplierInvoiceApproval,
} from "../services/purchase/supplierInvoices";
import { purchasesManagerProcedure, purchasesReadProcedure, router } from "../trpc";

const actor = (ctx: { user: { id: number; branchId?: number | null; role?: string } }) => ({
  userId: ctx.user.id,
  branchId: Number(ctx.user.branchId ?? 0),
  role: ctx.user.role,
});
const key = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(3).max(500);

export const supplierInvoiceApprovalRouter = router({
  list: purchasesReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        supplierId: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(({ input, ctx }) => listSupplierInvoices(input, actor(ctx))),
  get: purchasesReadProcedure
    .input(z.object({ supplierInvoiceId: z.number().int().positive() }))
    .query(({ input, ctx }) => getSupplierInvoice(input.supplierInvoiceId, actor(ctx))),
  // ⛔ يقبل POST_INVOICE أيضاً (قدرة الخدمة الفعلية) لكن الشاشة الحاليّة لا تعرض إلا
  // REVERSE_INVOICE — الترحيلَ الاعتياديّ يُنشئه postApprovedPurchaseInvoiceInTx تلقائياً
  // ضمن معاملة purchases.decideControl (راجع server/services/purchase/automaticInvoicePosting.ts)،
  // وهذا المسار اليدويّ مُعَدٌّ لحالاتٍ استثنائية فقط (لا شاشةَ لها اليوم).
  requestApproval: purchasesManagerProcedure
    .input(
      z.object({
        supplierInvoiceId: z.number().int().positive(),
        expectedInvoiceVersion: z.number().int().positive(),
        requestKey: key,
        kind: z.enum(["POST_INVOICE", "REVERSE_INVOICE"]),
        matchRunId: z.number().int().positive().nullish(),
        reason,
        evidenceType: z
          .enum(["DOCUMENT_IMAGE", "PDF", "EMAIL", "SIGNED_APPROVAL", "OTHER"])
          .nullish(),
        evidenceReference: z.string().trim().max(500).nullish(),
      }),
    )
    .mutation(({ input, ctx }) => requestSupplierInvoiceApproval(input, actor(ctx))),
  decideApproval: purchasesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: key,
        action: z.enum(["APPROVE", "REJECT"]),
        reviewReason: reason,
      }),
    )
    .mutation(({ input, ctx }) => decideSupplierInvoiceApproval(input, actor(ctx))),
  pendingApprovals: purchasesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => listPendingSupplierInvoiceApprovals(input.branchId, actor(ctx))),
});

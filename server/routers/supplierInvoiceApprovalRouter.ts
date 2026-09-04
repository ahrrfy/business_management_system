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
  // ⛔ (مراجعة Codex على #1001) يقبل REVERSE_INVOICE فقط عمداً — لا POST_INVOICE.
  // الترحيلَ الاعتياديّ يُنشئه postApprovedPurchaseInvoiceInTx تلقائياً ضمن معاملة
  // purchases.decideControl الذرّية (GRN → stock/WAVG → GRNI → فاتورة مورّد ومطابقة
  // وترحيل إلى AP → RECEIVED، راجع automaticInvoicePosting.ts) — منفذٌ مباشرٌ لـPOST_INVOICE
  // هنا كان يسمح لأيّ مستخدم مشترياتٍ بترحيل فاتورةٍ MATCHED مباشرةً (قيد AP/GRNI + تعديل
  // رصيد المورّد) **بلا** تحديث حالة أمر الشراء ولا معالجة مصاريف الشحن/الكمرك التي تؤدّيها
  // السلسلة الذرّية — يتجاوز الحظر الموثَّق على واجهة برمجة تطبيقاتٍ مستقلّة لفاتورة المورّد.
  requestApproval: purchasesManagerProcedure
    .input(
      z.object({
        supplierInvoiceId: z.number().int().positive(),
        expectedInvoiceVersion: z.number().int().positive(),
        requestKey: key,
        kind: z.literal("REVERSE_INVOICE"),
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

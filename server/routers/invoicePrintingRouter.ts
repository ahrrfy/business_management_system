import { z } from "zod";
import { hasOperationPolicy } from "../../shared/operationPermissions";
import { auditMetadataFromContext } from "../services/auditService";
import {
  authorizeInvoicePrint,
} from "../services/invoicePrintAuthorization";
import {
  invoiceViewProcedure,
  invoiceViewScopeForUser,
  directPrintBridgeProcedure,
  requireAtomicPermission,
  router,
} from "../trpc";

const printInput = z.object({
  invoiceId: z.number().int().positive(),
  requestId: z.string().uuid(),
  purpose: z.enum(["THERMAL", "A4", "WAREHOUSE", "SHIPPING_LABEL"]),
});

export const invoicePrintingRouter = router({
  requestPrint: invoiceViewProcedure
    .use(requireAtomicPermission("pos.invoice.print"))
    .input(printInput)
    .mutation(({ ctx, input }) =>
      authorizeInvoicePrint(
        input,
        "PRINT",
        {
          userId: ctx.user.id,
          branchId: ctx.user.branchId,
          role: ctx.user.role,
          isOwner: ctx.user.isOwner,
          canonical: hasOperationPolicy(ctx.user),
          scopedOwnerId: ctx.scopedOwnerId,
          invoiceScope: invoiceViewScopeForUser(
            ctx.user,
            "invoicePrinting.requestPrint",
          ),
        },
        auditMetadataFromContext(ctx),
      ),
    ),
  requestReprint: invoiceViewProcedure
    .use(requireAtomicPermission("pos.invoice.reprint"))
    .input(printInput)
    .mutation(({ ctx, input }) =>
      authorizeInvoicePrint(
        input,
        "REPRINT",
        {
          userId: ctx.user.id,
          branchId: ctx.user.branchId,
          role: ctx.user.role,
          isOwner: ctx.user.isOwner,
          canonical: hasOperationPolicy(ctx.user),
          scopedOwnerId: ctx.scopedOwnerId,
          invoiceScope: invoiceViewScopeForUser(
            ctx.user,
            "invoicePrinting.requestReprint",
          ),
        },
        auditMetadataFromContext(ctx),
      ),
    ),
  authorizeBridge: directPrintBridgeProcedure.query(() => ({ authorized: true as const })),
});

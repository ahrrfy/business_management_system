import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  assertOfficialDocumentAccess,
  downloadOfficialDocumentPdf,
  enqueueOfficialDocumentWhatsApp,
  getDocumentDeliveryReadiness,
  getDocumentOutboxStatus,
  loadOfficialDocumentSnapshot,
} from "../services/documentDeliveryService";
import { router, salesReadProcedure } from "../trpc";

const documentRef = z.object({
  kind: z.enum(["INVOICE", "QUOTATION"]),
  documentId: z.number().int().positive(),
});

async function loadForUser(
  input: z.infer<typeof documentRef>,
  ctx: { scopedBranchId: number | null; scopedOwnerId: number | null },
) {
  const document = await loadOfficialDocumentSnapshot(input.kind, input.documentId);
  assertOfficialDocumentAccess(document, ctx);
  return document;
}

export const documentDeliveryRouter = router({
  readiness: salesReadProcedure
    .input(documentRef.extend({ phone: z.string().trim().max(30).nullish() }))
    .query(async ({ input, ctx }) => {
      const document = await loadForUser(input, ctx);
      return getDocumentDeliveryReadiness(document, input.phone);
    }),

  downloadPdf: salesReadProcedure
    .input(documentRef)
    .mutation(async ({ input, ctx }) => {
      const document = await loadForUser(input, ctx);
      return downloadOfficialDocumentPdf(document);
    }),

  sendWhatsAppPdf: salesReadProcedure
    .input(documentRef.extend({
      phone: z.string().trim().min(8).max(30).nullish(),
      caption: z.string().trim().max(1024).nullish(),
      clientRequestId: z.string().uuid(),
    }))
    .mutation(async ({ input, ctx }) => {
      const document = await loadForUser(input, ctx);
      const result = await enqueueOfficialDocumentWhatsApp({
        document,
        phoneOverride: input.phone,
        caption: input.caption,
        clientRequestId: input.clientRequestId,
        createdBy: Number(ctx.user.id),
      });
      await logAudit(ctx, {
        action: "document.sendWhatsAppPdf",
        entityType: input.kind === "INVOICE" ? "invoice" : "quotation",
        entityId: input.documentId,
        newValue: {
          outboxId: result.outboxId,
          mode: result.mode,
          phone: result.phone,
          filename: result.filename,
        },
      });
      return result;
    }),

  sendStatus: salesReadProcedure
    .input(z.object({ outboxId: z.number().int().positive() }))
    .query(({ input, ctx }) => getDocumentOutboxStatus(input.outboxId, ctx.scopedBranchId)),
});

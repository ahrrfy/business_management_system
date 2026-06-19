/**
 * راوتر موافقات الائتمان — managerProcedure (المدير يُصدر؛ الكاشير لا يُصدر لنفسه).
 *
 * create(customerId, maxAmount, ttlMinutes) ⇒ يعيد approvalId يستعمله الكاشير في sale.create.
 * list(customerId) ⇒ يعرض الموافقات النشِطة.
 */
import { z } from "zod";
import { managerProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import { createApproval, getActiveApprovalsForCustomer } from "../services/creditApprovalService";
import { logAudit } from "../services/auditService";

const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");

export const creditApprovalRouter = router({
  create: managerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        maxAmount: moneyStr,
        ttlMinutes: z.number().int().min(1).max(1440).optional(), // ≤ 24h
        notes: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const r = await withTx(async (tx) =>
        createApproval(tx, {
          customerId: input.customerId,
          maxAmount: input.maxAmount,
          approvedBy: ctx.user.id,
          ttlMinutes: input.ttlMinutes,
          notes: input.notes ?? null,
        }),
      );
      await logAudit(ctx, {
        action: "creditApproval.create",
        entityType: "creditApproval",
        entityId: r.id,
        newValue: { customerId: input.customerId, maxAmount: input.maxAmount, expiresAt: r.expiresAt.toISOString() },
      });
      return r;
    }),

  listForCustomer: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await withTx(async (tx) => getActiveApprovalsForCustomer(tx, input.customerId));
      return { rows };
    }),
});

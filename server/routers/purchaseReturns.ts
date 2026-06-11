import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { createPurchaseReturn, listPurchaseReturns } from "../services/purchaseReturnsService";
import { managerProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على entryDate).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

/**
 * مرتجع المشتريات (إرجاع بضاعة للمورد):
 *  - يخصم المخزون (OUT) بقفل ذرّي.
 *  - يُسجّل قيد RETURN في الدفتر بقيم سالبة.
 *  - يخفّض ذمم المورد (AP) أو يُسجّل receipt IN إن سدّد المورد نقداً.
 *  - مدير فأعلى (تكلفة + ذمم + نقد).
 */
export const purchaseReturnsRouter = router({
  create: managerProcedure
    .input(
      z.object({
        clientRequestId: z.string().min(1).max(80).optional(),
        supplierId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        purchaseOrderRefId: z.number().int().positive().optional(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.string(),
              unitPrice: z.string(),
            })
          )
          .min(1),
        reason: z.string().max(500).optional().nullable(),
        paymentMethod: method.optional(),
        settlement: z.enum(["CASH", "CREDIT"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createPurchaseReturn(input, {
            userId: ctx.user.id,
            branchId: ctx.user.branchId ?? input.branchId,
          });
          await logAudit(ctx, {
            action: "purchaseReturn.create",
            entityType: "purchaseReturn",
            entityId: res.purchaseReturnEntryId,
            newValue: {
              supplierId: input.supplierId,
              items: input.items.length,
              returnedTotal: res.returnedTotal,
              idempotent: (res as { idempotent?: boolean }).idempotent,
            },
          });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام مرتجع الشراء" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام مرتجع الشراء (تكرار)" });
    }),

  list: managerProcedure
    .input(
      z
        .object({
          supplierId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().nonnegative().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return listPurchaseReturns(input ?? {});
    }),
});

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { createPurchaseReturn, listPurchaseReturns } from "../services/purchaseReturnsService";
import { nonNegMoneyString, positiveQtyString } from "../lib/schemas";
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
              // PROC-02: سعر/كمية إرجاع الشراء على حدّ الثقة — كانا z.string() بلا قيد إشارة.
              quantity: positiveQtyString,
              unitPrice: nonNegMoneyString,
            })
          )
          .min(1),
        reason: z.string().max(500).optional().nullable(),
        paymentMethod: method.optional(),
        settlement: z.enum(["CASH", "CREDIT"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // AUTHZ-2: عزل الفرع — لغير الأدمن لا نُصدّق input.branchId (كان `ctx.user.branchId ?? input.branchId`
      // يُتيح لمدير بلا فرع حقن أي فرع ⇒ مرتجع يَخصم مخزون فرع آخر). نُجبر فرع المستخدم؛ الأدمن وحده يَعبر.
      const isAdmin = ctx.user.role === "admin";
      let branchId = input.branchId;
      if (!isAdmin) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء مرتجع شراء" });
        }
        branchId = Number(ctx.user.branchId);
      }
      const effInput = { ...input, branchId };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createPurchaseReturn(effInput, {
            userId: ctx.user.id,
            branchId,
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
          q: z.string().trim().min(1).optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().nonnegative().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? input?.branchId : (ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined);
      return listPurchaseReturns({ ...(input ?? {}), branchId });
    }),
});

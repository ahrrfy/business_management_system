import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getPurchaseReturn,
  listPurchaseReturns,
} from "../services/purchaseReturnsService";
import { positiveQtyString } from "../lib/schemas";
import { purchasesManagerProcedure, router } from "../trpc";
import { assertLegacyPurchaseWritePathDisabled } from "../services/purchase/governanceCutover";

const method = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);
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
  create: purchasesManagerProcedure
    .input(
      z.object({
        clientRequestId: z.string().min(1).max(64),
        supplierId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        purchaseOrderRefId: z.number().int().positive(),
        items: z
          .array(
            z.object({
              purchaseOrderItemId: z.number().int().positive(),
              quantity: positiveQtyString,
            })
          )
          .min(1),
        reason: z.string().max(500).optional().nullable(),
        paymentMethod: method.optional(),
        settlement: z.enum(["CASH", "CREDIT"]).optional(),
      })
    )
    .mutation(() => assertLegacyPurchaseWritePathDisabled("purchaseReturns.create")),

  list: purchasesManagerProcedure
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
      // عزل الفرع (تدقيق ١٧/٧): غير الأدمن بلا فرع مُسنَد كان يمرّر undefined ⇒ كل الفروع تُعرَض.
      // نرفض صراحةً مطابقةً لمرآة returnRouter.list (مرتجع البيع).
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      return listPurchaseReturns({ ...(input ?? {}), branchId });
    }),

  get: purchasesManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) => {
      const branchId = ctx.user.role === "admin" ? undefined : Number(ctx.user.branchId);
      if (ctx.user.role !== "admin" && !branchId) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      return getPurchaseReturn(input.id, branchId);
    }),
});

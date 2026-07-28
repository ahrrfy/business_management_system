import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isDupEntry } from "@shared/errorMap.ar";
import { positiveMoneyString } from "../lib/schemas";
import { receiveInboundGift } from "../services/gifts/inbound";
import { listGifts } from "../services/gifts/list";
import { approveGift, createOutboundGift } from "../services/gifts/outbound";
import { branchScopedProcedure, requireModule, router } from "../trpc";

/**
 * وحدة الهدايا/المجانيات — G-م١ الوارد (بضاعة مجّانية من مورّد، صفر تكلفة تُخفِّف WAVG، بلا دين).
 * G-م٢ الصادر (قيد GIFT_OUT + حوكمة SOD) يُضاف لاحقاً في نفس الراوتر.
 * القراءة/الكتابة خلف مفتاح صلاحية `gifts` + عزل الفرع (غير المرتفع يرى/يكتب فرعه فقط).
 */
const giftsRead = branchScopedProcedure.use(requireModule("gifts", "READ"));
const giftsWrite = branchScopedProcedure.use(requireModule("gifts", "FULL"));

const inboundLineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.number().positive(),
  refSalePrice: positiveMoneyString.nullish(),
});

export const giftsRouter = router({
  list: giftsRead
    .input(
      z
        .object({
          direction: z.enum(["OUT", "IN"]).optional(),
          status: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "DELIVERED", "CANCELLED", "REVERSED"]).optional(),
          branchId: z.number().int().positive().optional(),
          q: z.string().optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .optional(),
    )
    // عزل الفرع (نمط consignmentRouter المُثبَت): غير المرتفع يرى فرعه فقط (من ctx.user مباشرةً)؛
    // admin/manager يحترمان branchId المُرسَل (عرض عبر-الفروع).
    .query(({ input, ctx }) => {
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const scopedBranchId = elevated ? null : Number(ctx.user.branchId);
      return listGifts({ scopedBranchId }, { ...(input ?? {}), branchId: elevated ? input?.branchId : undefined });
    }),

  receiveInbound: giftsWrite
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive().nullish(),
        giftType: z.string().max(32).nullish(),
        reason: z.string().max(255).nullish(),
        supplierRef: z.string().max(64).nullish(),
        estimatedValue: positiveMoneyString.nullish(),
        notes: z.string().max(500).nullish(),
        sellable: z.boolean().optional(), // false = استخدام داخليّ/عيّنة (لا يدخل مخزون البيع)
        lines: z.array(inboundLineSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المرتفع محصور بفرعه؛ المرتفع يحدّد الفرع صراحةً.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      if (branchId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع لاستلام الهدية" });
      const actor = { userId: ctx.user.id, branchId, role: ctx.user.role };
      // إعادة المحاولة على تصادم رقم السند اللحظيّ (uq_gift_number) — نمط consignmentRouter.
      const attempt = () => receiveInboundGift({ ...input, branchId }, actor);
      try {
        return await attempt();
      } catch (e) {
        if (isDupEntry(e)) return await attempt();
        throw e;
      }
    }),

  // G-م٢: منح هدية صادرة للعميل (GIFT_OUT + حوكمة SOD). فوق العتبة أو من غير مدير ⇒ PENDING_APPROVAL.
  createOutbound: giftsWrite
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().nullish(),
        giftType: z.string().max(32).nullish(),
        reason: z.string().max(255).nullish(),
        notes: z.string().max(500).nullish(),
        lines: z.array(inboundLineSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      if (branchId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع للهدية" });
      const actor = { userId: ctx.user.id, branchId, role: ctx.user.role };
      const attempt = () => createOutboundGift({ ...input, branchId }, actor);
      try {
        return await attempt();
      } catch (e) {
        if (isDupEntry(e)) return await attempt();
        throw e;
      }
    }),

  // اعتماد هدية صادرة معلَّقة (مدير آخر، SOD-04). الخدمة تفرض دور المدير + عزل الفرع + منع اعتماد الذات.
  approveGift: giftsWrite
    .input(z.object({ giftId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role };
      return approveGift(input.giftId, actor);
    }),
});

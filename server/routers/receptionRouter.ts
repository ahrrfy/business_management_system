// راوتر محطة خدمة الزبائن — ش١ من docs/reception-cashier-system-design-2026-08-05.md §٦.
//
// **صفر بوّابة جديدة**: كل النقاط خلف workordersCashierProcedure القائمة (cashier/manager +
// workorders=FULL) — نفس بوّابة الالتزام receptionCheckout والطابور القديم بالضبط، فلا مدخل
// جديد في authz-inventory. (workordersReadProcedure مرفوضة هنا عمداً — V9: بوّابة خريطةٍ بلا
// قائمة أدوار تفتح الطابور لـwarehouse/user/auditor.)
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { positiveMoneyString } from "../lib/schemas";
import { collectOnReceptionInvoice, listReceptionInvoices } from "../services/reception";
import { router, workordersCashierProcedure } from "../trpc";
import { logAudit } from "../services/auditService";

/** عزل الفرع (نمط deliveryRouter.effectiveBranch): المرتفعون يعبرون بـbranchId صريح؛
 *  غيرهم يُجبَرون على فرعهم، وغيابه = FORBIDDEN. */
function effectiveBranch(ctx: { user: { role?: string | null; branchId?: number | null } }, requested?: number | null) {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (elevated) return requested ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : null;
}

const payMethodEnum = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);

export const receptionRouter = router({
  /** طابور فواتير المحطة: keyset + فلاتر (§٨.٥ — الافتراض «ورديتي» يقرّره العميل بتمرير shiftIds). */
  invoiceQueue: workordersCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().nullish(),
        shiftIds: z.array(z.number().int().positive()).max(20).optional(),
        sinceDays: z.number().int().min(0).max(30).optional(),
        q: z.string().trim().max(80).optional(),
        deliveryState: z.enum(["ALL", "NOT_DISPATCHED", "DISPATCHED", "DELIVERED"]).optional(),
        paymentState: z.enum(["ALL", "UNSETTLED", "UNPAID", "PARTIAL", "PAID"]).optional(),
        method: payMethodEnum.optional(),
        cursor: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = effectiveBranch(ctx, input.branchId);
      if (!branchId) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      return listReceptionInvoices({ ...input, branchId });
    }),

  /** تسديد دفعة على فاتورة المحطة — ح٥ (V8): تفويضٌ إلى processPayment نفسها بحصرٍ بنيويّ
   *  (وردية إنشاء الفاتورة RECEPTION)، والدفعة تدخل درج **القابض** الحاليّ. */
  collectOnInvoice: workordersCashierProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        amount: positiveMoneyString,
        method: payMethodEnum,
        reference: z.string().trim().max(100).nullish(),
        clientRequestId: z.string().min(1).max(60),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const actor = {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : null,
        role: ctx.user.role,
      };
      const result = await collectOnReceptionInvoice(input, actor as never);
      // إفصاح «قَبَضَها» (§٩.٣): كل تسديدٍ يسمّي فاعله ووردية درجه — الرقابة اللاحقة أرخص من المنع.
      await logAudit(ctx, {
        action: "reception.collectOnInvoice",
        entityType: "invoice",
        entityId: input.invoiceId,
        newValue: {
          amount: input.amount,
          method: input.method,
          collectedIntoShiftId: result.collectedIntoShiftId,
        },
      });
      return result;
    }),
});

// راوتر سندات القبض/الصرف المستقلّة. managerProcedure (تأثير مالي مباشر على الذمم + الصندوق).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { createVoucher, getVoucher, listVouchers } from "../services/voucherService";
import { managerProcedure, protectedProcedure, router } from "../trpc";

const partyType = z.enum(["CUSTOMER", "SUPPLIER", "OTHER"]);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const voucherType = z.enum(["RECEIPT", "PAYMENT"]);
const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");

export const voucherRouter = router({
  create: managerProcedure
    .input(
      z.object({
        voucherType,
        branchId: z.number().int().positive(),
        amount: moneyStr,
        paymentMethod: method,
        partyType,
        partyId: z.number().int().positive().nullish(),
        description: z.string().min(1, "الوصف مطلوب").max(500),
        referenceNumber: z.string().max(100).nullish(),
        checkNumber: z.string().max(50).nullish(),
        cardLastFour: z.string().max(4).nullish(),
        // idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض مزدوج عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createVoucher(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId });
          await logAudit(ctx, {
            action: input.voucherType === "RECEIPT" ? "voucher.receipt.create" : "voucher.payment.create",
            entityType: "receipt",
            entityId: res.receiptId,
            newValue: { voucherNumber: res.voucherNumber, amount: input.amount, partyType: input.partyType, partyId: input.partyId ?? null },
          });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء السند" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء السند (تكرار)" });
    }),

  list: protectedProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          voucherType: voucherType.optional(),
          partyType: partyType.optional(),
          partyId: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(500).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => listVouchers(input ?? {})),

  get: protectedProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .query(({ input }) => getVoucher(input.receiptId)),
});

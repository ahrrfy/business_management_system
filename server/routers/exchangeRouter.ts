// راوتر «الصيرفة» (الصرّاف/التحويل) — managerProcedure (تأثير مالي مباشر على أرصدة الشركة).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  buyUsdAtExchange,
  createExchangeHouse,
  depositToExchange,
  getExchangeHouse,
  getExchangeStatement,
  listExchangeHouses,
  reconcileExchange,
  setExchangeActive,
  settleSupplierViaExchange,
  updateExchangeHouse,
  withdrawFromExchange,
} from "../services/exchangeHouseService";
import { managerProcedure, router } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";

const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان كحدّ أقصى)");
const signedMoneyStr = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "مبلغ غير صالح");
const rateStr = z.string().regex(/^\d+(\.\d{1,4})?$/, "سعر صرف غير صالح (موجب، ٤ منازل كحدّ أقصى)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

/** يحلّ فرع العملية النقدية: المدير = فرعه؛ admin يمرّر branchId صراحةً. */
function resolveBranchId(ctx: any, inputBranchId?: number): number {
  const b = ctx.user.branchId == null ? inputBranchId : Number(ctx.user.branchId);
  if (b == null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع (branchId)" });
  }
  return b;
}

function actorOf(ctx: any, branchId: number) {
  return { userId: ctx.user.id, branchId, role: ctx.user.role };
}

export const exchangeRouter = router({
  list: managerProcedure
    .input(
      z
        .object({
          q: z.string().max(120).optional(),
          activeOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => listExchangeHouses(input ?? {})),

  get: managerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => getExchangeHouse(input.id)),

  create: managerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        legacyCode: z.string().max(40).nullish(),
        notes: z.string().max(2000).nullish(),
        openingBalanceIqd: signedMoneyStr.nullish(),
        openingBalanceUsd: signedMoneyStr.nullish(),
        openingUsdRate: rateStr.nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = ctx.user.branchId == null ? 0 : Number(ctx.user.branchId);
      const res = await createExchangeHouse(input, actorOf(ctx, branchId));
      await logAudit(ctx, { action: "exchange.create", entityType: "exchangeHouse", entityId: res.id, newValue: { name: input.name } });
      return res;
    }),

  update: managerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        legacyCode: z.string().max(40).nullish(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await updateExchangeHouse(input, actorOf(ctx, 0));
      // AUDIT-DETAIL (تدقيق ٢/٧): كان سطر التدقيق فارغاً تماماً من القيم رغم تغيير name/phone/legacyCode.
      // نلتقط الحقول المُرسَلة للتعديل (الموجودة في الحمولة) فيصبح السطر كاشفاً لِما تغيّر فعلاً.
      await logAudit(ctx, {
        action: "exchange.update",
        entityType: "exchangeHouse",
        entityId: input.id,
        newValue: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.phone2 !== undefined ? { phone2: input.phone2 } : {}),
          ...(input.legacyCode !== undefined ? { legacyCode: input.legacyCode } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      return res;
    }),

  setActive: managerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setExchangeActive(input.id, input.isActive, actorOf(ctx, 0));
      await logAudit(ctx, { action: "exchange.setActive", entityType: "exchangeHouse", entityId: input.id, newValue: { isActive: input.isActive } });
      return res;
    }),

  deposit: managerProcedure
    .input(
      z.object({
        exchangeHouseId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        amount: moneyStr,
        currency: z.enum(["IQD", "USD"]).default("IQD"),
        exchangeRate: rateStr.nullish(),
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveBranchId(ctx, input.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await depositToExchange({ ...input, branchId }, actorOf(ctx, branchId));
          await logAudit(ctx, { action: "exchange.deposit", entityType: "exchangeTransaction", entityId: res.txnId, newValue: { exchangeHouseId: input.exchangeHouseId, amount: input.amount, currency: input.currency } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          throw e;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تسجيل الإيداع (تكرار)" });
    }),

  withdraw: managerProcedure
    .input(
      z.object({
        exchangeHouseId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        amount: moneyStr,
        currency: z.enum(["IQD", "USD"]).default("IQD"),
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
        confirmNegative: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveBranchId(ctx, input.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await withdrawFromExchange({ ...input, branchId }, actorOf(ctx, branchId));
          await logAudit(ctx, { action: "exchange.withdraw", entityType: "exchangeTransaction", entityId: res.txnId, newValue: { exchangeHouseId: input.exchangeHouseId, amount: input.amount, currency: input.currency } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          throw e;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تسجيل السحب (تكرار)" });
    }),

  buyUsd: managerProcedure
    .input(
      z.object({
        exchangeHouseId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        usdAmount: moneyStr,
        exchangeRate: rateStr,
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
        confirmNegative: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveBranchId(ctx, input.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await buyUsdAtExchange({ ...input, branchId }, actorOf(ctx, branchId));
          await logAudit(ctx, { action: "exchange.buyUsd", entityType: "exchangeTransaction", entityId: res.txnId, newValue: { exchangeHouseId: input.exchangeHouseId, usdAmount: input.usdAmount, exchangeRate: input.exchangeRate } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          throw e;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تسجيل شراء الدولار (تكرار)" });
    }),

  settle: managerProcedure
    .input(
      z.object({
        exchangeHouseId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive(),
        currency: z.enum(["USD", "IQD"]),
        walletAmount: moneyStr,
        settledIqd: moneyStr,
        commission: moneyStr.nullish(),
        exchangeRate: rateStr.nullish(),
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
        confirmNegative: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveBranchId(ctx, input.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await settleSupplierViaExchange({ ...input, branchId }, actorOf(ctx, branchId));
          await logAudit(ctx, {
            action: "exchange.settle",
            entityType: "exchangeTransaction",
            entityId: res.txnId,
            newValue: { exchangeHouseId: input.exchangeHouseId, supplierId: input.supplierId, settledIqd: input.settledIqd, currency: input.currency },
          });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          throw e;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر تسجيل التسديد (تكرار)" });
    }),

  statement: managerProcedure
    .input(z.object({ exchangeHouseId: z.number().int().positive(), from: ymd.optional(), to: ymd.optional() }))
    .query(async ({ input }) => getExchangeStatement(input)),

  reconcile: managerProcedure
    .input(
      z.object({
        exchangeHouseId: z.number().int().positive(),
        statedBalanceIqd: signedMoneyStr,
        statedBalanceUsd: signedMoneyStr,
        asOfDate: ymd.optional(),
      }),
    )
    .query(async ({ input }) => reconcileExchange(input)),
});

import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { invoiceItems, invoices } from "../../drizzle/schema";
import { getDb } from "../db";
import { createSale, processPayment } from "../services/saleService";
import { protectedProcedure, router } from "../trpc";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const lineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  quantity: z.string(),
  unitPriceOverride: z.string().optional(),
  discountPercent: z.string().optional(),
  discountAmount: z.string().optional(),
});

export const saleRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: tier.optional(),
        sourceType: z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]).default("POS"),
        lines: z.array(lineSchema).min(1),
        invoiceDiscount: z.string().optional(),
        taxRatePercent: z.string().optional(),
        payment: z.object({ amount: z.string(), method }).optional(),
        clientRequestId: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? input.branchId };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await createSale(input, actor);
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام البيع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  pay: protectedProcedure
    .input(z.object({ invoiceId: z.number().int().positive(), amount: z.string(), method, shiftId: z.number().int().positive().optional() }))
    .mutation(({ input, ctx }) => processPayment(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 })),

  list: protectedProcedure
    .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      return db.select().from(invoices).orderBy(desc(invoices.id)).limit(input?.limit ?? 50).offset(input?.offset ?? 0);
    }),

  get: protectedProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
    if (!inv) return null;
    const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, input.invoiceId));
    return { ...inv, items };
  }),
});

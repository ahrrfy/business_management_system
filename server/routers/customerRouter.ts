import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure, router } from "../trpc";

/** العملاء — قائمة بسيطة + إضافة سريعة (لازم لأوامر الشغل والبيع الآجل). */
export const customerRouter = router({
  list: protectedProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db.select().from(customers).where(eq(customers.isActive, true)).orderBy(asc(customers.name));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        defaultPriceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).default("RETAIL"),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      if (!db) throw new Error("DATABASE_URL مطلوب");
      const res = await db.insert(customers).values({
        name: input.name.trim(),
        phone: input.phone?.trim() || null,
        defaultPriceTier: input.defaultPriceTier,
        notes: input.notes?.trim() || null,
      });
      const id = Number((res as any)[0]?.insertId ?? (res as any).insertId);
      return { id };
    }),
});

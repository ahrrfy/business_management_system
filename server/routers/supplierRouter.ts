import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure, router } from "../trpc";

/** الموردون — قائمة بسيطة + إنشاء سريع (مطلوب لأوامر الشراء). */
export const supplierRouter = router({
  list: protectedProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db.select().from(suppliers).where(eq(suppliers.isActive, true)).orderBy(asc(suppliers.name));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        city: z.string().optional(),
        paymentTerms: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      if (!db) throw new Error("DATABASE_URL مطلوب");
      const res = await db.insert(suppliers).values({
        name: input.name.trim(),
        phone: input.phone?.trim() || null,
        city: input.city?.trim() || null,
        paymentTerms: input.paymentTerms?.trim() || null,
        notes: input.notes?.trim() || null,
      });
      const id = Number((res as any)[0]?.insertId ?? (res as any).insertId);
      return { id };
    }),
});

import { asc, eq } from "drizzle-orm";
import { branches } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure, router } from "../trpc";

/** الفروع — قائمة للاختيار في الشاشات (شراء/تحويل). */
export const branchRouter = router({
  list: protectedProcedure.query(async () => {
    const db = getDb();
    if (!db) return [];
    return db.select().from(branches).where(eq(branches.isActive, true)).orderBy(asc(branches.id));
  }),
});

import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { adminProcedure, router } from "../trpc";

/** سجلّ التدقيق — عرض فقط للأدمن (من فعل ماذا، متى، من أين). */
export const auditRouter = router({
  list: adminProcedure
    .input(
      z
        .object({
          userId: z.number().int().positive().optional(),
          entityType: z.string().optional(),
          action: z.string().optional(),
          from: z.string().optional(), // YYYY-MM-DD
          to: z.string().optional(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const i = input ?? ({} as NonNullable<typeof input>);
      const conds: any[] = [];
      if (i.userId) conds.push(eq(auditLogs.userId, i.userId));
      if (i.entityType) conds.push(eq(auditLogs.entityType, i.entityType));
      if (i.action?.trim()) conds.push(like(auditLogs.action, `%${i.action.trim()}%`));
      if (i.from) conds.push(gte(auditLogs.createdAt, new Date(i.from + "T00:00:00")));
      if (i.to) conds.push(lte(auditLogs.createdAt, new Date(i.to + "T23:59:59")));
      const where = conds.length ? and(...conds) : undefined;

      const rows = await db
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          userName: users.name,
          branchId: auditLogs.branchId,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          oldValue: auditLogs.oldValue,
          newValue: auditLogs.newValue,
          ipAddress: auditLogs.ipAddress,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where as any)
        .orderBy(desc(auditLogs.id))
        .limit(i.limit ?? 50)
        .offset(i.offset ?? 0);

      const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(auditLogs).where(where as any))[0];
      return { rows, total: Number(totalRow?.n ?? 0) };
    }),

  /** قيم مميّزة للفلاتر (أنواع الكيانات + الأفعال) لملء القوائم المنسدلة. */
  facets: adminProcedure.query(async () => {
    const db = getDb();
    if (!db) return { entityTypes: [], actions: [] };
    const ets = await db.selectDistinct({ v: auditLogs.entityType }).from(auditLogs);
    const acts = await db.selectDistinct({ v: auditLogs.action }).from(auditLogs);
    return {
      entityTypes: ets.map((r) => r.v).filter(Boolean).sort(),
      actions: acts.map((r) => r.v).filter(Boolean).sort(),
    };
  }),
});

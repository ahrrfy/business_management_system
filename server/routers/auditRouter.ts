import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { adminProcedure, router } from "../trpc";

const escLike = (s: string) => s.replace(/[!%_]/g, "!$&");

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
      if (i.action?.trim()) {
        const pat = `%${escLike(i.action.trim())}%`;
        conds.push(sql`${auditLogs.action} LIKE ${pat} ESCAPE '!'`);
      }
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

  /** قيم مميّزة للفلاتر (أنواع الكيانات + الأفعال + المستخدمون الذين نفّذوا فعلاً ما). */
  facets: adminProcedure.query(async () => {
    const db = getDb();
    if (!db) return { entityTypes: [], actions: [], users: [] };
    // PERF-03 (تدقيق ٢٠/٦): SELECT DISTINCT بلا حدّ = مسح كامل لجدول auditLogs (ينمو بلا سقف)
    // في كل تحميل للقائمة المنسدلة. نحدّه بـLIMIT حارس مع ORDER BY ليكون حتمياً (لا اعتماد على
    // ترتيب التخزين). action/entityType منخفضا التعدّد (enum-شبيهان) فالحدّ ٢٠٠ يكفي عملياً؛ لو
    // فاق المتجرُ ذلك مستقبلاً، تعرض القائمة أحدث القيم المميّزة. ملاحظة فهارس: action لديه
    // idx_audit_action، أمّا entityType فلا فهرس مخصّص له ⇒ DISTINCT عليه يبقى مسحاً (مقبول عند
    // هذا الحجم؛ يُضاف فهرس إن كبر الجدول كثيراً).
    const FACET_LIMIT = 200;
    const ets = await db
      .selectDistinct({ v: auditLogs.entityType })
      .from(auditLogs)
      .orderBy(auditLogs.entityType)
      .limit(FACET_LIMIT);
    const acts = await db
      .selectDistinct({ v: auditLogs.action })
      .from(auditLogs)
      .orderBy(auditLogs.action)
      .limit(FACET_LIMIT);
    // المستخدمون الذين ظهر اسمهم في السجلّ — قائمة قصيرة لقائمة منسدلة (لا كل المستخدمين).
    const usersRows = await db
      .selectDistinct({ id: auditLogs.userId, name: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .orderBy(auditLogs.userId)
      .limit(FACET_LIMIT);
    return {
      entityTypes: ets.map((r) => r.v).filter(Boolean).sort(),
      actions: acts.map((r) => r.v).filter(Boolean).sort(),
      users: usersRows
        .filter((r) => r.id != null)
        .map((r) => ({ id: Number(r.id), name: r.name ?? `#${r.id}` }))
        .sort((a, b) => a.name.localeCompare(b.name, "ar")),
    };
  }),
});

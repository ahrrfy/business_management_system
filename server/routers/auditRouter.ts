import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { auditLogs, branches, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { protectedProcedure, router } from "../trpc";
import { canonicalOperationAllowed } from "../operationAuthorization";
import { hasOperationPolicy, type OperationUser } from "@shared/operationPermissions";
import { canCrossBranches } from "../lib/branchAuthority";
import { appErrorMessage } from "@shared/errors";

const auditReadProcedure = protectedProcedure.use(({ ctx, path, next }) => {
  if (!canonicalOperationAllowed(ctx.user, path) && ctx.user.role !== "admin" && ctx.user.role !== "auditor") {
    throw new TRPCError({ code: "FORBIDDEN", message: "سجل التدقيق متاح للأدمن والمدقق المستقل فقط" });
  }
  auditBranch(ctx.user);
  return next({ ctx });
});

/** Legacy auditor access stays intact; delegated access is bound to the assigned branch. */
function auditBranch(user: OperationUser & { branchId?: number | null }): number | null {
  if (!hasOperationPolicy(user) || canCrossBranches(user)) return null;
  if (!user.branchId) throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
    what: "تعذر فتح سجل التدقيق",
    why: "الحساب المفوض لا يرتبط بفرع",
    doThis: "اطلب من مسؤول المستخدمين إسناد فرع للحساب ثم افتح السجل",
  }) });
  return Number(user.branchId);
}

const escLike = (s: string) => s.replace(/[!%_]/g, "!$&");

/** سجلّ التدقيق — عرض فقط للأدمن أو المدقق المستقل (من فعل ماذا، متى، من أين). */
export const auditRouter = router({
  list: auditReadProcedure
    .input(
      z
        .object({
          userId: z.number().int().positive().optional(),
          entityType: z.string().optional(),
          entityId: z.string().trim().min(1).max(50).optional(),
          action: z.string().optional(),
          screenPath: z.string().trim().startsWith("/").max(255).optional(),
          // فلتر فرع اختياري (شاشة سجلّ التدقيق) — auditReadProcedure أصلاً بلا عزل فروع (أدمن/مدقّق
          // يريان كل الفروع)، فلا حارس صلاحية إضافي هنا.
          branchId: z.number().int().positive().optional(),
          from: z.string().optional(), // YYYY-MM-DD
          to: z.string().optional(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
          // S3 (٣٠/٦): cursor (id) لـkeyset — يَتجاوز COUNT الكامل عند تَمريره.
          cursor: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0, hasMore: false, nextCursor: null as number | null };
      const i = input ?? ({} as NonNullable<typeof input>);
      const conds: SQL[] = [];
      const branchId = auditBranch(ctx.user);
      if (branchId != null && i.branchId != null && i.branchId !== branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
          what: "تعذر عرض سجل الفرع المحدد",
          why: "تفويض الحساب محصور بفرعه المسند",
          doThis: "اختر فرع حسابك أو اطلب من الإدارة تفويض الوصول عبر الفروع",
        }) });
      }
      if (i.userId) conds.push(eq(auditLogs.userId, i.userId));
      if (i.entityType) conds.push(eq(auditLogs.entityType, i.entityType));
      if (i.entityId) conds.push(eq(auditLogs.entityId, i.entityId));
      if (i.screenPath) conds.push(eq(auditLogs.screenPath, i.screenPath));
      if (branchId ?? i.branchId) conds.push(eq(auditLogs.branchId, (branchId ?? i.branchId)!));
      if (i.action?.trim()) {
        const pat = `%${escLike(i.action.trim())}%`;
        conds.push(sql`${auditLogs.action} LIKE ${pat} ESCAPE '!'`);
      }
      // تدقيق ١٧/٧: «Z» صريحة ⇒ UTC حتمياً (مطابق لتخزين createdAt وضبط الاتصال timezone:"Z"). بدونها
      // يُفسَّر التاريخ بمنطقة عملية Node فينزاح فلترة السجلّ على أي جهاز يعمل بغير TZ=UTC.
      if (i.from) conds.push(gte(auditLogs.createdAt, new Date(i.from + "T00:00:00Z")));
      if (i.to) conds.push(lte(auditLogs.createdAt, new Date(i.to + "T23:59:59Z")));

      // /simplify ٣٠/٦: paginateKeyset + countIfOffset.
      const { rows, hasMore, nextCursor, usingCursor } = await paginateKeyset({
        cursor: i.cursor,
        limit: i.limit,
        offset: i.offset,
        defaultLimit: 50,
        idCol: auditLogs.id,
        baseConds: conds,
        runQuery: async (where, lim, off) => {
          /**
           * ═══ جلبٌ بخطوتين — تحصينٌ ضدّ `Out of sort memory` (عطلٌ إنتاجيّ ١٤–١٦/٧) ═══
           *
           * الاستعلام الواحد (فرزٌ + أعمدة JSON معاً) كان يسقط كلّما حوى **صفٌّ واحد** حمولةً
           * عريضة: `ORDER BY id DESC` يُجبر MySQL على `filesort`، وحقلُ الفرز يحمل الأعمدة
           * المُختارة (addon fields) فيجب أن يتّسع **لأعرض صفّ**. صفُّ بنرٍ بصورة base64
           * (١٫٣ م.ب = ٥٫٣× `sort_buffer_size` الافتراضي) ⇒ يسقط الجدول **كلّه** لا صفُّه.
           *
           * ① نفرز **المعرّفات وحدها** (صفٌّ ضيّق ⇒ يستحيل أن يعجز الفرز مهما اتّسعت الحمولة).
           * ② نجلب الصفوف بـ`IN (...)` **بلا `ORDER BY`** ⇒ لا فرزَ لصفوفٍ عريضة إطلاقاً،
           *    ثم نرتّبها في الذاكرة على ترتيب الخطوة ①.
           *
           * التعقيم المركزيّ (`redactAuditValue`) يمنع الحمولات الجديدة، لكنه لا يكفي وحده:
           * الصفوف القديمة، والاستيراد، وأيّ كتابةٍ خارج `logAudit` تبقى ممكنة. هذه الطبقة
           * تجعل الشاشة صامدةً **مهما كانت البيانات** — والدفاع في العمق ليس تكراراً.
           */
          const ids = await db
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(where)
            .orderBy(desc(auditLogs.id))
            .limit(lim)
            .offset(off);
          if (!ids.length) return [];
          const ordered = ids.map((r) => Number(r.id));

          const fetched = await db
            .select({
              id: auditLogs.id,
              userId: auditLogs.userId,
              userName: users.name,
              branchId: auditLogs.branchId,
              branchName: branches.name,
              action: auditLogs.action,
              entityType: auditLogs.entityType,
              entityId: auditLogs.entityId,
              oldValue: auditLogs.oldValue,
              newValue: auditLogs.newValue,
              operation: auditLogs.operation,
              screenPath: auditLogs.screenPath,
              ipAddress: auditLogs.ipAddress,
              createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .leftJoin(users, eq(auditLogs.userId, users.id))
            .leftJoin(branches, eq(auditLogs.branchId, branches.id))
            .where(inArray(auditLogs.id, ordered));

          const byId = new Map(fetched.map((r) => [Number(r.id), r]));
          return ordered.map((id) => byId.get(id)).filter((r): r is (typeof fetched)[number] => r != null);
        },
      });
      const total = await countIfOffset(
        usingCursor,
        async () => {
          const baseWhere = conds.length ? and(...conds) : undefined;
          const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(auditLogs).where(baseWhere))[0];
          return Number(totalRow?.n ?? 0);
        },
        { rowsLength: rows.length, limit: i.limit ?? 50, offset: i.offset },
      );
      return { rows, total, hasMore, nextCursor };
    }),

  /** قيم مميّزة للفلاتر (أنواع الكيانات + الأفعال + المستخدمون الذين نفّذوا فعلاً ما). */
  facets: auditReadProcedure.query(async ({ ctx }) => {
    const db = getDb();
    if (!db) return { entityTypes: [], actions: [], users: [] };
    // PERF-03 (تدقيق ٢٠/٦): SELECT DISTINCT بلا حدّ = مسح كامل لجدول auditLogs (ينمو بلا سقف)
    // في كل تحميل للقائمة المنسدلة. نحدّه بـLIMIT حارس مع ORDER BY ليكون حتمياً (لا اعتماد على
    // ترتيب التخزين). action/entityType منخفضا التعدّد (enum-شبيهان) فالحدّ ٢٠٠ يكفي عملياً؛ لو
    // فاق المتجرُ ذلك مستقبلاً، تعرض القائمة أحدث القيم المميّزة. ملاحظة فهارس: action لديه
    // idx_audit_action، أمّا entityType فلا فهرس مخصّص له ⇒ DISTINCT عليه يبقى مسحاً (مقبول عند
    // هذا الحجم؛ يُضاف فهرس إن كبر الجدول كثيراً).
    const FACET_LIMIT = 200;
    const branchId = auditBranch(ctx.user);
    const where = branchId == null ? undefined : eq(auditLogs.branchId, branchId);
    const ets = await db
      .selectDistinct({ v: auditLogs.entityType })
      .from(auditLogs)
      .where(where)
      .orderBy(auditLogs.entityType)
      .limit(FACET_LIMIT);
    const acts = await db
      .selectDistinct({ v: auditLogs.action })
      .from(auditLogs)
      .where(where)
      .orderBy(auditLogs.action)
      .limit(FACET_LIMIT);
    // المستخدمون الذين ظهر اسمهم في السجلّ — قائمة قصيرة لقائمة منسدلة (لا كل المستخدمين).
    const usersRows = await db
      .selectDistinct({ id: auditLogs.userId, name: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(where)
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

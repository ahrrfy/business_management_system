// راوتر الجرد والتسوية — عقد docs/stocktake-contract.md §٣ كاملاً.
//
// الحُرّاس (مصفوفة README §٨):
//   - create/list/get/monitor/requestRecount/regeneratePin/cycleSuggestions/stats/countSheets: warehouseProcedure
//     (دور warehouse غير المرتفع يُجبَر على فرعه؛ حدود الإنشاء تُتجاهل منه فتُستعمل الافتراضيات).
//   - review/resolveConflict/decide/firstSign/approve/forceReview/ira/report/log: managerProcedure (تكاليف وقيم وقرارات).
//   - cancel: adminProcedure.
// كل كتابة يتبعها logAudit (best-effort) بنمط stocktake.<فعل> على entityType "stocktake".
import { TRPCError } from "@trpc/server";
import { asc, and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import {
  approveStocktake,
  cancelStocktakeSession,
  computeStocktakeReview,
  createStocktakeSession,
  decideStocktakeItem,
  firstSignStocktake,
  forceStocktakeReview,
  getCycleSuggestions,
  getIraStats,
  getStocktakeCountSheets,
  getStocktakeReport,
  getStocktakeSession,
  getStocktakeStats,
  listStocktakeSessions,
  monitorStocktakeSession,
  regenerateStocktakePin,
  requestStocktakeRecount,
  resolveStocktakeConflict,
} from "../services/stocktakeService";
import { adminProcedure, canSeeCost, managerProcedure, router, warehouseProcedure } from "../trpc";

/** مبلغ نصي بنمط purchaseRouter — الأموال نصوص تمرّ عبر decimal.js (لا parseFloat). */
const moneyStr = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const idNum = z.number().int().positive();
const reasonEnum = z.enum(["UNSPECIFIED", "DAMAGE", "LOSS_THEFT", "ENTRY_ERROR", "PRINT_WASTE"]);
const statusEnum = z.enum(["COUNTING", "REVIEW", "APPROVED", "CANCELLED"]);

/**
 * عزل الفرع لدور warehouse (نمط scopedBranchId): null = مرتفع الصلاحية (admin/manager)،
 * رقم = افرض هذا الفرع في كل الاستعلامات/الإنشاء. حساب مخزن بلا فرع = خطأ صريح لا تسريب.
 */
function restrictedBranchOf(ctx: { user: { role: string; branchId: number | null } }): number | null {
  if (ctx.user.role === "admin" || ctx.user.role === "manager") return null;
  const b = ctx.user.branchId;
  if (b == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "حسابك غير مرتبط بفرع — راجع المدير لتحديد فرعك" });
  }
  return Number(b);
}

export const stocktakeRouter = router({
  /* ─────────── الإنشاء ─────────── */
  create: warehouseProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, "اسم الجلسة مطلوب").max(255),
        branchId: idNum,
        scopeType: z.enum(["FULL", "MOVING", "CATEGORY", "MANUAL"]),
        movingDays: z.number().int().positive().max(365).optional(),
        categoryIds: z.array(idNum).optional(),
        variantIds: z.array(idNum).optional(),
        blind: z.boolean().optional(),
        thresholdPct: moneyStr.optional(),
        thresholdValue: moneyStr.optional(),
        dualThreshold: moneyStr.optional(),
        directUnderThreshold: z.boolean().optional(),
        waNotify: z.boolean().optional(),
        dupPolicy: z.enum(["VERIFY", "BLOCK"]).optional(),
        notes: z.string().max(2000).optional(),
        assignments: z
          .array(
            z.object({
              name: z.string().trim().min(1, "اسم العامل مطلوب").max(120),
              method: z.enum(["PIN", "USER"]),
              userId: idNum.optional(),
              zone: z.string().trim().max(120).optional(),
              variantIds: z.array(idNum).optional(),
            })
          )
          .min(1, "تكليف عامل واحد على الأقل")
          .max(20),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const restricted = restrictedBranchOf(ctx);
      const effective = { ...input };
      if (restricted != null) {
        // دور المخزن: الفرع يُجبَر على فرعه، وتعديل الحدود صلاحية مدير فأعلى (README §٨)
        // ⇒ تُتجاهل قيمه وتُستعمل افتراضيات المخطط (5% / 25,000 / 150,000).
        effective.branchId = restricted;
        delete effective.thresholdPct;
        delete effective.thresholdValue;
        delete effective.dualThreshold;
      }
      const res = await createStocktakeSession(effective, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "stocktake.create",
        entityType: "stocktake",
        entityId: res.sessionId,
        newValue: {
          code: res.code,
          name: input.name,
          branchId: effective.branchId,
          scopeType: input.scopeType,
          itemCount: res.itemCount,
          // لا PIN في سجلّ التدقيق أبداً.
          assignments: res.assignments.map((a) => ({ name: a.name, method: a.method, zone: a.zone, itemCount: a.itemCount })),
        },
      });
      return res;
    }),

  /* ─────────── القراءة ─────────── */
  list: warehouseProcedure
    .input(
      z
        .object({
          status: statusEnum.optional(),
          branchId: idNum.optional(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const restricted = restrictedBranchOf(ctx);
      return listStocktakeSessions({
        status: input?.status,
        branchId: restricted ?? input?.branchId,
        limit: input?.limit ?? 50,
        offset: input?.offset ?? 0,
      });
    }),

  get: warehouseProcedure.input(z.object({ sessionId: idNum })).query(async ({ input, ctx }) => {
    return getStocktakeSession(input.sessionId, { restrictBranchId: restrictedBranchOf(ctx) });
  }),

  /** q (اختياري): بحث في عدّات الجلسة (اسم/sku/متغيّر) — recentCounts تصبح المطابقات حتى 50 بدل آخر 20. */
  monitor: warehouseProcedure
    .input(z.object({ sessionId: idNum, q: z.string().trim().max(80).optional() }))
    .query(async ({ input, ctx }) => {
      return monitorStocktakeSession(input.sessionId, { restrictBranchId: restrictedBranchOf(ctx), q: input.q });
    }),

  /** المستخدمون النشطون لمنتقي تكليف USER في معالج الإنشاء — أسماء وأدوار فقط، لا حقول حساسة. */
  assignableUsers: warehouseProcedure.query(async () => {
    const db = getDb();
    if (!db) return [] as { id: number; name: string; role: string }[];
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.isActive, true));
    return rows
      .map((u) => {
        const id = Number(u.id);
        // الاسم قد يكون فارغاً ⇒ البديل: الجزء المحلي من البريد ثم «مستخدم #id».
        const name = u.name?.trim() || u.email?.split("@")[0] || `مستخدم #${id}`;
        return { id, name, role: u.role };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }),

  /** شاشة المراجعة (مدير فأعلى — تكاليف وقيم). autoAdjust=false للمقارنة في الواجهة فقط. */
  review: managerProcedure
    .input(z.object({ sessionId: idNum, autoAdjust: z.boolean().default(true) }))
    .query(async ({ input, ctx }) => {
      return computeStocktakeReview(input.sessionId, { autoAdjust: input.autoAdjust, viewerId: ctx.user.id });
    }),

  /* ─────────── معاملات المراجعة ─────────── */
  requestRecount: warehouseProcedure
    .input(z.object({ sessionId: idNum, variantId: idNum, reason: z.string().trim().min(3, "سبب الطلب مطلوب (٣ أحرف فأكثر)").max(255) }))
    .mutation(async ({ input, ctx }) => {
      const res = await requestStocktakeRecount(input, { userId: ctx.user.id }, { restrictBranchId: restrictedBranchOf(ctx) });
      await logAudit(ctx, {
        action: "stocktake.requestRecount",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { variantId: input.variantId, reason: input.reason },
      });
      return res;
    }),

  resolveConflict: managerProcedure
    .input(z.object({ sessionId: idNum, variantId: idNum, pick: z.enum(["FIRST", "VERIFY"]) }))
    .mutation(async ({ input, ctx }) => {
      const res = await resolveStocktakeConflict(input, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "stocktake.resolveConflict",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { variantId: input.variantId, pick: input.pick },
      });
      return res;
    }),

  decide: managerProcedure
    .input(
      z.object({
        sessionId: idNum,
        variantId: idNum,
        action: z.enum(["ADJUST", "KEEP"]),
        reason: reasonEnum,
        note: z.string().trim().max(1000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await decideStocktakeItem(input, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "stocktake.decide",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { variantId: input.variantId, action: input.action, reason: input.reason, note: input.note ?? null },
      });
      return res;
    }),

  firstSign: managerProcedure.input(z.object({ sessionId: idNum })).mutation(async ({ input, ctx }) => {
    const res = await firstSignStocktake(input.sessionId, { userId: ctx.user.id });
    await logAudit(ctx, {
      action: "stocktake.firstSign",
      entityType: "stocktake",
      entityId: input.sessionId,
      newValue: { firstSignByName: res.firstSignByName, firstSignAt: res.firstSignAt },
    });
    return res;
  }),

  approve: managerProcedure.input(z.object({ sessionId: idNum })).mutation(async ({ input, ctx }) => {
    const res = await approveStocktake(input.sessionId, { userId: ctx.user.id });
    // لا تدقيق مكرّراً لإعادة استدعاء idempotent — الاعتماد الفعلي سُجّل في مرّته الأولى.
    if (!res.alreadyApproved) {
      await logAudit(ctx, {
        action: "stocktake.approve",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { adjustedCount: res.adjustedCount, shortExpense: res.shortExpense, overGain: res.overGain },
      });
    }
    return res;
  }),

  forceReview: managerProcedure.input(z.object({ sessionId: idNum })).mutation(async ({ input, ctx }) => {
    const res = await forceStocktakeReview(input.sessionId, { userId: ctx.user.id });
    await logAudit(ctx, {
      action: "stocktake.forceReview",
      entityType: "stocktake",
      entityId: input.sessionId,
      newValue: { note: "إقفال العدّ يدوياً والانتقال للمراجعة" },
    });
    return res;
  }),

  cancel: adminProcedure
    .input(z.object({ sessionId: idNum, reason: z.string().trim().max(500).optional() }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelStocktakeSession(input, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "stocktake.cancel",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { reason: input.reason ?? null },
      });
      return res;
    }),

  regeneratePin: warehouseProcedure.input(z.object({ assignmentId: idNum })).mutation(async ({ input, ctx }) => {
    const res = await regenerateStocktakePin(input.assignmentId, { restrictBranchId: restrictedBranchOf(ctx) });
    // الـPIN نفسه لا يُسجَّل في التدقيق — يُعاد للواجهة مرة واحدة فقط.
    await logAudit(ctx, {
      action: "stocktake.regeneratePin",
      entityType: "stocktake",
      entityId: input.assignmentId,
      newValue: { assignmentId: input.assignmentId },
    });
    return res;
  }),

  /* ─────────── الذكاء التشغيلي ─────────── */
  cycleSuggestions: warehouseProcedure
    .input(z.object({ branchId: idNum.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const restricted = restrictedBranchOf(ctx);
      const rows = await getCycleSuggestions({ branchId: restricted ?? input?.branchId ?? null });
      // القيمة السنوية (تكلفة×استهلاك) للمدير فأعلى فقط — تُحجب خادمياً عن دور warehouse.
      if (canSeeCost(ctx.user.role)) return rows;
      return rows.map(({ annualValue: _hidden, ...safe }) => safe);
    }),

  ira: managerProcedure.query(async () => getIraStats()),

  stats: warehouseProcedure.query(async ({ ctx }) => {
    return getStocktakeStats({ restrictBranchId: restrictedBranchOf(ctx) });
  }),

  /* ─────────── المخرجات ─────────── */
  report: managerProcedure.input(z.object({ sessionId: idNum })).query(async ({ input }) => {
    return getStocktakeReport(input.sessionId);
  }),

  countSheets: warehouseProcedure.input(z.object({ sessionId: idNum })).query(async ({ input, ctx }) => {
    return getStocktakeCountSheets(input.sessionId, { restrictBranchId: restrictedBranchOf(ctx) });
  }),

  /** سجلّ الجلسة من auditLogs (entityType=stocktake) — يشمل عدّات البوابة (user=null باسم العامل). */
  log: managerProcedure.input(z.object({ sessionId: idNum })).query(async ({ input }) => {
    const db = getDb();
    if (!db) return [];
    const rows = await db
      .select({
        at: auditLogs.createdAt,
        userName: users.name,
        action: auditLogs.action,
        newValue: auditLogs.newValue,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(and(eq(auditLogs.entityType, "stocktake"), eq(auditLogs.entityId, String(input.sessionId))))
      .orderBy(asc(auditLogs.id));
    return rows.map((r) => {
      const raw = (r.newValue ?? null) as Record<string, unknown> | null;
      const portalName = raw && typeof raw.countedByName === "string" ? raw.countedByName : null;
      // detail نصّي مقروء (الشاشة تعرضه كما هو) — لا JSON خاماً للمستخدم.
      const detail = raw
        ? Object.entries(raw)
            .filter(([, v]) => v != null && typeof v !== "object")
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(" · ") || null
        : null;
      return {
        at: r.at,
        byName: r.userName ?? portalName ?? "النظام",
        action: r.action,
        detail,
      };
    });
  }),
});

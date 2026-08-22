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
  approveStocktakeItems,
  addStocktakeWorker,
  cancelStocktakeSession,
  computeStocktakeReview,
  createStocktakeSession,
  decideStocktakeItem,
  firstSignStocktake,
  forceStocktakeReview,
  getCycleSuggestions,
  getIraStats,
  getStocktakeCountSheets,
  getStocktakeRemainingItems,
  getStocktakeReport,
  getStocktakeSession,
  getStocktakeStats,
  listStocktakeSessions,
  monitorStocktakeSession,
  previewScope,
  refreshOpeningValuationBasis,
  regenerateStocktakePin,
  reopenStocktakeItemReview,
  removeStocktakeWorker,
  requestStocktakeRecount,
  resolveStocktakeConflict,
  listUnknownScans,
  resolveUnknownScan,
  computeBarcodeCoverage,
} from "../services/stocktakeService";
import {
  adminProcedure,
  canSeeCostForUser,
  inventoryAdminProcedure,
  inventoryManagerProcedure,
  inventoryReadProcedure,
  managerProcedure,
  router,
  warehouseProcedure,
} from "../trpc";

/** مبلغ نصي بنمط purchaseRouter — الأموال نصوص تمرّ عبر decimal.js (لا parseFloat). */
const moneyStr = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const idNum = z.number().int().positive();
const reasonEnum = z.enum([
  "UNSPECIFIED",
  "DAMAGE",
  "LOSS_THEFT",
  "ENTRY_ERROR",
  "PRINT_WASTE",
]);
const statusEnum = z.enum(["COUNTING", "REVIEW", "APPROVED", "CANCELLED"]);

/**
 * عزل الفرع لدور warehouse (نمط scopedBranchId): null = مرتفع الصلاحية (admin/manager)،
 * رقم = افرض هذا الفرع في كل الاستعلامات/الإنشاء. حساب مخزن بلا فرع = خطأ صريح لا تسريب.
 */
function restrictedBranchOf(ctx: {
  user: { role: string; branchId: number | null };
}): number | null {
  // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط بلا قيد؛ مدير الفرع يُجبَر على فرعه (كان يعبُر).
  if (ctx.user.role === "admin") return null;
  const b = ctx.user.branchId;
  if (b == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "حسابك غير مرتبط بفرع — راجع المدير لتحديد فرعك",
    });
  }
  return Number(b);
}

async function assertManagerStocktakeBranch(
  ctx: { user: { role: string; branchId: number | null } },
  sessionId: number,
): Promise<void> {
  if (ctx.user.role === "admin") return;
  if (ctx.user.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا فرع مسند لهذا المدير",
    });
  }
  await getStocktakeSession(sessionId, {
    restrictBranchId: Number(ctx.user.branchId),
  });
}

export const stocktakeRouter = router({
  /* ─────────── الإنشاء ─────────── */
  create: warehouseProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, "اسم الجلسة مطلوب").max(255),
        branchId: idNum,
        // OPENING = «جرد افتتاحي» (الافتتاح التدريجي ١٨/٧) — الخدمة تفرض: مدير فأعلى + نافذة
        // وضع الافتتاح فعّالة + استبعاد المُفتتَح + حصر متبادل مع أي جلسة نشطة بالفرع.
        sessionType: z.enum(["NORMAL", "OPENING"]).optional(),
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
        // أسلوب العدّ — «الحر» محصورٌ بمدير+ (تفرضه الخدمة)؛ الافتراض SCAN_REQUIRED.
        countMethod: z.enum(["SCAN_REQUIRED", "FREE"]).optional(),
        notes: z.string().max(2000).optional(),
        assignments: z
          .array(
            z.object({
              name: z.string().trim().min(1, "اسم العامل مطلوب").max(120),
              method: z.enum(["PIN", "USER"]),
              userId: idNum.optional(),
              zone: z.string().trim().max(120).optional(),
              variantIds: z.array(idNum).optional(),
            }),
          )
          .min(1, "تكليف عامل واحد على الأقل")
          .max(20),
      }),
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
      const res = await createStocktakeSession(effective, {
        userId: ctx.user.id,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action:
          input.sessionType === "OPENING"
            ? "stocktake.openingCreate"
            : "stocktake.create",
        entityType: "stocktake",
        entityId: res.sessionId,
        newValue: {
          code: res.code,
          name: input.name,
          branchId: effective.branchId,
          scopeType: input.scopeType,
          sessionType: input.sessionType ?? "NORMAL",
          itemCount: res.itemCount,
          // لا PIN في سجلّ التدقيق أبداً.
          assignments: res.assignments.map((a) => ({
            name: a.name,
            method: a.method,
            zone: a.zone,
            itemCount: a.itemCount,
          })),
        },
      });
      return res;
    }),

  /**
   * معاينة عدّاد النطاق للمعالج (Wizard) — يعكس منطق resolveScope حرفياً:
   * FULL/MOVING/CATEGORY (MANUAL يُحسب في العميل من الاختيار). قراءة صرفة بلا آثار جانبيّة.
   * يزيل التضليل الذي كان يعرض inventory.onHand.length (يعدّ صفوف branchStock السابقة فقط
   * فيُخفي الأصناف التي لم تُلامَس بحركة بعد — فارق قاتل في الجرد الافتتاحي).
   *
   * البوّابة: inventoryReadProcedure (branchScoped + requireModule("inventory","READ")) —
   * الجرد جزء من وحدة المخزون فيرث نفس بوّابتها؛ العزل الفرعيّ يأتي من scopedBranchId تلقائياً
   * (المدير/الأدمن null فيمرّ input.branchId؛ غيرهم مُجبَر على فرعه). أنظف من warehouseProcedure
   * الخام (RAW_ROLE_GATE) الذي يفرضه حارس authz لكل endpoint مستجدّ.
   */
  previewScopeCount: inventoryReadProcedure
    .input(
      z.object({
        branchId: idNum,
        sessionType: z.enum(["NORMAL", "OPENING"]).default("NORMAL"),
        scopeType: z.enum(["FULL", "MOVING", "CATEGORY"]),
        movingDays: z.number().int().positive().max(365).optional(),
        categoryIds: z.array(idNum).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const branchId = ctx.scopedBranchId ?? input.branchId;
      return previewScope({
        branchId,
        sessionType: input.sessionType,
        scopeType: input.scopeType,
        movingDays: input.movingDays,
        categoryIds: input.categoryIds,
      });
    }),

  /** تغطية الباركود لمتغيّرات مختارة صراحةً (نطاق MANUAL في المعالج) — بوّابة جاهزية م٢. */
  barcodeCoverage: inventoryReadProcedure
    .input(z.object({ variantIds: z.array(idNum).max(10_000) }))
    .query(async ({ input }) => computeBarcodeCoverage(input.variantIds)),

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
        .optional(),
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

  get: warehouseProcedure
    .input(z.object({ sessionId: idNum }))
    .query(async ({ input, ctx }) => {
      return getStocktakeSession(input.sessionId, {
        restrictBranchId: restrictedBranchOf(ctx),
      });
    }),

  /** q (اختياري): بحث في عدّات الجلسة (اسم/sku/متغيّر) — recentCounts تصبح المطابقات حتى 50 بدل آخر 20. */
  monitor: warehouseProcedure
    .input(
      z.object({ sessionId: idNum, q: z.string().trim().max(80).optional() }),
    )
    .query(async ({ input, ctx }) => {
      return monitorStocktakeSession(input.sessionId, {
        restrictBranchId: restrictedBranchOf(ctx),
        q: input.q,
      });
    }),

  /** كشف تشغيلي للمنتجات غير المعدودة — بلا رصيد دفتري/تكلفة، صالح للطباعة والتصدير. */
  remaining: inventoryReadProcedure
    .input(
      z.object({
        sessionId: idNum,
        q: z.string().trim().max(80).optional(),
        assignmentId: idNum.optional(),
        limit: z.number().int().positive().max(10_000).default(500),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) =>
      getStocktakeRemainingItems(input.sessionId, {
        restrictBranchId: ctx.scopedBranchId ?? restrictedBranchOf(ctx),
        q: input.q,
        assignmentId: input.assignmentId,
        limit: input.limit,
        offset: input.offset,
      }),
    ),

  /** المستخدمون النشطون لمنتقي تكليف USER في معالج الإنشاء — أسماء وأدوار فقط، لا حقول حساسة. */
  assignableUsers: warehouseProcedure.query(async () => {
    const db = getDb();
    if (!db) return [] as { id: number; name: string; role: string }[];
    // AUTHZ-4: لا نَسحب البريد إطلاقاً لمنتقٍ يَبلغه أمين المخزن — لا تسريب بريد (ولا اشتقاق اسم منه).
    const rows = await db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.isActive, true));
    return rows
      .map((u) => {
        const id = Number(u.id);
        // الاسم قد يكون فارغاً ⇒ البديل «مستخدم #id» (لا نشتقّ من البريد كي لا يُكشَف).
        const name = u.name?.trim() || `مستخدم #${id}`;
        return { id, name, role: u.role };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }),

  /** إدارة العمال أثناء COUNTING — حفظ العدّات وإبطال الوصول عند الإزالة، بصلاحية إدارة المخزون. */
  addWorker: inventoryManagerProcedure
    .input(
      z.object({
        sessionId: idNum,
        name: z.string().trim().min(1, "اسم العامل مطلوب").max(120),
        method: z.enum(["PIN", "USER"]),
        userId: idNum.optional(),
        zone: z.string().trim().max(120).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await addStocktakeWorker(input, {
        userId: ctx.user.id,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "stocktake.addWorker",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: {
          assignmentId: res.assignmentId,
          name: res.name,
          method: res.method,
          userId: res.userId,
          zone: res.zone,
          routedItemCount: res.routedItemCount,
        },
      });
      return res;
    }),

  removeWorker: inventoryManagerProcedure
    .input(
      z.object({
        sessionId: idNum,
        assignmentId: idNum,
        reason: z
          .string()
          .trim()
          .min(3, "سبب الإزالة مطلوب (٣ أحرف فأكثر)")
          .max(255),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await removeStocktakeWorker(input, {
        userId: ctx.user.id,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "stocktake.removeWorker",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: {
          assignmentId: input.assignmentId,
          reason: input.reason,
          preservedCountRows: res.preservedCountRows,
          routedItemCount: res.routedItemCount,
          alreadyRemoved: res.alreadyRemoved,
        },
      });
      return res;
    }),

  /** طابور الباركود المجهول (ب-٤): باركوداتٌ مُسِحت خارج نطاق الجلسة — قراءةٌ مبوّبة (كـ remaining). */
  unknownScans: inventoryReadProcedure
    .input(z.object({ sessionId: idNum }))
    .query(async ({ input, ctx }) =>
      listUnknownScans(input.sessionId, {
        restrictBranchId: ctx.scopedBranchId ?? restrictedBranchOf(ctx),
      }),
    ),

  /** حسم باركودٍ مجهول: إضافةٌ للنطاق (يحلّه إلى متغيّره) أو تجاهل — بصلاحية إدارة المخزون. */
  resolveUnknownScan: inventoryManagerProcedure
    .input(
      z.object({
        sessionId: idNum,
        barcode: z.string().trim().min(1).max(64),
        action: z.enum(["ADD_TO_SCOPE", "DISMISS"]),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await resolveUnknownScan(
        {
          sessionId: input.sessionId,
          barcode: input.barcode,
          action: input.action,
          note: input.note,
        },
        { userId: ctx.user.id, role: ctx.user.role },
        { restrictBranchId: restrictedBranchOf(ctx) },
      );
      await logAudit(ctx, {
        action: "stocktake.resolveUnknownScan",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: {
          barcode: input.barcode,
          action: input.action,
          resolvedRows: res.resolvedRows,
          addedVariantId: res.addedVariantId,
          alreadyInScope: res.alreadyInScope,
          note: input.note ?? null,
        },
      });
      return res;
    }),

  /** شاشة المراجعة (مدير فأعلى — تكاليف وقيم). autoAdjust=false للمقارنة في الواجهة فقط. */
  review: managerProcedure
    .input(
      z.object({ sessionId: idNum, autoAdjust: z.boolean().default(true) }),
    )
    .query(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      return computeStocktakeReview(input.sessionId, {
        autoAdjust: input.autoAdjust,
        viewerId: ctx.user.id,
      });
    }),

  /* ─────────── معاملات المراجعة ─────────── */
  requestRecount: warehouseProcedure
    .input(
      z.object({
        sessionId: idNum,
        variantId: idNum,
        reason: z
          .string()
          .trim()
          .min(3, "سبب الطلب مطلوب (٣ أحرف فأكثر)")
          .max(255),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await requestStocktakeRecount(
        input,
        { userId: ctx.user.id },
        { restrictBranchId: restrictedBranchOf(ctx) },
      );
      await logAudit(ctx, {
        action: "stocktake.requestRecount",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { variantId: input.variantId, reason: input.reason },
      });
      return res;
    }),

  resolveConflict: managerProcedure
    .input(
      z.object({
        sessionId: idNum,
        variantId: idNum,
        pick: z.enum(["FIRST", "VERIFY"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await resolveStocktakeConflict(input, {
        userId: ctx.user.id,
      });
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await decideStocktakeItem(input, { userId: ctx.user.id });
      await logAudit(ctx, {
        action: "stocktake.decide",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: {
          variantId: input.variantId,
          action: input.action,
          reason: input.reason,
          note: input.note ?? null,
        },
      });
      return res;
    }),

  /** اعتماد مرحلي للأصناف الجاهزة بينما يبقى بقية نطاق الجلسة قيد العدّ. */
  approveItems: inventoryManagerProcedure
    .input(
      z.object({
        sessionId: idNum,
        variantIds: z.array(idNum).min(1).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await approveStocktakeItems(input, { userId: ctx.user.id });
      if (res.approvedCount > 0) {
        await logAudit(ctx, {
          action: "stocktake.approveItems",
          entityType: "stocktake",
          entityId: input.sessionId,
          newValue: {
            approvedCount: res.approvedCount,
            refreshedCount: res.refreshedCount,
            variantIds: input.variantIds,
          },
        });
      }
      return res;
    }),

  /**
   * إنقاذ تقييم افتتاحي فقط: الخادم يعيد اشتقاق كل التكاليف الحية تحت الأقفال ولا يقبل سعراً
   * أو قائمة أصناف من العميل. العملية تفتح الاعتمادات المتأثرة وتبطل التوقيع في معاملة واحدة.
   */
  refreshOpeningValuationBasis: inventoryAdminProcedure
    .input(
      z.object({
        sessionId: idNum,
        expectedDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/i, "بصمة المعاينة غير صالحة"),
        reason: z
          .string()
          .trim()
          .min(10, "اكتب سبباً موثقاً لا يقل عن 10 أحرف")
          .max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      return refreshOpeningValuationBasis(input, {
        userId: ctx.user.id,
        role: ctx.user.role,
      });
    }),

  /** إلغاء اعتماد مرحلي بسبب موثّق؛ لا يطلب إعادة عدّ ما لم يختر المدير ذلك منفصلاً. */
  reopenItemReview: inventoryManagerProcedure
    .input(
      z.object({
        sessionId: idNum,
        variantId: idNum,
        reason: z
          .string()
          .trim()
          .min(3, "سبب إعادة الفتح مطلوب (3 أحرف فأكثر)")
          .max(255),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await reopenStocktakeItemReview(input, {
        userId: ctx.user.id,
      });
      await logAudit(ctx, {
        action: "stocktake.reopenItemReview",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { variantId: input.variantId, reason: input.reason },
      });
      return res;
    }),

  firstSign: managerProcedure
    .input(z.object({ sessionId: idNum }))
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await firstSignStocktake(input.sessionId, {
        userId: ctx.user.id,
      });
      await logAudit(ctx, {
        action: "stocktake.firstSign",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: {
          firstSignByName: res.firstSignByName,
          firstSignAt: res.firstSignAt,
        },
      });
      return res;
    }),

  approve: managerProcedure
    .input(z.object({ sessionId: idNum }))
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      // role يلزم حوكمة الاعتماد الافتتاحي (منشئ≠معتمد وعادّ≠معتمد، admin مُستثنى للتصحيح الإداري).
      const res = await approveStocktake(input.sessionId, {
        userId: ctx.user.id,
        role: ctx.user.role,
      });
      // لا تدقيق مكرّراً لإعادة استدعاء idempotent — الاعتماد الفعلي سُجّل في مرّته الأولى.
      if (!res.alreadyApproved) {
        await logAudit(ctx, {
          action: "stocktake.approve",
          entityType: "stocktake",
          entityId: input.sessionId,
          newValue: {
            adjustedCount: res.adjustedCount,
            shortExpense: res.shortExpense,
            overGain: res.overGain,
          },
        });
      }
      return res;
    }),

  forceReview: managerProcedure
    .input(z.object({ sessionId: idNum }))
    .mutation(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      const res = await forceStocktakeReview(input.sessionId, {
        userId: ctx.user.id,
      });
      await logAudit(ctx, {
        action: "stocktake.forceReview",
        entityType: "stocktake",
        entityId: input.sessionId,
        newValue: { note: "إقفال العدّ يدوياً والانتقال للمراجعة" },
      });
      return res;
    }),

  cancel: adminProcedure
    .input(
      z.object({
        sessionId: idNum,
        reason: z.string().trim().max(500).optional(),
      }),
    )
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

  regeneratePin: warehouseProcedure
    .input(z.object({ assignmentId: idNum }))
    .mutation(async ({ input, ctx }) => {
      const res = await regenerateStocktakePin(input.assignmentId, {
        restrictBranchId: restrictedBranchOf(ctx),
      });
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
      const rows = await getCycleSuggestions({
        branchId: restricted ?? input?.branchId ?? null,
      });
      // القيمة السنوية (تكلفة×استهلاك) للمدير فأعلى فقط — تُحجب خادمياً عن دور warehouse.
      if (canSeeCostForUser(ctx.user)) return rows;
      return rows.map(({ annualValue: _hidden, ...safe }) => safe);
    }),

  ira: managerProcedure.query(async ({ ctx }) => getIraStats(restrictedBranchOf(ctx))),

  stats: warehouseProcedure.query(async ({ ctx }) => {
    return getStocktakeStats({ restrictBranchId: restrictedBranchOf(ctx) });
  }),

  /* ─────────── المخرجات ─────────── */
  report: managerProcedure
    .input(z.object({ sessionId: idNum }))
    .query(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
      return getStocktakeReport(input.sessionId);
    }),

  countSheets: warehouseProcedure
    .input(z.object({ sessionId: idNum }))
    .query(async ({ input, ctx }) => {
      return getStocktakeCountSheets(input.sessionId, {
        restrictBranchId: restrictedBranchOf(ctx),
      });
    }),

  /** سجلّ الجلسة من auditLogs (entityType=stocktake) — يشمل عدّات البوابة (user=null باسم العامل). */
  log: managerProcedure
    .input(z.object({ sessionId: idNum }))
    .query(async ({ input, ctx }) => {
      await assertManagerStocktakeBranch(ctx, input.sessionId);
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
        .where(
          and(
            eq(auditLogs.entityType, "stocktake"),
            eq(auditLogs.entityId, String(input.sessionId)),
          ),
        )
        .orderBy(asc(auditLogs.id));
      return rows.map((r) => {
        const raw = (r.newValue ?? null) as Record<string, unknown> | null;
        const portalName =
          raw && typeof raw.countedByName === "string"
            ? raw.countedByName
            : null;
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

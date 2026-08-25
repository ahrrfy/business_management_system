import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { nonNegMoneyString } from "../lib/schemas";
import { alias } from "drizzle-orm/mysql-core";

// استخدام ! كحرف هروب بـ ESCAPE '!' — بديل آمن عن \ (لا يُصاب بـNO_BACKSLASH_ESCAPES MySQL mode).
const escLike = (s: string) => s.replace(/[!%_]/g, "!$&");
import { z } from "zod";
import { branches, branchStock, inventoryMovements, productVariants, products, stockAdjustmentRequests, stockTransfers, users, variantBranchThresholds } from "../../drizzle/schema";
import { getDb } from "../db";
import { createAppNotification } from "../services/appNotificationService";
import { logAudit } from "../services/auditService";
import {
  cancelStockTransfer,
  createStockTransfer,
  getStockTransfer,
  listStockTransfers,
  pendingIncomingCount,
  receiveStockTransfer,
} from "../services/transferService";
import {
  clearBranchThresholds,
  countReorderAlerts,
  createReorderDraft,
  effectiveMinStockSql,
  effectiveReorderPointSql,
  listBranchThresholds,
  listReorderAlerts,
  setBranchThresholds,
  setReorderThresholds,
} from "../services/inventory/reorder";
import { countSeasonBelowTarget, listSeasonPlan, searchSeasonCandidates, setSeasonTarget } from "../services/inventory/seasonPlanning";
import { signedMoveQty } from "../services/inventoryService";
import {
  ADJUSTMENT_REASONS,
  requestStockAdjustment,
  approveStockAdjustment,
  rejectStockAdjustment,
  listStockAdjustmentRequests,
  readAdjustmentAttachment,
} from "../services/inventory/adjustmentApproval";
import {
  requestCostRevaluation,
  approveCostRevaluation,
  rejectCostRevaluation,
  listCostRevaluations,
  getCostRevaluationPreview,
} from "../services/inventory/costRevaluationRequest";
import { withTx } from "../services/tx";
import { retryOnDup } from "../lib/retryDup";
import { inventoryManagerProcedure, inventoryReadProcedure, inventoryWarehouseProcedure, protectedProcedure, router } from "../trpc";

/** تسميات عربية لأسباب الحركة اليدوية — تكتب في notes. */
const REASON_LABELS = {
  STOCK_TAKE: "جرد",
  DAMAGE: "تالف",
  SAMPLE: "عيّنة",
  INTERNAL_USE: "استخدام داخلي",
  GIFT: "إهداء",
  CORRECTION: "تصحيح",
  OTHER: "أخرى",
} as const;
type Reason = keyof typeof REASON_LABELS;
const REASON_KEYS = Object.keys(REASON_LABELS) as [Reason, ...Reason[]];

const MOVEMENT_TYPES = ["IN", "OUT", "ADJUST", "RETURN", "TRANSFER_IN", "TRANSFER_OUT"] as const;

/** أسباب التحويل بين الفروع — تُكتب في notes الحركة (سند تحويل، بلا قيد محاسبي). */
const TRANSFER_REASONS = {
  REBALANCE: "إعادة توزيع المخزون",
  STOCKOUT: "نفاد في الفرع المستلم",
  BRANCH_REQ: "طلب من الفرع",
  SEASONAL: "تجهيز موسمي",
  RETURN_HQ: "إرجاع للمخزن الرئيسي",
  OTHER: "أخرى",
} as const;
type TransferReason = keyof typeof TRANSFER_REASONS;
const TRANSFER_REASON_KEYS = Object.keys(TRANSFER_REASONS) as [TransferReason, ...TransferReason[]];

/**
 * سجلّ سندات التحويل ببحثٍ برقم السند + مدى تاريخ — امتدادٌ محليّ لـ`listStockTransfers`
 * (transferService.ts مملوكٌ لجلسةٍ أخرى اليوم فلا نلمسه). يُستدعى فقط حين يُرسِل العميل
 * q/fromDate/toDate؛ خلاف ذلك يبقى المسار القديم `listStockTransfers` كما هو بلا أثرٍ جانبيّ.
 * نطاق العزل مطابقٌ حرفياً لـ`listStockTransfers` (isElevated/scopeBranch/dir) كي لا ينحرف
 * سلوك التصفية بالفرع/الاتجاه بين المسارين.
 */
async function listStockTransfersFiltered(a: {
  actor: { userId: number; role: string; branchId: number | null };
  branchId?: number | null;
  direction?: "in" | "out" | "all";
  status?: "IN_TRANSIT" | "RECEIVED" | "CANCELLED" | "all";
  cursor?: number | null;
  limit?: number;
  q?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const limit = Math.min(a.limit ?? 30, 100);
  const elevated = a.actor.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران

  let scopeBranch: number | null;
  if (elevated) {
    scopeBranch = a.branchId ?? null;
  } else {
    if (a.actor.branchId == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
    scopeBranch = Number(a.actor.branchId);
  }

  const conds: any[] = [];
  if (scopeBranch != null) {
    const dir = a.direction ?? "all";
    if (dir === "in") conds.push(eq(stockTransfers.toBranchId, scopeBranch));
    else if (dir === "out") conds.push(eq(stockTransfers.fromBranchId, scopeBranch));
    else conds.push(or(eq(stockTransfers.fromBranchId, scopeBranch), eq(stockTransfers.toBranchId, scopeBranch)));
  }
  if (a.status && a.status !== "all") conds.push(eq(stockTransfers.status, a.status));
  if (a.cursor) conds.push(lt(stockTransfers.id, a.cursor));
  const q = a.q?.trim();
  if (q) {
    const pat = `%${escLike(q)}%`;
    conds.push(sql`${stockTransfers.transferNumber} LIKE ${pat} ESCAPE '!'`);
  }
  if (a.fromDate) {
    const from = new Date(a.fromDate);
    if (!isNaN(from.getTime())) conds.push(gte(stockTransfers.createdAt, from));
  }
  if (a.toDate) {
    // شامل لليوم كامل — نمط movementsRich (Date.UTC حتميّ بمعزل عن TZ العملية).
    const to = new Date(a.toDate);
    if (!isNaN(to.getTime())) {
      const next = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
      conds.push(lt(stockTransfers.createdAt, next));
    }
  }

  const fromB = sql`(SELECT name FROM branches WHERE id = ${stockTransfers.fromBranchId})`;
  const rows = await db
    .select({
      id: stockTransfers.id,
      transferNumber: stockTransfers.transferNumber,
      fromBranchId: stockTransfers.fromBranchId,
      toBranchId: stockTransfers.toBranchId,
      status: stockTransfers.status,
      reason: stockTransfers.reason,
      totalSentBase: stockTransfers.totalSentBase,
      totalReceivedBase: stockTransfers.totalReceivedBase,
      createdAt: stockTransfers.createdAt,
      receivedAt: stockTransfers.receivedAt,
      fromBranchName: fromB.mapWith(String).as("fromBranchName"),
      toBranchName: sql`(SELECT name FROM branches WHERE id = ${stockTransfers.toBranchId})`.mapWith(String).as("toBranchName"),
      linesCount: sql`(SELECT COUNT(*) FROM stockTransferLines WHERE transferId = ${stockTransfers.id})`.mapWith(Number).as("linesCount"),
    })
    .from(stockTransfers)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(stockTransfers.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? Number(page[page.length - 1].id) : null };
}

export const inventoryRouter = router({
  transfer: inventoryWarehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        fromBranchId: z.number().int().positive(),
        toBranchId: z.number().int().positive(),
        baseQuantity: z.number().int().positive(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: warehouse يُجبَر على أن يكون فرع المصدر فرعَه (لا يُفرغ مخزن فرع ليس له
      // عبر استدعاء API مباشر). admin/manager يحترمان fromBranchId المُرسَل (نقل بين أي فرعين).
      const elevated = ctx.user.role === "admin"; // «كتابة فرعه»: المدير لم يعُد عابر الفروع كتابةً (قرار المالك ٢٣/٧)
      let fromBranchId = input.fromBranchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        if (Number(ctx.user.branchId) !== input.fromBranchId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن نقل بضاعة من فرع ليس فرعك" });
        }
        fromBranchId = Number(ctx.user.branchId);
      }
      // منذ ١٤/٧ (تحويل بخطوتين): هذا الغلاف المفرد ينشئ سنداً «بالطريق» بسطر واحد — الوجهة
      // تستلمه بمطابقة من شاشة التحويلات. أُبقي الـendpoint لاستقرار الـAPI (rbac tests قائمة).
      const res = await retryOnDup(() =>
        withTx((tx) =>
          createStockTransfer(tx, {
            fromBranchId,
            toBranchId: input.toBranchId,
            items: [{ variantId: input.variantId, baseQuantity: input.baseQuantity }],
            notes: input.notes,
            createdBy: ctx.user.id,
          }),
        ),
      );
      // entityType='transfer' لأن العملية تُعدّل صفّي مخزون (out+in) ومرجعها منطقياً «حدث نقل»
      // لا صفّ stock مفرد؛ المفاتيح بصيغة كاملة (fromBranchId/toBranchId) لاتساق سجلّ التدقيق
      // مع بقية الراوترات (sale/purchase). الكمية في الوحدة الأساس (baseQuantity).
      await logAudit(ctx, {
        action: "inventory.transfer",
        entityType: "transfer",
        entityId: input.variantId,
        newValue: {
          variantId: input.variantId,
          fromBranchId,
          toBranchId: input.toBranchId,
          baseQuantity: input.baseQuantity,
          notes: input.notes ?? null,
        },
      });
      return res;
    }),

  /**
   * تحويل سند بأسطر متعددة بين فرعين — ذرّي (كل الأسطر في معاملة واحدة، إمّا تُطبَّق كلها أو
   * لا شيء). يعيد استخدام transferBetweenBranches (قفل ثنائي تصاعدي لكل متغيّر) بلا قيد محاسبي.
   * عزل الفرع: warehouse يُجبَر على فرعه مصدراً؛ admin/manager يحوّلان بين أي فرعين.
   */
  transferBatch: inventoryWarehouseProcedure
    .input(
      z.object({
        fromBranchId: z.number().int().positive(),
        toBranchId: z.number().int().positive(),
        reason: z.enum(TRANSFER_REASON_KEYS).optional(),
        notes: z.string().max(500).optional(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
            })
          )
          .min(1, "أضف صنفاً واحداً على الأقل")
          .max(200, "حدّ الأصناف في السند الواحد 200"),
        // idempotency (تدقيق ٢٣/٦/٢٦): نقرة مزدوجة كانت تنقل المخزون بين الفروع مرّتين ⇒
        // عجز/فائض ظاهر في الجرد. المفتاح يَحرس ضدّ النقر المزدوج وإعادة المحاولة الشبكية.
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // «كتابة فرعه»: المدير لم يعُد عابر الفروع كتابةً (قرار المالك ٢٣/٧)
      let fromBranchId = input.fromBranchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        if (Number(ctx.user.branchId) !== input.fromBranchId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن نقل بضاعة من فرع ليس فرعك" });
        }
        fromBranchId = Number(ctx.user.branchId);
      }
      // منذ ١٤/٧ (تحويل بخطوتين): الإنشاء يخصم المصدر ويضع السند «بالطريق»؛ الوجهة تستلم
      // بمطابقة عبر transferReceive. الذرّية والقفل الحتمي وidempotency داخل الخدمة.
      const res = await retryOnDup(() =>
        withTx((tx) =>
          createStockTransfer(tx, {
            fromBranchId,
            toBranchId: input.toBranchId,
            items: input.items,
            reason: input.reason,
            notes: input.notes,
            clientRequestId: input.clientRequestId,
            createdBy: ctx.user.id,
          }),
        ),
      );

      // لا نَكتب audit log على replay (السند مُسجَّل مسبقاً) — يَمنع تضخّم السجلّ بمحاولات مكرّرة.
      if (!res.idempotentReplay) {
        await logAudit(ctx, {
          action: "inventory.transferBatch",
          entityType: "transfer",
          entityId: res.transferId,
          newValue: {
            transferNumber: res.transferNumber,
            fromBranchId,
            toBranchId: input.toBranchId,
            reason: input.reason ?? null,
            notes: input.notes ?? null,
            itemCount: res.lines,
            items: input.items,
          },
        });
      }
      return res;
    }),

  /** قائمة سندات التحويل بنطاق الفرع (وارد/صادر/الكل) — قراءة، keyset. */
  transfersList: inventoryReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().nullish(),
        // «dir» لا «direction» — tRPC يحجز مفتاح direction في useInfiniteQuery (ReservedInfiniteQueryKeys).
        dir: z.enum(["in", "out", "all"]).optional(),
        status: z.enum(["IN_TRANSIT", "RECEIVED", "CANCELLED", "all"]).optional(),
        cursor: z.number().int().positive().nullish(),
        limit: z.number().int().min(1).max(100).optional(),
        // بحث برقم السند + مدى تاريخ (اختياريان) — عند غيابهما يبقى المسار القديم كما هو حرفياً.
        q: z.string().max(60).optional(),
        fromDate: z.string().optional(),
        toDate: z.string().optional(),
      })
    )
    .query(({ input, ctx }) => {
      const actor = { userId: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId) };
      if (input.q?.trim() || input.fromDate || input.toDate) {
        return listStockTransfersFiltered({
          actor,
          branchId: input.branchId,
          direction: input.dir,
          status: input.status,
          cursor: input.cursor,
          limit: input.limit,
          q: input.q,
          fromDate: input.fromDate,
          toDate: input.toDate,
        });
      }
      return listStockTransfers({
        actor,
        branchId: input.branchId,
        direction: input.dir,
        status: input.status,
        cursor: input.cursor,
        limit: input.limit,
      });
    }),

  /** تفاصيل سند بأسطره — بنفس نطاق عزل القائمة (السند يخصّ أحد فرعَي المستخدم غير المرفوع). */
  transferGet: inventoryReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getStockTransfer(input.id, {
        userId: ctx.user.id,
        role: ctx.user.role,
        branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
      })
    ),

  /** عدد الوارد «بالطريق» — شارة بانتظار الاستلام في شاشة التحويلات. */
  transfersPendingIncoming: inventoryReadProcedure
    .input(z.object({ branchId: z.number().int().positive().nullish() }).optional())
    .query(({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨ يُلغي سماح ٢٣/٧): المالك/الأدمن فقط
      const own = ctx.user.branchId == null ? null : Number(ctx.user.branchId);
      const scope = elevated ? (input?.branchId ?? null) : own;
      if (!elevated && scope == null) return 0;
      return pendingIncomingCount(scope);
    }),

  /**
   * استلام سند «بالطريق» في الفرع الوجهة بمطابقة فعلية: كمية مستلَمة لكل سطر (0..المرسَل)
   * وملاحظة إلزامية عند الفرق. يُقفل السند نهائياً (RECEIVED) والعجز يبقى موثَّقاً عليه.
   */
  transferReceive: inventoryWarehouseProcedure
    .input(
      z.object({
        transferId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              lineId: z.number().int().positive(),
              quantityReceived: z.number().int().min(0),
              note: z.string().max(255).optional(),
            })
          )
          .min(1)
          .max(200),
        receiveNotes: z.string().max(500).optional(),
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await retryOnDup(() =>
        withTx((tx) =>
          receiveStockTransfer(tx, {
            ...input,
            actor: { userId: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId) },
          }),
        ),
      );
      if (!res.idempotentReplay) {
        await logAudit(ctx, {
          action: "inventory.transferReceive",
          entityType: "transfer",
          entityId: input.transferId,
          newValue: { lines: input.lines, discrepancyUnits: res.discrepancyUnits, receiveNotes: input.receiveNotes ?? null },
        });
      }
      return res;
    }),

  /** إلغاء سند «بالطريق» (المرسل تراجع) — يعيد الكمية كاملة لرصيد المصدر. */
  transferCancel: inventoryWarehouseProcedure
    .input(z.object({ transferId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await withTx((tx) =>
        cancelStockTransfer(tx, {
          transferId: input.transferId,
          actor: { userId: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId) },
        }),
      );
      await logAudit(ctx, {
        action: "inventory.transferCancel",
        entityType: "transfer",
        entityId: input.transferId,
        newValue: { transferNumber: res.transferNumber },
      });
      return res;
    }),

  // فصل مهام #٦ (الشريحة ٢، قرار المالك ١٨/٧): التسوية المباشرة عملية حسّاسة ⇒ لم تعُد تُطبَّق فوراً؛
  // تُنشئ **طلباً معلَّقاً** (بلا تغيير مخزون) يعتمده مديرٌ آخر عبر approveAdjustment (SOD-04).
  adjust: inventoryWarehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        targetQuantity: z.number().int().min(0),
        notes: z.string().optional(),
        // سببُ التسوية (P2-#3، ٢٥/٨) — اختياريٌّ للتوافق الخلفيّ مع مستدعياتٍ قديمة، لكنّ الشاشات
        // الجديدة تُلزمه. الأسبابُ الحسّاسة (DAMAGE/LOSS/THEFT) تُلزم `attachmentUrl`.
        reason: z.enum(ADJUSTMENT_REASONS).optional(),
        // مرفق إثبات بصريّ (data URL لصورة). التحقّق من الصيغة/الحجم على مستوى الخدمة.
        attachmentUrl: z.string().max(8 * 1024 * 1024).optional(),
        // مفتاح تكرار من الشاشة (P2-#1): إعادةُ الإرسال بنفس المفتاح والحمولة تُرجع الطلب الأوّل بلا
        // إنشاءِ ثانٍ (يمنع الاعتمادَ المضاعف الناتج عن نقرٍ مضاعف أو انقطاعِ شبكة).
        clientRequestId: z.string().min(8).max(128).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: warehouse يُجبَر على فرعه — يمنع طلب تسوية فرع آخر عبر API مباشر.
      const elevated = ctx.user.role === "admin"; // «كتابة فرعه»: المدير لم يعُد عابر الفروع كتابةً (قرار المالك ٢٣/٧)
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        branchId = Number(ctx.user.branchId);
      }
      const res = await requestStockAdjustment(
        {
          variantId: input.variantId,
          branchId,
          targetQuantity: input.targetQuantity,
          notes: input.notes,
          reason: input.reason ?? null,
          attachmentUrl: input.attachmentUrl ?? null,
          clientRequestId: input.clientRequestId ?? null,
        },
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
      );
      if (res.idempotentReplay) {
        // إعادةُ إرسالٍ لطلبٍ قائم — لا سجلَّ تدقيقٍ ولا إشعارَ اعتمادٍ ثانياً.
        return { requestId: res.requestId, status: "PENDING_APPROVAL" as const, idempotentReplay: true as const };
      }
      await logAudit(ctx, { action: "inventory.adjustRequest", entityType: "stockAdjustmentRequest", entityId: res.requestId, newValue: { variantId: input.variantId, branchId, target: input.targetQuantity } });
      const db = getDb();
      if (db) {
        const candidates = await db
          .select({ id: users.id, role: users.role, permissionsOverride: users.permissionsOverride })
          .from(users)
          .where(and(eq(users.isActive, true), or(eq(users.role, "admin"), and(eq(users.role, "manager"), eq(users.branchId, branchId)))));
        await Promise.all(candidates.filter((user) =>
          user.id !== ctx.user.id &&
          resolvePermissions(user.role as RoleKey, (user.permissionsOverride ?? null) as Record<string, AccessLevel> | null).inventory === "FULL"
        ).map((user) => createAppNotification({
          userId: user.id,
          kind: "APPROVAL_REQUIRED",
          title: "تسوية مخزون بانتظار قرار",
          body: `طلب #${res.requestId} · الفرع ${branchId}`,
          route: "/mobile#approvals",
          eventKey: `stock-adjustment:${res.requestId}:approval:${user.id}`,
          entityType: "stockAdjustmentRequest",
          entityId: res.requestId,
          requiresAction: true,
        }).catch(() => undefined)));
      }
      return { requestId: res.requestId, status: "PENDING_APPROVAL" as const };
    }),

  // اعتماد طلب تسوية معلَّق — مديرٌ آخر (SOD-04) ⇒ يطبّق setStock + قيد ADJUST.
  approveAdjustment: inventoryManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await approveStockAdjustment(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "inventory.adjustApprove", entityType: "stockAdjustmentRequest", entityId: input.id, newValue: { movementId: res.movementId, delta: res.delta } });
      const db = getDb();
      const [request] = db
        ? await db.select({ createdBy: stockAdjustmentRequests.createdBy }).from(stockAdjustmentRequests).where(eq(stockAdjustmentRequests.id, input.id)).limit(1)
        : [];
      if (request?.createdBy) {
        await createAppNotification({
          userId: request.createdBy,
          kind: "APPROVAL_REQUIRED",
          title: "تم اعتماد تسوية المخزون",
          body: `الطلب #${input.id}`,
          route: "/inventory",
          eventKey: `stock-adjustment:${input.id}:approved`,
          entityType: "stockAdjustmentRequest",
          entityId: input.id,
          push: false,
        }).catch(() => undefined);
      }
      return res;
    }),

  rejectAdjustment: inventoryManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      await rejectStockAdjustment(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role }, input.reason);
      await logAudit(ctx, { action: "inventory.adjustReject", entityType: "stockAdjustmentRequest", entityId: input.id, newValue: { reason: input.reason } });
      const db = getDb();
      const [request] = db
        ? await db.select({ createdBy: stockAdjustmentRequests.createdBy }).from(stockAdjustmentRequests).where(eq(stockAdjustmentRequests.id, input.id)).limit(1)
        : [];
      if (request?.createdBy) {
        await createAppNotification({
          userId: request.createdBy,
          kind: "APPROVAL_REQUIRED",
          title: "تم تحديث طلب تسوية المخزون",
          body: `الطلب #${input.id}`,
          route: "/inventory",
          eventKey: `stock-adjustment:${input.id}:rejected`,
          entityType: "stockAdjustmentRequest",
          entityId: input.id,
          push: false,
        }).catch(() => undefined);
      }
      return { ok: true };
    }),

  // قائمة طلبات التسوية (المعلَّقة افتراضياً) — معزولةٌ بالفرع (admin يرى الكل).
  /* ── إعادة تقييم تكلفة المخزون (حوكمة التكلفة — تدقيق ٢٧/٧ H3/H4/H5) ─────────────────
   * التعديل اليدويّ لتكلفة صنفٍ **له رصيد** مُغلقٌ بنيوياً (`services/costRevaluation.ts`) لأنّه
   * يحرّك أصل المخزون بلا قيدٍ مقابل. هذا هو المسار المحكوم البديل: طلبٌ معلَّق بغرضٍ محاسبيّ
   * وسببٍ مكتوب، يعتمده مديرٌ ثانٍ فيُرحَّل قيد ADJUST لكل فرعٍ له رصيد — ومنه يسري حارس الفترة.
   */
  requestCostRevaluation: inventoryManagerProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        newCost: nonNegMoneyString,
        purpose: z.enum(["CORRECTION", "IMPAIRMENT"]),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await requestCostRevaluation(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "inventory.costRevaluationRequest",
        entityType: "costRevaluationRequest",
        entityId: res.requestId,
        newValue: {
          variantId: input.variantId,
          oldCost: res.oldCost,
          newCost: res.newCost,
          purpose: input.purpose,
          expectedValueDelta: res.expectedValueDelta,
        },
      });
      // إشعار المُعتمِدين المؤهَّلين (مرآة طلب التسوية): طلبٌ لا يراه أحدٌ = تكلفةٌ خاطئة تبقى
      // في الميزانية إلى الأبد. المُنشئ مستثنى (لا يعتمد طلبه)، والفلترة بالصلاحية الفعلية.
      const db = getDb();
      if (db) {
        const branchId = Number(ctx.user.branchId ?? 1);
        const candidates = await db
          .select({ id: users.id, role: users.role, permissionsOverride: users.permissionsOverride })
          .from(users)
          .where(and(eq(users.isActive, true), or(eq(users.role, "admin"), and(eq(users.role, "manager"), eq(users.branchId, branchId)))));
        await Promise.all(candidates.filter((user) =>
          user.id !== ctx.user.id &&
          resolvePermissions(user.role as RoleKey, (user.permissionsOverride ?? null) as Record<string, AccessLevel> | null).inventory === "FULL"
        ).map((user) => createAppNotification({
          userId: user.id,
          kind: "APPROVAL_REQUIRED",
          title: "إعادة تقييم تكلفة بانتظار قرار",
          body: `طلب #${res.requestId} · ${res.oldCost} ← ${res.newCost} · أثر ${res.expectedValueDelta}`,
          route: "/inventory",
          eventKey: `cost-revaluation:${res.requestId}:approval:${user.id}`,
          entityType: "costRevaluationRequest",
          entityId: res.requestId,
          requiresAction: true,
        }).catch(() => undefined)));
      }
      return { ...res, status: "PENDING_APPROVAL" as const };
    }),

  approveCostRevaluation: inventoryManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await approveCostRevaluation(input.id, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "inventory.costRevaluationApprove",
        entityType: "costRevaluationRequest",
        entityId: input.id,
        newValue: { newCost: res.newCost, postedEntries: res.postedEntries, totalValueDelta: res.totalValueDelta },
      });
      return res;
    }),

  rejectCostRevaluation: inventoryManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      await rejectCostRevaluation(
        input.id,
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
        input.reason,
      );
      await logAudit(ctx, {
        action: "inventory.costRevaluationReject",
        entityType: "costRevaluationRequest",
        entityId: input.id,
        newValue: { reason: input.reason },
      });
      return { ok: true };
    }),

  /** سجلّ إعادة التقييم — نطاق القراءة = نطاق الاعتماد (نمط pendingAdjustments). */
  costRevaluations: inventoryReadProcedure
    .input(
      z
        .object({ status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]).optional() })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد — لا يمكن عرض طلبات إعادة التقييم" });
      }
      const branchId = ctx.user.role === "admin" ? null : Number(ctx.user.branchId);
      return listCostRevaluations(
        { branchId, status: input?.status ?? "PENDING_APPROVAL" },
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
      );
    }),

  /** حالة الصنف قبل الطلب: التكلفة الحالية وكميّاته لكل فرع ⇒ أثر القيمة يُعرَض قبل الإرسال. */
  costRevaluationPreview: inventoryReadProcedure
    .input(z.object({ variantId: z.number().int().positive() }))
    .query(async ({ input, ctx }) =>
      getCostRevaluationPreview(input.variantId, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      })
    ),

  pendingAdjustments: inventoryReadProcedure
    .input(z.object({ status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]).optional() }).optional())
    .query(async ({ input, ctx }) => {
      // S3 (مراجعة عدائية): غير الأدمن بلا فرع مُسنَد كان يقرأ طلبات كل الفروع (branchId=null) — تسريب.
      // نطاق القراءة يساوي نطاق الاعتماد: admin=الكل، وإلّا فرعه، وبلا فرع ⇒ FORBIDDEN (نمط reorderAlerts).
      if (ctx.user.role !== "admin" && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد — لا يمكن عرض طلبات التسوية" });
      }
      const branchId = ctx.user.role === "admin" ? null : Number(ctx.user.branchId);
      return listStockAdjustmentRequests({ branchId, status: input?.status ?? "PENDING_APPROVAL" });
    }),

  /**
   * قراءةُ مرفق الإثبات لطلبِ تسوية (P2-#3، ٢٥/٨) — يُعاد data URL كاملاً لعرض الصورة في الشاشة.
   * منفصلٌ عن `pendingAdjustments` كي لا نغرق القائمة بحمولاتٍ ضخمة. عزلُ الفرع: نُعيد فحصاً على
   * الطلب نفسه (`branchId` عمود قائم) — غير admin لا يقرأ مرفقَ فرعٍ آخر.
   */
  adjustmentAttachment: inventoryReadProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
      const [row] = await db
        .select({ branchId: stockAdjustmentRequests.branchId })
        .from(stockAdjustmentRequests)
        .where(eq(stockAdjustmentRequests.id, input.id))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "طلب التسوية غير موجود" });
      if (ctx.user.role !== "admin" && ctx.user.branchId != null && Number(row.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة مرفق فرعٍ آخر" });
      }
      return readAdjustmentAttachment(input.id);
    }),

  /**
   * الأرصدة الحالية لكل متغيّر في فرع، بالأسماء + علم «تحت الحد الأدنى».
   * عزل الفرع: الكاشير/المخزن يُقيَّدان بفرعهما؛ المدير/الأدمن يختاران (افتراضي فرعهما).
   * لا تُعاد التكلفة (لا تسريب هامش الربح).
   *
   * ⛔ **بلاغ المالك ٢٤/٨ + سبب الاستبدال البنيويّ (لا `?? 1` على الرصيد):**
   * كان هذا الاستعلام يبدأ من `branchStock` بـINNER JOIN ⇒ يُخفي كل متغيّرٍ لم يُلامَس بحركةٍ
   * في الفرع (لا صفَّ له). لكن `listStockByUnitIds` في الكاشير يبدأ من الكتالوج بـLEFT JOIN
   * فيعرضه «مخزون 0» — وشاشة تسوية المخزون في Inventory.tsx تستعمل هذا الاستعلام ⇒ لم يكن
   * المدير يستطيع أن يفتح تسويةً على المنتج الذي يشتكيه المالك (مثال: «ظرف ابيض 110×220
   * COLDEN 8S8643P-AA1»). الفئة نفسها أوّل من كشفها إصلاحُ منتقي MANUAL بالجرد قبل ساعات
   * (#763)، وبقيَ هذا الأخ عالقاً — الدرس في [[sweep-siblings-when-fixing-shared-concept-drift]].
   *
   * الإصلاح: بدء من كتالوج `productVariants` + INNER JOIN products + **LEFT JOIN branchStock**
   * (شرط الفرع في `ON` لا `WHERE` كي لا يُقلَب إلى INNER). المتغيّر بلا صفٍّ يظهر بـ`quantity=0`
   * (COALESCE في الإسقاط).
   *
   * **قاعدة الرؤية = اتّحاد** (مراجعة Codex — ثلاث ملاحظات P2 على الإصدار الأوّل من هذا الإصلاح):
   *   (١) أيّ صفٍّ حقيقيّ في `branchStock` يبقى ظاهراً بلا استثناء — حتى لو صار المنتج/المتغيّر
   *       غير نشط، أو تحوّل النوع إلى خدمة/بكج لاحقاً. هذا التزامٌ عكسيٌّ بالسلوك السابق: قبل
   *       الإصلاح كانت الأرصدة تظهر دائماً؛ لا يجوز إخفاؤها بمنطقٍ جديد وإلّا فقد المدير قدرة
   *       التسوية على صنفٍ مُعطَّل يحمل رصيداً فعلياً.
   *   (٢) **زائداً** كتالوجٌ نشطٌ قابلٌ للجرد (متغيّر + منتج نشطان، غير خدميّ، غير بكج) حتى بلا
   *       صفّ رصيد — بـ`quantity=0` — لتُغلَق ثغرة البلاغ. الخدمة والبكج لا يُضافان زوراً كصفٍّ
   *       صفريّ لأنّ `inventory.adjust` يرفضهما (فيفشل الزرّ المعروض)؛ ويأتيان فقط إن كان لهما
   *       صفّ رصيدٍ حقيقيّ (شرط ١).
   * `lowOnly` و`negativeOnly` يبقيان **صارمَي دلالة** بمقارنة `branchStock.quantity` الخام
   * (NULL ⇒ يسقط) — لا فيضان بصفريّات كتالوجيّة. و`isLow` في الإسقاط يشترط وجود الصفّ (`hasStockRow`)
   * كي يتطابق مع فلتر `lowOnly` (كلاهما دلالياً «تحت الحدّ لصنفٍ له رصيدٌ فعليّ»).
   */
  onHand: inventoryReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          q: z.string().optional(),
          lowOnly: z.boolean().default(false),
          negativeOnly: z.boolean().default(false),
          // فلترة بالفئة (نمط catalog.adminList): رقم = فئة محدّدة، 0 = «بلا فئة» (categoryId NULL)، غياب = الكل.
          categoryId: z.number().int().min(0).optional(),
          limit: z.number().int().positive().max(1000).default(300),
          // ترقيم offset — الشكل المُعاد يبقى مصفوفةً صرفة (توافق عكسي: StocktakeNew واختبارات onHand
          // تعتمد المصفوفة). صفحة مكتملة (rows.length === limit) = مؤشّر «هناك المزيد» للعميل —
          // نفس تقريب paginateKeyset في وضع offset، بلا COUNT ثانٍ كامل.
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      // «قراءة الكل» (قرار المالك ٢٣/٧): المدير يقرأ مخزون أيّ فرع (إشراف) — scopedBranchId=null له فيمرّ
      // input.branchId؛ الأدمن كذلك. الكاشير/المخزن مُجبَران على فرعهما عبر scopedBranchId. (الكتابة تبقى على الفرع.)
      const branchId = ctx.scopedBranchId ?? input?.branchId ?? ctx.user.branchId ?? 1;

      // ملاحظة (٢٤/٨): كان هنا `eq(branchStock.branchId, branchId)` في WHERE ⇒ عاد INNER
      // ضمنياً حتى بعد LEFT JOIN. شرط الفرع صار في `ON` أدناه.
      //
      // قاعدة الرؤية = اتّحاد (انظر الشرح أعلى): أيّ صفّ branchStock قائم يظهر (شرط ١، للمحافظة
      // على أرصدة المنتجات المُعطَّلة/المُحوَّلة)، **أو** كتالوجٌ نشطٌ قابلٌ للجرد (شرط ٢). بدون
      // OR هذا كانت مراجعة Codex محقّة: (أ) الخدمة/البكج تظهر زوراً كصفر ⇒ الزرّ يفشل، (ب) الصنف
      // المُعطَّل ذو الرصيد يختفي ⇒ لا سبيل لتسوية رصيدٍ حقيقيّ من هذه الشاشة.
      const conds: any[] = [
        sql`(${branchStock.variantId} IS NOT NULL OR (${productVariants.isActive} = true AND ${products.isActive} = true AND ${products.isService} = false AND ${products.isBundle} = false))`,
      ];
      const search = input?.q?.trim();
      if (search) {
        const pat = `%${escLike(search)}%`;
        conds.push(
          sql`(${products.name} LIKE ${pat} ESCAPE '!' OR ${productVariants.sku} LIKE ${pat} ESCAPE '!' OR ${productVariants.variantName} LIKE ${pat} ESCAPE '!')`
        );
      }
      // «تحت الحدّ» و«سالب فقط»: مقارنةٌ على الحقل الخام دون COALESCE — المتغيّر بلا صفٍّ
      // (quantity = NULL) لا يُصنّف «تحت الحدّ» ولا «سالباً»، فلا يُفيض هذان الفلتران بمنتجاتٍ
      // كتالوجيّة صفريّة. من يريد رؤيتها يفتح القائمة بلا فلتر «تحت الحدّ».
      // ⭐ P1-#4 (٢٥/٨): «الحدّ» = العتبةُ الفعّالة (override الفرعيّ أو الافتراض العام) عبر
      // effectiveMinStockSql — نفسُ ما يُظهره العمود أدناه. المقارنةُ على `> 0 AND <= X` تبقى
      // على الحقل الخام: صفرٌ (لا حدّ محدَّد) لا يُعدّ تحت الحدّ ولو كان الرصيد صفراً.
      if (input?.lowOnly) {
        const effMin = effectiveMinStockSql();
        conds.push(sql`${effMin} > 0 AND ${branchStock.quantity} <= ${effMin}`);
      }
      // «وضع الافتتاح» (١٨/٧): السوالب فقط — كميات بلا تكلفة (أمين المخزن يقود بها العدّ الافتتاحي؛
      // تقرير الانكشاف بالقيمة خلف بوّابة التقارير الحمراء reports.negativeStock).
      if (input?.negativeOnly) {
        conds.push(sql`${branchStock.quantity} < 0`);
      }
      if (input?.categoryId != null) {
        conds.push(input.categoryId === 0 ? isNull(products.categoryId) : eq(products.categoryId, input.categoryId));
      }

      const rows = await db
        .select({
          variantId: productVariants.id,
          quantity: branchStock.quantity,
          sku: productVariants.sku,
          variantName: productVariants.variantName,
          color: productVariants.color,
          size: productVariants.size,
          // العتبةُ الفعّالة (override الفرعيّ أو الافتراض العام) — نفسُ منطق فلتر lowOnly أعلاه.
          minStock: effectiveMinStockSql(),
          reorderPoint: effectiveReorderPointSql(),
          productName: products.name,
          // آخر جرد معتمد شمل الصنف — يبني الثقة بالأرقام ويغذّي الجرد الدوري ABC.
          lastCountedAt: branchStock.lastCountedAt,
          // شارةُ «مخصّص لهذا الفرع» في الشاشة — تُميّز العتبةَ الموروثة عن المخصَّصة.
          hasBranchOverride: sql<number>`CASE WHEN ${variantBranchThresholds.id} IS NOT NULL THEN 1 ELSE 0 END`,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        // شرط الفرع في ON — وضعُه في WHERE يُلغي معنى LEFT (يُسقط الصفوف NULL).
        .leftJoin(
          branchStock,
          and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)),
        )
        // override الفرعيّ إن وُجد — نفس شرط الاتّحاد في ON (وضعُه في WHERE يُلغي معنى LEFT).
        .leftJoin(
          variantBranchThresholds,
          and(
            eq(variantBranchThresholds.variantId, productVariants.id),
            eq(variantBranchThresholds.branchId, branchId),
          ),
        )
        .where(and(...conds))
        .orderBy(asc(products.name), asc(productVariants.sku))
        .limit(input?.limit ?? 300)
        .offset(input?.offset ?? 0);

      return rows.map((r) => {
        // hasStockRow = صفٌّ فعليّ في branchStock (LEFT JOIN التقط الرصيد). المتغيّرات
        // الكتالوجيّة الصفريّة (لا صفَّ) تخرج بـ`quantity = 0` لكنّ isLow=false — كي يتطابق
        // مع فلتر lowOnly (الذي يقارن الحقل الخام NULL فيسقطها). دلالياً: «تحت الحدّ» تُطبَّق
        // على صنفٍ **له رصيدٌ فعليّ** لا على كتالوجٍ لم يُلامَس بعد (مراجعة Codex P2 لتطابق الفلتر والشارة).
        const hasStockRow = r.quantity != null;
        const quantity = Number(r.quantity ?? 0);
        const minStock = r.minStock == null ? null : Number(r.minStock);
        return {
          variantId: Number(r.variantId),
          branchId,
          quantity,
          sku: r.sku,
          variantName: r.variantName,
          hasBranchOverride: Number(r.hasBranchOverride) === 1,
          color: r.color,
          size: r.size,
          minStock,
          reorderPoint: r.reorderPoint == null ? null : Number(r.reorderPoint),
          productName: r.productName,
          lastCountedAt: r.lastCountedAt ?? null,
          isLow: hasStockRow && (minStock ?? 0) > 0 && quantity <= (minStock ?? 0),
        };
      });
    }),

  stockByBranch: inventoryReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        // ترقيم اختياري لتقييد الحجم عند الفروع الكبيرة. غير مُمرَّر ⇒ بلا حدّ (السلوك السابق محفوظ،
        // فلا قطع صامت). الترتيب الثابت أدناه يجعل limit/offset حتمياً متى استُعملا.
        limit: z.number().int().positive().max(5000).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      // «قراءة الكل» (قرار المالك ٢٣/٧): المدير يقرأ مخزون أيّ فرع (إشراف) — scopedBranchId=null له فيمرّ input.branchId.
      const branchId = ctx.scopedBranchId ?? input.branchId;
      const q = db
        .select()
        .from(branchStock)
        .where(eq(branchStock.branchId, branchId))
        .orderBy(asc(branchStock.variantId));
      if (input.limit != null) return q.limit(input.limit).offset(input.offset ?? 0);
      return q;
    }),

  movements: inventoryReadProcedure
    .input(z.object({ variantId: z.number().int().positive().optional(), branchId: z.number().int().positive().optional(), limit: z.number().int().positive().max(500).default(100) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      // «قراءة الكل» (قرار المالك ٢٣/٧): المدير يقرأ حركات أيّ فرع (إشراف) — الافتراضيّ فرعه عند غياب branchId (أدناه).
      // عزل المدير (تدقيق ١٧/٧): scopedBranchId=null للمدير ⇒ عند غياب input.branchId كان يمسح حركات
      // كل الفروع. الافتراضي فرعه المُسنَد (لا سقوط إلى null)؛ admin وحده يرى الكل بلا فرع صريح.
      const branchId =
        ctx.scopedBranchId ??
        input.branchId ??
        (ctx.user.role === "manager" ? Number(ctx.user.branchId) : undefined);
      if (input.variantId) conds.push(eq(inventoryMovements.variantId, input.variantId));
      if (branchId) conds.push(eq(inventoryMovements.branchId, branchId));
      const q = db.select().from(inventoryMovements);
      return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(inventoryMovements.id)).limit(input.limit);
    }),

  /**
   * حركات المخزون الغنيّة بالأسماء (Manager/Warehouse/Cashier) — لشاشة عرض الحركات.
   * فلاتر: نوع، فرع (مع عزل صارم لغير المدير)، متغيّر، بحث نصّي، نطاق تاريخ، نوع المرجع.
   * يُعيد إجمالي الصفوف للترقيم.
   */
  movementsRich: inventoryReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          movementType: z.enum(MOVEMENT_TYPES).optional(),
          variantId: z.number().int().positive().optional(),
          q: z.string().optional(),
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          referenceType: z.string().max(24).optional(),
          // فلتر منشئ الحركة — مطابقة جزئية على اسم المستخدم (لا معرّفاً رقمياً: users.list
          // adminProcedure حصراً، وهذه الشاشة يفتحها مخزن/كاشير أيضاً فلا يصحّ الاعتماد عليه).
          createdByName: z.string().max(120).optional(),
          limit: z.number().int().positive().max(500).default(200),
          offset: z.number().int().min(0).default(0),
          // S3 (٣٠/٦): cursor (id) اختياري لـkeyset — يُتجاوز COUNT الكامل عند تمريره.
          cursor: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0, hasMore: false, nextCursor: null as number | null };
      const i = input ?? { limit: 200, offset: 0 };

      // «قراءة الكل» (قرار المالك ٢٣/٧): المدير يقرأ حركات أيّ فرع (إشراف) — scopedBranchId=null له فيمرّ i.branchId (null=الكل).
      const branchFilter = ctx.scopedBranchId ?? i.branchId ?? null;

      const conds: any[] = [];
      if (branchFilter != null) conds.push(eq(inventoryMovements.branchId, branchFilter));
      if (i.movementType) conds.push(eq(inventoryMovements.movementType, i.movementType));
      if (i.variantId) conds.push(eq(inventoryMovements.variantId, i.variantId));
      if (i.referenceType) conds.push(eq(inventoryMovements.referenceType, i.referenceType));
      const createdByName = i.createdByName?.trim();
      if (createdByName) {
        const pat = `%${escLike(createdByName)}%`;
        conds.push(sql`${users.name} LIKE ${pat} ESCAPE '!'`);
      }
      const search = i.q?.trim();
      if (search) {
        const pat = `%${escLike(search)}%`;
        conds.push(
          sql`(${products.name} LIKE ${pat} ESCAPE '!' OR ${productVariants.sku} LIKE ${pat} ESCAPE '!' OR ${productVariants.variantName} LIKE ${pat} ESCAPE '!')`
        );
      }
      if (i.fromDate) {
        const from = new Date(i.fromDate);
        if (!isNaN(from.getTime())) conds.push(gte(inventoryMovements.createdAt, from));
      }
      if (i.toDate) {
        // شامل لليوم: < بداية اليوم التالي بـUTC. البناء بـDate.UTC حتميّ ومستقلّ عن منطقة عملية
        // Node (تدقيق ١٧/٧، مخاطرة جهازية #٧) — كان setDate/setHours المحليّان يَنزاحان على أي جهاز بغير TZ=UTC.
        const to = new Date(i.toDate);
        if (!isNaN(to.getTime())) {
          const next = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
          conds.push(lt(inventoryMovements.createdAt, next));
        }
      }

      // alias من mysql-core للفرع المرتبط (TRANSFER) — يحفظ استدلال النوع لـ Drizzle.
      const relatedBranches = alias(branches, "rb");

      // /simplify ٣٠/٦: paginateKeyset + countIfOffset يَستبدلان ~٣٠ سطر مَنطق مُكرَّر.
      // variantId/branchId NOT NULL على inventoryMovements (FK) ⇒ INNER JOIN آمن وأدقّ نوعاً.
      const { rows, hasMore, nextCursor, usingCursor } = await paginateKeyset({
        cursor: i.cursor,
        limit: i.limit,
        offset: i.offset,
        defaultLimit: 200,
        idCol: inventoryMovements.id,
        baseConds: conds,
        runQuery: (where, lim, off) => db
          .select({
            id: inventoryMovements.id,
            createdAt: inventoryMovements.createdAt,
            movementType: inventoryMovements.movementType,
            quantity: inventoryMovements.quantity,
            variantId: inventoryMovements.variantId,
            productName: products.name,
            variantName: productVariants.variantName,
            color: productVariants.color,
            size: productVariants.size,
            sku: productVariants.sku,
            branchId: inventoryMovements.branchId,
            branchName: branches.name,
            relatedBranchId: inventoryMovements.relatedBranchId,
            relatedBranchName: relatedBranches.name,
            referenceType: inventoryMovements.referenceType,
            referenceId: inventoryMovements.referenceId,
            notes: inventoryMovements.notes,
            createdBy: inventoryMovements.createdBy,
            createdByName: users.name,
          })
          .from(inventoryMovements)
          .innerJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
          .innerJoin(products, eq(products.id, productVariants.productId))
          .innerJoin(branches, eq(branches.id, inventoryMovements.branchId))
          .leftJoin(relatedBranches, eq(relatedBranches.id, inventoryMovements.relatedBranchId))
          .leftJoin(users, eq(users.id, inventoryMovements.createdBy))
          .where(where ?? sql`1=1`)
          .orderBy(desc(inventoryMovements.id))
          .limit(lim)
          .offset(off),
      });

      // COUNT الكامل (مَسحٌ ثانٍ) يَتدهور خطّياً عند الملايين ⇒ نَتجاوزه عند keyset.
      const total = await countIfOffset(usingCursor, async () => {
        const baseWhere = conds.length ? and(...conds) : sql`1=1`;
        const countRows = await db
          .select({ c: sql<number>`count(*)` })
          .from(inventoryMovements)
          .innerJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
          .innerJoin(products, eq(products.id, productVariants.productId))
          .innerJoin(branches, eq(branches.id, inventoryMovements.branchId))
          // leftJoin مطلوب فقط لأن createdByName قد يُصفّي على users.name (أعلاه) — بلا أثر إن غاب.
          .leftJoin(users, eq(users.id, inventoryMovements.createdBy))
          .where(baseWhere);
        return Number(countRows[0]?.c ?? 0);
      });

      return {
        rows: rows.map((r) => ({
          ...r,
          variantId: Number(r.variantId),
          branchId: Number(r.branchId),
          relatedBranchId: r.relatedBranchId == null ? null : Number(r.relatedBranchId),
          referenceId: r.referenceId == null ? null : Number(r.referenceId),
          createdBy: r.createdBy == null ? null : Number(r.createdBy),
          // تدقيق ١١/٨ (S2): الكمية الموقَّعة من مصدر الحقيقة الخادميّ (signedMoveQty — نفس الكاردكس/الجرد)،
          // تشمل اتجاه ADJUST المستنبَط من علامة «(فرق ±D)» في notes. للعرض/الطباعة/التصدير الموقَّع بلا تخمينٍ عميليّ.
          signedQty: signedMoveQty(r.movementType, r.quantity, r.notes),
        })),
        total,
        hasMore,
        nextCursor,
      };
    }),

  /**
   * تنبيهات إعادة الطلب: كل (متغيّر × فرع) رصيده ≤ حدّ الطلب (reorderPoint > 0) — الأشدّ نقصاً أولاً.
   * عزل الفرع: الكاشير/المخزن مُجبَران بفرعهما (scopedBranchId)؛ المدير بفرعه (طلب فرع آخر = FORBIDDEN،
   * نمط onHand)؛ الأدمن يختار فرعاً أو يمرّر بلا فرع = كل الفروع.
   */
  reorderAlerts: inventoryReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().nullish(),
          limit: z.number().int().positive().max(500).default(200),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      // «قراءة الكل» (قرار المالك ٢٣/٧): المدير يقرأ تنبيهات أيّ فرع (إشراف) — يمرّ input.branchId؛ الافتراضيّ فرعه أدناه.
      // admin بلا فرع صريح ⇒ كل الفروع (null). غير الأدمن يسقط على فرعه (لا `?? 1` — نمط G3).
      const branchId =
        ctx.scopedBranchId ??
        input?.branchId ??
        (ctx.user.role === "admin" ? null : ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
      if (branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const limit = input?.limit ?? 200;
      const offset = input?.offset ?? 0;
      // العدد الكامل (بنفس نطاق الفرع) — يكشف الاقتطاع الصامت عند تجاوز limit بدل لافتة كاذبة
      // «كل شيء ظاهر» فيما يبقى النقص مخفياً (كان limit الافتراضي 200 يقتطع بصمت).
      const [rows, total] = await Promise.all([
        listReorderAlerts({ branchId, limit, offset }),
        countReorderAlerts({ branchId }),
      ]);
      return { rows, total, hasMore: offset + rows.length < total };
    }),

  /** تحديث عتبتَي الحد الأدنى/إعادة الطلب لمتغيّر — المدير/المخزن (التحقّق داخل الخدمة). */
  setReorderThresholds: inventoryWarehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        minStock: z.number().int().min(0),
        reorderPoint: z.number().int().min(0),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await setReorderThresholds(input);
      await logAudit(ctx, {
        action: "inventory.setReorderThresholds",
        entityType: "variant",
        entityId: input.variantId,
        newValue: { minStock: input.minStock, reorderPoint: input.reorderPoint },
      });
      return res;
    }),

  /**
   * override العتبات لفرعٍ بعينه (P1-#4، ٢٥/٨) — يحلّ محلّ الافتراض العامّ لهذا (المتغيّر × الفرع).
   * قرار المالك: كلّ فرعٍ يُغطّى بعتبته الخاصة عند الحاجة؛ الفرعُ سريع الدوران والبطيء لا يشتركان
   * تنبيهاً موحَّداً. النقلة تدريجية: الأعمدةُ العامّة على المتغيّر تبقى default، والـoverride اختياريّ.
   */
  setBranchThresholds: inventoryWarehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        // NULL في حقلٍ يعني ورث الافتراض العام لهذا الحقل بعينه (كلاهما NULL ⇒ إزالة الصفّ).
        minStock: z.number().int().min(0).nullable(),
        reorderPoint: z.number().int().min(0).nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: المدير لغير admin يُقصر التعديل على فرعه المُسنَد (نفس نمط adjust).
      const elevated = ctx.user.role === "admin" || Boolean((ctx.user as { isOwner?: boolean }).isOwner);
      if (!elevated) {
        if (ctx.user.branchId == null || Number(ctx.user.branchId) !== Number(input.branchId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن تعديل عتبات فرعٍ آخر" });
        }
      }
      const res = await setBranchThresholds(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: res.cleared ? "inventory.clearBranchThresholds" : "inventory.setBranchThresholds",
        entityType: "variant",
        entityId: input.variantId,
        newValue: { branchId: input.branchId, minStock: input.minStock, reorderPoint: input.reorderPoint, cleared: res.cleared },
      });
      return res;
    }),

  /** مسحُ override للفرع — يعيده إلى وراثة الافتراض العام. API صريح للشاشة. */
  clearBranchThresholds: inventoryWarehouseProcedure
    .input(z.object({ variantId: z.number().int().positive(), branchId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin" || Boolean((ctx.user as { isOwner?: boolean }).isOwner);
      if (!elevated) {
        if (ctx.user.branchId == null || Number(ctx.user.branchId) !== Number(input.branchId)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن حذف عتبات فرعٍ آخر" });
        }
      }
      const res = await clearBranchThresholds(input);
      await logAudit(ctx, {
        action: "inventory.clearBranchThresholds",
        entityType: "variant",
        entityId: input.variantId,
        newValue: { branchId: input.branchId },
      });
      return res;
    }),

  /** قائمةُ overrides الفرعيّة — للشاشة الإدارية. عزل الفرع لغير admin/isOwner. */
  listBranchThresholds: inventoryReadProcedure
    .input(z.object({ branchId: z.number().int().positive().nullish(), variantId: z.number().int().positive().nullish() }).optional())
    .query(async ({ input, ctx }) => {
      const branchId =
        ctx.scopedBranchId ??
        input?.branchId ??
        (ctx.user.role === "admin" ? null : ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
      if (branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      return listBranchThresholds({ branchId, variantId: input?.variantId ?? null });
    }),

  /**
   * مسودة أمر شراء (DRAFT) من تنبيهات إعادة الطلب — المدير/المخزن. يعيد استعمال
   * purchaseService.createPurchaseOrder كما هي (الترقيم/التحقّق/الذرّية هناك).
   * عزل الفرع: warehouse يُجبَر على فرعه؛ admin/manager يحترمان branchId المُرسَل (نمط adjust).
   */
  createReorderDraft: inventoryWarehouseProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              quantity: z.number().int().positive(),
            })
          )
          .min(1, "اختر صنفاً واحداً على الأقل")
          .max(200, "حدّ الأصناف في المسودة الواحدة 200"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // «كتابة فرعه»: المدير لم يعُد عابر الفروع كتابةً (قرار المالك ٢٣/٧)
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        branchId = Number(ctx.user.branchId);
      }
      const res = await createReorderDraft(
        { supplierId: input.supplierId, branchId, lines: input.lines },
        { userId: ctx.user.id, branchId },
      );
      await logAudit(ctx, {
        action: "inventory.createReorderDraft",
        entityType: "purchaseOrder",
        entityId: res.purchaseOrderId,
        newValue: { supplierId: input.supplierId, branchId, lines: input.lines },
      });
      return res;
    }),

  /**
   * خطة موسم المدارس: كل متغيّرٍ موسميّ (seasonTarget > 0) بمخزونه الكلّيّ عبر كل الفروع مقابل الهدف —
   * الأبعد عن الهدف أولاً، مع الفجوة (كمية الشراء المقترحة). أداة تجهيزٍ على مستوى العمل كلّه (لا عزل
   * فرعٍ — تُشترى الكمية دفعةً ثم تُوزَّع)، بلا تكلفة. المدير/المخزن (inventoryWarehouseProcedure).
   */
  seasonPlan: inventoryWarehouseProcedure
    .input(
      z
        .object({
          onlyBelowTarget: z.boolean().optional(),
          limit: z.number().int().positive().max(1000).default(300),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(({ input }) =>
      listSeasonPlan({ onlyBelowTarget: input?.onlyBelowTarget, limit: input?.limit, offset: input?.offset }),
    ),

  /** بحث المتغيّرات لإضافتها لخطة الموسم (يُعيد الهدف الحاليّ فيميّز المُضاف سلفاً) — المدير/المخزن. */
  seasonVariantSearch: inventoryWarehouseProcedure
    .input(z.object({ q: z.string().min(1).max(120), limit: z.number().int().positive().max(50).default(20) }))
    .query(({ input }) => searchSeasonCandidates(input.q, input.limit)),

  /** ضبط هدف موسم المدارس لمتغيّر (0 = يُزيله من الخطة) — المدير/المخزن (التحقّق داخل الخدمة). */
  setSeasonTarget: inventoryWarehouseProcedure
    .input(z.object({ variantId: z.number().int().positive(), seasonTarget: z.number().int().min(0) }))
    .mutation(async ({ input, ctx }) => {
      const res = await setSeasonTarget(input);
      await logAudit(ctx, {
        action: "inventory.setSeasonTarget",
        entityType: "variant",
        entityId: input.variantId,
        newValue: { seasonTarget: input.seasonTarget },
      });
      return res;
    }),

  /**
   * ملخّص تخطيط المخزون لمؤشّر رأس شاشة المخزون (استباقيّ): عدد صفوف إعادة الطلب (بنطاق فرع المستخدم —
   * admin=الكل، غير الأدمن بفرعه، وبلا فرع ⇒ 0 لا تسريب) + عدد الأصناف الموسمية تحت الهدف (مستوى العمل).
   */
  planningSummary: inventoryWarehouseProcedure.query(async ({ ctx }) => {
    let reorderCount = 0;
    if (ctx.user.role === "admin") {
      reorderCount = await countReorderAlerts({ branchId: null });
    } else if (ctx.user.branchId != null) {
      reorderCount = await countReorderAlerts({ branchId: Number(ctx.user.branchId) });
    }
    const seasonBelowTargetCount = await countSeasonBelowTarget();
    return { reorderCount, seasonBelowTargetCount };
  }),

  /**
   * عقد API قديم للحركات اليدوية. يبقى لاستقرار العملاء لكنه يفشل مغلقاً دائماً:
   * الزيادة تحتاج مستند شراء/مرتجع حقيقي، والتصحيح يمرّ بطلب تسوية ثنائي الاعتماد.
   */
  createManualMovement: inventoryWarehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        movementType: z.enum(["IN", "OUT", "RETURN"]),
        productUnitId: z.number().int().positive(),
        quantity: z.string().min(1),
        reason: z.enum(REASON_KEYS),
        notes: z.string().max(500).optional(),
        // idempotency (تدقيق ١٧/٧): إعادة إرسال شبكية تكرّر الخصم/الإضافة + قيد ADJUST — نمنعها بمفتاح.
        clientRequestId: z.string().min(1).max(64).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // لا زيادة ولا شطب بلا مصدر: كل التصحيحات تمرّ بمسار التسوية المعتمَد.
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "لا تُنشأ كمية مخزون يدوياً بلا مستند مصدر. الشراء والمرتجعات تُسجّل من شاشاتها، وأي تصحيح يمرّ بطلب «تسوية الرصيد» ويعتمده مسؤول آخر.",
      });
    }),
});

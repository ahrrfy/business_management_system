import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { alias } from "drizzle-orm/mysql-core";

// استخدام ! كحرف هروب بـ ESCAPE '!' — بديل آمن عن \ (لا يُصاب بـNO_BACKSLASH_ESCAPES MySQL mode).
const escLike = (s: string) => s.replace(/[!%_]/g, "!$&");
import { z } from "zod";
import { branches, branchStock, inventoryMovements, productVariants, products, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { applyMovement, convertToBaseQuantity } from "../services/inventoryService";
import {
  cancelStockTransfer,
  createStockTransfer,
  getStockTransfer,
  listStockTransfers,
  pendingIncomingCount,
  receiveStockTransfer,
} from "../services/transferService";
import { createReorderDraft, listReorderAlerts, setReorderThresholds } from "../services/inventory/reorder";
import {
  requestStockAdjustment,
  approveStockAdjustment,
  rejectStockAdjustment,
  listStockAdjustmentRequests,
} from "../services/inventory/adjustmentApproval";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../services/idempotency";
import { withTx } from "../services/tx";
import { postEntry } from "../services/ledgerService";
import { money } from "../services/money";
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
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
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
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
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
      })
    )
    .query(({ input, ctx }) =>
      listStockTransfers({
        actor: { userId: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId) },
        branchId: input.branchId,
        direction: input.dir,
        status: input.status,
        cursor: input.cursor,
        limit: input.limit,
      })
    ),

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
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: warehouse يُجبَر على فرعه — يمنع طلب تسوية فرع آخر عبر API مباشر.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        branchId = Number(ctx.user.branchId);
      }
      const res = await requestStockAdjustment(
        { variantId: input.variantId, branchId, targetQuantity: input.targetQuantity, notes: input.notes },
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
      );
      await logAudit(ctx, { action: "inventory.adjustRequest", entityType: "stockAdjustmentRequest", entityId: res.requestId, newValue: { variantId: input.variantId, branchId, target: input.targetQuantity } });
      return { requestId: res.requestId, status: "PENDING_APPROVAL" as const };
    }),

  // اعتماد طلب تسوية معلَّق — مديرٌ آخر (SOD-04) ⇒ يطبّق setStock + قيد ADJUST.
  approveAdjustment: inventoryManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await approveStockAdjustment(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "inventory.adjustApprove", entityType: "stockAdjustmentRequest", entityId: input.id, newValue: { movementId: res.movementId, delta: res.delta } });
      return res;
    }),

  rejectAdjustment: inventoryManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      await rejectStockAdjustment(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role }, input.reason);
      await logAudit(ctx, { action: "inventory.adjustReject", entityType: "stockAdjustmentRequest", entityId: input.id, newValue: { reason: input.reason } });
      return { ok: true };
    }),

  // قائمة طلبات التسوية (المعلَّقة افتراضياً) — معزولةٌ بالفرع (admin يرى الكل).
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
   * الأرصدة الحالية لكل متغيّر في فرع، بالأسماء + علم «تحت الحد الأدنى».
   * عزل الفرع: الكاشير/المخزن يُقيَّدان بفرعهما؛ المدير/الأدمن يختاران (افتراضي فرعهما).
   * لا تُعاد التكلفة (لا تسريب هامش الربح).
   */
  onHand: inventoryReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          q: z.string().optional(),
          lowOnly: z.boolean().default(false),
          limit: z.number().int().positive().max(1000).default(300),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      // عزل (تَدقيق ٢٣/٦/٢٦): مدير الفرع يُقيَّد بفرعه. الـadmin يَعبر.
      if (ctx.user.role === "manager" && input?.branchId != null && input.branchId !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة مخزون فرع آخر" });
      }
      const branchId = ctx.scopedBranchId ?? input?.branchId ?? ctx.user.branchId ?? 1;

      const conds: any[] = [eq(branchStock.branchId, branchId)];
      const search = input?.q?.trim();
      if (search) {
        const pat = `%${escLike(search)}%`;
        conds.push(
          sql`(${products.name} LIKE ${pat} ESCAPE '!' OR ${productVariants.sku} LIKE ${pat} ESCAPE '!' OR ${productVariants.variantName} LIKE ${pat} ESCAPE '!')`
        );
      }
      if (input?.lowOnly) {
        conds.push(sql`${productVariants.minStock} > 0 AND ${branchStock.quantity} <= ${productVariants.minStock}`);
      }

      const rows = await db
        .select({
          variantId: branchStock.variantId,
          branchId: branchStock.branchId,
          quantity: branchStock.quantity,
          sku: productVariants.sku,
          variantName: productVariants.variantName,
          color: productVariants.color,
          size: productVariants.size,
          minStock: productVariants.minStock,
          reorderPoint: productVariants.reorderPoint,
          productName: products.name,
          // آخر جرد معتمد شمل الصنف — يبني الثقة بالأرقام ويغذّي الجرد الدوري ABC.
          lastCountedAt: branchStock.lastCountedAt,
        })
        .from(branchStock)
        .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(...conds))
        .orderBy(asc(products.name), asc(productVariants.sku))
        .limit(input?.limit ?? 300);

      return rows.map((r) => ({
        ...r,
        isLow: (r.minStock ?? 0) > 0 && r.quantity <= (r.minStock ?? 0),
      }));
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
      // عزل (تَدقيق ٢٣/٦/٢٦): inventoryReadProcedure يُعامل المدير كـelevated (scope=null) ⇒
      // مدير ف١ كان يَقرأ مخزون ف٢ بلا حسيب. الـadmin يَبقى cross-branch (سلطة عليا)، والمدير
      // يُحَدّ في فرعه. الكاشير/المخزن مُجبَران سلفاً عبر scopedBranchId.
      if (ctx.user.role === "manager" && input.branchId !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة مخزون فرع آخر" });
      }
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
      // عزل (تَدقيق ٢٣/٦/٢٦): مدير الفرع يُقيَّد بفرعه على movements (كاردكس عبر-فرعي = تَسريب).
      if (ctx.user.role === "manager" && input.branchId != null && input.branchId !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة حركات فرع آخر" });
      }
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

      // عزل (تَدقيق ٢٣/٦/٢٦): مدير الفرع يُقيَّد بفرعه على movementsRich (كاردكس عبر-فرعي = تَسريب).
      if (ctx.user.role === "manager" && i.branchId != null && i.branchId !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة حركات فرع آخر" });
      }
      const branchFilter = ctx.scopedBranchId ?? i.branchId ?? null;

      const conds: any[] = [];
      if (branchFilter != null) conds.push(eq(inventoryMovements.branchId, branchFilter));
      if (i.movementType) conds.push(eq(inventoryMovements.movementType, i.movementType));
      if (i.variantId) conds.push(eq(inventoryMovements.variantId, i.variantId));
      if (i.referenceType) conds.push(eq(inventoryMovements.referenceType, i.referenceType));
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
      if (ctx.user.role === "manager" && input?.branchId != null && input.branchId !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة تنبيهات فرع آخر" });
      }
      // admin بلا فرع صريح ⇒ كل الفروع (null). غير الأدمن يسقط على فرعه (لا `?? 1` — نمط G3).
      const branchId =
        ctx.scopedBranchId ??
        input?.branchId ??
        (ctx.user.role === "admin" ? null : ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
      if (branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      return listReorderAlerts({ branchId, limit: input?.limit, offset: input?.offset });
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
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
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
   * إنشاء حركة مخزون يدوية (IN/OUT/RETURN) — أمين المخزن فأعلى.
   * مسموح فقط للأنواع غير الحوّلية والتسوية لها مسار منفصل (`inventory.adjust`).
   * - warehouse مُقيَّد بفرعه (أي branchId يُرسَل يُتجاهَل ويُستبدَل بفرع المستخدم).
   * - يحوّل الكمية إلى الوحدة الأساس ثم يُمرّرها لـ applyMovement داخل tx ذرّية.
   * - يكتب سطر تدقيق بعد النجاح (best-effort).
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
      // فصل مهام #٦ (مراجعة عدائية MF-1): الحركة المُنقِصة للمخزون (OUT/شطب: تلف/عيّنة/تصحيح…) عمليةٌ
      // حسّاسة قد تُخفي عجزاً/سرقة بفاعلٍ واحد — كانت باب تجاوزٍ للاعتماد الثنائيّ. تُوحَّد الآن في مسار
      // «تسوية الرصيد» المعتمَد (inventory.adjust ⇒ طلبٌ معلَّق يعتمده مديرٌ آخر). الإضافة (IN/RETURN) تبقى.
      if (input.movementType === "OUT") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "شطب المخزون يمرّ بطلب تسوية معتمَد (فصل مهام) — استعمل «تسوية الرصيد» من شاشة المخزون بالكمية المستهدفة، يعتمده مديرٌ آخر.",
        });
      }
      // عزل الفرع: warehouse يُجبَر على فرعه؛ admin/manager يحترمان branchId المُرسَل.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        branchId = Number(ctx.user.branchId);
      }

      const reasonLabel = REASON_LABELS[input.reason];
      const notesLine = input.notes && input.notes.trim().length > 0
        ? `${reasonLabel} — ${input.notes.trim()}`
        : reasonLabel;
      const referenceType = `MANUAL_${input.movementType}`; // ≤ 16 chars ⇒ آمن (الحدّ 24).

      const { result, baseQty, replayed } = await withTx(async (tx) => {
        // idempotency: إعادة إرسال بنفس المفتاح تعيد الحركة الأولى بدل خصم/إضافة مكرّرة + قيد ADJUST ثانٍ
        // (نمط inventory.transferCreate). المفتاح يُسجَّل داخل نفس المعاملة ⇒ سباق متزامن يُحسَم بالقيد الفريد.
        if (input.clientRequestId) {
          const existing = await checkIdempotency(tx, "inventory.manualMovement", input.clientRequestId, idempotencyHash(input));
          if (existing != null) {
            const st = (
              await tx.select({ q: branchStock.quantity }).from(branchStock)
                .where(and(eq(branchStock.variantId, input.variantId), eq(branchStock.branchId, branchId))).limit(1)
            )[0];
            return { result: { movementId: existing, newQuantity: Number(st?.q ?? 0) }, baseQty: 0, replayed: true as const };
          }
        }
        const conv = await convertToBaseQuantity(tx, input.productUnitId, input.quantity, input.variantId);
        const res = await applyMovement(tx, {
          variantId: input.variantId,
          branchId,
          baseQuantity: conv.baseQuantity,
          movementType: input.movementType,
          referenceType,
          notes: notesLine,
          createdBy: ctx.user.id,
        });
        // INV-MANUAL-LEDGER (تدقيق ٢/٧): حركة مخزون يدوية (بلا شراء/بيع) تغيّر قيمة المخزون بلا قيد ⇒
        // نُرحّل قيد ADJUST بقيمة الفرق × التكلفة. IN/RETURN ترفع القيمة (cost سالب/profit موجب)،
        // OUT يخفضها (خسارة: cost موجب/profit سالب). dedupeKey على معرّف الحركة يمنع الازدواج.
        const signedDelta = input.movementType === "OUT" ? -conv.baseQuantity : conv.baseQuantity;
        const v = (await tx.select({ costPrice: productVariants.costPrice }).from(productVariants).where(eq(productVariants.id, input.variantId)).limit(1))[0];
        const adjustValue = money(v?.costPrice ?? "0").times(signedDelta);
        if (!adjustValue.isZero()) {
          await postEntry(tx, {
            entryType: "ADJUST",
            branchId,
            cost: adjustValue.neg(),
            profit: adjustValue,
            amount: money(0),
            dedupeKey: `INV_MANUAL:${res.movementId}`,
            notes: `حركة مخزون يدوية (${input.movementType}) — ${notesLine}`,
          });
        }
        if (input.clientRequestId) {
          await recordIdempotencyKey(tx, "inventory.manualMovement", input.clientRequestId, res.movementId, idempotencyHash(input));
        }
        return { result: res, baseQty: conv.baseQuantity, replayed: false as const };
      });

      if (!replayed) await logAudit(ctx, {
        action: "inventory.manualMovement",
        entityType: "stock",
        entityId: input.variantId,
        newValue: {
          movementId: result.movementId,
          branchId,
          type: input.movementType,
          productUnitId: input.productUnitId,
          quantity: input.quantity,
          baseQuantity: baseQty,
          reason: input.reason,
          notes: input.notes ?? null,
        },
      });

      return { movementId: result.movementId, newQuantity: result.newQuantity };
    }),
});

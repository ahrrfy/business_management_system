import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";

// استخدام ! كحرف هروب بـ ESCAPE '!' — بديل آمن عن \ (لا يُصاب بـNO_BACKSLASH_ESCAPES MySQL mode).
const escLike = (s: string) => s.replace(/[!%_]/g, "!$&");
import { z } from "zod";
import { branches, branchStock, inventoryMovements, productVariants, products, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { applyMovement, convertToBaseQuantity, setStock, transferBetweenBranches } from "../services/inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "../services/idempotency";
import { withTx } from "../services/tx";
import { branchScopedProcedure, protectedProcedure, router, warehouseProcedure } from "../trpc";

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
  transfer: warehouseProcedure
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
      const res = await withTx((tx) => transferBetweenBranches(tx, { ...input, fromBranchId, createdBy: ctx.user.id }));
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
  transferBatch: warehouseProcedure
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
      if (fromBranchId === input.toBranchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل لنفس الفرع" });
      }
      // رفض تكرار المتغيّر في السند الواحد (لبس في الكمية + قفل مزدوج بلا داعٍ).
      const seen = new Set<number>();
      for (const it of input.items) {
        if (seen.has(it.variantId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "صنف مكرّر في السند — ادمج كميته في سطر واحد." });
        }
        seen.add(it.variantId);
      }
      const noteLine = [input.reason ? TRANSFER_REASONS[input.reason] : null, input.notes?.trim() || null]
        .filter(Boolean)
        .join(" — ") || undefined;

      // معاملة واحدة لكل الأسطر ⇒ ذرّية (فشل أي سطر يُرجِع كل السند).
      // idempotency: المفتاح يُربط بأوّل movementId. على replay نَرفض بـCONFLICT بدل
      // إعادة تنفيذ الحركات (السند الواحد له «خروج» واحد لا قابل لإعادة الإصدار).
      const { lines, idempotentReplay } = await withTx(async (tx) => {
        if (input.clientRequestId) {
          const existing = await findIdempotentRefId(tx, "inventory.transferBatch", input.clientRequestId);
          if (existing != null) {
            // السند نُفِّذ مسبقاً — لا نُعيد الكتابة. الواجهة تستطيع استعلام movementsRich لرؤية النتيجة.
            return { lines: input.items.length, idempotentReplay: true as const };
          }
        }
        const out: Array<{ variantId: number }> = [];
        let firstMovementId = 0;
        for (const it of input.items) {
          const res = await transferBetweenBranches(tx, {
            variantId: it.variantId,
            fromBranchId,
            toBranchId: input.toBranchId,
            baseQuantity: it.baseQuantity,
            notes: noteLine,
            createdBy: ctx.user.id,
          });
          if (firstMovementId === 0) firstMovementId = Number(res.from.movementId);
          out.push({ variantId: it.variantId });
        }
        if (input.clientRequestId && firstMovementId > 0) {
          // الـUNIQUE على (operation, key) يَلتقط السباق المتزامن بنفس المفتاح ⇒ ER_DUP_ENTRY يُرجِع كل السند.
          await recordIdempotencyKey(tx, "inventory.transferBatch", input.clientRequestId, firstMovementId);
        }
        return { lines: out.length, idempotentReplay: false as const };
      });

      // لا نَكتب audit log على replay (السند مُسجَّل مسبقاً) — يَمنع تضخّم السجلّ بمحاولات مكرّرة.
      if (!idempotentReplay) {
        await logAudit(ctx, {
          action: "inventory.transferBatch",
          entityType: "transfer",
          entityId: fromBranchId,
          newValue: {
            fromBranchId,
            toBranchId: input.toBranchId,
            reason: input.reason ?? null,
            notes: input.notes ?? null,
            itemCount: lines,
            items: input.items,
          },
        });
      }
      return { lines, idempotentReplay };
    }),

  adjust: warehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        targetQuantity: z.number().int().min(0),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: warehouse يُجبَر على فرعه — يمنع تسوية مخزون فرع آخر عبر API مباشر.
      // admin/manager يحترمان branchId المُرسَل (نفس نمط createManualMovement).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let branchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        branchId = Number(ctx.user.branchId);
      }
      const res = await withTx((tx) => setStock(tx, { ...input, branchId, createdBy: ctx.user.id }));
      await logAudit(ctx, { action: "inventory.adjust", entityType: "stock", entityId: input.variantId, newValue: { branchId, target: input.targetQuantity } });
      return res;
    }),

  /**
   * الأرصدة الحالية لكل متغيّر في فرع، بالأسماء + علم «تحت الحد الأدنى».
   * عزل الفرع: الكاشير/المخزن يُقيَّدان بفرعهما؛ المدير/الأدمن يختاران (افتراضي فرعهما).
   * لا تُعاد التكلفة (لا تسريب هامش الربح).
   */
  onHand: branchScopedProcedure
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

  stockByBranch: branchScopedProcedure
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
      // عزل (تَدقيق ٢٣/٦/٢٦): branchScopedProcedure يُعامل المدير كـelevated (scope=null) ⇒
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

  movements: branchScopedProcedure
    .input(z.object({ variantId: z.number().int().positive().optional(), branchId: z.number().int().positive().optional(), limit: z.number().default(100) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      // عزل (تَدقيق ٢٣/٦/٢٦): مدير الفرع يُقيَّد بفرعه على movements (كاردكس عبر-فرعي = تَسريب).
      if (ctx.user.role === "manager" && input.branchId != null && input.branchId !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة حركات فرع آخر" });
      }
      const branchId = ctx.scopedBranchId ?? input.branchId;
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
  movementsRich: branchScopedProcedure
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
        // شامل لليوم: < اليوم التالي.
        const to = new Date(i.toDate);
        if (!isNaN(to.getTime())) {
          const next = new Date(to);
          next.setDate(next.getDate() + 1);
          next.setHours(0, 0, 0, 0);
          conds.push(lt(inventoryMovements.createdAt, next));
        }
      }

      // alias من mysql-core للفرع المرتبط (TRANSFER) — يحفظ استدلال النوع لـ Drizzle.
      const relatedBranches = alias(branches, "rb");
      // S3 (٣٠/٦): cursor عند تَمريره يَفرض `id < cursor` ⇒ يَستفيد من المفتاح الأساس بـO(log n).
      if ((i as any).cursor != null) conds.push(lt(inventoryMovements.id, (i as any).cursor));
      const whereExpr = conds.length ? and(...conds) : sql`1=1`;

      // variantId/branchId NOT NULL على inventoryMovements (FK) ⇒ INNER JOIN آمن وأدقّ نوعاً.
      // relatedBranchId/createdBy nullable ⇒ LEFT JOIN.
      // S4 (٣٠/٦): limit+1 ⇒ hasMore بلا COUNT ثانٍ عند keyset؛ COUNT يَبقى لـoffset التَوافقي.
      const usingCursor = (i as any).cursor != null;
      const fetchLimit = usingCursor ? i.limit + 1 : i.limit;
      const rawRows = await db
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
        .where(whereExpr)
        .orderBy(desc(inventoryMovements.id))
        .limit(fetchLimit)
        .offset(usingCursor ? 0 : i.offset);
      const hasMore = usingCursor ? rawRows.length > i.limit : rawRows.length === i.limit;
      const rows = usingCursor && hasMore ? rawRows.slice(0, i.limit) : rawRows;
      const nextCursor = hasMore && rows.length ? rows[rows.length - 1].id : null;

      // COUNT الكامل (مسحٌ ثانٍ) يَتدهور خطّياً عند الملايين ⇒ نَتجاوزه عند keyset.
      // عند offset التوافقي، نَحسبه (الواجهات القديمة تَستهلكه لعداد الصفحات).
      let total = 0;
      if (!usingCursor) {
        const countRows = await db
          .select({ c: sql<number>`count(*)` })
          .from(inventoryMovements)
          .innerJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
          .innerJoin(products, eq(products.id, productVariants.productId))
          .innerJoin(branches, eq(branches.id, inventoryMovements.branchId))
          .where(whereExpr);
        total = Number(countRows[0]?.c ?? 0);
      }

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
   * إنشاء حركة مخزون يدوية (IN/OUT/RETURN) — أمين المخزن فأعلى.
   * مسموح فقط للأنواع غير الحوّلية والتسوية لها مسار منفصل (`inventory.adjust`).
   * - warehouse مُقيَّد بفرعه (أي branchId يُرسَل يُتجاهَل ويُستبدَل بفرع المستخدم).
   * - يحوّل الكمية إلى الوحدة الأساس ثم يُمرّرها لـ applyMovement داخل tx ذرّية.
   * - يكتب سطر تدقيق بعد النجاح (best-effort).
   */
  createManualMovement: warehouseProcedure
    .input(
      z.object({
        variantId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        movementType: z.enum(["IN", "OUT", "RETURN"]),
        productUnitId: z.number().int().positive(),
        quantity: z.string().min(1),
        reason: z.enum(REASON_KEYS),
        notes: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
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

      const { result, baseQty } = await withTx(async (tx) => {
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
        return { result: res, baseQty: conv.baseQuantity };
      });

      await logAudit(ctx, {
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

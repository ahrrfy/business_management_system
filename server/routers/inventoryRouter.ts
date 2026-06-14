import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { z } from "zod";
import { branches, branchStock, inventoryMovements, productVariants, products, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { applyMovement, convertToBaseQuantity, setStock, transferBetweenBranches } from "../services/inventoryService";
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
      // عزل الفرع: warehouse يُجبَر فرع المصدر على فرعه (لا يحوّل من فرع آخر)؛ admin/manager
      // يحترمان fromBranchId المُرسَل. النمط نفسه المُطبَّق في createManualMovement أدناه.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let fromBranchId = input.fromBranchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        const userBranch = Number(ctx.user.branchId);
        if (fromBranchId !== userBranch) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التحويل من فرع غير فرعك" });
        }
        fromBranchId = userBranch;
      }
      const res = await withTx((tx) => transferBetweenBranches(tx, { ...input, fromBranchId, createdBy: ctx.user.id }));
      await logAudit(ctx, { action: "inventory.transfer", entityType: "stock", entityId: input.variantId, newValue: { from: fromBranchId, to: input.toBranchId, qty: input.baseQuantity } });
      return res;
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
      // عزل الفرع: warehouse يُجبَر على فرعه (لا يسوّي مخزون فرع آخر).
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
      const branchId = ctx.scopedBranchId ?? input?.branchId ?? ctx.user.branchId ?? 1;

      const conds: any[] = [eq(branchStock.branchId, branchId)];
      const search = input?.q?.trim();
      if (search) {
        const pat = `%${search}%`;
        conds.push(
          or(like(products.name, pat), like(productVariants.sku, pat), like(productVariants.variantName, pat))
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
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      // عزل: غير المدير/الأدمن يُجبَر على فرعه.
      const branchId = ctx.scopedBranchId ?? input.branchId;
      return db.select().from(branchStock).where(eq(branchStock.branchId, branchId));
    }),

  movements: branchScopedProcedure
    .input(z.object({ variantId: z.number().int().positive().optional(), branchId: z.number().int().positive().optional(), limit: z.number().default(100) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const conds = [];
      // عزل: غير المدير/الأدمن يُجبَر على فرعه.
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
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const i = input ?? { limit: 200, offset: 0 };

      // عزل الفرع: غير المدير/الأدمن يُجبَر على فرعه (ctx.scopedBranchId).
      const branchFilter = ctx.scopedBranchId ?? i.branchId ?? null;

      const conds: any[] = [];
      if (branchFilter != null) conds.push(eq(inventoryMovements.branchId, branchFilter));
      if (i.movementType) conds.push(eq(inventoryMovements.movementType, i.movementType));
      if (i.variantId) conds.push(eq(inventoryMovements.variantId, i.variantId));
      if (i.referenceType) conds.push(eq(inventoryMovements.referenceType, i.referenceType));
      const search = i.q?.trim();
      if (search) {
        const pat = `%${search}%`;
        conds.push(
          or(like(products.name, pat), like(productVariants.sku, pat), like(productVariants.variantName, pat))
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
      const whereExpr = conds.length ? and(...conds) : sql`1=1`;

      // variantId/branchId NOT NULL على inventoryMovements (FK) ⇒ INNER JOIN آمن وأدقّ نوعاً.
      // relatedBranchId/createdBy nullable ⇒ LEFT JOIN.
      const rows = await db
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
        .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
        .limit(i.limit)
        .offset(i.offset);

      // count يستعمل نفس مجموعة الـ JOINs لتفادي اختلاف العدّ عن الصفوف.
      const countRows = await db
        .select({ c: sql<number>`count(*)` })
        .from(inventoryMovements)
        .innerJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(branches, eq(branches.id, inventoryMovements.branchId))
        .where(whereExpr);
      const total = Number(countRows[0]?.c ?? 0);

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

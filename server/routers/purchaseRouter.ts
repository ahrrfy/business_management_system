import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { paginateKeyset } from "../lib/paginateKeyset";
import { z } from "zod";
import { productUnits, productVariants, products, purchaseOrderItems, purchaseOrders, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { maskCostFields } from "../lib/redact";
import { nonNegMoneyString, percentString, positiveMoneyString, positiveQtyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { cancelPurchaseOrder, createPurchaseOrder, receivePurchase } from "../services/purchaseService";
import { canSeeCostForUser, purchasesManagerProcedure, purchasesReadProcedure, purchasesWarehouseProcedure, router } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على orderDate).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

// المشتريات تحمل التكلفة (unitPrice = سعر الشراء) ⇒ مدير فأعلى للإنشاء والعرض، والمخزن للاستلام.
/** مدخلات فلترة قائمة المشتريات (بلا limit/offset/cursor) — يتقاسمها list وlistCount. */
type PurchasesListFilters = {
  from?: string;
  to?: string;
  supplierId?: number;
  branchId?: number;
  status?: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  q?: string;
} | undefined;

/** يبني شروط WHERE لقائمة المشتريات — مستخدم في list وlistCount معاً ⇒ الإجمالي المعروض في
 *  الترقيم يطابق الصفوف حتماً (نفس عزل الفرع ونفس البحث). نمط buildSalesListConds نفسه.
 *  ⚠️ يُشير لـsuppliers.name عند البحث ⇒ كل مستهلك يلزمه join على suppliers. */
export function buildPurchasesListConds(input: PurchasesListFilters, scopedBranchId: number | null) {
  const conds = [];
  // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
  if (input?.from) conds.push(gte(purchaseOrders.orderDate, localDayStart(input.from)));
  if (input?.to) conds.push(lt(purchaseOrders.orderDate, localNextDayStart(input.to)));
  if (input?.supplierId) conds.push(eq(purchaseOrders.supplierId, input.supplierId));
  if (input?.status) conds.push(eq(purchaseOrders.status, input.status));
  // عزل الفرع: غير المرتفعين يُقتصرون على فرعهم (يُغلَب على input.branchId).
  // admin/manager يحترمان input.branchId إن مُرِّر (تقارير عبر-الفروع).
  const branchId = scopedBranchId != null ? scopedBranchId : input?.branchId;
  if (branchId != null) conds.push(eq(purchaseOrders.branchId, branchId));
  // بحث نصّي آمن (escLike + ESCAPE '!') عبر رقم الأمر/اسم المورد/الملاحظات.
  if (input?.q) {
    const pat = `%${escLike(input.q)}%`;
    const cond = or(
      sql`${purchaseOrders.poNumber} LIKE ${pat} ESCAPE '!'`,
      sql`${suppliers.name} LIKE ${pat} ESCAPE '!'`,
      sql`${purchaseOrders.notes} LIKE ${pat} ESCAPE '!'`,
    );
    if (cond) conds.push(cond);
  }
  return conds;
}

export const purchaseRouter = router({
  createOrder: purchasesManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        // PROC-03: نسبة الضريبة مُقيّدة [٠،١٠٠] على حدّ الثقة (كانت z.string() بلا قيد ⇒ ضريبة سالبة).
        taxRatePercent: percentString.optional(),
        status: z.enum(["DRAFT", "SENT", "CONFIRMED"]).optional(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              // PROC-01: سعر/كمية الشراء على حدّ الثقة — كانا z.string() ⇒ سعر سالب يُسمّم WAVG ويُخفّض AP.
              quantity: positiveQtyString,
              unitPrice: nonNegMoneyString,
            })
          )
          .min(1),
        notes: z.string().optional(),
        clientRequestId: z.string().min(1).max(80).optional(),
        // usd-po-reconcile: مطابقة سعر الشراء بالدولار (إعلامي — لا يمسّ total/paidAmount الديناريَين).
        agreedCurrency: z.enum(["IQD", "USD"]).optional(),
        usdTotal: positiveMoneyString.optional(),
        // landed-cost: تكلفة الشحن/الكمرك (nonNegMoneyString يرفض السالب/الصيغ التالفة). تُرسمَل
        // في تكلفة المخزون عند الاستلام (WAVG) وتُضاف إلى AP — لا مصروف P&L (تُحتسَب في COGS عند البيع).
        shippingCost: nonNegMoneyString.optional(),
        customsCost: nonNegMoneyString.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع (تدقيق ١٧/٧، AUTHZ-2): createPurchaseOrder كان يستعمل input.branchId في الترقيم
      // والتخزين لا actor.branchId ⇒ دور purchasing في فرع SALES يُنشئ أمراً على MAIN بتمرير branchId
      // مغاير. غير admin/manager يُجبَر على فرعه المُسنَد ويُتجاهَل input.branchId (نمط saleRouter).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء أمر شراء" });
      }
      const effectiveBranchId = elevated ? input.branchId : Number(ctx.user.branchId);
      const res = await createPurchaseOrder(
        { ...input, branchId: effectiveBranchId },
        { userId: ctx.user.id, branchId: effectiveBranchId },
      );
      await logAudit(ctx, { action: "purchase.createOrder", entityType: "purchaseOrder", entityId: (res as { purchaseOrderId?: number })?.purchaseOrderId, newValue: { supplierId: input.supplierId, items: input.items.length } });
      return res;
    }),

  receive: purchasesWarehouseProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        lines: z.array(z.object({ purchaseOrderItemId: z.number().int().positive(), receivedBaseQuantity: z.number().int().positive() })).min(1),
        payment: z.object({ amount: positiveMoneyString, method }).optional(),
        // idempotency: نفس المفتاح ⇒ استلام واحد (لا مخزون/AP/قيد/دفعة مزدوجة عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // G3: purchasesWarehouseProcedure يضمن branchId لغير-المدير عبر requireOwnBranch.
      // المدير/الأدمن قد يصل بلا فرع (شرعي)، لكن الاستلام نفسه يحتاج فرعاً.
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن استلام بضاعة" });
      }
      const actorBranchId = Number(ctx.user.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await receivePurchase(input, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role });
          // AUDIT-DETAIL (تدقيق ٢/٧): كان يسجّل «عدد الأسطر» فقط — لا الكميات المستلمة ولا مبلغ دفعة
          // المورد ⇒ لا يميّز استلام قطعة عن ألف مع دفعة ملايين. الآن نلتقط الكميات والدفعة.
          await logAudit(ctx, {
            action: "purchase.receive",
            entityType: "purchaseOrder",
            entityId: input.purchaseOrderId,
            newValue: {
              lines: input.lines.map((l) => ({ purchaseOrderItemId: l.purchaseOrderItemId, receivedBaseQuantity: l.receivedBaseQuantity })),
              totalReceivedBaseQuantity: input.lines.reduce((s, l) => s + l.receivedBaseQuantity, 0),
              payment: input.payment ? { amount: input.payment.amount, method: input.payment.method } : null,
            },
          });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام الاستلام" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام الاستلام (تكرار)" });
    }),

  // إلغاء أمر شراء لم يُستلم منه شيء (قلب حالة خالص — الحارس المالي/المخزني في الخدمة).
  cancel: purchasesManagerProcedure
    .input(z.object({ purchaseOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      // G3: لا إلغاء بلا فرع — assertBranchOwnership داخل الخدمة يحتاج actor.branchId صحيحاً.
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إلغاء أمر شراء" });
      }
      const res = await cancelPurchaseOrder(input.purchaseOrderId, { userId: ctx.user.id, branchId: Number(ctx.user.branchId), role: ctx.user.role });
      await logAudit(ctx, {
        action: "purchase.cancelOrder",
        entityType: "purchaseOrder",
        entityId: input.purchaseOrderId,
        newValue: { status: "CANCELLED" },
      });
      return res;
    }),

  // F3 (تدقيق ١٤/٦/٢٦): list/get تحوّلتا إلى branchScopedProcedure — قبل ذلك كان مدير
  // فرع SALES يستطيع قراءة أوامر شراء فرع MAIN عبر استدعاء API مباشر (IDOR قراءة).
  list: purchasesReadProcedure
    .input(
      z
        .object({
          limit: z.number().default(50),
          offset: z.number().default(0),
          // S3 (٣٠/٦): cursor اختياري لـkeyset — `WHERE id < cursor` بدل OFFSET للعمق العميق.
          cursor: z.number().int().positive().optional(),
          // فلترة خادمية بالفترة (orderDate) والمورد والحالة.
          from: ymd.optional(),
          to: ymd.optional(),
          supplierId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).optional(),
          // بحث نصّي خادمي: رقم الأمر/اسم المورد/الملاحظات (يستبدل الفلترة المحلّية على الصفحة).
          q: z.string().trim().min(1).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const conds = buildPurchasesListConds(input, ctx.scopedBranchId);
      // /simplify ٣٠/٦: paginateKeyset يُدير cursor/limit/offset/hasMore بدل التَكرار اليَدوي.
      const { rows } = await paginateKeyset({
        cursor: input?.cursor,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 50,
        idCol: purchaseOrders.id,
        baseConds: conds,
        runQuery: (where, lim, off) => db
          .select({
            id: purchaseOrders.id,
            poNumber: purchaseOrders.poNumber,
            orderDate: purchaseOrders.orderDate,
            // supplierId مطلوب لإجراءات الصف (كشف حساب المورد) في شاشة المشتريات.
            supplierId: purchaseOrders.supplierId,
            total: purchaseOrders.total,
            paidAmount: purchaseOrders.paidAmount,
            status: purchaseOrders.status,
            supplierName: suppliers.name,
          })
          .from(purchaseOrders)
          .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
          .where(where)
          .orderBy(desc(purchaseOrders.id))
          .limit(lim)
          .offset(off),
      });
      // حجب التكلفة (total/paidAmount) عن غير المدير — نمط saleRouter.get:371.
      if (!canSeeCostForUser(ctx.user)) {
        return rows.map((row) => ({ ...row, total: null, paidAmount: null }));
      }
      return rows;
    }),

  /** عدد أوامر الشراء المطابقة للفلتر — لِترقيم القائمة («عرض ١–٥٠ من N»).
   *  يتقاسم buildPurchasesListConds مع list ⇒ العدد يطابق الصفوف حتماً، ولا يُسرّب أي مبلغ
   *  (عدد فقط ⇒ لا حجب تكلفة مطلوباً؛ نفس صلاحية قراءة القائمة). */
  listCount: purchasesReadProcedure
    .input(
      z
        .object({
          from: ymd.optional(),
          to: ymd.optional(),
          supplierId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"]).optional(),
          q: z.string().trim().min(1).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { count: 0 };
      const conds = buildPurchasesListConds(input, ctx.scopedBranchId);
      const row = (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(purchaseOrders)
          // join إلزاميّ: الشروط قد تُشير لـsuppliers.name عند البحث بـq.
          .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
          .where(conds.length ? and(...conds) : undefined)
      )[0];
      return { count: Number(row?.count ?? 0) };
    }),

  get: purchasesReadProcedure.input(z.object({ purchaseOrderId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const po = (
      await db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
          branchId: purchaseOrders.branchId,
          orderDate: purchaseOrders.orderDate,
          subtotal: purchaseOrders.subtotal,
          taxAmount: purchaseOrders.taxAmount,
          // landed-cost: الشحن/الكمرك المُرسمَلان — للعرض في شاشة الاستلام/التفاصيل (تكلفة ⇒ محجوبة عن غير المدير).
          shippingCost: purchaseOrders.shippingCost,
          customsCost: purchaseOrders.customsCost,
          total: purchaseOrders.total,
          paidAmount: purchaseOrders.paidAmount,
          status: purchaseOrders.status,
          notes: purchaseOrders.notes,
          // usd-po-reconcile: للمقارنة البصرية لاحقاً بسعر التسديد الفعلي عبر الصيرفة.
          agreedCurrency: purchaseOrders.agreedCurrency,
          usdTotal: purchaseOrders.usdTotal,
          agreedRate: purchaseOrders.agreedRate,
        })
        .from(purchaseOrders)
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .limit(1)
    )[0];
    if (!po) return null;
    // عزل الفرع: لا يُكشَف وجود أمر شراء فرع آخر للأدوار غير المرتفعة (نمط sales.get / voucher.get).
    if (ctx.scopedBranchId != null && Number(po.branchId) !== ctx.scopedBranchId) return null;
    const items = await db
      .select({
        id: purchaseOrderItems.id,
        variantId: purchaseOrderItems.variantId,
        productUnitId: purchaseOrderItems.productUnitId,
        quantity: purchaseOrderItems.quantity,
        baseQuantity: purchaseOrderItems.baseQuantity,
        receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity,
        unitPrice: purchaseOrderItems.unitPrice,
        total: purchaseOrderItems.total,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
      })
      .from(purchaseOrderItems)
      .leftJoin(productVariants, eq(purchaseOrderItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(purchaseOrderItems.productUnitId, productUnits.id))
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    // حجب التكلفة عن غير المدير — نمط saleRouter.get:371. usdTotal/agreedRate تكلفة أيضاً (بعملة أخرى).
    if (!canSeeCostForUser(ctx.user)) {
      const poMasked = { ...po, subtotal: null, taxAmount: null, shippingCost: null, customsCost: null, total: null, paidAmount: null, usdTotal: null, agreedRate: null };
      const itemsMasked = items.map((row) => maskCostFields(row, ctx.user.role));
      return { ...poMasked, items: itemsMasked };
    }
    return { ...po, items };
  }),
});

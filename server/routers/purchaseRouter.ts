import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { paginateKeyset } from "../lib/paginateKeyset";
import { z } from "zod";
import {
  productUnits,
  productVariants,
  products,
  purchaseControlSettings,
  purchaseOrderControlRequests,
  purchaseOrderItems,
  purchaseOrders,
  suppliers,
  users,
} from "../../drizzle/schema";
import { nextActionTerminalReason } from "@shared/nextAction";
import { derivePurchaseOrderNextActionFromRow } from "../services/nextActionDerivation";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import {
  nonNegMoneyString,
  percentString,
  positiveMoneyString,
  positiveQtyString,
  positiveRateString,
  unitPriceString,
} from "../lib/schemas";
import { logAudit } from "../services/auditService";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import {
  getPurchaseIntegrityReport,
  MAX_PURCHASE_INTEGRITY_LIMIT,
} from "../services/purchaseIntegrityService";
import {
  createPurchaseRequisition,
  createPurchaseOrder,
  decidePurchaseOrderControl,
  decidePurchaseRequisitionControl,
  getPurchaseControlSettings,
  getPurchaseOrderControlRequest,
  getPurchaseOrderRevisionDiff,
  getPurchaseRequisition,
  listPendingPurchaseOrderControls,
  listPendingPurchaseRequisitionControls,
  listPurchaseOrderEvents,
  listPurchaseOrderRevisions,
  listPurchaseRequisitions,
  requestPurchaseOrderControl,
  requestPurchaseRequisitionCancellation,
  submitPurchaseOrderForApproval,
  submitPurchaseRequisition,
  updatePurchaseControlSettings,
  updatePurchaseRequisition,
  updatePurchaseOrder,
} from "../services/purchaseService";
import { assertLegacyPurchaseWritePathDisabled } from "../services/purchase/governanceCutover";
import {
  canSeeCostForUser,
  purchasesManagerProcedure,
  purchasesReadProcedure,
  router,
} from "../trpc";

/**
 * دفعةُ المورّد **لحظة الاستلام**: نقديّة فقط — العقد الخادميّ يرفض غيرها منذ أوّل سطر في
 * `receivePurchase` («الدفع غير النقدي للمورد يتطلب سند صرف موثقاً بمرجع الأداة المالية»)،
 * والرفض يُسقِط **الاستلام كلّه** داخل نفس المعاملة: لا مخزون، ولا ذمّة مورّد، ولا قيد شراء.
 *
 * كان الزود يقبل الخمس طرق فتصل الحمولة إلى الخدمة لتُرفَض هناك ⇒ أمين المخزن يُدخل الكميات
 * ويختار «تحويل» فيخسر الإدخال كلّه برسالةٍ تحيله إلى سندٍ لا مسار له في الشاشة. تضييق الزود
 * يجعل الرفض عند **حدّ العقد** (خطأ تحقّقٍ واضح) بدل عملٍ يسقط كاملاً — وهو الدرس المُوثَّق
 * في CLAUDE.md §٦: لا تُفتَح طريقةٌ قبل التحقّق أنّ الخادم يقبل حمولتها.
 *
 * ⚠️ تسويةُ الشحن/الكمرك (`shippingPaymentMethod`) تبقى على الطرق المدعومة أعلاه: مسارها
 * مختلف تماماً — تُنشئ طلب صرفٍ نظاميّاً يقبل غير النقد مع دليله، ولا يقبل الصكوك.
 */
const supplierPaymentMethod = z.enum(["CASH"]);
const requisitionItemInput = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive().nullish(),
  requestedBaseQuantity: z.number().int().positive(),
  estimatedUnitPrice: nonNegMoneyString.nullish(),
  preferredSupplierId: z.number().int().positive().nullish(),
  justification: z.string().trim().min(3).max(500),
});
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على orderDate).
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

// المشتريات تحمل التكلفة (unitPrice = سعر الشراء) ⇒ مدير فأعلى للإنشاء والعرض، والمخزن للاستلام.
/** مدخلات فلترة قائمة المشتريات (بلا limit/offset/cursor) — يتقاسمها list وlistCount. */
type PurchasesListFilters =
  | {
      from?: string;
      to?: string;
      supplierId?: number;
      branchId?: number;
      status?: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
      q?: string;
    }
  | undefined;

/** يبني شروط WHERE لقائمة المشتريات — مستخدم في list وlistCount معاً ⇒ الإجمالي المعروض في
 *  الترقيم يطابق الصفوف حتماً (نفس عزل الفرع ونفس البحث). نمط buildSalesListConds نفسه.
 *  ⚠️ يُشير لـsuppliers.name عند البحث ⇒ كل مستهلك يلزمه join على suppliers. */
export function buildPurchasesListConds(
  input: PurchasesListFilters,
  scopedBranchId: number | null,
) {
  const conds = [];
  // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
  if (input?.from)
    conds.push(gte(purchaseOrders.orderDate, localDayStart(input.from)));
  if (input?.to)
    conds.push(lt(purchaseOrders.orderDate, localNextDayStart(input.to)));
  if (input?.supplierId)
    conds.push(eq(purchaseOrders.supplierId, input.supplierId));
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
  priceInsights: purchasesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        supplierId: z.number().int().positive().optional(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return {};
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      if (!elevated && ctx.user.branchId == null)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم",
        });
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      const items = Array.from(
        new Map(
          input.items.map((item) => [
            `${item.variantId}:${item.productUnitId}`,
            item,
          ]),
        ).values(),
      );
      const pairs = items.map((item) =>
        and(
          eq(purchaseOrderItems.variantId, item.variantId),
          eq(purchaseOrderItems.productUnitId, item.productUnitId),
        ),
      );
      const rows = await db
        .select({
          variantId: purchaseOrderItems.variantId,
          productUnitId: purchaseOrderItems.productUnitId,
          unitPrice: purchaseOrderItems.unitPrice,
          purchaseOrderId: purchaseOrders.id,
          orderDate: purchaseOrders.orderDate,
          supplierId: purchaseOrders.supplierId,
          supplierName: suppliers.name,
        })
        .from(purchaseOrderItems)
        .innerJoin(
          purchaseOrders,
          eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id),
        )
        .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(
          and(
            eq(purchaseOrders.branchId, branchId),
            inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
            or(...pairs),
          ),
        )
        .orderBy(
          desc(purchaseOrders.orderDate),
          desc(purchaseOrders.id),
          desc(purchaseOrderItems.id),
        );
      type Ref = {
        price: string;
        supplierId: number;
        supplierName: string;
        purchaseOrderId: number;
        orderDate: Date;
      };
      const result: Record<
        string,
        {
          lastPurchase: Ref;
          lowestPurchase: Ref;
          selectedSupplierLastPurchase?: Ref;
        }
      > = {};
      for (const row of rows) {
        const key = `${Number(row.variantId)}:${Number(row.productUnitId)}`;
        const reference: Ref = {
          price: String(row.unitPrice),
          supplierId: Number(row.supplierId),
          supplierName: row.supplierName || "مورد غير مسمّى",
          purchaseOrderId: Number(row.purchaseOrderId),
          orderDate: row.orderDate,
        };
        const current = result[key];
        if (!current) {
          result[key] = { lastPurchase: reference, lowestPurchase: reference };
          if (input.supplierId === reference.supplierId)
            result[key].selectedSupplierLastPurchase = reference;
        } else {
          if (Number(reference.price) < Number(current.lowestPurchase.price))
            current.lowestPurchase = reference;
          if (
            input.supplierId === reference.supplierId &&
            !current.selectedSupplierLastPurchase
          )
            current.selectedSupplierLastPurchase = reference;
        }
      }
      return result;
    }),

  createOrder: purchasesManagerProcedure
    .input(
      z
        .object({
          supplierId: z.number().int().positive(),
          branchId: z.number().int().positive(),
          // PROC-03: نسبة الضريبة مُقيّدة [٠،١٠٠] على حدّ الثقة (كانت z.string() بلا قيد ⇒ ضريبة سالبة).
          taxRatePercent: percentString.optional(),
          settlementType: z.enum(["CASH", "CREDIT"]).optional(),
          items: z
            .array(
              z.object({
                variantId: z.number().int().positive(),
                productUnitId: z.number().int().positive(),
                // PROC-01: سعر/كمية الشراء على حدّ الثقة — كانا z.string() ⇒ سعر سالب يُسمّم WAVG ويُخفّض AP.
                quantity: positiveQtyString,
                // سعرُ الوحدة **بعملة الأمر** (`agreedCurrency`): حتى ٤ منازل كسقفٍ أعلى، وتُضيّقه
                // `computePurchaseDocument` حسب العملة (الدينار منزلتان). كان `nonNegMoneyString`
                // فيقصّ سعر الدولار 3.4566 إلى 3.46 صامتاً رغم أنّ العمود `decimal(15,4)`.
                unitPrice: unitPriceString,
              }),
            )
            .min(1),
          notes: z.string().optional(),
          clientRequestId: z.string().min(1).max(80),
          // usd-po-reconcile: مطابقة سعر الشراء بالدولار (إعلامي — لا يمسّ total/paidAmount الديناريَين).
          agreedCurrency: z.enum(["IQD", "USD"]).optional(),
          usdTotal: positiveMoneyString.optional(),
          agreedRate: positiveRateString.optional(),
          // مطابقة فاتورة المورّد: قيمة الورقة بعملة الأمر. اختياريّة، وحين تُرسَل يفرض
          // `computePurchaseDocument` تطابقها مع مجموع البنود برسالةٍ تحمل الرقمين والفرق.
          supplierInvoiceTotal: nonNegMoneyString.optional(),
          // خصم فاتورة المورّد بعملة الأمر (0204) — يُوزَّع بنسبة القيمة فتُخزَّن الأعمدة صافيةً.
          invoiceDiscount: nonNegMoneyString.optional(),
          // landed-cost: تكلفة الشحن/الكمرك (nonNegMoneyString يرفض السالب/الصيغ التالفة). تُرسمَل
          // في تكلفة المخزون عند الاستلام (WAVG) وتُضاف إلى AP — لا مصروف P&L (تُحتسَب في COGS عند البيع).
          shippingCost: nonNegMoneyString.optional(),
          customsCost: nonNegMoneyString.optional(),
          revisionReason: z.string().trim().min(3).max(500).optional(),
          requisitionAllocations: z
            .array(
              z.object({
                lineNo: z.number().int().positive(),
                requisitionItemId: z.number().int().positive(),
                allocatedBaseQuantity: z.number().int().positive(),
              }),
            )
            .max(500)
            .optional(),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع (تدقيق ١٧/٧، AUTHZ-2 + عزل مدير الفرع ١٢/٨): createPurchaseOrder كان يستعمل input.branchId
      // في الترقيم والتخزين لا actor.branchId. المالك/الأدمن وحدهما يعبُران الفروع؛ مدير الفرع وغيره
      // يُجبَرون على فرعهم المُسنَد ويُتجاهَل input.branchId.
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إنشاء أمر شراء",
        });
      }
      const effectiveBranchId = elevated
        ? input.branchId
        : Number(ctx.user.branchId);
      const res = await createPurchaseOrder(
        { ...input, branchId: effectiveBranchId },
        {
          userId: ctx.user.id,
          branchId: effectiveBranchId,
          role: ctx.user.role,
        },
      );
      await logAudit(ctx, {
        action: "purchase.createOrder",
        entityType: "purchaseOrder",
        entityId: (res as { purchaseOrderId?: number })?.purchaseOrderId,
        newValue: { supplierId: input.supplierId, items: input.items.length },
      });
      return res;
    }),

  // تعديل أمر شراء قبل الاستلام — بنفس محرّر الإنشاء (شاشة `/purchases/:id/edit`). الحرّاس
  // (لا استلام، لا دفعة، حالة غير نهائية) في الخدمة نفسها كي تحرس أيّ قناةٍ أخرى تستدعيها.
  // الفرع **لا يُستقبَل من المدخلات**: تغييره يغيّر عزل الأمر وترقيمه ⇒ الخدمة تُبقيه على حاله.
  updateOrder: purchasesManagerProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        revisionReason: z.string().trim().min(3).max(500),
        supplierId: z.number().int().positive(),
        taxRatePercent: percentString.optional(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: positiveQtyString,
              // نفس عقد الإنشاء: سعرٌ بعملة الأمر حتى ٤ منازل (تُضيَّق حسب العملة في الخدمة).
              // تعديلُ أمرٍ دولاريّ كان يقصّ أسعاره إلى منزلتين عند كلّ حفظٍ ولو لم تُمَسّ.
              unitPrice: unitPriceString,
            }),
          )
          .min(1),
        notes: z.string().optional(),
        agreedCurrency: z.enum(["IQD", "USD"]).optional(),
        usdTotal: positiveMoneyString.optional(),
        agreedRate: positiveRateString.optional(),
        // مطابقة فاتورة المورّد: قيمة الورقة بعملة الأمر. اختياريّة، وحين تُرسَل يفرض
        // `computePurchaseDocument` تطابقها مع مجموع البنود برسالةٍ تحمل الرقمين والفرق.
        supplierInvoiceTotal: nonNegMoneyString.optional(),
        // خصم فاتورة المورّد بعملة الأمر (0204) — يُوزَّع بنسبة القيمة فتُخزَّن الأعمدة صافيةً.
        invoiceDiscount: nonNegMoneyString.optional(),
        shippingCost: nonNegMoneyString.optional(),
        customsCost: nonNegMoneyString.optional(),
        requisitionAllocations: z
          .array(
            z.object({
              lineNo: z.number().int().positive(),
              requisitionItemId: z.number().int().positive(),
              allocatedBaseQuantity: z.number().int().positive(),
            }),
          )
          .max(500)
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن تعديل أمر شراء",
        });
      }
      const res = await updatePurchaseOrder(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      // لقطة تدقيق بمبلغٍ وعددٍ لا بـ«عُدِّل» فقط — تعديلُ سعرٍ أو مورّدٍ قبل الاستلام يغيّر AP
      // التي ستُرحَّل لاحقاً، فيلزم أثرٌ رقميّ يُراجَع (نفس درس المسار د-١ على تعديل الأسعار).
      await logAudit(ctx, {
        action: "purchase.updateOrder",
        entityType: "purchaseOrder",
        entityId: input.purchaseOrderId,
        newValue: {
          supplierId: input.supplierId,
          items: input.items.length,
          total: res.total,
          shippingCost: input.shippingCost ?? "0",
          customsCost: input.customsCost ?? "0",
          agreedCurrency: input.agreedCurrency ?? "IQD",
        },
      });
      return res;
    }),

  // اعتماد مسوّدة (DRAFT → CONFIRMED): يُتمّم دورة «حفظ مسوّدة» — مسوّدةٌ تُحفَظ بلا التزام فوري
  // (لا تُستلَم منها بضاعة، لا أثر مخزني/مالي أصلاً — createOrder لا يكتب شيئاً غير سطور الأمر
  // نفسها) ثم تُعتمَد لاحقاً فتصبح قابلة للاستلام عبر receive (الذي يشترط status=CONFIRMED حرفياً).
  confirmOrder: purchasesManagerProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(3).max(500),
        clientRequestId: z.string().trim().min(1).max(80),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن اعتماد أمر شراء",
        });
      }
      const res = await submitPurchaseOrderForApproval(
        {
          purchaseOrderId: input.purchaseOrderId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          requestKey: input.clientRequestId,
        },
        {
          userId: ctx.user.id,
          branchId: Number(ctx.user.branchId),
          role: ctx.user.role,
        },
      );
      await logAudit(ctx, {
        action: "purchase.confirmOrder",
        entityType: "purchaseOrder",
        entityId: input.purchaseOrderId,
        newValue: {
          status: "SENT",
          requestStatus: res.status,
          reason: input.reason,
          idempotent: res.idempotent,
        },
      });
      return res;
    }),

  /**
   * تسديد أمر شراءٍ بعد استلامه — الفجوة التي كانت تُبقي الشراء الآجل بلا مسار إقفال
   * (البيع يملك `sales.pay`؛ الشراء لا نظير له، فكلّ سدادٍ لاحق يخرج لسند صرفٍ عامّ لا
   * يمسّ `purchaseOrders.paidAmount` ⇒ «المتبقّي» مضخَّم وخطرُ دفعٍ مكرَّر للمورّد).
   * يُنشئ **طلباً معلّقاً** باعتماد ثانٍ — قرار المالك في كل صرفٍ للمورّد.
   */
  pay: purchasesManagerProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        amount: positiveMoneyString,
        method: supplierPaymentMethod,
        clientRequestId: z.string().min(1).max(80),
      }),
    )
    .mutation(() => assertLegacyPurchaseWritePathDisabled("purchases.pay")),

  cancel: purchasesManagerProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(3).max(500),
        requestKey: z.string().trim().min(1).max(120),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // G3: لا إلغاء بلا فرع — assertBranchOwnership داخل الخدمة يحتاج actor.branchId صحيحاً.
      if (ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إلغاء أمر شراء",
        });
      }
      const res = await requestPurchaseOrderControl(
        {
          purchaseOrderId: input.purchaseOrderId,
          expectedVersion: input.expectedVersion,
          kind: "CANCEL_ORDER",
          requestKey: input.requestKey,
          reason: input.reason,
        },
        {
          userId: ctx.user.id,
          branchId: Number(ctx.user.branchId),
          role: ctx.user.role,
        },
      );
      await logAudit(ctx, {
        action: "purchase.cancelOrder",
        entityType: "purchaseOrder",
        entityId: input.purchaseOrderId,
        newValue: {
          requestedStatus: "CANCELLED",
          requestId: res.requestId,
          requestStatus: res.status,
        },
      });
      return res;
    }),

  requestControl: purchasesManagerProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        revisionId: z.number().int().positive().nullish(),
        expectedVersion: z.number().int().positive(),
        kind: z.enum(["APPROVE_REVISION", "CANCEL_ORDER", "EMERGENCY_ORDER"]),
        requestKey: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestPurchaseOrderControl(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  decideControl: purchasesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: z.string().trim().min(1).max(120),
        approve: z.boolean(),
        reason: z.string().trim().min(3).max(500),
        confirmedFullReceipt: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      decidePurchaseOrderControl(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  pendingControls: purchasesManagerProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          cursor: z
            .object({
              purchaseOrderId: z.number().int().positive().nullish(),
              requisitionId: z.number().int().positive().nullish(),
            })
            .optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const limit = input?.limit ?? 50;
      const actor = {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      };
      const [orders, requisitions] = await Promise.all([
        listPendingPurchaseOrderControls(actor, {
          limit,
          cursor: input?.cursor?.purchaseOrderId,
        }),
        listPendingPurchaseRequisitionControls(actor, {
          limit,
          cursor: input?.cursor?.requisitionId,
        }),
      ]);
      const combined = [
        ...orders.map((request) => ({
          documentType: "PURCHASE_ORDER" as const,
          ...request,
        })),
        ...requisitions.map((request) => ({
          documentType: "REQUISITION" as const,
          ...request,
        })),
      ].sort(
        (a, b) =>
          Number(b.id) - Number(a.id) ||
          a.documentType.localeCompare(b.documentType),
      );
      const rows = combined.slice(0, limit);
      const consumedOrder = rows.filter(
        (row) => row.documentType === "PURCHASE_ORDER",
      );
      const consumedRequisition = rows.filter(
        (row) => row.documentType === "REQUISITION",
      );
      const hasMore =
        combined.length > limit ||
        orders.length > limit ||
        requisitions.length > limit;
      return {
        rows,
        hasMore,
        nextCursor: hasMore
          ? {
              purchaseOrderId: consumedOrder.length
                ? Number(consumedOrder.at(-1)!.id)
                : (input?.cursor?.purchaseOrderId ?? null),
              requisitionId: consumedRequisition.length
                ? Number(consumedRequisition.at(-1)!.id)
                : (input?.cursor?.requisitionId ?? null),
            }
          : null,
      };
    }),

  controlRequest: purchasesManagerProcedure
    .input(z.object({ requestId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getPurchaseOrderControlRequest(input.requestId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  revisions: purchasesReadProcedure
    .input(z.object({ purchaseOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) => {
      if (!canSeeCostForUser(ctx.user)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "سجل مراجعات أمر الشراء يحتوي تكاليف محجوبة عن صلاحيتك",
        });
      }
      return listPurchaseOrderRevisions(input.purchaseOrderId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
    }),

  revisionDiff: purchasesReadProcedure
    .input(
      z.object({
        purchaseOrderId: z.number().int().positive(),
        fromRevisionId: z.number().int().positive(),
        toRevisionId: z.number().int().positive(),
      }),
    )
    .query(({ input, ctx }) => {
      if (!canSeeCostForUser(ctx.user)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "فروق مراجعات أمر الشراء تحتوي تكاليف محجوبة عن صلاحيتك",
        });
      }
      return getPurchaseOrderRevisionDiff(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
    }),

  events: purchasesReadProcedure
    .input(z.object({ purchaseOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      listPurchaseOrderEvents(input.purchaseOrderId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  requisitions: purchasesReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          status: z
            .enum([
              "DRAFT",
              "SUBMITTED",
              "APPROVED",
              "PARTIALLY_ORDERED",
              "FULLY_ORDERED",
              "FULFILLED",
              "REJECTED",
              "CANCELLED",
            ])
            .optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) =>
      listPurchaseRequisitions(input ?? {}, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  requisition: purchasesReadProcedure
    .input(z.object({ requisitionId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getPurchaseRequisition(input.requisitionId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  createRequisition: purchasesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        neededBy: ymd.nullish(),
        purpose: z.string().trim().min(3).max(500),
        costCenter: z.string().trim().max(120).nullish(),
        priority: z.enum(["LOW", "NORMAL", "URGENT"]).optional(),
        items: z.array(requisitionItemInput).min(1).max(200),
        clientRequestId: z.string().trim().min(1).max(120),
      }),
    )
    .mutation(({ input, ctx }) => {
      return createPurchaseRequisition(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
    }),

  updateRequisition: purchasesManagerProcedure
    .input(
      z.object({
        requisitionId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        branchId: z.number().int().positive(),
        neededBy: ymd.nullish(),
        purpose: z.string().trim().min(3).max(500),
        costCenter: z.string().trim().max(120).nullish(),
        priority: z.enum(["LOW", "NORMAL", "URGENT"]).optional(),
        items: z.array(requisitionItemInput).min(1).max(200),
      }),
    )
    .mutation(({ input, ctx }) =>
      updatePurchaseRequisition(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  submitRequisition: purchasesManagerProcedure
    .input(
      z.object({
        requisitionId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        requestKey: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      submitPurchaseRequisition(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  requestRequisitionCancel: purchasesManagerProcedure
    .input(
      z.object({
        requisitionId: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        requestKey: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      requestPurchaseRequisitionCancellation(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  decideRequisition: purchasesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        decisionKey: z.string().trim().min(1).max(120),
        approve: z.boolean(),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      decidePurchaseRequisitionControl(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  controlSettings: purchasesManagerProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      getPurchaseControlSettings(input.branchId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  updateControlSettings: purchasesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        expectedVersion: z.number().int().nonnegative(),
        requireRequisition: z.boolean(),
        allowEmergencyOrder: z.boolean(),
        requireEmergencyApproval: z.boolean(),
        priceTolerancePercent: percentString,
        totalToleranceAmount: nonNegMoneyString,
        blockUninvoicedReceiptsAtClose: z.boolean(),
      }),
    )
    .mutation(({ input, ctx }) =>
      updatePurchaseControlSettings(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      }),
    ),

  /**
   * تقرير سلامة المشتريات: قراءة جنائية محدودة بفرع واحد، ومصدرها القيود المحاسبية لا
   * الأرصدة المخبأة. لا يعرّض هذا المسار أي mutation أو تصحيح تلقائي.
   */
  integrityReport: purchasesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_PURCHASE_INTEGRITY_LIMIT)
          .default(100),
        offset: z.number().int().min(0).max(100_000).default(0),
        staleAfterDays: z.number().int().min(1).max(3_650).default(14),
        historicalCreditAgeDays: z.number().int().min(1).max(3_650).default(90),
      }),
    )
    .query(async ({ input, ctx }) => {
      const crossBranch = ctx.user.role === "admin";
      if (!crossBranch && ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "لا فرع مُسنَد لهذا المستخدم — لا يمكن تشغيل تقرير سلامة المشتريات",
        });
      }
      if (crossBranch && input.branchId == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "اختر فرعاً واحداً لتشغيل تقرير سلامة المشتريات",
        });
      }
      const branchId = crossBranch
        ? Number(input.branchId)
        : Number(ctx.user.branchId);
      return getPurchaseIntegrityReport({
        branchId,
        limit: input.limit,
        offset: input.offset,
        staleAfterDays: input.staleAfterDays,
        historicalCreditAgeDays: input.historicalCreditAgeDays,
      });
    }),

  // F3 (تدقيق ١٤/٦/٢٦): list/get تحوّلتا إلى branchScopedProcedure — قبل ذلك كان مدير
  // فرع SALES يستطيع قراءة أوامر شراء فرع MAIN عبر استدعاء API مباشر (IDOR قراءة).
  list: purchasesReadProcedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(50), // تدقيق ٣/٨: سقف صريح ضدّ DoS الذاكرة.
          offset: z.number().int().min(0).max(1_000_000).default(0),
          // S3 (٣٠/٦): cursor اختياري لـkeyset — `WHERE id < cursor` بدل OFFSET للعمق العميق.
          cursor: z.number().int().positive().optional(),
          // فلترة خادمية بالفترة (orderDate) والمورد والحالة.
          from: ymd.optional(),
          to: ymd.optional(),
          supplierId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          status: z
            .enum(["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"])
            .optional(),
          // بحث نصّي خادمي: رقم الأمر/اسم المورد/الملاحظات (يستبدل الفلترة المحلّية على الصفحة).
          q: z.string().trim().min(1).optional(),
        })
        .optional(),
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
        runQuery: (where, lim, off) =>
          db
            .select({
              id: purchaseOrders.id,
              poNumber: purchaseOrders.poNumber,
              orderDate: purchaseOrders.orderDate,
              // supplierId مطلوب لإجراءات الصف (كشف حساب المورد) في شاشة المشتريات.
              supplierId: purchaseOrders.supplierId,
              // branchId لعمود «الفرع» عند فلتر «كل الفروع» للمرتفعين (نمط sales.list).
              branchId: purchaseOrders.branchId,
              total: purchaseOrders.total,
              paidAmount: purchaseOrders.paidAmount,
              settlementType: purchaseOrders.settlementType,
              shippingCost: purchaseOrders.shippingCost,
              customsCost: purchaseOrders.customsCost,
              agreedCurrency: purchaseOrders.agreedCurrency,
              usdTotal: purchaseOrders.usdTotal,
              paidUsd: purchaseOrders.paidUsd,
              returnedUsd: purchaseOrders.returnedUsd,
              agreedRate: purchaseOrders.agreedRate,
              status: purchaseOrders.status,
              version: purchaseOrders.version,
              currentRevisionId: purchaseOrders.currentRevisionId,
              approvedRevisionId: purchaseOrders.approvedRevisionId,
              createdBy: purchaseOrders.createdBy,
              createdByName: users.name,
              supplierName: suppliers.name,
            })
            .from(purchaseOrders)
            .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
            .leftJoin(users, eq(purchaseOrders.createdBy, users.id))
            .where(where)
            .orderBy(desc(purchaseOrders.id))
            .limit(lim)
            .offset(off),
      });
      // حجب التكلفة (total/paidAmount) عن غير المدير — نمط saleRouter.get:371.
      if (!canSeeCostForUser(ctx.user)) {
        return rows.map((row) => ({
          ...row,
          total: null,
          paidAmount: null,
          usdTotal: null,
          paidUsd: null,
          agreedRate: null,
        }));
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
          status: z
            .enum(["DRAFT", "SENT", "CONFIRMED", "RECEIVED", "CANCELLED"])
            .optional(),
          q: z.string().trim().min(1).optional(),
        })
        .optional(),
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

  get: purchasesReadProcedure
    .input(z.object({ purchaseOrderId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
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
            // م٢ ق١١: تاريخ التسليم المتوقّع — يدخل سقف «الخطوة التالية» عند CONFIRMED.
            expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
            subtotal: purchaseOrders.subtotal,
            taxAmount: purchaseOrders.taxAmount,
            taxRatePercent: purchaseOrders.taxRatePercent,
            // landed-cost: الشحن/الكمرك المُرسمَلان — للعرض في شاشة الاستلام/التفاصيل (تكلفة ⇒ محجوبة عن غير المدير).
            shippingCost: purchaseOrders.shippingCost,
            customsCost: purchaseOrders.customsCost,
            total: purchaseOrders.total,
            paidAmount: purchaseOrders.paidAmount,
            settlementType: purchaseOrders.settlementType,
            paidUsd: purchaseOrders.paidUsd,
            returnedUsd: purchaseOrders.returnedUsd,
            status: purchaseOrders.status,
            version: purchaseOrders.version,
            currentRevisionId: purchaseOrders.currentRevisionId,
            approvedRevisionId: purchaseOrders.approvedRevisionId,
            lastEditedBy: purchaseOrders.lastEditedBy,
            submittedBy: purchaseOrders.submittedBy,
            submittedAt: purchaseOrders.submittedAt,
            approvedBy: purchaseOrders.approvedBy,
            approvedAt: purchaseOrders.approvedAt,
            notes: purchaseOrders.notes,
            // usd-po-reconcile: للمقارنة البصرية لاحقاً بسعر التسديد الفعلي عبر الصيرفة.
            agreedCurrency: purchaseOrders.agreedCurrency,
            usdTotal: purchaseOrders.usdTotal,
            agreedRate: purchaseOrders.agreedRate,
            // خصم فاتورة المورّد (0204): إفصاحٌ في شاشة التفاصيل، وإعادةُ تحميلٍ لمحرّر التعديل
            // (يُعاد الخصم كما أُدخل مع الأسعار **قبل** الخصم ⇒ إعادةُ الحفظ لا تخصم مرّتين).
            invoiceDiscount: purchaseOrders.invoiceDiscount,
            usdInvoiceDiscount: purchaseOrders.usdInvoiceDiscount,
          })
          .from(purchaseOrders)
          .leftJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
          .where(eq(purchaseOrders.id, input.purchaseOrderId))
          .limit(1)
      )[0];
      if (!po) return null;
      // عزل الفرع: لا يُكشَف وجود أمر شراء فرع آخر للأدوار غير المرتفعة (نمط sales.get / voucher.get).
      if (
        ctx.scopedBranchId != null &&
        Number(po.branchId) !== ctx.scopedBranchId
      )
        return null;
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
          usdUnitPrice: purchaseOrderItems.usdUnitPrice,
          usdTotal: purchaseOrderItems.usdTotal,
          // السعر **قبل الخصم** — المحرّر يُعيد تحميله كي يُعاد توزيع الخصم من أصله لا من الصافي.
          listUnitPrice: purchaseOrderItems.listUnitPrice,
          usdListUnitPrice: purchaseOrderItems.usdListUnitPrice,
          productName: products.name,
          sku: productVariants.sku,
          variantName: productVariants.variantName,
          unitName: productUnits.unitName,
          // الحقول الثلاثة التالية تُعيد بناء سطر السلّة في شاشة التعديل بنفس شكل سطر الإنشاء
          // (`InvoiceLine`): بلا `productId` لا تجميعَ ولا تنقّلَ للمنتج، وبلا `conversionFactor`
          // لا تحقّقَ من كسر وحدة الأساس عميلياً. اشتقاق المعامل من baseQuantity/quantity كان
          // سيُخطئ عند كمّيةٍ كسريّة مقرَّبة ⇒ نقرأه من مصدره.
          productId: products.id,
          conversionFactor: productUnits.conversionFactor,
          barcode: productUnits.barcode,
        })
        .from(purchaseOrderItems)
        .leftJoin(
          productVariants,
          eq(purchaseOrderItems.variantId, productVariants.id),
        )
        .leftJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(
          productUnits,
          eq(purchaseOrderItems.productUnitId, productUnits.id),
        )
        .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
      /**
       * م٢ ق١١ — «الخطوة التالية». نقرأ هنا حقيقتَين قصيرتَين من جداول التحكّم مباشرةً:
       *  · إعدادُ الفرع `requireRequisition` — نصفُ سطرٍ يجيب سؤال «هل التغطية مفروضة أصلاً؟».
       *  · طلبُ اعتمادٍ نشطٌ على الأمر (PENDING/STALE) — لتقول الرقاقة «مَن ينتظر أحداً؟».
       *
       * ⛔ لا نمرّ بخدمة الشراء (`server/services/purchase/**` ممنوعُ المسّ في هذه الموجة).
       *   استعلامان مقروءان مباشرةً على المخطّط، بحدود صفٍّ واحد ومصفوفٍ محدودٍ (LIMIT 1).
       */
      const [controlSetting] = po.branchId != null
        ? await db
            .select({ requireRequisition: purchaseControlSettings.requireRequisition })
            .from(purchaseControlSettings)
            .where(eq(purchaseControlSettings.branchId, Number(po.branchId)))
            .limit(1)
        : [];
      const activeApprovals = await db
        .select({ status: purchaseOrderControlRequests.status })
        .from(purchaseOrderControlRequests)
        .where(
          and(
            eq(purchaseOrderControlRequests.purchaseOrderId, po.id),
            eq(purchaseOrderControlRequests.kind, "APPROVE_REVISION"),
            inArray(purchaseOrderControlRequests.status, ["PENDING", "STALE"]),
          ),
        )
        .orderBy(desc(purchaseOrderControlRequests.id))
        .limit(1);
      const approvalRequest: "PENDING" | "STALE" | "NONE" =
        activeApprovals[0]?.status === "PENDING"
          ? "PENDING"
          : activeApprovals[0]?.status === "STALE"
            ? "STALE"
            : "NONE";
      const totalDec = Number(po.total ?? 0);
      const paidDec = Number(po.paidAmount ?? 0);
      const nextAction = derivePurchaseOrderNextActionFromRow({
        purchaseOrderId: po.id,
        status: po.status,
        currentRevisionId: po.currentRevisionId,
        hasUnpaidBalance: Number.isFinite(totalDec) && Number.isFinite(paidDec) && totalDec - paidDec > 0,
        approvalRequest,
        requireRequisition: controlSetting?.requireRequisition,
        expectedDeliveryDate: po.expectedDeliveryDate,
      });
      const nextActionReason =
        nextAction == null
          ? nextActionTerminalReason("PURCHASE_ORDER", po.status)
          : null;

      // حجب التكلفة عن غير المدير — نمط saleRouter.get:371. usdTotal/agreedRate تكلفة أيضاً (بعملة أخرى).
      if (!canSeeCostForUser(ctx.user)) {
        // 0204: الخصم وسعرُ ما قبله **تكلفةٌ أيضاً** (يكشفان بنية سعر المورّد) ⇒ يُحجبان مع البقيّة.
        const poMasked = {
          ...po,
          subtotal: null,
          taxAmount: null,
          taxRatePercent: null,
          shippingCost: null,
          customsCost: null,
          total: null,
          paidAmount: null,
          usdTotal: null,
          paidUsd: null,
          returnedUsd: null,
          agreedRate: null,
          invoiceDiscount: null,
          usdInvoiceDiscount: null,
        };
        // نحن داخل فرع «لا يرى التكلفة» (قرار canSeeCostForUser الكامل: يحترم المنح/الدور المخصّص) ⇒ نحجب
        // بنود التكلفة **بلا شرط**. (كان maskCostFields يُعيد التقييم بالدور الخام فيكشف بنود دورٍ مخصّص
        // أساسه manager بـreports=NONE — تناقضٌ مع حجب الرأس؛ تدقيق ٢٥/٧، M2.)
        const itemsMasked = items.map(
          (row) =>
            ({
              ...row,
              unitPrice: null,
              usdUnitPrice: null,
              usdTotal: null,
              total: null,
              listUnitPrice: null,
              usdListUnitPrice: null,
            }) as unknown as typeof row,
        );
        return { ...poMasked, items: itemsMasked, nextAction, nextActionReason };
      }
      return { ...po, items, nextAction, nextActionReason };
    }),
});

import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import {
  assertOperationAuthorityTx,
  loadOperationUserTx,
  storedCanonicalOperationAllowed,
} from "../services/authorization/operationAuthority";
import { appErrorMessage } from "@shared/errors";
import {
  evaluateRefundOperationalDecision,
  OperationalApprovalRequiredError,
} from "@shared/operationalDecision";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { operationDecision } from "@shared/operationPermissions";
import { variantDescriptor } from "@shared/variantDisplay";
import { z } from "zod";
import {
  accountingEntries,
  auditLogs,
  branchStock,
  customers,
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryParties,
  digitalSaleDetails,
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  productPrices,
  productUnits,
  productVariants,
  products,
  receipts,
  returnRequests,
  salesControlRequests,
  shifts,
  suppliers,
  users,
  workOrders,
} from "../../drizzle/schema";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../services/idempotency";
import { retryOnDup } from "../lib/retryDup";
import { isDeadInvoice } from "@shared/predicates/isDeadInvoice";
import { deriveInvoiceChannel } from "@shared/invoiceChannel";
import { classifyVariants, getBundleDefinitions } from "../services/bundleService";
import { canCrossBranches } from "../lib/branchAuthority";
import {
  adjustCustomerBalance,
  adjustSupplierBalance,
  computeInvoiceStatus,
  postEntry,
} from "../services/ledgerService";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  type PostingProfile,
} from "../services/accounting/postingEngine";
import { classifyGiftPosting } from "../services/sale/giftPosting";
import { allocateLineCost } from "../services/billing";
import { money, round2, toDbMoney } from "../services/money";
import {
  assertCashOutAvailable,
  computeDrawerCashBalance,
  lockCashSourceForUpdate,
} from "../services/cash/cashAvailability";
import { getDb, type Tx } from "../db";
import { logAudit, logAuditTx } from "../services/auditService";
import {
  allocateReturnAgainstInvoice,
  postPurchaseReturnCartCardRefund,
  recordPurchaseReturnCartReceipt,
  recordSalesReturnCartCardReceipt,
  recordSalesReturnCartReceipt,
  remainingUnremittedDeliveryCustody,
  returnSaleAsOwner,
  returnSaleDirect,
  returnSaleInTx,
  reverseUnremittedDeliveryConsignment,
  type UnremittedDeliverySnapshot,
} from "../services/returnService";
import { reconcileDeliveryOnReturnTx } from "../services/delivery/returnReconciliation";
import {
  RETURN_EXECUTED_AUDIT_ACTION,
  type ReturnExecutionMode,
} from "../services/returns/auditActions";
import { requestSalesControl } from "../services/sale/controlRequests";
import { withTx } from "../services/tx";
import {
  loadRefundCaps,
  SURFACED_REFUND_METHODS,
} from "../services/returns/refundCaps";
import { getOpenShifts } from "../services/treasury/openShifts";
import { openShiftIdTx } from "../services/shiftService";
import {
  canSeeCostForUser,
  returnInvoiceScopeForUser,
  returnsProcedure,
  router,
  salesCashierProcedure,
  salesManagerProcedure,
  salesReadProcedure,
  workordersCashierProcedure,
  workordersExecProcedure,
} from "../trpc";
import {
  buildInvoiceChannelCondition,
  forensicTraceInvoices,
  universalBarcodeScan,
} from "../services/returns/forensicTraceService";
import { applyMovement, convertToBaseQuantity } from "../services/inventoryService";
import { assertPeriodOpen } from "../services/periodLockService";
import { assertNoActiveInstallmentPlanAfterInvoiceLockTx } from "../services/installment/guards";
import { resolveBarcodeOwner } from "../services/catalog/barcodeAliases";
import {
  createReturnRequest,
  listReturnRequests,
  loadApprovableRequest,
  loadApprovableRequestTx,
  markRequestApprovedTx,
  rejectReturnRequest,
  withdrawReturnRequest,
} from "../services/returns/requests";
import { nonNegMoneyString } from "../lib/schemas";
import { escLike } from "../lib/sqlLike";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { randomUUID } from "node:crypto";
import { todayUtcDate } from "../services/businessDay";
import { loadCurrentOperationalAuthorityTx } from "../services/authorization/currentOperationalAuthority";

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const walkInResolution = z.object({
  kind: z.literal("IMMEDIATE_REFUND"),
  // تُبقي الخدمةُ التوجيهَ التجاريّ لطريقةٍ غير CASH؛ enum هنا يمنع القيم المجهولة فقط.
  method,
  amount: nonNegMoneyString,
  /**
   * اختياريّ (١/٩/٢٦): بلا وردية مفتوحة يقرّر `shiftIdForCashTx` بالدور — خزينةٌ للإداريّ
   * (استثناءٌ مصنَّف `SALE_RETURN_COMPENSATION`) ورفضٌ للكاشير. كان إلزامياً فيحجب مرتجع
   * الزبون العابر النقديّ خارج ساعات الوردية حجباً كاملاً.
   */
  shiftId: z.number().int().positive().optional(),
  // مرجع جهاز الدفع إلزامي خادمياً عندما تكون الطريقة CARD والمبلغ موجباً.
  reference: z.string().trim().min(1).max(100).optional(),
  reason: z
    .string()
    .trim()
    .min(3, "سبب المرتجع إلزامي (٣ أحرف على الأقل)")
    .max(500),
  disposition: z.enum(["RESTOCK", "DAMAGED"]),
});
// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على entryDate).
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

/**
 * نطاق ملكية الكاشير (نظير `scopedOwnerId` في `branchScopedProcedure` و`sales.get`).
 * المدير والمسؤول والمالك = null (يرون ويعكسون كل فواتير الفرع).
 * الكاشير = معرفه الشخصي (لا يرى ولا يعكس إلا فواتيره وفواتير أوامر الشغل التي استقبلها).
 */
function getScopedOwnerId(
  user?: { id?: number | string; role?: string; isOwner?: boolean } | null,
): number | null {
  if (!user) return null;
  if (canCrossBranches(user) || user.role === "manager") return null;
  return Number(user.id);
}

/**
 * حلّ وتحويل كمية بند المرتجع إلى كمية الأساس الصحيحة مع تدقيق الوحدة ومعامل التحويل.
 *
 * الأولويات:
 * 1. إن مرّر العميل productUnitId صريحاً ⇒ يُحقَّق منه ويُحوّل عبر convertToBaseQuantity.
 * 2. إن غاب productUnitId ووُجد fallbackProductUnitId (من بند الفاتورة الأصلية) ⇒ يُستعمَل للتحويل.
 * 3. إن غاب كلاهما ⇒ يُستعلَم عن وحدة الأساس للمتغيّر (isBaseUnit = true) ويُحوّل عبرها.
 * 4. للأصناف التاريخية التي لا وحدات لها إطلاقاً ⇒ يعود بالكمية كما هي بمعامل 1.
 */
async function resolveReturnBaseQuantity(
  tx: Tx,
  item: {
    variantId: number;
    productUnitId?: number | null;
    quantity: number;
  },
  fallbackProductUnitId?: number | null,
): Promise<{ baseQuantity: number; conversionFactor: number }> {
  const effectiveUnitId = item.productUnitId ?? fallbackProductUnitId;

  if (effectiveUnitId != null) {
    const res = await convertToBaseQuantity(
      tx,
      effectiveUnitId,
      item.quantity,
      item.variantId,
    );
    return {
      baseQuantity: res.baseQuantity,
      conversionFactor: Number(res.conversionFactor) || 1,
    };
  }

  // البحث عن وحدة الأساس للمتغيّر
  const [baseUnit] = await tx
    .select({
      id: productUnits.id,
      factor: productUnits.conversionFactor,
    })
    .from(productUnits)
    .where(
      and(
        eq(productUnits.variantId, item.variantId),
        eq(productUnits.isBaseUnit, true),
      ),
    )
    .limit(1);

  if (baseUnit) {
    const res = await convertToBaseQuantity(
      tx,
      baseUnit.id,
      item.quantity,
      item.variantId,
    );
    return {
      baseQuantity: res.baseQuantity,
      conversionFactor: Number(res.conversionFactor) || 1,
    };
  }

  // ملاذ آمن أخير للأصناف القديمة بلا سجلات في productUnits
  return {
    baseQuantity: item.quantity,
    conversionFactor: 1,
  };
}

async function replaySalesReturnCartResult(
  tx: Tx,
  refId: number,
  input: {
    invoiceNumber?: string | null;
    customer?: { name?: string | null; phone?: string | null } | null;
    disposition: "RESTOCK" | "DAMAGED";
    items: Array<{
      productName: string;
      quantity: number;
      unitPrice: string;
      barcode?: string | null;
    }>;
    settlement: {
      method: "CASH" | "CARD" | "STORE_CREDIT" | "CREDIT_OFFSET";
      totalAmount: string;
      reference?: string | null;
    };
  },
  actorBranchId: number,
): Promise<{
  ok: true;
  returnNumber: string;
  customerName: string;
  customerPhone: string | null;
  originalInvoiceNumber: string | null | undefined;
  disposition: "RESTOCK" | "DAMAGED";
  totalAmount: string;
  method: "CASH" | "CARD" | "STORE_CREDIT" | "CREDIT_OFFSET";
  reference: string | null | undefined;
  itemsCount: number;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: string;
    barcode: string | null | undefined;
  }>;
  dateStr: string;
  timeStr: string;
  idempotentReplay: true;
  noCashNoAccount: boolean;
  receiptId: number | null;
  payoutAmount: string;
  debtOffsetAmount: string;
}> {
  // جلب سجل القيد المحاسبي المرتبط بالمرتجع الأصلي
  const [entry] = await tx
    .select({
      id: accountingEntries.id,
      branchId: accountingEntries.branchId,
      invoiceId: accountingEntries.invoiceId,
      customerId: accountingEntries.customerId,
      receiptId: accountingEntries.receiptId,
      notes: accountingEntries.notes,
      createdAt: accountingEntries.createdAt,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.id, refId))
    .limit(1);

  if (!entry) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذر استرجاع نتيجة المرتجع السابقة",
        why: `سجل المرتجع المرجعي #${refId} المرتبط بهذا الطلب غير موجود في القيود المحاسبية`,
        doThis: "تحقق من سجل المبيعات والمرتجعات في الفرع قبل تكرار العملية",
      }),
    });
  }

  // التحقق الصارم من عزل الفرع
  if (Number(entry.branchId) !== actorBranchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذر إعادة عرض المرتجع",
        why: "مفتاح هذا الطلب مسجل لعملية نُفذت في فرع تشغيلي آخر",
        doThis: "سجل الدخول إلى الفرع الذي نُفذت فيه العملية لمراجعتها",
      }),
    });
  }

  // استخراج رقم المرتجع التاريخي من الملاحظات
  const match = entry.notes?.match(/\[(SR-[^\]]+)\]/);
  const returnNumber = match ? match[1] : `SR-REPLAY-${refId}`;
  const recordDate = entry.createdAt;
  const [cartAudit] = await tx.select({ value: auditLogs.newValue }).from(auditLogs)
    .where(and(eq(auditLogs.action, "sale.return_cart"), eq(auditLogs.entityType, "sale"),
      eq(auditLogs.entityId, String(entry.invoiceId)),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.returnNumber')) = ${returnNumber}`))
    .orderBy(desc(auditLogs.id)).limit(1);
  const recordedResult = cartAudit?.value as { receiptId?: unknown; payoutAmount?: string; debtOffsetAmount?: string } | null;
  const recordedReceiptId = recordedResult?.receiptId;
  const receiptId = recordedReceiptId == null ? entry.receiptId : Number(recordedReceiptId);
  const cashOrCard = input.settlement.method === "CASH" || input.settlement.method === "CARD";
  // Older cart audits lack the split. Recover physical payout from its original
  // receipt, never from the invoice's current paid amount or refund caps.
  const [originalReceipt] = cashOrCard && recordedResult?.payoutAmount == null && receiptId != null
    ? await tx.select({ amount: receipts.amount }).from(receipts)
      .where(and(eq(receipts.id, Number(receiptId)), eq(receipts.direction, "OUT"))).limit(1)
    : [];
  const payoutAmount = money(recordedResult?.payoutAmount ?? originalReceipt?.amount ?? "0").toFixed(2);
  const debtOffsetAmount = money(recordedResult?.debtOffsetAmount ?? (
    input.settlement.method === "CREDIT_OFFSET" ? input.settlement.totalAmount
      : cashOrCard ? Decimal.max(0, money(input.settlement.totalAmount).minus(payoutAmount)).toFixed(2) : "0"
  )).toFixed(2);

  return {
    ok: true as const,
    returnNumber,
    receiptId: receiptId == null ? null : Number(receiptId),
    payoutAmount,
    debtOffsetAmount,
    customerName: input.customer?.name?.trim() || "زبون عابر",
    customerPhone: input.customer?.phone?.trim() || null,
    originalInvoiceNumber: input.invoiceNumber,
    disposition: input.disposition,
    totalAmount: input.settlement.totalAmount,
    method: input.settlement.method,
    reference: input.settlement.reference,
    itemsCount: input.items.length,
    items: input.items.map((i) => ({
      name: i.productName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      barcode: i.barcode,
    })),
    dateStr: recordDate.toLocaleDateString("ar-IQ-u-nu-latn", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    timeStr: recordDate.toLocaleTimeString("ar-IQ-u-nu-latn", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    idempotentReplay: true as const,
    noCashNoAccount: input.settlement.method === "CREDIT_OFFSET" && entry.customerId == null,
  };
}

// المرتجعات تعكس مخزوناً ونقداً ⇒ كاشير بوردية مفتوحة أو مدير فأعلى.
export const returnRouter = router({
  create: returnsProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              invoiceItemId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
            }),
          )
          .min(1),
        // shiftId اختياري: يُلزَم فقط حين يتعدّد الدرج المفتوح بالفرع (resolveBranchCashShiftTx
        // يرمي طالباً التحديد حينها) — يختار المستخدم أيّ درجٍ خرج منه النقد فعلياً.
        refund: z
          .object({
            amount: nonNegMoneyString,
            method,
            shiftId: z.number().int().positive().optional(),
            // مرجع عملية جهاز الدفع — إلزاميّ للردّ بالبطاقة (تفرضه الخدمة، لا مجرّد تزيين واجهة).
            reference: z.string().trim().min(1).max(100).optional(),
          })
          .optional(),
        /** إلزامي خادمياً إذا كانت الفاتورة بلا customerId؛ لا يغيّر عقد العميل المسجّل. */
        resolution: walkInResolution.optional(),
        restock: z.boolean().optional(),
        reason: z.string().trim().min(3).max(500).optional(),
        // idempotency: نفس المفتاح ⇒ مرتجع واحد (لا استرداد/إرجاع/خصم AR مزدوج عند النقر المزدوج/إعادة الشبكة).
        clientRequestId: z.string().min(1).max(80).optional(),
        /** تنفيذ مباشر ذري (إلغاء التعليق البيروقراطي للمالك والإدارة والكاشير). */
        directExecution: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // G3 (١٩/٦/٢٦): استبدال fallback `?? 1` — مرتجع يؤثّر على ذمم وصندوق فرع محدّد، لا فرع افتراضي.
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر إنشاء طلب المرتجع",
            why: "لا يوجد فرع مُسنَد لحسابك الحالي",
            doThis: "تواصل مع مدير النظام لإسناد الفرع التشغيلي لحسابك",
          }),
        });
      }
      const actorBranchId = Number(ctx.user.branchId ?? 0);
      const {
        invoiceId,
        clientRequestId,
        reason: explicitReason,
        directExecution: _directExecution,
        ...payload
      } = input;
      const rawReason = explicitReason || input.resolution?.reason;

      /**
       * ⭐ **مسارُ التنفيذ الفوريّ الذريّ بتفويضٍ وحدودٍ تشغيلية**.
       *
       * المالكُ ينفّذ عبر `returnSaleAsOwner`. أمّا المفوّضون فيمرّون عبر
       * `returnSaleDirect` الذي يعيد تحميل صلاحياتهم وسقوفهم من الصفوف المقفلة،
       * ويحوّل تجاوز شروط الفرع والمنشئ والوردية والسقف إلى طلب اعتماد.
       *
       * ⚠️ **العائدُ نوعٌ مُميَّزٌ بـ`mode`**: كلّ مستهلكٍ يتفرّع على `mode` صراحةً.
       */
      const shouldExecuteDirect =
        ctx.user.isOwner === true || input.directExecution !== false;

      if (shouldExecuteDirect && (!rawReason || rawReason.trim().length < 3)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "اكتب سبب المرتجع (٣ أحرف على الأقل) — المرتجع الفوريّ موثَّقٌ بسببه",
        });
      }
      const reason = (rawReason ?? "").trim();

      const [invRow] = await withTx(
        async (tx) =>
          tx
            .select({
              sourceType: invoices.sourceType,
              branchId: invoices.branchId,
              createdBy: invoices.createdBy,
              workOrderCreatedBy: workOrders.createdBy,
            })
            .from(invoices)
            .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
            .where(eq(invoices.id, invoiceId))
            .limit(1),
        { gate: "NONE" },
      );

      if (!invRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: `الفاتورة #${invoiceId} غير موجودة`,
            doThis: "تحقّق من رقم الفاتورة ثم أعد المحاولة",
          }),
        });
      }
      if (
        ctx.user.role !== "admin" &&
        Number(invRow.branchId) !== actorBranchId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: "الفاتورة تنتمي إلى فرع آخر غير فرعك المسند",
            doThis: "سجّل المرتجع من الفرع المصدر أو اطلب من الإدارة إتمامه",
          }),
        });
      }

      /**
       * ⛔ **فاتورةُ أمر الشغل خارج هذا المسار** (أمسكه Codex على PR #932، P1).
       *
       * فواتير WORKORDER تُعالَج من شاشة أمر الشغل (عكس التسليم) لا من مسار المرتجع.
       */
      if (invRow.sourceType === "WORKORDER") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: "فاتورة أمر الشغل لا تقبل المرتجع المباشر من مسار المبيعات",
            doThis: "توجّه إلى شاشة أمر الشغل ونفّذ عكس التسليم من هناك",
          }),
        });
      }

      let approvalDecision: OperationalApprovalRequiredError["decision"] | null = null;
      if (shouldExecuteDirect) {
        try {
        const executed =
          ctx.user.isOwner === true
            ? await returnSaleAsOwner(
                {
                  ...payload,
                  ...(_directExecution !== undefined
                    ? { directExecution: _directExecution }
                    : {}),
                  invoiceId,
                  ownerReason: reason,
                  clientRequestId: clientRequestId ?? randomUUID(),
                },
                {
                  userId: ctx.user.id,
                  branchId: actorBranchId,
                  role: ctx.user.role,
                },
              )
            : await retryOnDeadlock(() =>
                returnSaleDirect(
                  {
                    ...payload,
                    invoiceId,
                    operatorReason: reason,
                    clientRequestId: clientRequestId ?? randomUUID(),
                  },
                  {
                    userId: ctx.user.id,
                    branchId: actorBranchId,
                    role: ctx.user.role,
                    isOwner: ctx.user.isOwner,
                    operationalCaps: ctx.user.resolvedOperationalCaps,
                  },
                ),
              );

        const executionMode: ReturnExecutionMode =
          ctx.user.isOwner === true ? "OWNER_IMMEDIATE" : "DIRECT_EXECUTION";

        const isReplay =
          "idempotentReplay" in executed && executed.idempotentReplay === true;
        if (!isReplay) {
          await logAudit(ctx, {
            action: RETURN_EXECUTED_AUDIT_ACTION,
            entityType: "invoice",
            entityId: invoiceId,
            newValue: {
              mode: executionMode satisfies ReturnExecutionMode,
              reason,
              lines: input.lines.length,
              returnedTotal: String(executed.returnedTotal ?? "0"),
              fullyReturned: !!executed.fullyReturned,
              refund: input.refund?.amount ?? input.resolution?.amount ?? null,
              restock: input.restock ?? input.resolution?.disposition ?? null,
            },
          });
        }
        return { ...executed, mode: "EXECUTED" as const, invoiceId };
        } catch (error) {
          if (!(error instanceof OperationalApprovalRequiredError)) throw error;
          approvalDecision = error.decision;
        }
      }

      // صون عدم التكرار عبر النشر المتدرّج: إن كان هذا المفتاح قد التزم سابقاً كمرتجعٍ مباشر
      // (`sale.return`) وضاعت استجابته، نُعيد تشغيل نتيجة التنفيذ الأصلي بدل إنشاء طلب رقابي جديد.
      if (clientRequestId) {
        const normalizedReason = reason.replace(/\s+/g, " ");
        const replayWithDirectFlag = {
          ...payload,
          directExecution: true,
          invoiceId,
          operatorReason: normalizedReason,
          clientRequestId,
        };
        const replayWithoutDirectFlag = {
          ...payload,
          invoiceId,
          operatorReason: normalizedReason,
          clientRequestId,
        };
        const replayCandidates =
          _directExecution === false
            ? [
                replayWithDirectFlag,
                { ...replayWithoutDirectFlag, directExecution: false },
                replayWithoutDirectFlag,
              ]
            : [replayWithDirectFlag, replayWithoutDirectFlag];
        const legacyReplay = await withTx(async (tx) => {
          let lastConflict: unknown = null;
          for (const candidate of replayCandidates) {
            try {
              const existingRefId = await checkIdempotency(
                tx,
                "sale.return",
                clientRequestId,
                idempotencyHash(candidate),
              );
              if (existingRefId == null) return null;
              return await returnSaleInTx(tx, candidate, {
                userId: ctx.user.id,
                branchId: actorBranchId,
                role: ctx.user.role,
              });
            } catch (err) {
              if (err instanceof TRPCError && err.code === "CONFLICT") {
                lastConflict = err;
                continue;
              }
              throw err;
            }
          }
          if (lastConflict) throw lastConflict;
          return null;
        });
        if (legacyReplay) {
          return { ...legacyReplay, mode: "EXECUTED" as const, invoiceId };
        }
      }

      const res = await requestSalesControl(
        {
          requestKey: clientRequestId ?? randomUUID(),
          invoiceId,
          requestType: "SALES_RETURN",
          reason,
          payload,
        },
        { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role },
      );
      await logAudit(ctx, {
        action: "return.request",
        entityType: "invoice",
        entityId: invoiceId,
        newValue: {
          requestId: res.id,
          payloadHash: res.payloadHash,
          lines: input.lines.length,
          reason,
          decision: approvalDecision,
        },
      });
      const isApproved = res.status === "APPROVED";
      return {
        mode: isApproved ? ("EXECUTED" as const) : ("REQUESTED" as const),
        requestId: res.id,
        status: res.status,
        replayed: res.replayed,
        decision: approvalDecision,
      };
    }),

  // ════════ طلبات الإرجاع من المحطة (١٩/٨ — قرار المالك: طلب موظف + اعتماد مدير) ════════
  // البلاغ: رفضُ الزبون وإرجاعُ المندوب حدثٌ يوميّ، والمرتجع محصورٌ بالمدير — فالعمل يتوقّف
  // حتى يحضر، أو يُحفَظ بحسابه فتضيع نسبةُ الفاعل ويسقط فصلُ المهام. الطلب مستند نيّةٍ لا مال.

  /** موظّف المحطة يطلب إرجاعاً — بلا أيّ أثرٍ ماليّ أو مخزنيّ حتى الاعتماد. */
  request: workordersCashierProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              invoiceItemId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
            }),
          )
          .min(1),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم",
        });
      }
      const res = await createReturnRequest(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "return.request",
        entityType: "invoice",
        entityId: input.invoiceId,
        newValue: {
          requestId: res.requestId,
          reason: input.reason,
          lines: input.lines.length,
        },
      });
      return res;
    }),

  /** قائمة الطلبات: المدير يرى طلبات فرعه، والموظّف يتابع طلباته وحدها. */
  requests: workordersExecProcedure
    .input(
      z
        .object({
          status: z
            .enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"])
            .optional(),
          mine: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // مَن لا يملك سلطة الاعتماد يرى طلباته وحدها — لا نافذةَ على مرتجعات غيره.
      const canApprove =
        ctx.user.role === "admin" || ctx.user.role === "manager";
      return listReturnRequests({
        branchId:
          ctx.user.role === "admin" ? null : Number(ctx.user.branchId ?? 0),
        status: input?.status,
        createdBy: !canApprove || input?.mine ? ctx.user.id : null,
      });
    }),

  /** Withdrawal closes only the maker's unexecuted legacy intent. */
  withdrawRequest: returnsProcedure
    .input(z.object({
      requestId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(480),
    }))
    .mutation(({ input, ctx }) => withdrawReturnRequest(input.requestId, input.reason, {
      userId: ctx.user.id,
      branchId: ctx.user.branchId == null ? 0 : Number(ctx.user.branchId),
      role: ctx.user.role,
    })),

  /**
   * ⭐ بنود الطلب المعلَّق — **الكمّيات التي سيُنفّذها الخادم فعلاً** (تدقيق ١/٩/٢٦).
   *
   * كانت شاشة الاعتماد تفتح جدولَ كمّياتٍ **فارغاً** ثمّ تُلزم المدير بإدخال كمّيات،
   * وتحسب له قيمة المرتجع وتُقسم في حوار التأكيد بما أدخل — بينما `approveRequest` يقرأ
   * `linesJson` المخزَّنة ويتجاهل إدخاله تماماً. فيعتمد المدير «قلمان / ١٠٠٠ د.ع»
   * ويُرجع الخادم عشرة: المخزون والإيراد وCOGS تتحرّك بقيمةٍ لم يرها أحد، والنقد المُسلَّم
   * يقابل كمّيةً أخرى. الشاشة الآن تُحمّل هذه البنود وتقفلها للقراءة.
   */
  getRequest: salesManagerProcedure
    .input(z.object({ requestId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;
      const [req] = await db
        .select({
          id: returnRequests.id,
          invoiceId: returnRequests.invoiceId,
          branchId: returnRequests.branchId,
          linesJson: returnRequests.linesJson,
          reason: returnRequests.reason,
          status: returnRequests.status,
          createdBy: returnRequests.createdBy,
          createdByName: users.name,
        })
        .from(returnRequests)
        .leftJoin(users, eq(returnRequests.createdBy, users.id))
        .where(eq(returnRequests.id, input.requestId))
        .limit(1);
      if (!req) return null;
      // عزل الفرع — مرآةٌ لحارس `getInvoice`: لا يقرأ مديرُ فرعٍ بنودَ طلبِ فرعٍ آخر.
      if (
        ctx.user.role !== "admin" &&
        Number(req.branchId) !== Number(ctx.user.branchId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "الطلب لا يخصّ فرعك",
        });
      }
      const lines = (
        (req.linesJson as Array<{
          invoiceItemId: number;
          baseQuantity: number;
        }>) ?? []
      ).map((l) => ({
        invoiceItemId: Number(l.invoiceItemId),
        baseQuantity: Number(l.baseQuantity),
      }));
      return {
        id: Number(req.id),
        invoiceId: Number(req.invoiceId),
        status: req.status,
        reason: req.reason,
        createdBy: Number(req.createdBy),
        createdByName: req.createdByName ?? null,
        lines,
      };
    }),

  /**
   * المدير يعتمد الطلب فيُنفَّذ المرتجع **بالمسار القائم نفسه** — لا نسخةَ منطقٍ ماليّ ثانية.
   * الرافد والدرج والمرجع يقرّرها المدير لحظة الاعتماد كما يفعل في المرتجع المباشر.
   */
  approveRequest: salesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        refund: z
          .object({
            amount: nonNegMoneyString,
            method,
            shiftId: z.number().int().positive().optional(),
            reference: z.string().trim().min(1).max(100).optional(),
          })
          .optional(),
        resolution: walkInResolution.optional(),
        restock: z.boolean().optional(),
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // ٢٠/٨ (تصويب مراجعة Codex): الأدمن **عابرُ فروعٍ بحكم التصميم** وقد يكون
      // `branchId = null`؛ وكان يُرفَض هنا **قبل قراءة الطلب** فيرى الطلبات المعلّقة
      // ولا يستطيع اعتماد أيٍّ منها. الفرعُ يُشتقّ من الطلب نفسه له، ويبقى الإسنادُ
      // شرطاً لغير الأدمن.
      const isAdmin = ctx.user.role === "admin";
      if (ctx.user.branchId == null && !isAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا فرع مُسنَد لهذا المستخدم",
        });
      }
      // ⚛️ **وحدةٌ ذرّية**: قفلُ الطلب ثمّ التنفيذ ثمّ الختم في معاملةٍ واحدة. كانت ثلاثاً
      // منفصلة ⇒ فشلُ الختم يترك مرتجعاً منفَّذاً وطلباً معلَّقاً لا تُعاد محاولته (الحارس
      // التفاؤليّ يرفضه)، ومعتمدان متزامنان يُنفّذان المرتجع مرّتين.
      const res = await retryOnDeadlock(() =>
        withTx(async (tx) => {
          const probe = {
            userId: ctx.user.id,
            branchId: ctx.user.branchId ?? null,
            role: ctx.user.role,
          } as never;
          const { request, lines, invoiceId } = await loadApprovableRequestTx(
            tx,
            input.requestId,
            probe,
          );
          // الفاعلُ الماليّ يحمل فرعَ **الطلب** — لا فرعاً مفقوداً ولا فرعَ المعتمِد.
          const actor = {
            userId: ctx.user.id,
            branchId: Number(request.branchId),
            role: ctx.user.role,
          };
          const out = await returnSaleInTx(
            tx,
            {
              invoiceId,
              lines,
              refund: input.refund,
              resolution: input.resolution,
              restock: input.restock,
              clientRequestId:
                input.clientRequestId ?? `retreq-${input.requestId}`,
            },
            actor,
          );
          await markRequestApprovedTx(
            tx,
            input.requestId,
            ctx.user.id,
            invoiceId,
          );
          return { ...out, invoiceId };
        }),
      );
      const invoiceId = res.invoiceId;
      await logAudit(ctx, {
        action: RETURN_EXECUTED_AUDIT_ACTION,
        entityType: "invoice",
        entityId: invoiceId,
        newValue: {
          mode: "STATION_REQUEST_APPROVAL" satisfies ReturnExecutionMode,
          requestId: input.requestId,
          refund: input.refund?.amount ?? input.resolution?.amount ?? null,
          resolution: input.resolution?.kind ?? null,
          reason: input.resolution?.reason ?? null,
          disposition: input.resolution?.disposition ?? null,
        },
      });
      return { ...res, requestId: input.requestId };
    }),

  /** رفضٌ بسببٍ إلزاميّ — الموظّف يرى لماذا بدل صمتٍ يُعيد الطلب نفسه. */
  rejectRequest: salesManagerProcedure
    .input(
      z.object({
        requestId: z.number().int().positive(),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await rejectReturnRequest(input.requestId, input.reason, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "return.rejectRequest",
        entityType: "returnRequest",
        entityId: input.requestId,
        newValue: { reason: input.reason },
      });
      return res;
    }),

  /** سجلّ مرتجعات البيع (قيود RETURN ذات فاتورة بلا مورد) — فلاتر عميل/فرع/فترة/رقم فاتورة/منفّذ
   *  + ترقيم خادمي. الاستعلام مباشر هنا (لا listSalesReturns من الخدمة، القاصرة عن q/createdBy —
   *  تبقى بلا مسّ — نمط reservations.list/quotations.list) بنفس شروط الخدمة حرفياً + الفلترين الجديدين. */
  list: salesManagerProcedure
    .input(
      z
        .object({
          customerId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().nonnegative().optional(),
          // بحث خادمي برقم الفاتورة (كل صفوف هذا السجلّ مرتبطة بفاتورة أصلاً — invoiceId NOT NULL).
          q: z.string().trim().min(1).max(100).optional(),
          // فلتر منفّذ المرتجع (accountingEntries.createdBy) — لا مالك الفاتورة/العميل.
          createdBy: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع: admin يختار الفرع بحرّية؛ غير-admin مُقيَّد بفرعه. مدير بلا فرع مُسنَد ⇒
      // FORBIDDEN لا فلتر مفتوح (وإلّا تسرّبت مرتجعات كل الفروع) — مرآةٌ لفحص create/getInvoice.
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر عرض سجل المرتجعات",
            why: "لا فرع مُسنَد لهذا المستخدم",
            doThis: "سجّل الدخول بحسابٍ مُسنَد لفرعٍ لعرض المرتجعات الخاصة به",
          }),
        });
      }

      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const limit = Math.min(Math.max(input?.limit ?? 50, 1), 200);
      const offset = input?.offset ?? 0;
      const where = [
        eq(accountingEntries.entryType, "RETURN"),
        // مرتجع البيع: مرتبط بفاتورة ولا مورد له — عكس مرتجع الشراء (supplierId NOT NULL).
        isNull(accountingEntries.supplierId),
        isNotNull(accountingEntries.invoiceId),
        // تصحيحُ الفاتورة يعكسها عبر `returnSaleInTx` فينتج قيد RETURN **بنفس شكل المرتجع
        // الحقيقيّ تماماً** ⇒ كان كلّ تصحيحٍ يُحصى مرتجعَ بيعٍ باسم العميل وبقيمته الكاملة في
        // السجلّ والتصدير وعدّاد المرتجعات: عميلٌ لم يُرجِع شيئاً يظهر بمرتجعٍ كامل.
        // حالةُ الأصل هي الفاصل الحاسم: التصحيح يتركه SUPERSEDED دائماً، والمرتجع الحقيقيّ
        // لا يُنتجها أبداً — ولا تلتبس الحالتان لأنّ `correctSale` يرفض فاتورةً عليها مرتجعٌ
        // سابق، و`returnSale` يرفض المستبدَلة.
        sql`${invoices.status} <> 'SUPERSEDED'`,
      ];
      if (input?.customerId)
        where.push(eq(accountingEntries.customerId, input.customerId));
      if (branchId) where.push(eq(accountingEntries.branchId, branchId));
      // entryDate عمود DATE ⇒ نقارن بمنتصف ليل UTC (timezone:"Z") ليطابق ما يُخزَّن فعلياً.
      if (input?.from)
        where.push(
          gte(
            accountingEntries.entryDate,
            new Date(input.from + "T00:00:00.000Z"),
          ),
        );
      if (input?.to)
        where.push(
          lte(
            accountingEntries.entryDate,
            new Date(input.to + "T00:00:00.000Z"),
          ),
        );
      if (input?.createdBy)
        where.push(eq(accountingEntries.createdBy, input.createdBy));
      // بحث آمن (escLike + ESCAPE '!') على رقم الفاتورة — يستلزم الانضمام لـinvoices في العدّ أيضاً.
      if (input?.q) {
        const pat = `%${escLike(input.q)}%`;
        where.push(sql`${invoices.invoiceNumber} LIKE ${pat} ESCAPE '!'`);
      }

      const rows = await db
        .select({
          id: accountingEntries.id,
          entryDate: accountingEntries.entryDate,
          branchId: accountingEntries.branchId,
          invoiceId: accountingEntries.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          customerId: accountingEntries.customerId,
          customerName: customers.name,
          customerPhone: sql<
            string | null
          >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
          amount: accountingEntries.amount,
          notes: accountingEntries.notes,
          createdAt: accountingEntries.createdAt,
          performedBy: accountingEntries.createdBy,
          performedByName: accountingEntries.createdByNameSnapshot,
        })
        .from(accountingEntries)
        .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
        .leftJoin(customers, eq(accountingEntries.customerId, customers.id))
        .where(and(...where))
        .orderBy(sql`${accountingEntries.id} DESC`)
        .limit(limit)
        .offset(offset);

      let total: number;
      if (offset === 0 && rows.length < limit) {
        // إذا كانت نتائج الصفحة الأولى أقل من الحد الأقصى، فالإجمالي هو عدد الصفوف نفسه دون حاجة لاستعلام COUNT(*) إضافي
        total = rows.length;
      } else {
        const totalRow = await db
          .select({ c: sql<number>`COUNT(*)` })
          .from(accountingEntries)
          .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
          .where(and(...where));
        total = Number(totalRow[0]?.c ?? 0);
      }

      return { rows, total };
    }),

  /** منفّذو المرتجعات (createdBy مميّز على قيود RETURN المطابقة لنطاق الفرع) — يغذّي فلتر
   *  «منفّذ المرتجع» بلا كشف دليل المستخدمين الكامل (users.list حصريّ لـadminProcedure، والمدير
   *  غير-admin لا يصله — نمط sales.salespeople حرفياً). */
  performers: salesManagerProcedure
    .input(
      z.object({ branchId: z.number().int().positive().optional() }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [] as { id: number; name: string }[];
      let branchId: number | undefined;
      if (ctx.user.role === "admin") {
        branchId = input?.branchId;
      } else if (ctx.user.branchId != null) {
        branchId = Number(ctx.user.branchId);
      } else {
        return [];
      }
      const where = [
        eq(accountingEntries.entryType, "RETURN"),
        isNull(accountingEntries.supplierId),
        isNotNull(accountingEntries.invoiceId),
        isNotNull(accountingEntries.createdBy),
      ];
      if (branchId != null)
        where.push(eq(accountingEntries.branchId, branchId));
      const rows = await db
        .select({
          id: accountingEntries.createdBy,
          // لقطة الاسم وقت المرتجع أولى (يبقى صحيحاً حتى لو تغيّر اسم المستخدم لاحقاً)، والاسم
          // الحيّ احتياطي لصفوف قديمة سابقة على إضافة اللقطة.
          name: sql<string>`COALESCE(MAX(${accountingEntries.createdByNameSnapshot}), MAX(${users.name}), '—')`,
        })
        .from(accountingEntries)
        .leftJoin(users, eq(accountingEntries.createdBy, users.id))
        .where(and(...where))
        .groupBy(accountingEntries.createdBy)
        .orderBy(sql`name ASC`);
      return rows.map((r) => ({ id: Number(r.id), name: r.name }));
    }),

  getInvoice: returnsProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;
      const invoiceScope = returnInvoiceScopeForUser(
        ctx.user,
        "returns.getInvoice",
      );
      if (!invoiceScope) return null;
      const invoiceChannelCondition = buildInvoiceChannelCondition(invoiceScope);
      const loadScopedInvoice = async (invoiceId: number) => {
        const inv = (
          await db
            .select({
              id: invoices.id,
              invoiceNumber: invoices.invoiceNumber,
              status: invoices.status,
              branchId: invoices.branchId,
              sourceType: invoices.sourceType,
              /** منشئ الفاتورة — تحتاجه الشاشة لتعرف مسبقاً أنّ هذا المستخدم محجوبٌ عن اعتماد إرجاعها. */
              createdBy: invoices.createdBy,
              workOrderCreatedBy: workOrders.createdBy,
              customerId: invoices.customerId,
              customerName: customers.name,
              subtotal: invoices.subtotal,
              discountAmount: invoices.discountAmount,
              taxAmount: invoices.taxAmount,
              total: invoices.total,
              paidAmount: invoices.paidAmount,
              correctedByInvoiceId: invoices.correctedByInvoiceId,
              returnedTotal: invoices.returnedTotal,
              paymentMethod: invoices.paymentMethod,
            })
            .from(invoices)
            .leftJoin(customers, eq(invoices.customerId, customers.id))
            .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
            .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
            .where(and(eq(invoices.id, invoiceId), invoiceChannelCondition))
            .limit(1)
        )[0];
        if (!inv) return null;
        // عزل الفرع (IDOR قراءة): مدير فرعٍ لا يقرأ تفاصيل فاتورة فرعٍ آخر (بنود/عميل/مبالغ).
        // مرآةٌ لفحص ملكية الفرع في returnSale.create؛ admin يتجاوز، وغياب الفرع للمدير ⇒ منع.
        if (
          ctx.user.role !== "admin" &&
          Number(inv.branchId) !== Number(ctx.user.branchId)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر قراءة تفاصيل الفاتورة",
              why: "الفاتورة تنتمي إلى فرع آخر غير فرعك المسند",
              doThis: "افتح الفاتورة من فرعها الأصلي أو عبر حساب إداري",
            }),
          });
        }

        // عزل أوامر الشغل: فواتير WORKORDER تُعالَج من شاشة أمر الشغل (عكس التسليم) — لا من مسار المرتجع
        if (inv.sourceType === "WORKORDER") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذّر تحميل تفاصيل الفاتورة للمرتجع",
              why: "فاتورة أمر الشغل لا تقبل المرتجع المباشر من مسار المبيعات",
              doThis: "توجّه إلى شاشة أمر الشغل ونفّذ عكس التسليم من هناك",
            }),
          });
        }
        return inv;
      };
      const scanned = await loadScopedInvoice(input.invoiceId);
      if (!scanned) return null;
      let inv = scanned;
      const visited = new Set<number>([Number(inv.id)]);
      while (inv.status === "SUPERSEDED") {
        const nextId = Number(inv.correctedByInvoiceId);
        if (!Number.isSafeInteger(nextId) || nextId <= 0 || visited.has(nextId) || visited.size >= 32) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
            what: "تعذر تحميل الفاتورة الحالية للمرتجع",
            why: "رابط الفاتورة المصححة غير صالح أو يحتوي حلقة",
            doThis: "افتح سجل الفاتورة وراجع الإدارة لتحديد آخر فاتورة صحيحة قبل الإرجاع",
          }) });
        }
        visited.add(nextId);
        const next = await loadScopedInvoice(nextId);
        if (!next) return null;
        inv = next;
      }

      const rows = await db
        .select({
          invoiceItemId: invoiceItems.id,
          productName: products.name,
          isBundle: products.isBundle,
          variantName: productVariants.variantName,
          color: productVariants.color,
          colorHex: productVariants.colorHex,
          size: productVariants.size,
          variantKind: productVariants.variantKind,
          sku: productVariants.sku,
          barcode: productUnits.barcode,
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
          baseQuantity: invoiceItems.baseQuantity,
          returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
          unitPrice: invoiceItems.unitPrice,
          total: invoiceItems.total,
        })
        .from(invoiceItems)
        .innerJoin(
          productVariants,
          eq(invoiceItems.variantId, productVariants.id),
        )
        .innerJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
        .where(eq(invoiceItems.invoiceId, Number(inv.id)));

      const items = rows.map((r) => {
        const desc = variantDescriptor({
          productName: r.productName,
          variantName: r.variantName,
          color: r.color,
          size: r.size,
          variantKind: r.variantKind,
          sku: r.sku,
        });
        const variantLabel = desc || r.sku || "";
        const remaining = r.baseQuantity - r.returnedBaseQuantity;
        const conversionFactor = Number(r.conversionFactor ?? 1) || 1;
        const baseUnitName = r.isBundle ? "بكج" : "قطعة";
        return {
          invoiceItemId: Number(r.invoiceItemId),
          productName: r.productName,
          isBundle: r.isBundle === true,
          variantLabel,
          color: r.color ?? null,
          size: r.size ?? null,
          colorHex: r.colorHex ?? null,
          variantKind: r.variantKind ?? null,
          barcode: r.barcode ?? null,
          sku: r.sku ?? null,
          // البكج وحدة تشغيلية قائمة بذاتها. بعض البكجات القديمة ورثت اسم «قطعة» من القالب
          // عند الإنشاء؛ لا نعرض ذلك الاسم المضلّل في المرتجع، فـ1 هنا يعني بكجاً كاملاً.
          unitName: r.isBundle && conversionFactor === 1
            ? "بكج"
            : r.unitName?.trim() || baseUnitName,
          baseUnitName,
          // معامل تحويل وحدة البيع (درزن=12…) — الشاشة تعرض «١ درزن = ١٢ قطعة» وتَخطو به،
          // فلا يحسب الموظف الوحدة الأساس ذهنياً (كان أكبر مصدر خطأ كميات المرتجع).
          conversionFactor,
          baseQuantity: r.baseQuantity,
          returnedBaseQuantity: r.returnedBaseQuantity,
          remaining,
          unitPrice: r.unitPrice,
          total: r.total,
        };
      });

      // سقوف الاسترداد — **نفس دالّة الخادم التي ستحكم على الطلب** (`loadRefundCaps`) لا نسخةٌ
      // مقارِبة. كانت الشاشة تحسبها بنفسها فتعرض خياراً يرفضه الخادم بعد ملء كل شيء (بلاغ المالك
      // ١٧/٨). الآن: ما تعرضه الشاشة = ما يقبله الخادم، بالتعريف.
      const caps = await loadRefundCaps(db, Number(inv.id));
      const paidByMethod: Array<{ method: string; amount: string }> = [];
      caps.netByMethod.forEach((v, m) => {
        if (v.gt(0)) paidByMethod.push({ method: m, amount: v.toFixed(2) });
      });
      // سقفٌ خامّ لكل طريقة (قبل قصّه بقيمة المرتجع الذي لم تُحدَّد كمّياته بعد) — الشاشة تقصّه
      // لحظياً بقيمة ما اختاره الموظف، فيبقى الطرفان على معادلةٍ واحدة.
      // رافدا الردّ وحدهما (قرار المالك ١٧/٨: نقدٌ أو بطاقة) — لا تُعرَض طريقةٌ لا يريدها العمل.
      const isWalkIn = inv.customerId == null;
      const surfacedMethods = SURFACED_REFUND_METHODS;
      const refundOptions = surfacedMethods.map((m) => {
        const rawCap = caps.capByMethod.get(m) ?? money(0);
        const rawPaid = caps.netByMethod.get(m) ?? money(0);
        const effectiveCap =
          inv.paymentMethod === "MIXED" && m !== "CASH"
            ? Decimal.min(rawCap, rawPaid)
            : rawCap;
        return {
          method: m,
          cap: effectiveCap.toFixed(2),
          /** صافي المقبوض بهذا الرافد (زين مطويٌّ في النقد) — إفصاحٌ يشرح للموظف مصدر المال. */
          paid: rawPaid.toFixed(2),
          // الحجب يعني «لا يمكن **ردّ نقدٍ** بهذا الرافد» لا «لا يمكن تسجيل مرتجع». النصّ السابق
          // كان يُقرأ منعاً للمرتجع كلّه على فاتورةٍ لم تُقبض (بلاغ المالك ١٨/٨) — والمرتجع بلا ردّ
          // مقبولٌ خادمياً أصلاً: يُخصَم من المتبقّي ومن ذمّة العميل.
          blockedReason: effectiveCap.lte(0)
            ? isWalkIn
              ? caps.hasUnremittedDelivery
                ? "الطلب مرتبط بشحنة توصيل لم يورَّد نقدها بعد؛ سيتم عكس عهدة التوصيل آلياً دون إخراج نقد من الدرج."
                : "لا يوجد مقبوض يستوجب الرد؛ سجّل المرتجع بلا إخراج نقد وبلا وردية صرف."
              : "لا يوجد متبقٍّ من المقبوض على هذه الفاتورة — يبقى المرتجع بلا ردّ نقديّ متاحاً (يُخصَم من المتبقّي/الذمّة)"
            : null,
        };
      });

      // أدراج الفرع المفتوحة — تُجلب هنا مع التفاصيل لا بطلبٍ ثانٍ مشروط، كي لا تُبنى الشاشة
      // على حالةٍ ناقصة («جارٍ فحص الورديات…» ثمّ رفضٌ عند الحفظ). قرار المالك (١٧/٨): الاسترداد
      // من **وردية منفّذ المرتجع المفتوحة** افتراضاً، أو يختار وردية أخرى مفتوحة صراحةً.
      // النطاق = فرع الفاتورة دائماً (لا فرع الفاعل) — الدرج مورد فرعٍ لا مستخدم.
      const openShifts = await getOpenShifts(
        {},
        {
          scopedBranchId: Number(inv.branchId),
          role:
            ctx.user.role === "admin" || ctx.user.role === "manager"
              ? ctx.user.role
              : "cashier",
          userId: ctx.user.id,
        },
      );
      const refundShifts = openShifts.map((s) => ({
        shiftId: s.shiftId,
        userId: s.userId,
        userName: s.userName,
        shiftType: s.shiftType,
        expectedCash: s.expectedCash,
        /** درج المنفّذ نفسه — تختاره الشاشة افتراضاً فلا يقرّر الموظف ما لا يعرفه. */
        isMine: Number(s.userId) === Number(ctx.user.id),
      }));

      /**
       * ⭐ الطلب المعلّق يُكشَف للشاشة (تدقيق ١/٩/٢٦ — بلاغ «المرتجع وهميّ ولا أثر له»).
       * كانت الشاشة تعرض الفاتورة كأنّها بكرٌ: كامل المتبقّي قابلٌ للإرجاع وبلا أيّ إشارةٍ إلى
       * طلبٍ سابقٍ ينتظر مراجعاً. فيُعيد الموظّف الإرسال فيصطدم بخطأ الفهرس الفريد الخامّ
       * (`activeInvoiceUq`) بلا تفسير، أو — أسوأ — يظنّ أنّ المرتجع الأوّل لم يُسجَّل أصلاً
       * فيسلّم البضاعة والنقود مرّةً ثانية. النظامان معاً يُكشَفان: الحوكميّ الجديد والقديم.
       */
      const invoiceCreatedBy =
        inv.createdBy == null ? null : Number(inv.createdBy);
      const [governedPending] = await db
        .select({
          id: salesControlRequests.id,
          requestType: salesControlRequests.requestType,
          requestedBy: salesControlRequests.requestedBy,
          requestedByName: users.name,
          reason: salesControlRequests.reason,
          createdAt: salesControlRequests.createdAt,
        })
        .from(salesControlRequests)
        .leftJoin(users, eq(salesControlRequests.requestedBy, users.id))
        .where(
          and(
            eq(salesControlRequests.invoiceId, Number(inv.id)),
            eq(salesControlRequests.status, "PENDING"),
          ),
        )
        .limit(1);
      const [legacyPending] = await db
        .select({
          id: returnRequests.id,
          createdBy: returnRequests.createdBy,
          createdByName: users.name,
          reason: returnRequests.reason,
          createdAt: returnRequests.createdAt,
        })
        .from(returnRequests)
        .leftJoin(users, eq(returnRequests.createdBy, users.id))
        .where(
          and(
            eq(returnRequests.invoiceId, Number(inv.id)),
            eq(returnRequests.status, "PENDING_APPROVAL"),
          ),
        )
        .limit(1);

      const canReviewRole =
        ctx.user.isOwner === true ||
        ctx.user.role === "admin" ||
        moduleAccessAllowed(
          ctx.user.role as RoleKey,
          (ctx.user.permissionsOverride ?? null) as PermissionMap | null,
          "sales",
          "FULL",
          ["manager"],
        );

      return {
        /** الوعاء المتبقّي من المقبوض على الفاتورة بكل الطرق — سقف الردّ الأقصى بأيّ رافد. */
        refundPool: caps.pool.toFixed(2),
        refundOptions,
        refundShifts,
        /**
         * طلبٌ معلّقٌ على هذه الفاتورة — الشاشة تُظهره وتمنع إرسالاً ثانياً. `canReviewIt`
         * تُشتقّ خادمياً بسلطة الدور (salesManagerProcedure) وحارس `assertReviewerSeparation`
         * كي لا تدعو الشاشةُ مستخدماً إلى زرِّ اعتمادٍ سيرفضه الخادم (نمط «ما تعرضه الشاشة = ما يقبله الخادم»).
         */
        pendingRequest: governedPending
          ? {
              source: "CONTROL" as const,
              id: Number(governedPending.id),
              requestType: governedPending.requestType,
              requestedBy: Number(governedPending.requestedBy),
              requestedByName: governedPending.requestedByName ?? null,
              reason: governedPending.reason,
              createdAt: governedPending.createdAt,
              isMine:
                Number(governedPending.requestedBy) === Number(ctx.user.id),
              canReviewIt:
                ctx.user.isOwner === true || (canReviewRole &&
                Number(governedPending.requestedBy) !== Number(ctx.user.id) &&
                Number(invoiceCreatedBy ?? -1) !== Number(ctx.user.id)),
            }
          : legacyPending
            ? {
                source: "LEGACY" as const,
                id: Number(legacyPending.id),
                requestType: "SALES_RETURN" as const,
                requestedBy: Number(legacyPending.createdBy),
                requestedByName: legacyPending.createdByName ?? null,
                reason: legacyPending.reason,
                createdAt: legacyPending.createdAt,
                isMine: Number(legacyPending.createdBy) === Number(ctx.user.id),
                canReviewIt:
                  canReviewRole &&
                  Number(legacyPending.createdBy) !== Number(ctx.user.id) &&
                  Number(invoiceCreatedBy ?? -1) !== Number(ctx.user.id),
              }
            : null,
        walkInResolutionPolicy: isWalkIn
          ? {
              required: true as const,
              kind: "IMMEDIATE_REFUND" as const,
              /** CASH افتراضي العرض؛ الرد الفوري متاح أيضاً على CARD بمرجع الجهاز. */
              method: "CASH" as const,
              methods: SURFACED_REFUND_METHODS,
              exactAmountRequired: true as const,
              deliveryCustodyReversal: caps.hasUnremittedDelivery,
              reasonRequired: true as const,
              dispositions: ["RESTOCK", "DAMAGED"] as const,
            }
          : null,
        id: Number(inv.id),
        scannedInvoiceId: input.invoiceId,
        scannedInvoiceNumber: scanned.invoiceNumber,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        branchId: Number(inv.branchId),
        customerId: inv.customerId === null ? null : Number(inv.customerId),
        customerName: inv.customerName ?? null,
        subtotal: inv.subtotal,
        discountAmount: inv.discountAmount,
        taxAmount: inv.taxAmount,
        total: inv.total,
        paidAmount: inv.paidAmount,
        /** المقبوض الموجود فعلاً لدى المتجر؛ يستبعد عهدة المندوب غير المورّدة. */
        refundablePaidAmount: caps.pool.toFixed(2),
        /** Any recorded payment/courier custody prevents the unpaid-only shortcut. */
        sourcePaidAmountIqd: Decimal.max(money(inv.paidAmount), caps.pool, caps.unremittedDeliveryCustody).toFixed(2),
        /** ما أُرجِع سابقاً — تحتاجه الشاشة لتحسب «المستحقّ للزبون» فلا تُعبّئ ردّاً لمدين. */
        returnedTotal: inv.returnedTotal ?? "0",
        paymentMethod: inv.paymentMethod,
        paidByMethod,
        items,
      };
    }),

  /**
   * فحص فاتورة المبيعات للمرتجع الفوري الذكي
   * يجلب بيانات الفاتورة والسقف المالي الأقصى للاسترداد وبنود الفاتورة مع المتبقي لكل بند
   */
  inspectInvoiceForReturn: returnsProcedure
    .input(z.object({ invoiceNumber: z.string().trim().min(1) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;

      const actorBranchId =
        ctx.user.branchId != null ? Number(ctx.user.branchId) : null;
      const isAdmin = ctx.user.role === "admin";
      const invoiceScope = returnInvoiceScopeForUser(
        ctx.user,
        "returns.inspectInvoiceForReturn",
      );
      if (!invoiceScope) return null;
      const invoiceChannelCondition = buildInvoiceChannelCondition(invoiceScope);
      const invoiceBranchCondition = !isAdmin
        ? actorBranchId != null
          ? eq(invoices.branchId, actorBranchId)
          : sql`1=0`
        : sql`1=1`;

      const rawNo = input.invoiceNumber.trim();
      const strippedNo = rawNo.replace(/^INV-/i, "");
      const prefixedNo = `INV-${strippedNo}`;

      const loadScopedInvoice = (condition: ReturnType<typeof eq>) => db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          sourceType: invoices.sourceType,
          branchId: invoices.branchId,
          customerId: invoices.customerId,
          customerName: customers.name,
          customerPhone: customers.phone,
          customerBalance: customers.currentBalance,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          returnedTotal: invoices.returnedTotal,
          paymentMethod: invoices.paymentMethod,
          createdAt: invoices.createdAt,
          correctedByInvoiceId: invoices.correctedByInvoiceId,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
        .where(
          and(
            condition,
            invoiceBranchCondition,
            invoiceChannelCondition,
          ),
        )
        .limit(1);
      let [inv] = await loadScopedInvoice(or(
              eq(invoices.invoiceNumber, rawNo),
              eq(invoices.invoiceNumber, strippedNo),
              eq(invoices.invoiceNumber, prefixedNo),
      )!);

      if (!inv) return null;
      const scannedInvoiceNumber = inv.invoiceNumber;
      const visited = new Set<number>([Number(inv.id)]);
      while (inv.status === "SUPERSEDED") {
        const nextId = Number(inv.correctedByInvoiceId);
        if (inv.sourceType === "WORKORDER" || !Number.isSafeInteger(nextId) || nextId <= 0 || visited.has(nextId) || visited.size >= 32) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
            what: "تعذر تحميل الفاتورة الحالية للمرتجع",
            why: "رابط الفاتورة المصححة غير صالح أو خارج مسار مرتجع المبيعات",
            doThis: "افتح سجل الفاتورة وحدد آخر فاتورة صحيحة قبل الإرجاع",
          }) });
        }
        visited.add(nextId);
        const [next] = await loadScopedInvoice(eq(invoices.id, nextId));
        if (!next) return null;
        inv = next;
      }

      if (inv.sourceType === "WORKORDER") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تحميل تفاصيل الفاتورة للمرتجع",
            why: "فاتورة أمر الشغل لا تقبل المرتجع المباشر من مسار المبيعات",
            doThis: "توجّه إلى شاشة أمر الشغل ونفّذ عكس التسليم من هناك",
          }),
        });
      }

      const isOtherBranch =
        !isAdmin &&
        actorBranchId != null &&
        inv.branchId != null &&
        Number(inv.branchId) !== Number(actorBranchId);

      const isDead = isDeadInvoice(inv.status);
      const remainingInvoiceTotal = Decimal.max(
        0,
        money(inv.total).minus(money(inv.returnedTotal ?? "0")),
      );
      const paidDec = money(inv.paidAmount ?? "0");
      const caps = await loadRefundCaps(db, Number(inv.id));
      const maxRefundable = Decimal.min(remainingInvoiceTotal, caps.pool);
      const unpaidAmount = Decimal.max(0, remainingInvoiceTotal.minus(paidDec));
      const maxCreditOffsetAmount = round2(unpaidAmount.plus(caps.unremittedDeliveryCustody));
      const subtotalDec = money(inv.subtotal ?? "0");
      const discountDec = money(inv.discountAmount ?? "0");
      const taxDec = money(inv.taxAmount ?? "0");
      const invoiceMerchandiseRevenue = round2(
        Decimal.max(0, subtotalDec.minus(discountDec)),
      );

      const itemRows = await db
        .select({
          invoiceItemId: invoiceItems.id,
          variantId: invoiceItems.variantId,
          productUnitId: invoiceItems.productUnitId,
          productName: products.name,
          isBundle: products.isBundle,
          isService: products.isService,
          isGift: invoiceItems.isGift,
          variantName: productVariants.variantName,
          color: productVariants.color,
          colorHex: productVariants.colorHex,
          size: productVariants.size,
          variantKind: productVariants.variantKind,
          sku: productVariants.sku,
          barcode: productUnits.barcode,
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
          baseQuantity: invoiceItems.baseQuantity,
          returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
          unitPrice: invoiceItems.unitPrice,
          total: invoiceItems.total,
        })
        .from(invoiceItems)
        .innerJoin(
          productVariants,
          eq(invoiceItems.variantId, productVariants.id),
        )
        .innerJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
        .where(eq(invoiceItems.invoiceId, inv.id));

      const revenueItems = itemRows
        .filter((item) => !item.isGift && money(item.total ?? "0").gt(0))
        .sort((a, b) => Number(a.invoiceItemId) - Number(b.invoiceItemId));
      const itemRevenueBasis = revenueItems.reduce(
        (sum, item) => sum.plus(money(item.total ?? "0")),
        money(0),
      );
      const netRevenueByItemId = new Map<number, Decimal>();
      const netTaxByItemId = new Map<number, Decimal>();
      let allocatedInvoiceRevenue = money(0);
      let allocatedInvoiceTax = money(0);
      for (let index = 0; index < revenueItems.length; index++) {
        const item = revenueItems[index]!;
        const lineRevenue =
          index === revenueItems.length - 1
            ? round2(invoiceMerchandiseRevenue.minus(allocatedInvoiceRevenue))
            : round2(
                invoiceMerchandiseRevenue
                  .times(money(item.total ?? "0"))
                  .div(itemRevenueBasis),
              );
        const lineTax =
          index === revenueItems.length - 1
            ? round2(taxDec.minus(allocatedInvoiceTax))
            : round2(
                taxDec
                  .times(money(item.total ?? "0"))
                  .div(itemRevenueBasis),
              );
        allocatedInvoiceRevenue = allocatedInvoiceRevenue.plus(lineRevenue);
        allocatedInvoiceTax = allocatedInvoiceTax.plus(lineTax);
        netRevenueByItemId.set(Number(item.invoiceItemId), lineRevenue);
        netTaxByItemId.set(Number(item.invoiceItemId), lineTax);
      }

      const variantIds = Array.from(
        new Set(itemRows.map((r) => Number(r.variantId))),
      );
      const baseUnitRows =
        variantIds.length > 0
          ? await db
              .select({
                id: productUnits.id,
                variantId: productUnits.variantId,
                unitName: productUnits.unitName,
                barcode: productUnits.barcode,
              })
              .from(productUnits)
              .where(
                and(
                  inArray(productUnits.variantId, variantIds),
                  eq(productUnits.isBaseUnit, true),
                ),
              )
          : [];
      const baseUnitByVariantId = new Map(
        baseUnitRows.map((u) => [Number(u.variantId), u]),
      );

      const items = itemRows.map((r) => {
        const totalBaseQty = Number(r.baseQuantity ?? 0);
        const priorReturned = Number(r.returnedBaseQuantity ?? 0);
        const remainingQuantity = Math.max(0, totalBaseQty - priorReturned);
        const effectiveItemRevenue =
          netRevenueByItemId.get(Number(r.invoiceItemId)) ?? money(0);
        const effectiveItemTax =
          netTaxByItemId.get(Number(r.invoiceItemId)) ?? money(0);
        const effectiveItemTotal = round2(
          effectiveItemRevenue.plus(effectiveItemTax),
        );
        const rawPrice =
          totalBaseQty > 0
            ? money(r.total ?? "0").dividedBy(totalBaseQty)
            : money(r.unitPrice ?? "0");
        const baseEffectiveUnitPrice =
          totalBaseQty > 0
            ? effectiveItemTotal.dividedBy(totalBaseQty).toDecimalPlaces(2)
            : money(0);
        const cumulativeValue = (returnedQty: number): Decimal => {
          if (totalBaseQty <= 0) {
            return round2(baseEffectiveUnitPrice.times(returnedQty));
          }
          if (returnedQty >= totalBaseQty) {
            return effectiveItemTotal;
          }
          return round2(baseEffectiveUnitPrice.times(returnedQty));
        };
        const remainingLineTotal =
          remainingQuantity > 0
            ? round2(
                cumulativeValue(priorReturned + remainingQuantity).minus(
                  cumulativeValue(priorReturned),
                ),
              )
            : new Decimal(0);
        const nextUnitEffectivePrice =
          remainingQuantity > 0
            ? round2(
                cumulativeValue(priorReturned + 1).minus(
                  cumulativeValue(priorReturned),
                ),
              )
            : baseEffectiveUnitPrice;
        const baseUnit = baseUnitByVariantId.get(Number(r.variantId));
        return {
          invoiceItemId: Number(r.invoiceItemId),
          variantId: Number(r.variantId),
          productUnitId: baseUnit ? Number(baseUnit.id) : undefined,
          productName: r.productName,
          isBundle: r.isBundle === true,
          isService: r.isService === true,
          isGift: r.isGift === true,
          barcode: baseUnit?.barcode ?? r.barcode ?? null,
          sku: r.sku ?? null,
          unitName: baseUnit?.unitName ?? (r.isBundle ? "بكج" : "قطعة"),
          conversionFactor: 1,
          baseQuantity: totalBaseQty,
          returnedBaseQuantity: priorReturned,
          remainingQuantity,
          unitPrice: rawPrice.toDecimalPlaces(2).toFixed(2),
          effectiveUnitPrice: nextUnitEffectivePrice.toFixed(2),
          remainingLineTotal: remainingLineTotal.toFixed(2),
          total: String(r.total),
        };
      });

      // جلب سجلات المرتجعات السابقة المرتبطة بهذه الفاتورة
      const previousReturnEntries = await db
        .select({
          id: accountingEntries.id,
          amount: accountingEntries.amount,
          receiptId: accountingEntries.receiptId,
          notes: accountingEntries.notes,
          performedBy: accountingEntries.createdBy,
          performedByName: accountingEntries.createdByNameSnapshot,
          createdAt: accountingEntries.createdAt,
          receiptPaymentMethod: receipts.paymentMethod,
          receiptReference: receipts.referenceNumber,
          receiptDescription: receipts.description,
          receiptAmount: receipts.amount,
        })
        .from(accountingEntries)
        .leftJoin(receipts, eq(accountingEntries.receiptId, receipts.id))
        .where(
          and(
            eq(accountingEntries.invoiceId, inv.id),
            eq(accountingEntries.entryType, "RETURN"),
            isNull(accountingEntries.supplierId),
          ),
        )
        .orderBy(desc(accountingEntries.id));

      const returnAudits = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          newValue: auditLogs.newValue,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            or(
              and(eq(auditLogs.action, "sale.return_cart"), eq(auditLogs.entityType, "sale")),
              and(eq(auditLogs.action, RETURN_EXECUTED_AUDIT_ACTION), eq(auditLogs.entityType, "invoice")),
            ),
            eq(auditLogs.entityId, String(inv.id)),
          ),
        )
        .orderBy(desc(auditLogs.id));

      const previousReturns = previousReturnEntries.map((entry) => {
        const notesNumberMatch = entry.notes?.match(/\[(SR-[^\]]+)\]/);
        const receiptNumberMatch = entry.receiptDescription?.match(/\[(SR-[^\]]+)\]/);
        const auditMatch = returnAudits.find(
          (a) => (a.newValue as any)?.returnNumber && (a.newValue as any)?.receiptId === entry.receiptId,
        );
        const returnNumber =
          notesNumberMatch?.[1] ||
          receiptNumberMatch?.[1] ||
          (auditMatch?.newValue as any)?.returnNumber ||
          `SR-${entry.id}`;

        let method = entry.receiptPaymentMethod || (auditMatch?.newValue as any)?.method;
        if (!method) {
          if (entry.notes?.includes("رصيد متجر")) method = "STORE_CREDIT";
          else if (entry.notes?.includes("بطاقة")) method = "CARD";
          else if (entry.notes?.includes("نقدي")) method = "CASH";
          else method = inv.paymentMethod && inv.paymentMethod !== "MIXED" ? inv.paymentMethod : "CASH";
        }

        let disposition: "RESTOCK" | "DAMAGED" = "RESTOCK";
        const auditDisposition = (auditMatch?.newValue as any)?.disposition;
        if (auditDisposition === "DAMAGED" || entry.notes?.includes("إتلاف") || entry.notes?.includes("تالف")) {
          disposition = "DAMAGED";
        }

        const auditItems = (auditMatch?.newValue as any)?.items;
        let returnItems: Array<{
          name: string;
          quantity: number;
          unitPrice: string;
          barcode?: string | null;
        }> = [];
        if (Array.isArray(auditItems) && auditItems.length > 0) {
          returnItems = auditItems.map((ai: any) => ({
            name: String(ai.name || ai.productName || "صنف"),
            quantity: Number(ai.quantity || 1),
            unitPrice: String(ai.unitPrice || "0"),
            barcode: ai.barcode ?? null,
          }));
        } else {
          returnItems = items
            .filter((i) => i.returnedBaseQuantity > 0)
            .map((i) => ({
              name: i.productName,
              quantity: i.returnedBaseQuantity,
              unitPrice: i.unitPrice,
              barcode: i.barcode,
            }));
        }

        const rawAmount = entry.receiptAmount ?? entry.amount;
        const absAmount = Math.abs(Number(rawAmount ?? 0)).toFixed(2);

        return {
          id: Number(entry.id),
          returnNumber,
          createdAt: entry.createdAt,
          performedByName: entry.performedByName || "كاشير",
          amount: absAmount,
          method: String(method),
          referenceNumber: entry.receiptReference ?? null,
          disposition,
          reason: (auditMatch?.newValue as any)?.reason ?? null,
          receiptId: entry.receiptId ? Number(entry.receiptId) : null,
          items: returnItems,
        };
      });

      const hasRemainingItems = items.some((i) => i.remainingQuantity > 0);
      const isFullyReturned =
        inv.status === "RETURNED" ||
        isDead ||
        (remainingInvoiceTotal.lte(0) && !hasRemainingItems);

      return {
        id: Number(inv.id),
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        isDead,
        isFullyReturned,
        branchId: Number(inv.branchId),
        originBranchId: Number(inv.branchId),
        isOtherBranch,
        customerId: inv.customerId != null ? Number(inv.customerId) : null,
        customerName: inv.customerName ?? "عميل نقدي",
        customerPhone: inv.customerPhone ?? null,
        customerBalance: inv.customerBalance != null ? String(inv.customerBalance) : null,
        total: String(inv.total),
        discountAmount: String(inv.discountAmount ?? "0"),
        paidAmount: String(inv.paidAmount ?? "0"),
        returnedTotal: String(inv.returnedTotal ?? "0"),
        unpaidAmount: unpaidAmount.toFixed(2),
        remainingInvoiceTotal: remainingInvoiceTotal.toFixed(2),
        maxRefundable: maxRefundable.toFixed(2),
        paymentMethod: inv.paymentMethod,
        createdAt: inv.createdAt,
        items,
        previousReturns,
        scannedInvoiceNumber,
        refundablePaidAmount: caps.pool.toFixed(2),
        maxCreditOffsetAmount: maxCreditOffsetAmount.toFixed(2),
        sourcePaidAmountIqd: Decimal.max(paidDec, caps.pool, caps.unremittedDeliveryCustody).toFixed(2),
        fullReturnTotal: remainingInvoiceTotal.toFixed(2),
      };
    }),

  /**
   * التحري والتقصي الجنائي للفواتير المفقودة بعدسات متعددة:
   * باركود الصنف / آخر ٤ أرقام من البطاقة / هاتف العميل / الوردية والتاريخ
   */
  forensicTrace: returnsProcedure
    .input(
      z.object({
        query: z.string().trim().min(1, "أدخل نص البحث"),
        mode: z.enum([
          "ITEM_BARCODE",
          "CARD_LAST4",
          "CUSTOMER_PHONE",
          "DATE_SHIFT",
        ]),
        days: z.number().int().min(1).max(180).optional(),
        shiftId: z.number().int().positive().optional(),
        dateFrom: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        dateTo: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      return forensicTraceInvoices(input, {
        userId: ctx.user.id,
        branchId:
          ctx.user.role === "admin" ? 0 : Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        invoiceScope: returnInvoiceScopeForUser(
          ctx.user,
          "returns.forensicTrace",
        ),
      });
    }),

  /**
   * المسح الكوني للباركود — يتعرف تلقائياً على نوع المعاملة أو الصنف من الرمز الممسوح.
   */
  universalScan: returnsProcedure
    .input(z.object({ barcode: z.string().trim().min(1, "امسح الباركود") }))
    .query(async ({ input, ctx }) => {
      const invoiceScope = returnInvoiceScopeForUser(
        ctx.user,
        "returns.universalScan",
      );
      return universalBarcodeScan(input.barcode, {
        userId: ctx.user.id,
        branchId:
          ctx.user.role === "admin" ? 0 : Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
        invoiceScope,
        canReadWorkOrders:
          invoiceScope !== "print" &&
          operationDecision(ctx.user, "workOrders.list").allowed,
        canReadDelivery: operationDecision(ctx.user, "delivery.listParties").allowed,
        canReadPurchaseReturns: operationDecision(ctx.user, "purchaseReturns.list").allowed,
      });
    }),

  /**
   * الورديات المفتوحة للمستخدم أو الفرع (لإرجاع مالي أو دفع فرق استبدال في الدرج).
   */
  shifts: returnsProcedure.query(async ({ ctx }) => {
    const actorBranchId =
      ctx.user.role === "admin" || !ctx.user.branchId
        ? null
        : Number(ctx.user.branchId);
    const openShifts = await getOpenShifts(
      {},
      {
        scopedBranchId: actorBranchId,
        role:
          ctx.user.role === "admin" || ctx.user.role === "manager"
            ? ctx.user.role
            : "cashier",
        userId: ctx.user.id,
      },
    );
    return openShifts.map((s) => ({
      shiftId: s.shiftId,
      userId: s.userId,
      userName: s.userName,
      shiftType: s.shiftType,
      expectedCash: s.expectedCash,
      isMine: Number(s.userId) === Number(ctx.user.id),
    }));
  }),

  /**
   * جلب تفاصيل صنف بالباركود للإرجاع أو الاستبدال، شاملاً سعر التجزئة وأدنى سعر تاريخي (٦٠ يوماً) والرصيد المخزني.
   */
  lookupItemForReturn: returnsProcedure
    .input(z.object({ barcode: z.string().trim().min(1, "امسح الباركود") }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "قاعدة البيانات غير متوفرة",
        });
      }
      const code = input.barcode.trim();
      const owner = await resolveBarcodeOwner(db, code);
      const actorBranchId =
        ctx.user.role === "admin" || !ctx.user.branchId
          ? 1
          : Number(ctx.user.branchId);
      const scopedInvoiceBranchId =
        ctx.user.role === "admin" || !ctx.user.branchId
          ? null
          : Number(ctx.user.branchId);
      const invoiceScope = returnInvoiceScopeForUser(
        ctx.user,
        "returns.lookupItemForReturn",
      );
      const invoiceChannelCondition = buildInvoiceChannelCondition(invoiceScope);
      const invoiceBranchCondition =
        scopedInvoiceBranchId != null
          ? eq(invoices.branchId, scopedInvoiceBranchId)
          : sql`1=1`;

      if (!owner) {
        // إذا لم يُعثر عليه بالباركود، نحاول بالـ SKU
        const [skuVariant] = await db
          .select({
            variantId: productVariants.id,
            productId: products.id,
            productName: products.name,
            variantName: productVariants.variantName,
            color: productVariants.color,
            colorHex: productVariants.colorHex,
            size: productVariants.size,
            variantKind: productVariants.variantKind,
            sku: productVariants.sku,
            costPrice: productVariants.costPrice,
          })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(eq(productVariants.sku, code))
          .limit(1);

        if (!skuVariant) {
          return null;
        }

        // جلب وحدة الأساس
        const [baseUnit] = await db
          .select({
            id: productUnits.id,
            unitName: productUnits.unitName,
            barcode: productUnits.barcode,
          })
          .from(productUnits)
          .where(eq(productUnits.variantId, skuVariant.variantId))
          .limit(1);

        // سعر التجزئة
        const [priceRow] = baseUnit
          ? await db
              .select({ price: productPrices.price })
              .from(productPrices)
              .where(
                and(
                  eq(productPrices.productUnitId, baseUnit.id),
                  eq(productPrices.priceTier, "RETAIL"),
                ),
              )
              .limit(1)
          : [];

        // الرصيد المخزني
        const [stockRow] = await db
          .select({ quantity: branchStock.quantity })
          .from(branchStock)
          .where(
            and(
              eq(branchStock.variantId, skuVariant.variantId),
              eq(branchStock.branchId, actorBranchId),
            ),
          )
          .limit(1);

        // أدنى سعر تاريخي 60 يوماً
        const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
        const [lowestRow] = await db
          .select({ minPrice: sql<string>`MIN(${invoiceItems.unitPrice})` })
          .from(invoiceItems)
          .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
          .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
          .where(
            and(
              eq(invoiceItems.variantId, skuVariant.variantId),
              gte(invoices.createdAt, sixtyDaysAgo),
              invoiceBranchCondition,
              invoiceChannelCondition,
            ),
          );

        const retailPrice = priceRow?.price ? String(priceRow.price) : "0";
        const lowestHistoricalPrice = lowestRow?.minPrice
          ? String(lowestRow.minPrice)
          : retailPrice;

        const costPrice = skuVariant.costPrice
          ? String(skuVariant.costPrice)
          : "0";

        return {
          productId: Number(skuVariant.productId),
          variantId: Number(skuVariant.variantId),
          productUnitId: baseUnit ? Number(baseUnit.id) : 0,
          productName: skuVariant.productName,
          variantName: skuVariant.variantName ?? null,
          unitName: baseUnit?.unitName ?? "قطعة",
          barcode: baseUnit?.barcode ?? null,
          sku: skuVariant.sku ?? null,
          retailPrice,
          costPrice: canSeeCostForUser(ctx.user) ? costPrice : null,
          lowestHistoricalPrice,
          currentStock: Number(stockRow?.quantity ?? 0),
        };
      }

      // سعر التكلفة وسعر التجزئة
      const [variantRow] = await db
        .select({ costPrice: productVariants.costPrice })
        .from(productVariants)
        .where(eq(productVariants.id, owner.variantId))
        .limit(1);

      const [priceRow] = await db
        .select({ price: productPrices.price })
        .from(productPrices)
        .where(
          and(
            eq(productPrices.productUnitId, owner.productUnitId),
            eq(productPrices.priceTier, "RETAIL"),
          ),
        )
        .limit(1);

      // الرصيد المخزني
      const [stockRow] = await db
        .select({ quantity: branchStock.quantity })
        .from(branchStock)
        .where(
          and(
            eq(branchStock.variantId, owner.variantId),
            eq(branchStock.branchId, actorBranchId),
          ),
        )
        .limit(1);

      // أدنى سعر بيع تاريخي خلال ٦٠ يوماً
      const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
      const [lowestRow] = await db
        .select({ minPrice: sql<string>`MIN(${invoiceItems.unitPrice})` })
        .from(invoiceItems)
        .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
        .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
        .where(
          and(
            eq(invoiceItems.variantId, owner.variantId),
            gte(invoices.createdAt, sixtyDaysAgo),
            invoiceBranchCondition,
            invoiceChannelCondition,
          ),
        );

      const retailPrice = priceRow?.price ? String(priceRow.price) : "0";
      const costPrice = variantRow?.costPrice
        ? String(variantRow.costPrice)
        : "0";
      const lowestHistoricalPrice = lowestRow?.minPrice
        ? String(lowestRow.minPrice)
        : retailPrice;

      return {
        productId: Number(owner.productId),
        variantId: Number(owner.variantId),
        productUnitId: Number(owner.productUnitId),
        productName: owner.productName,
        variantName: owner.variantName ?? null,
        unitName: owner.unitName,
        barcode: owner.primaryBarcode ?? code,
        sku: owner.sku ?? null,
        retailPrice,
        costPrice: canSeeCostForUser(ctx.user) ? costPrice : null,
        lowestHistoricalPrice,
        currentStock: Number(stockRow?.quantity ?? 0),
      };
    }),

  /**
   * تنفيذ الإرجاع الاستثنائي بدون فاتورة أو الاستبدال المباشر بصنف آخر، مع التسوية المخزنية والمالية وحفظ الحقوق.
   */
  executeNoReceiptOrExchange: salesManagerProcedure
    .input(
      z.object({
        mode: z.enum(["STORE_CREDIT", "DIRECT_EXCHANGE"]),
        returnItems: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive().optional(),
              productName: z.string().min(1),
              barcode: z.string().nullish(),
              quantity: z.number().int().positive(),
              unitPrice: nonNegMoneyString,
              disposition: z.enum(["RESTOCK", "SCRAP"]),
            }),
          )
          .min(1, "يجب تحديد صنف واحد على الأقل للإرجاع"),
        exchangeItems: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive().optional(),
              productName: z.string().min(1),
              barcode: z.string().nullish(),
              quantity: z.number().int().positive(),
              unitPrice: nonNegMoneyString,
            }),
          )
          .optional(),
        customer: z
          .object({
            name: z.string().trim().max(120).nullish(),
            phone: z.string().trim().max(40).nullish(),
          })
          .nullish(),
        reason: z.string().trim().max(500).nullish(),
        settlement: z.object({
          returnTotal: nonNegMoneyString,
          exchangeTotal: nonNegMoneyString.optional(),
          differenceAmount: z.string(),
          paymentMethod: z.enum(["CASH", "CARD", "STORE_CREDIT"]).optional(),
          shiftId: z.number().int().positive().optional(),
          reference: z.string().trim().nullish(),
        }),
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر تنفيذ عملية الإرجاع أو الاستبدال",
            why: "لا يوجد فرع مُسنَد لحسابك الحالي",
            doThis: "تواصل مع مدير النظام لإسناد الفرع التشغيلي لحسابك",
          }),
        });
      }
      const actorBranchId = Number(ctx.user.branchId ?? 1);

      return withTx(
        async (tx) => {
          await assertPeriodOpen(tx, new Date());

          const now = new Date();
          const randSuffix = Math.floor(1000 + Math.random() * 9000);
          const voucherCode =
            input.mode === "DIRECT_EXCHANGE"
              ? `EX-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${randSuffix}`
              : `SC-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${randSuffix}`;

          const customerName = input.customer?.name?.trim() || "زبون عابر";
          const customerPhone = input.customer?.phone?.trim() || null;
          const returnReason =
            input.reason?.trim() ||
            (input.mode === "DIRECT_EXCHANGE"
              ? "استبدال مباشر بضاعة"
              : "إرجاع بضاعة بدون فاتورة");

          // ١) حركات المخزون للمرتجع (زيادة المخزون إذا كان RESTOCK) بالوحدة الأساس
          for (const itm of input.returnItems) {
            if (itm.disposition === "RESTOCK") {
              const { baseQuantity: effectiveBaseQty } =
                await resolveReturnBaseQuantity(tx, itm);
              await applyMovement(tx, {
                variantId: itm.variantId,
                branchId: actorBranchId,
                baseQuantity: effectiveBaseQty,
                movementType: "RETURN",
                referenceType:
                  input.mode === "DIRECT_EXCHANGE"
                    ? "EXCHANGE_RETURN"
                    : "NO_RECEIPT_RETURN",
                documentNumber: voucherCode,
                notes: `${input.mode === "DIRECT_EXCHANGE" ? "استبدال بضاعة" : "مرتجع استثنائي بدون وصل"} [${voucherCode}] — ${returnReason} (${customerName})`,
                createdBy: ctx.user.id,
              });
            }
          }

          // ٢) حركات المخزون للبديل الجديد (خصم المخزون OUT) بالوحدة الأساس في حالة الاستبدال المباشر
          if (
            input.mode === "DIRECT_EXCHANGE" &&
            input.exchangeItems &&
            input.exchangeItems.length > 0
          ) {
            for (const itm of input.exchangeItems) {
              const { baseQuantity: effectiveBaseQty } =
                await resolveReturnBaseQuantity(tx, itm);
              await applyMovement(tx, {
                variantId: itm.variantId,
                branchId: actorBranchId,
                baseQuantity: effectiveBaseQty,
                movementType: "OUT",
                referenceType: "EXCHANGE_ISSUE",
                documentNumber: voucherCode,
                notes: `صرف بضاعة بديلة مقابل استبدال [${voucherCode}] — ${returnReason} (${customerName})`,
                createdBy: ctx.user.id,
              });
            }
          }

          // ٣) توثيق التدقيق الرقابي
          await logAudit(ctx, {
            action:
              input.mode === "DIRECT_EXCHANGE"
                ? "return.direct_exchange"
                : "return.no_receipt_voucher",
            entityType: "voucher",
            entityId: null,
            newValue: {
              voucherCode,
              mode: input.mode,
              customerName,
              customerPhone,
              reason: returnReason,
              returnTotal: input.settlement.returnTotal,
              exchangeTotal: input.settlement.exchangeTotal ?? "0",
              differenceAmount: input.settlement.differenceAmount,
              returnLinesCount: input.returnItems.length,
              exchangeLinesCount: input.exchangeItems?.length ?? 0,
              dispositions: input.returnItems.map((i) => ({
                name: i.productName,
                disp: i.disposition,
                qty: i.quantity,
              })),
            },
          });

          return {
            ok: true as const,
            voucherCode,
            mode: input.mode,
            returnTotal: input.settlement.returnTotal,
            exchangeTotal: input.settlement.exchangeTotal ?? "0",
            differenceAmount: input.settlement.differenceAmount,
            customerName,
            customerPhone,
            dateStr: now.toLocaleDateString("ar-IQ-u-nu-latn", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          };
        },
        { gate: "NONE" },
      );
    }),

  /**
   * جلب أدراج النقدية / الورديات المفتوحة في فرع الكاشير لصرف المرتجع منها
   * متاحة للكاشير والمدير ضمن صلاحيات المبيعات، وتفرّق بين وردية المستخدم الحالي والورديات الأخرى
   */
  getOpenRefundDrawers: returnsProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const canCross = canCrossBranches(ctx.user);
      const userBranchId =
        (ctx as { scopedBranchId?: number | null }).scopedBranchId ??
        (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
      if (!canCross && userBranchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر استعراض أدراج النقدية المفتوحة",
            why: "لا يوجد فرع مُسنَد لحسابك الحالي",
            doThis: "تواصل مع مدير النظام لإسناد الفرع التشغيلي لحسابك",
          }),
        });
      }
      if (
        !canCross &&
        input?.branchId != null &&
        userBranchId != null &&
        Number(input.branchId) !== Number(userBranchId)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر استعراض أدراج النقدية المفتوحة",
            why: "لا يمكن قراءة أدراج فرع آخر غير فرعك المسند",
            doThis: "استعرض الأدراج المفتوحة ضمن فرعك المسند فقط",
          }),
        });
      }
      const effectiveScopedBranchId = canCross
        ? (input?.branchId ?? userBranchId ?? null)
        : userBranchId;
      if (!effectiveScopedBranchId) {
        return [];
      }
      const openShifts = await getOpenShifts(
        { branchId: effectiveScopedBranchId },
        {
          scopedBranchId: effectiveScopedBranchId,
          role:
            ctx.user.role === "admin" || ctx.user.role === "manager"
              ? ctx.user.role
              : "cashier",
          userId: ctx.user.id,
        },
      );
      return openShifts.map((s) => ({
        shiftId: s.shiftId,
        userId: s.userId,
        userName: s.userName,
        shiftType: s.shiftType,
        expectedCash: s.expectedCash,
        isMine: Number(s.userId) === Number(ctx.user.id),
      }));
    }),

  /**
   * تنفيذ مرتجع مبيعات فوري عبر سلة المنتجات الذكية
   * يدعم: إدخال رقم فاتورة اختياري، ربط عميل CRM أو زبون عابر، تحديد مسار الصنف (رجوع للرف أو تالف مسجل خسارة)
   * طرق الاسترداد: نقدي، بطاقة، رصيد متجر
   */
  executeSalesReturnCart: returnsProcedure
    .input(
      z.object({
        invoiceNumber: z.string().trim().max(64).nullish(),
        customer: z
          .object({
            customerId: z.number().int().positive().nullish(),
            name: z.string().trim().max(120).nullish(),
            phone: z.string().trim().max(40).nullish(),
          })
          .nullish(),
        disposition: z.enum(["RESTOCK", "DAMAGED"]).default("RESTOCK"),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive().optional(),
              invoiceItemId: z.number().int().positive().optional(),
              productName: z.string().min(1),
              barcode: z.string().nullish(),
              quantity: z.number().int().positive(),
              unitPrice: nonNegMoneyString,
            }),
          )
          .min(1, "يجب تحديد صنف واحد على الأقل للإرجاع"),
        settlement: z.object({
          method: z.enum(["CASH", "CARD", "STORE_CREDIT", "CREDIT_OFFSET"]),
          totalAmount: nonNegMoneyString,
          shiftId: z.number().int().positive().nullish(),
          reference: z.string().trim().max(120).nullish(),
        }),
        reason: z.string().trim().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // عزلُ الفرع صارم: كلُّ مسارٍ نقديٍّ/مخزنيٍّ يلزمه فرعٌ مُسنَد صريح — لا افتراضَ صامتٌ
      // (`?? 1` بابُ IDOR تاريخيّ يحرسه check:branch). المشرفُ (admin) بلا فرعٍ يمرّ من
      // `salesCashierProcedure` (`requireOwnBranch` يستثنيه) فيُرفَض هنا صراحةً: أيَّ درجٍ
      // ومخزونِ أيِّ فرعٍ سيَمَسّ مرتجعٌ نُفِّذ بلا فرع؟
      if (ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر تنفيذ مرتجع المبيعات",
            why: "لا يوجد فرع مُسنَد لحسابك الحالي",
            doThis:
              "سجّل الدخول بحسابٍ مُسنَدٍ لفرعٍ تشغيليّ لتنفيذ المرتجع النقديّ/المخزنيّ",
          }),
        });
      }
      const actorBranchId = Number(ctx.user.branchId);
      const clientRequestId = input.clientRequestId?.trim() || null;
      const requestFingerprint = clientRequestId ? idempotencyHash(input) : null;

      return retryOnDup(async () => {
        return withTx(
          async (tx) => {
            // ١. الفحص الأولي للـ Idempotency قبل أخذ أي أقفال
            if (clientRequestId) {
              const existingRefId = await checkIdempotency(
                tx,
                "sale.return_cart",
                clientRequestId,
                requestFingerprint,
              );
              if (existingRefId != null) {
                return replaySalesReturnCartResult(
                  tx,
                  existingRefId,
                  input,
                  actorBranchId,
                );
              }
            }

            const currentOperationUser = await loadOperationUserTx(tx, ctx.user.id);
            const currentApprovalAllowed = currentOperationUser.isOwner === true || (
              storedCanonicalOperationAllowed(currentOperationUser, "salesControl.approve") ??
              moduleAccessAllowed(
                currentOperationUser.role,
                currentOperationUser.permissionsOverride as PermissionMap | null,
                "sales",
                "FULL",
                ["manager", "admin"],
              )
            );
            const directLimitsApply = !currentApprovalAllowed;
            const currentOperationalAuthority = await loadCurrentOperationalAuthorityTx(
              tx,
              ctx.user.id,
            );
            if (
              (currentOperationalAuthority.branchId !== actorBranchId ||
                currentOperationalAuthority.role !== ctx.user.role)
            ) {
              throw new TRPCError({
                code: "CONFLICT",
                message: appErrorMessage({
                  what: "تعذر تثبيت تفويض المرتجع",
                  why: "تغير دور الحساب أو فرعه أثناء تنفيذ المرتجع",
                  doThis: "حدث الصفحة وأعد المرتجع بصلاحيات الحساب الحالية",
                }),
              });
            }
            const legacyCartReturnAllowed =
              moduleAccessAllowed(
                currentOperationUser.role,
                currentOperationUser.permissionsOverride as PermissionMap | null,
                "sales",
                "FULL",
                ["cashier", "manager"],
              ) ||
              moduleAccessAllowed(
                currentOperationUser.role,
                currentOperationUser.permissionsOverride as PermissionMap | null,
                "workorders",
                "FULL",
                ["cashier", "manager", "print_operator"],
              ) ||
              moduleAccessAllowed(
                currentOperationUser.role,
                currentOperationUser.permissionsOverride as PermissionMap | null,
                "pos",
                "FULL",
                ["cashier", "manager", "print_operator"],
              );
            const canonicalCartReturnAllowed = await assertOperationAuthorityTx(
              tx,
              {
                userId: ctx.user.id,
                branchId: actorBranchId,
                role: ctx.user.role,
              },
              "returns.executeSalesReturnCart",
              legacyCartReturnAllowed,
            );
            const currentCartReturnAllowed =
              canonicalCartReturnAllowed || legacyCartReturnAllowed;

            await assertPeriodOpen(tx, new Date());

          const now = new Date();
          const randSuffix = Math.floor(1000 + Math.random() * 9000);
          const returnNumber = `SR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${randSuffix}`;

          const customerName = input.customer?.name?.trim() || "زبون عابر";
          const customerPhone = input.customer?.phone?.trim() || null;
          const returnReason =
            input.reason?.trim() ||
            (input.disposition === "RESTOCK"
              ? "مرتجع مبيعات — إعادة للرف"
              : "مرتجع مبيعات — إتلاف وتسجيل خسارة");
          const returnTotalDec = new Decimal(input.settlement.totalAmount);
          if (returnTotalDec.lte(0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "مبلغ المرتجع غير صالح",
                why: "يجب أن يكون إجمالي مبلغ المرتجع أكبر من صفر",
                doThis: "تحقق من كميات وأسعار الأصناف في سلة المرتجع",
              }),
            });
          }

          if (
            !input.invoiceNumber?.trim() &&
            input.settlement.method === "STORE_CREDIT"
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "تعذر إيداع رصيد المتجر",
                why: "إيداع رصيد المتجر يتطلّب ربطَ المرتجع بالفاتورة الأصليّة — لا يُنشأ رصيدٌ دائنٌ لعميلٍ بلا بيعٍ موثَّق",
                doThis:
                  "أدخل رقم الفاتورة الأصليّة، أو اختر استرداداً نقدياً/بالبطاقة للمرتجع العابر",
              }),
            });
          }
          if (
            !input.invoiceNumber?.trim() &&
            input.settlement.method === "CREDIT_OFFSET"
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "تعذر تنفيذ معادلة الذمة",
                why: "طريقة معادلة الذمم تتطلب ربط المرتجع بالفاتورة الأصلية الآجلة",
                doThis:
                  "أدخل رقم الفاتورة الأصلية، أو اختر استرداداً نقدياً/بالبطاقة للمرتجع العابر",
              }),
            });
          }
          const cartVariantIds = Array.from(
            new Set(input.items.map((i) => Number(i.variantId))),
          );
          if (cartVariantIds.length > 0) {
            const digitalProductRows = await tx
              .select({
                variantId: productVariants.id,
                productName: products.name,
              })
              .from(productVariants)
              .innerJoin(products, eq(productVariants.productId, products.id))
              .where(
                and(
                  inArray(productVariants.id, cartVariantIds),
                  eq(products.productType, "DIGITAL_CARD"),
                ),
              );
            if (digitalProductRows.length > 0) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذّر تسجيل المرتجع",
                  why: `السلة تحوي ${digitalProductRows.length} صنفاً من الكروت الرقمية، والكرت يصدر من جهاز المزوّد وقد يكون استُهلك — فإعادته عكسٌ ماليّ يحتاج تأكيد المزوّد لا إعادةَ بضاعةٍ إلى الرفّ`,
                  doThis:
                    "أزِل بنود الكروت من هذا المرتجع وأرجِع بقيّة الأصناف؛ ثمّ افتح شاشة «عكس بيع الكروت» ليقرّرها المدير مع المزوّد",
                }),
              });
            }
          }
          if (!input.invoiceNumber?.trim()) {
            let computedWalkInTotal = money(0);
            for (const itm of input.items) {
              const itemUnitPrice = money(itm.unitPrice);
              if (itemUnitPrice.lte(0)) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: "سعر الصنف المرتجع غير صالح",
                    why: `يجب أن يكون سعر الوحدة للصنف «${itm.productName}» أكبر من صفر في المرتجع العابر`,
                    doThis:
                      "تحقق من سعر الصنف في سلة المرتجع أو اربط المرتجع بالفاتورة الأصلية",
                  }),
                });
              }
              computedWalkInTotal = computedWalkInTotal.plus(
                itemUnitPrice.times(itm.quantity),
              );
            }
            const roundedWalkInTotal = round2(computedWalkInTotal);
            if (!round2(returnTotalDec).eq(roundedWalkInTotal)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "مبلغ تسوية المرتجع غير مطابق لمجموع السلة",
                  why: `مبلغ التسوية (${round2(returnTotalDec).toFixed(2)} د.ع) لا يطابق مجموع كميات وأسعار الأصناف في السلة (${roundedWalkInTotal.toFixed(2)} د.ع)`,
                  doThis:
                    "أعد احتساب السلة وتأكد من تطابق إجمالي التسوية مع مجموع البنود قبل تنفيذ المرتجع",
                }),
              });
            }
          }
          if (directLimitsApply && !input.invoiceNumber?.trim()) {
            for (const itm of input.items) {
              const itemUnitPrice = money(itm.unitPrice);
              const [unitRow] =
                itm.productUnitId != null
                  ? await tx
                      .select({ id: productUnits.id })
                      .from(productUnits)
                      .where(
                        and(
                          eq(productUnits.id, itm.productUnitId),
                          eq(productUnits.variantId, itm.variantId),
                        ),
                      )
                      .limit(1)
                  : await tx
                      .select({ id: productUnits.id })
                      .from(productUnits)
                      .where(
                        and(
                          eq(productUnits.variantId, itm.variantId),
                          eq(productUnits.isBaseUnit, true),
                        ),
                      )
                      .limit(1);
              const [retailPriceRow] = unitRow
                ? await tx
                    .select({ price: productPrices.price })
                    .from(productPrices)
                    .where(
                      and(
                        eq(productPrices.productUnitId, unitRow.id),
                        eq(productPrices.priceTier, "RETAIL"),
                      ),
                    )
                    .limit(1)
                : [undefined];
              const catalogRetailPrice =
                retailPriceRow?.price != null
                  ? round2(money(retailPriceRow.price))
                  : null;
              if (
                catalogRetailPrice == null ||
                catalogRetailPrice.lte(0) ||
                !round2(itemUnitPrice).eq(catalogRetailPrice)
              ) {
                throw new TRPCError({
                  code: "PRECONDITION_FAILED",
                  message: appErrorMessage({
                    what: "يتطلب المرتجع موافقة المدير",
                    why:
                      catalogRetailPrice == null || catalogRetailPrice.lte(0)
                        ? `الصنف «${itm.productName}» لا يملك سعر بيع تجزئة معتمداً في الكتالوج للمرتجع العابر بلا فاتورة`
                        : `سعر الوحدة المدخل للصنف «${itm.productName}» (${round2(itemUnitPrice).toFixed(2)} د.ع) يختلف عن سعر البيع المعتمد (${catalogRetailPrice.toFixed(2)} د.ع) في المرتجع العابر بلا فاتورة`,
                    doThis:
                      "التزم بسعر البيع المعتمد للصنف في المرتجع العابر، أو اربط المرتجع بالفاتورة الأصلية ليعتمده المدير",
                  }),
                });
              }
            }
            let walkInDrawerHasFunds = true;
            let walkInSameOpenShift = input.settlement.method !== "CASH";
            if (input.settlement.method === "CASH") {
              const walkInShiftId =
                input.settlement.shiftId ??
                (await openShiftIdTx(tx, ctx.user.id, actorBranchId));
              if (walkInShiftId != null) {
                const [walkInShift] = await tx
                  .select()
                  .from(shifts)
                  .where(
                    and(
                      eq(shifts.id, Number(walkInShiftId)),
                      eq(shifts.branchId, actorBranchId),
                    ),
                  )
                  .for("update")
                  .limit(1);
                walkInSameOpenShift =
                  walkInShift != null &&
                  walkInShift.status === "OPEN" &&
                  Number(walkInShift.userId) === Number(ctx.user.id);
                if (walkInSameOpenShift && returnTotalDec.gt(0)) {
                  const lockedDrawer = await lockCashSourceForUpdate(tx, {
                    branchId: actorBranchId,
                    cashBucket: "DRAWER",
                    shiftId: Number(walkInShiftId),
                  });
                  walkInDrawerHasFunds = (
                    await computeDrawerCashBalance(
                      tx,
                      Number(walkInShiftId),
                      lockedDrawer.openingBalance ?? "0",
                    )
                  ).gte(returnTotalDec);
                }
              }
            }
            const walkInDecision = evaluateRefundOperationalDecision({
              operationAllowed: currentCartReturnAllowed,
              sameBranch: true,
              ownsTransaction: true,
              sameOpenShift: walkInSameOpenShift,
              cashSourceReady: walkInSameOpenShift,
              sameBusinessDay: true,
              accountingPeriodOpen: true,
              hasDownstreamEffects: false,
              hasSourceDocument: true,
              refundAmountIqd: returnTotalDec.toFixed(2),
              maxRefundAmountIqd:
                currentOperationalAuthority.caps.maxRefundAmountIqd,
              refundMethod: input.settlement.method,
              originalPaymentMethods: [input.settlement.method],
              originalPaymentAmounts: {
                [input.settlement.method]: returnTotalDec.toFixed(2),
              },
              drawerHasFunds: walkInDrawerHasFunds,
              approvalOperation: "salesControl.requestReturn",
            });
            if (walkInDecision.result !== "DIRECT") {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: appErrorMessage({
                  what: "يتطلب المرتجع موافقة المدير",
                  why: walkInDecision.reason,
                  doThis:
                    "تحقق من التزام المرتجع بسقف الاسترداد المسموح وتوفر النقد في درج ورديتك، أو اربط المرتجع بالفاتورة الأصلية ليعتمده المدير",
                }),
              });
            }
          }
          // ٠) التحقق من الفاتورة الأصلية إن أدخلت وفرض الحوكمة المالية الصارمة
          let matchedInvoice: typeof invoices.$inferSelect | null = null;
          let matchedDeliveryPreview: {
            id: number;
            partyId: number;
            branchId: number;
            invoiceId: number;
            consignmentNumber: string;
            codAmount: string;
            collectedAmount: string | null;
            counterSettledAmount: string | null;
            status: string;
            parcelStatus: string;
            moneyStatus:
              | "NOT_APPLICABLE"
              | "UNSETTLED"
              | "PARTIAL"
              | "SETTLED"
              | "CANCELLED"
              | "WRITTEN_OFF";
            remittanceId: number | null;
            custodyRecognizedAt?: Date | null;
          } | null = null;
          let invoiceItemRows: Array<typeof invoiceItems.$inferSelect> = [];
          const resolvedBaseQtyByItem = new Map<any, number>();
          const resolvedRevenueByItem = new Map<any, Decimal>();
          let returnedTaxDec = money(0);
          let matchedSourcePaid = money(0);
          let matchedDebtAndCustodyCap = money(0);
          let matchedActualPayout = money(0);
          let useInvoiceReturnCore = false;
          let coreLines: Array<{ invoiceItemId: number; baseQuantity: number }> = [];
          let generatedReceiptId: number | null = null;
          let returnLedgerEntryId = 0;
          if (input.invoiceNumber?.trim()) {
            const rawNo = input.invoiceNumber.trim();
            const strippedNo = rawNo.replace(/^INV-/i, "");
            const prefixedNo = `INV-${strippedNo}`;
            const cartInvoiceScope = returnInvoiceScopeForUser(
              currentOperationUser,
              "returns.executeSalesReturnCart",
            );
            const cartInvoiceChannelCondition =
              buildInvoiceChannelCondition(cartInvoiceScope);

            // ١) قراءة الفاتورة أولاً دون قفل لمعرفة المعرّف والإرسالية:
            const [invPreview] = await tx
              .select({
                id: invoices.id,
                branchId: invoices.branchId,
                status: invoices.status,
                sourceType: invoices.sourceType,
              })
              .from(invoices)
              .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
              .where(
                and(
                  or(
                    eq(invoices.invoiceNumber, rawNo),
                    eq(invoices.invoiceNumber, strippedNo),
                    eq(invoices.invoiceNumber, prefixedNo),
                  ),
                  cartInvoiceScope ? cartInvoiceChannelCondition : sql`1=0`,
                ),
              )
              .limit(1);

            if (!invPreview) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: appErrorMessage({
                  what: "تعذر العثور على الفاتورة المحددة",
                  why: `لا توجد فاتورة بالرقم «${input.invoiceNumber.trim()}» مسجلة في النظام`,
                  doThis: "تأكد من صحة رقم الفاتورة أو رمز الباركود المدخل",
                }),
              });
            }

            if (invPreview.sourceType === "WORKORDER") {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: appErrorMessage({
                  what: "تعذّر تسجيل المرتجع",
                  why: "فاتورة أمر الشغل لا تقبل المرتجع المباشر من مسار المبيعات",
                  doThis: "توجّه إلى شاشة أمر الشغل ونفّذ عكس التسليم من هناك",
                }),
              });
            }

            // ٢) الترتيب الصارم للأقفال منعاً للـ Deadlock مع مسار التوريد:
            // party → consignment → invoice
            const [deliveryPreview] = await tx
              .select({
                id: deliveryConsignments.id,
                partyId: deliveryConsignments.partyId,
                branchId: deliveryConsignments.branchId,
                invoiceId: deliveryConsignments.invoiceId,
                consignmentNumber: deliveryConsignments.consignmentNumber,
                codAmount: deliveryConsignments.codAmount,
                collectedAmount: deliveryConsignments.collectedAmount,
                counterSettledAmount: deliveryConsignments.counterSettledAmount,
                status: deliveryConsignments.status,
                parcelStatus: deliveryConsignments.parcelStatus,
                moneyStatus: deliveryConsignments.moneyStatus,
                remittanceId: deliveryConsignments.remittanceId,
                custodyRecognizedAt: deliveryConsignments.custodyRecognizedAt,
              })
              .from(deliveryConsignments)
              .where(
                and(
                  eq(deliveryConsignments.invoiceId, invPreview.id),
                  ne(deliveryConsignments.status, "CANCELLED"),
                ),
              )
              .limit(1);

            if (deliveryPreview) {
              // أ) قفل جهة التوصيل أولاً
              await tx
                .select({ id: deliveryParties.id })
                .from(deliveryParties)
                .where(eq(deliveryParties.id, Number(deliveryPreview.partyId)))
                .for("update")
                .limit(1);

              // ب) قفل الإرسالية ثانياً
              const [lockedDelivery] = await tx
                .select({
                  id: deliveryConsignments.id,
                  partyId: deliveryConsignments.partyId,
                  branchId: deliveryConsignments.branchId,
                  invoiceId: deliveryConsignments.invoiceId,
                  consignmentNumber: deliveryConsignments.consignmentNumber,
                  codAmount: deliveryConsignments.codAmount,
                  collectedAmount: deliveryConsignments.collectedAmount,
                  counterSettledAmount: deliveryConsignments.counterSettledAmount,
                  status: deliveryConsignments.status,
                  parcelStatus: deliveryConsignments.parcelStatus,
                  moneyStatus: deliveryConsignments.moneyStatus,
                  remittanceId: deliveryConsignments.remittanceId,
                  custodyRecognizedAt: deliveryConsignments.custodyRecognizedAt,
                })
                .from(deliveryConsignments)
                .where(eq(deliveryConsignments.id, Number(deliveryPreview.id)))
                .for("update")
                .limit(1);
              const currentDelivery = lockedDelivery ?? deliveryPreview;
              if (currentDelivery.invoiceId == null) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر ربط مرتجع الفاتورة", why: "الإرسالية لا تحمل فاتورة بيع حالية", doThis: "افتح مستند مصدر الإرسالية واستخدم مسار رجوع طلب التجهيز أو المعالجة المخصص" }) });
              matchedDeliveryPreview = { ...currentDelivery, invoiceId: currentDelivery.invoiceId };
            } else {
              // قفل فجوة الإرسالية
              await tx
                .select({ id: deliveryConsignments.id })
                .from(deliveryConsignments)
                .where(eq(deliveryConsignments.invoiceId, invPreview.id))
                .for("update");
            }

            // ج) قفل الفاتورة ثالثاً بعد التوصيل (party → consignment → invoice)
            const [found] = await tx
              .select()
              .from(invoices)
              .where(eq(invoices.id, invPreview.id))
              .for("update")
              .limit(1);

            if (!found) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: appErrorMessage({
                  what: "تعذر العثور على الفاتورة المحددة",
                  why: `لا توجد فاتورة بالرقم «${input.invoiceNumber.trim()}» مسجلة في النظام`,
                  doThis: "تأكد من صحة رقم الفاتورة أو رمز الباركود المدخل",
                }),
              });
            }

            if (cartInvoiceScope === "reception" || cartInvoiceScope === "print") {
              const [lockedShift] =
                found.shiftId != null
                  ? await tx
                      .select({ shiftType: shifts.shiftType })
                      .from(shifts)
                      .where(eq(shifts.id, Number(found.shiftId)))
                      .limit(1)
                  : [];
              const lockedChannel = deriveInvoiceChannel({
                sourceType: found.sourceType,
                shiftType: lockedShift?.shiftType,
              });
              const channelMatches =
                cartInvoiceScope === "reception"
                  ? lockedChannel === "RECEPTION"
                  : lockedChannel === "PRINT";
              if (!channelMatches) {
                throw new TRPCError({
                  code: "NOT_FOUND",
                  message: appErrorMessage({
                    what: "تعذر العثور على الفاتورة المحددة",
                    why: `لا توجد فاتورة بالرقم «${input.invoiceNumber.trim()}» مسجلة في النظام`,
                    doThis: "تأكد من صحة رقم الفاتورة أو رمز الباركود المدخل",
                  }),
                });
              }
            }

            if (found.sourceType === "WORKORDER") {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: appErrorMessage({
                  what: "تعذّر تسجيل المرتجع",
                  why: "فاتورة أمر الشغل لا تقبل المرتجع المباشر من مسار المبيعات",
                  doThis: "توجّه إلى شاشة أمر الشغل ونفّذ عكس التسليم من هناك",
                }),
              });
            }

            if (
              ctx.user.role !== "admin" &&
              found.branchId != null &&
              Number(found.branchId) !== actorBranchId
            ) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: appErrorMessage({
                  what: "تعذر إرجاع الفاتورة من هذا الفرع",
                  why: `الفاتورة صادرة من الفرع رقم (${Number(found.branchId)}) وأنت تعمل على الفرع (${actorBranchId}). يُحظر إرجاع فواتير الفروع الأخرى بدون صلاحية إدارية لمنع تكرار الصرف واختلال صناديق الفروع`,
                  doThis:
                    "وجّه العميل إلى الفرع المصدِر للفاتورة أو اطلب من المدير العام تنفيذ المرتجع بصلاحيته العابرة للفروع. يُحظر صرف مرتجع عابر لفاتورة مسجلة بفرع آخر منعاً لازدواجية الصرف",
                }),
              });
            }

            // ٢. إعادة الفحص بعد قفل الفاتورة (Post-Lock Check)
            // يمنع سباق نقرتين متزامنتين انتظر أحدهما قفل الفاتورة
            if (clientRequestId) {
              const existingAfterLock = await checkIdempotency(
                tx,
                "sale.return_cart",
                clientRequestId,
                requestFingerprint,
                { forUpdate: true },
              );
              if (existingAfterLock != null) {
                return replaySalesReturnCartResult(
                  tx,
                  existingAfterLock,
                  input,
                  actorBranchId,
                );
              }
            }

            if (isDeadInvoice(found.status)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "لا يمكن تنفيذ مرتجع على هذه الفاتورة",
                  why: `حالة الفاتورة الحالية هي (${found.status})، وهي فاتورة ملغاة أو مستبدلة أو مرجعة بالكامل مسبقاً`,
                  doThis: "تحقق من سجل الفاتورة الأصلي لتفادي تكرار المرتجع",
                }),
              });
            }

            matchedInvoice = found;
            if (input.customer?.customerId != null && Number(input.customer.customerId) !== Number(found.customerId ?? 0)) {
              throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
                what: "عميل المرتجع لا يطابق الفاتورة",
                why: "تسوية المرتجع تتبع صاحب الفاتورة المسجل ولا تنتقل إلى حساب آخر",
                doThis: "اترك الزبون العابر بلا حساب أو استخدم عميل الفاتورة نفسها",
              }) });
            }
            const [pendingControl] = await tx.select({ id: salesControlRequests.id }).from(salesControlRequests)
              .where(and(eq(salesControlRequests.invoiceId, found.id), eq(salesControlRequests.status, "PENDING"))).for("update").limit(1);
            const [pendingLegacy] = await tx.select({ id: returnRequests.id }).from(returnRequests)
              .where(and(eq(returnRequests.invoiceId, found.id), eq(returnRequests.status, "PENDING_APPROVAL"))).for("update").limit(1);
            if (pendingControl || pendingLegacy) {
              throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
                what: "توجد معاملة رقابية معلّقة على هذه الفاتورة",
                why: "لا ينفذ مرتجع جديد قبل حسم الطلب السابق",
                doThis: "اسحب طلبك السابق صراحة أو افتحه لمراجعته ثم أعد تحميل الفاتورة",
              }) });
            }
            if (input.settlement.method === "STORE_CREDIT" && !input.customer?.customerId) {
              throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({
                what: "تعذر إيداع رصيد المتجر",
                why: "طريقة استرداد رصيد المتجر تتطلب تحديد عميل مسجل في النظام لإيداع الرصيد في حسابه",
                doThis: "اختر عميل الفاتورة المسجل أو حدد طريقة استرداد نقدي",
              }) });
            }
            await assertPeriodOpen(tx, matchedInvoice.invoiceDate);
            await assertNoActiveInstallmentPlanAfterInvoiceLockTx(tx, {
              invoiceId: Number(matchedInvoice.id),
              operationLabel: "إرجاع الفاتورة كلياً أو جزئياً",
            });

            const paidAmount = money(matchedInvoice.paidAmount ?? "0");
            const remainingUnpaidAmount = Decimal.max(
              0,
              money(matchedInvoice.total)
                .minus(money(matchedInvoice.returnedTotal ?? "0"))
                .minus(paidAmount),
            );
            const unremittedDeliveryCustody = matchedDeliveryPreview
              ? (
                  await remainingUnremittedDeliveryCustody(
                    tx,
                    Number(matchedDeliveryPreview.id),
                  )
                ).total
              : money(0);
            const maxCreditOffsetAmount = round2(
              remainingUnpaidAmount.plus(unremittedDeliveryCustody),
            );
            matchedDebtAndCustodyCap = maxCreditOffsetAmount;
            const lockedRefundCaps = await loadRefundCaps(tx, Number(matchedInvoice.id), { lock: true });
            matchedSourcePaid = Decimal.max(paidAmount, lockedRefundCaps.pool, unremittedDeliveryCustody);
            const debtOffsetPortionDec =
              input.settlement.method === "CASH" ||
              input.settlement.method === "CARD"
                ? Decimal.min(returnTotalDec, maxCreditOffsetAmount)
                : money(0);
            const actualRefundPayoutDec =
              input.settlement.method === "CASH" ||
              input.settlement.method === "CARD"
                ? round2(returnTotalDec.minus(debtOffsetPortionDec))
                : input.settlement.method === "CREDIT_OFFSET" ? money(0) : returnTotalDec;
            matchedActualPayout = (input.settlement.method === "CASH" || input.settlement.method === "CARD")
              ? actualRefundPayoutDec : money(0);

            if ((input.settlement.method === "CASH" || input.settlement.method === "CARD") && (actualRefundPayoutDec.lte(0) || actualRefundPayoutDec.gt(lockedRefundCaps.pool))) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "مبلغ الاسترداد يتجاوز المدفوع الفعلي للفاتورة",
                  why: `المبلغ المطلوب استرداده (${returnTotalDec.toFixed(2)} د.ع) أكبر من إجمالي المسدد فعلياً على الفاتورة (${paidAmount.toFixed(2)} د.ع)${paidAmount.lte(0) ? " — الفاتورة آجلة بالكامل ولم يُقبض منها أي مبلغ" : ""}`,
                  doThis: "لا يمكن صرف مبلغ يفوق ما قبضه المحل؛ استخدم معادلة الذمة للجزء الآجل",
                }),
              });
            }
            if (input.settlement.method === "CARD" && lockedRefundCaps.pool.gt(0) && (!directLimitsApply || (lockedRefundCaps.netByMethod.get("CARD") ?? money(0)).gt(0)) && actualRefundPayoutDec.gt(lockedRefundCaps.netByMethod.get("CARD") ?? money(0))) {
              const cardCap = lockedRefundCaps.netByMethod.get("CARD") ?? money(0);
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "مبلغ الاسترداد للبطاقة يتجاوز صافي المقبوض بالبطاقة",
                  why: `المبلغ المطلوب استرداده عبر البطاقة (${actualRefundPayoutDec.toFixed(2)} د.ع) أكبر من صافي ما قُبض بالبطاقة على هذه الفاتورة (${cardCap.toFixed(2)} د.ع)`,
                  doThis:
                    "استرد بالبطاقة في حدود المقبوض بالبطاقة فقط أو اختر النقد/رصيد المتجر للجزء المتبقي",
                }),
              });
            }
            if (input.settlement.method === "CREDIT_OFFSET" && returnTotalDec.gt(maxCreditOffsetAmount)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "مبلغ معادلة الذمة يتجاوز الرصيد القابل للعكس",
                  why: `المبلغ المطلوب (${returnTotalDec.toFixed(2)} د.ع) أكبر من مجموع الجزء الآجل والعهدة الحية غير الموردة (${maxCreditOffsetAmount.toFixed(2)} د.ع)`,
                  doThis: "خفّض مبلغ معادلة الذمة إلى الرصيد القابل للعكس، وعالج أي جزء مدفوع بطريقة الدفع الأصلية",
                }),
              });
            }

            if (directLimitsApply) {
              let drawerHasFunds = true;
              let effectiveShiftId: number | null = null;
              if (input.settlement.method === "CASH") {
                if (input.settlement.shiftId != null) {
                  const [selectedShift] = await tx
                    .select({
                      id: shifts.id,
                      userId: shifts.userId,
                      branchId: shifts.branchId,
                      status: shifts.status,
                    })
                    .from(shifts)
                    .where(eq(shifts.id, Number(input.settlement.shiftId)))
                    .limit(1);
                  if (
                    selectedShift != null &&
                    selectedShift.status === "OPEN" &&
                    Number(selectedShift.userId) === Number(ctx.user.id) &&
                    Number(selectedShift.branchId) ===
                      Number(matchedInvoice.branchId)
                  ) {
                    effectiveShiftId = Number(selectedShift.id);
                  }
                } else {
                  effectiveShiftId = await openShiftIdTx(
                    tx,
                    ctx.user.id,
                    Number(matchedInvoice.branchId),
                  );
                }
              }
              if (
                input.settlement.method === "CASH" &&
                effectiveShiftId != null &&
                actualRefundPayoutDec.gt(0)
              ) {
                const lockedDrawer = await lockCashSourceForUpdate(tx, {
                  branchId: Number(matchedInvoice.branchId),
                  cashBucket: "DRAWER",
                  shiftId: Number(effectiveShiftId),
                });
                drawerHasFunds = (await computeDrawerCashBalance(
                  tx,
                  Number(effectiveShiftId),
                  lockedDrawer.openingBalance ?? "0",
                )).gte(actualRefundPayoutDec);
              }
              const originalPaymentMethods = Array.from(
                new Set([
                  ...Array.from(lockedRefundCaps.netByMethod.entries())
                    .filter(([, amount]) => amount.gt(0))
                    .map(([method]) => method),
                  ...(maxCreditOffsetAmount.gt(0) ? ["CREDIT_OFFSET"] : []),
                ]),
              );
              const originalPaymentAmounts = Object.fromEntries([
                ...Array.from(lockedRefundCaps.netByMethod.entries())
                  .filter(([, amount]) => amount.gt(0))
                  .map(([method, amount]) => [method, amount.toFixed(2)] as const),
                ...(maxCreditOffsetAmount.gt(0)
                  ? [["CREDIT_OFFSET", maxCreditOffsetAmount.toFixed(2)] as const]
                  : []),
              ]);
              const decision = evaluateRefundOperationalDecision({
                operationAllowed: currentCartReturnAllowed,
                sameBranch: Number(matchedInvoice.branchId) === actorBranchId,
                ownsTransaction:
                  Number(matchedInvoice.createdBy) === Number(ctx.user.id),
                cashSourceReady: input.settlement.method !== "CASH" || effectiveShiftId != null,
                sameOpenShift:
                  input.settlement.method !== "CASH" ||
                  (effectiveShiftId != null &&
                    (lockedRefundCaps.cashNetByShift.get(Number(effectiveShiftId)) ?? money(0))
                      .gte(actualRefundPayoutDec)),
                sameBusinessDay:
                  matchedInvoice.invoiceDate.toISOString().slice(0, 10) ===
                  todayUtcDate(),
                accountingPeriodOpen: true,
                hasDownstreamEffects: false,
                hasSourceDocument: true,
                refundAmountIqd:
                  input.settlement.method === "CASH" ||
                  input.settlement.method === "CARD"
                    ? actualRefundPayoutDec.toFixed(2)
                    : input.settlement.method === "CREDIT_OFFSET" ? "0.00" : returnTotalDec.toFixed(2),
                sourcePaidAmountIqd: matchedSourcePaid.toFixed(2),
                maxRefundAmountIqd:
                  currentOperationalAuthority.caps.maxRefundAmountIqd,
                refundMethod: input.settlement.method,
                originalPaymentMethods,
                originalPaymentAmounts,
                drawerHasFunds,
                approvalOperation: "salesControl.requestReturn",
              });
              if (decision.result !== "DIRECT") {
                throw new TRPCError({
                  code: "PRECONDITION_FAILED",
                  message: appErrorMessage({
                    what: "يتطلب المرتجع موافقة المدير",
                    why: decision.reason,
                    doThis:
                      "أنشئ طلب المرتجع من شاشة الفاتورة ليُراجع ويُعتمد قبل التنفيذ",
                  }),
                });
              }
            }

            // الحارس المالي الصارم لمنع تضخيم المرتجع فوق قيمة الفاتورة:
            // 1) الحد الأقصى لقيمة المرتجع لا يمكن أن يتجاوز (إجمالي الفاتورة - المرتجع سابقاً)
            const remainingInvoiceTotal = Decimal.max(
              0,
              money(matchedInvoice.total).minus(
                money(matchedInvoice.returnedTotal ?? "0"),
              ),
            );
            if (remainingInvoiceTotal.lte(0)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "الفاتورة مُرتجَعة بالكامل مسبقاً",
                  why: `تم استرداد كامل قيمة الفاتورة (${money(matchedInvoice.total).toFixed(2)} د.ع)، ولا يوجد أي رصيد متبقٍ للإرجاع`,
                  doThis: "تحقق من سجل المرتجعات السابقة لهذه الفاتورة",
                }),
              });
            }
            if (returnTotalDec.gt(remainingInvoiceTotal)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "مبلغ المرتجع يتجاوز القيمة المتبقية للفاتورة",
                  why: `مبلغ المرتجع المطلوب (${returnTotalDec.toFixed(2)} د.ع) أكبر من المتبقي غير المرتجع للفاتورة (${remainingInvoiceTotal.toFixed(2)} د.ع من أصل إجمالي ${money(matchedInvoice.total).toFixed(2)} د.ع)`,
                  doThis:
                    "عدّل مبالغ وأصناف السلة لتكون ضمن حدود المتبقي الفعلي للفاتورة",
                }),
              });
            }

            // 3) التحقق من بنود الفاتورة وكمياتها بالوحدة الأساس وحساب معاملات التحويل
            invoiceItemRows = await tx
              .select()
              .from(invoiceItems)
              .where(eq(invoiceItems.invoiceId, matchedInvoice.id))
              .for("update");

            const digitalRows = await tx
              .select({ invoiceItemId: digitalSaleDetails.invoiceItemId })
              .from(digitalSaleDetails)
              .where(eq(digitalSaleDetails.invoiceId, matchedInvoice.id));
            const digitalItemIds = new Set(
              digitalRows.map((r) => Number(r.invoiceItemId)),
            );

            // تتبع تراكم الكميات المرتجعة لكل بند في السلة نفسها لمنع الالتفاف بتكرار البند
            const accumulatedReturnedByItemId = new Map<number, number>();
            const invSubtotalDec = money(matchedInvoice.subtotal ?? "0");
            const invDiscountDec = money(matchedInvoice.discountAmount ?? "0");
            const invTaxDec = money(matchedInvoice.taxAmount ?? "0");
            const invoiceMerchandiseRevenue = round2(
              Decimal.max(0, invSubtotalDec.minus(invDiscountDec)),
            );
            const revenueItems = invoiceItemRows
              .filter((item) => !item.isGift && money(item.total ?? "0").gt(0))
              .sort((a, b) => Number(a.id) - Number(b.id));
            const itemRevenueBasis = revenueItems.reduce(
              (sum, item) => sum.plus(money(item.total ?? "0")),
              money(0),
            );
            const netRevenueByItemId = new Map<number, Decimal>();
            const netTaxByItemId = new Map<number, Decimal>();
            let allocatedInvoiceRevenue = money(0);
            let allocatedInvoiceTax = money(0);
            for (let index = 0; index < revenueItems.length; index++) {
              const item = revenueItems[index]!;
              const lineRevenue =
                index === revenueItems.length - 1
                  ? round2(
                      invoiceMerchandiseRevenue.minus(allocatedInvoiceRevenue),
                    )
                  : round2(
                      invoiceMerchandiseRevenue
                        .times(money(item.total ?? "0"))
                        .div(itemRevenueBasis),
                    );
              const lineTax =
                index === revenueItems.length - 1
                  ? round2(invTaxDec.minus(allocatedInvoiceTax))
                  : round2(
                      invTaxDec
                        .times(money(item.total ?? "0"))
                        .div(itemRevenueBasis),
                    );
              allocatedInvoiceRevenue = allocatedInvoiceRevenue.plus(lineRevenue);
              allocatedInvoiceTax = allocatedInvoiceTax.plus(lineTax);
              netRevenueByItemId.set(Number(item.id), lineRevenue);
              netTaxByItemId.set(Number(item.id), lineTax);
            }
            let expectedInvoiceReturnTotal = new Decimal(0);

            for (const itm of input.items) {
              const targetItem = itm.invoiceItemId
                ? invoiceItemRows.find(
                    (ii) =>
                      ii.id === itm.invoiceItemId &&
                      ii.variantId === itm.variantId,
                  )
                : invoiceItemRows.find((ii) => ii.variantId === itm.variantId);

              if (!targetItem) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: "العنصر غير موجود في الفاتورة المرجعية",
                    why: `الصنف «${itm.productName}» (معرّف ${itm.variantId}) غير مدرج ضمن بنود الفاتورة المرجعية «${matchedInvoice.invoiceNumber}»`,
                    doThis:
                      "تحقق من الصنف الممسوح وتطابقه مع بنود الفاتورة المرجعية",
                  }),
                });
              }

              if (digitalItemIds.has(Number(targetItem.id))) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: "تعذّر تسجيل المرتجع",
                    why: "الفاتورة تحوي بنداً من الكروت الرقمية، والكرت يصدر من جهاز المزوّد وقد يكون استُهلك — فإعادته عكسٌ ماليّ يحتاج تأكيد المزوّد لا إعادةَ بضاعةٍ إلى الرفّ",
                    doThis:
                      "أزِل بنود الكروت من هذا المرتجع وأرجِع بقيّة الأصناف؛ ثمّ افتح شاشة «عكس بيع الكروت» ليقرّرها المدير مع المزوّد",
                  }),
                });
              }

              const totalBaseQty = Number(targetItem.baseQuantity ?? 0);
              const effectiveItemRevenue =
                netRevenueByItemId.get(Number(targetItem.id)) ?? money(0);
              const effectiveItemTax =
                netTaxByItemId.get(Number(targetItem.id)) ?? money(0);
              const effectiveItemTotal = round2(
                effectiveItemRevenue.plus(effectiveItemTax),
              );
              const effectiveBaseUnitPrice =
                totalBaseQty > 0
                  ? effectiveItemTotal
                      .dividedBy(totalBaseQty)
                      .toDecimalPlaces(2)
                  : money(0);
              const soldUnitEffectivePrice =
                Number(targetItem.quantity ?? 0) > 0
                  ? round2(
                      effectiveItemTotal.dividedBy(Number(targetItem.quantity)),
                    )
                  : money(targetItem.unitPrice ?? "0");
              const submittedUnitPrice = round2(money(itm.unitPrice));
              const fallbackUnitId =
                itm.productUnitId != null
                  ? itm.productUnitId
                  : totalBaseQty > Number(targetItem.quantity ?? 0) &&
                      submittedUnitPrice.lt(soldUnitEffectivePrice)
                    ? null
                    : targetItem.productUnitId;
              const { baseQuantity: effectiveBaseQty, conversionFactor } =
                await resolveReturnBaseQuantity(
                  tx,
                  itm,
                  fallbackUnitId,
                );

              // حفظ الكمية المحسوبة لإعادة استخدامها في حركات المخزون وتحديث الفاتورة
              resolvedBaseQtyByItem.set(itm, effectiveBaseQty);

              const priorReturned =
                accumulatedReturnedByItemId.get(targetItem.id) ??
                (targetItem.returnedBaseQuantity ?? 0);
              const remainingBaseQty =
                (targetItem.baseQuantity ?? 0) - priorReturned;

              if (effectiveBaseQty > remainingBaseQty) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: `كمية الصنف «${itm.productName}» تتجاوز المتبقي في الفاتورة`,
                    why: `الكمية المطلوب إرجاعها بالوحدة الأساس (${effectiveBaseQty}${conversionFactor > 1 ? ` = ${itm.quantity} × معامل ${conversionFactor}` : ""}) أكبر من الكمية المتبقية غير المرتجعة (${remainingBaseQty}) من أصل (${targetItem.baseQuantity}) تم بيعها`,
                    doThis: `قلل الكمية المرتجعة لهذا الصنف إلى ما يعادل ${remainingBaseQty} بالوحدة الأساس أو أقل`,
                  }),
                });
              }

              accumulatedReturnedByItemId.set(
                targetItem.id,
                priorReturned + effectiveBaseQty,
              );

              const cumulativeReturnedValue = (returnedQty: number): Decimal => {
                if (totalBaseQty <= 0) {
                  return round2(effectiveBaseUnitPrice.times(returnedQty));
                }
                if (returnedQty >= totalBaseQty) {
                  return effectiveItemTotal;
                }
                return round2(effectiveBaseUnitPrice.times(returnedQty));
              };
              const expectedLineTotal = round2(
                cumulativeReturnedValue(priorReturned + effectiveBaseQty).minus(
                  cumulativeReturnedValue(priorReturned),
                ),
              );
              const allocatedSliceTotal =
                totalBaseQty > 0
                  ? allocateLineCost(
                      effectiveItemTotal,
                      totalBaseQty,
                      priorReturned,
                      effectiveBaseQty,
                    )
                  : expectedLineTotal;
              const submittedLineTotal = round2(
                money(itm.unitPrice).times(itm.quantity),
              );
              const expectedSubmittedUnitPrice = round2(
                expectedLineTotal.dividedBy(itm.quantity),
              );
              const allocatedSubmittedUnitPrice = round2(
                allocatedSliceTotal.dividedBy(itm.quantity),
              );
              const linePriceMatches =
                submittedLineTotal.eq(expectedLineTotal) ||
                submittedLineTotal.eq(allocatedSliceTotal) ||
                submittedUnitPrice.eq(expectedSubmittedUnitPrice) ||
                submittedUnitPrice.eq(allocatedSubmittedUnitPrice) ||
                (priorReturned + effectiveBaseQty >= totalBaseQty &&
                  conversionFactor === 1 &&
                  submittedUnitPrice.eq(effectiveBaseUnitPrice));
              if (!linePriceMatches) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: `سعر إرجاع الصنف «${itm.productName}» لا يطابق سعر الفاتورة المرجعية`,
                    why: `قيمة البند المُدخلة (${submittedLineTotal.toFixed(2)} د.ع) تختلف عن القيمة الفعلية للبند في الفاتورة «${matchedInvoice.invoiceNumber}» (${expectedLineTotal.toFixed(2)} د.ع)`,
                    doThis:
                      "التزم بسعر البند الفعلي المسجّل في الفاتورة المرجعية وأعد احتساب السلة",
                  }),
                });
              }
              const matchedLineTotal = submittedLineTotal.eq(allocatedSliceTotal)
                ? allocatedSliceTotal
                : expectedLineTotal;
              const lineTax =
                totalBaseQty > 0 && effectiveItemTax.gt(0)
                  ? allocateLineCost(
                      effectiveItemTax,
                      totalBaseQty,
                      priorReturned,
                      effectiveBaseQty,
                    )
                  : money(0);
              resolvedRevenueByItem.set(
                itm,
                round2(Decimal.max(0, matchedLineTotal.minus(lineTax))),
              );
              returnedTaxDec = round2(returnedTaxDec.plus(lineTax));
              expectedInvoiceReturnTotal =
                expectedInvoiceReturnTotal.plus(matchedLineTotal);
            }

            const isFullSelection = invoiceItemRows.every((item) =>
              (accumulatedReturnedByItemId.get(Number(item.id)) ?? Number(item.returnedBaseQuantity ?? 0)) >= Number(item.baseQuantity));
            const itemExpectedTotal = round2(expectedInvoiceReturnTotal);
            const roundedExpectedInvoiceReturnTotal = isFullSelection
              ? round2(money(matchedInvoice.total).minus(money(matchedInvoice.returnedTotal ?? "0")))
              : itemExpectedTotal;
            if (!round2(returnTotalDec).eq(roundedExpectedInvoiceReturnTotal)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "مبلغ تسوية المرتجع غير مطابق لقيمة البنود المرتجعة من الفاتورة",
                  why: `مبلغ التسوية (${round2(returnTotalDec).toFixed(2)} د.ع) لا يطابق مجموع قيمة البنود المرتجعة وفق أسعار الفاتورة المرجعية (${roundedExpectedInvoiceReturnTotal.toFixed(2)} د.ع)`,
                  doThis:
                    "أعد احتساب السلة وتأكد من تطابق إجمالي التسوية مع قيمة البنود المرتجعة من الفاتورة",
                }),
              });
            }
            coreLines = invoiceItemRows.map((item) => ({
              invoiceItemId: Number(item.id),
              baseQuantity: (accumulatedReturnedByItemId.get(Number(item.id)) ?? Number(item.returnedBaseQuantity ?? 0)) - Number(item.returnedBaseQuantity ?? 0),
            })).filter((line) => line.baseQuantity > 0);
            useInvoiceReturnCore = (isFullSelection && !roundedExpectedInvoiceReturnTotal.eq(itemExpectedTotal)) ||
              (input.settlement.method === "CREDIT_OFFSET" && matchedInvoice.customerId == null);
          }

          if (useInvoiceReturnCore && matchedInvoice) {
            const coreReason = `${returnReason.slice(0, 430)} [${returnNumber}]`;
            const cashOrCard = input.settlement.method === "CASH" || input.settlement.method === "CARD";
            const refund = cashOrCard && matchedActualPayout.gt(0) ? {
              amount: matchedActualPayout.toFixed(2), method: input.settlement.method as "CASH" | "CARD",
              shiftId: input.settlement.shiftId ?? null, reference: input.settlement.reference ?? null,
            } : undefined;
            await returnSaleInTx(tx, {
              invoiceId: Number(matchedInvoice.id), lines: coreLines, restock: input.disposition === "RESTOCK",
              operatorReason: coreReason,
              ...(matchedInvoice.customerId == null ? { resolution: {
                kind: "IMMEDIATE_REFUND" as const, amount: matchedActualPayout.toFixed(2),
                method: cashOrCard ? input.settlement.method as "CASH" | "CARD" : "CASH" as const,
                shiftId: input.settlement.shiftId ?? null, reference: input.settlement.reference ?? null,
                reason: coreReason, disposition: input.disposition,
              } } : { refund }),
            }, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role },
            { requireUnpaidSource: directLimitsApply && matchedSourcePaid.isZero() });
            const [entry] = await tx.select({ id: accountingEntries.id }).from(accountingEntries)
              .where(and(eq(accountingEntries.invoiceId, matchedInvoice.id), eq(accountingEntries.entryType, "RETURN")))
              .orderBy(desc(accountingEntries.id)).limit(1);
            if (!entry) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: appErrorMessage({
              what: "تعذر إتمام المرتجع", why: "لم يكتب المرتجع قيده المرجعي",
              doThis: "حدّث الفاتورة وأعد العملية؛ تراجعت جميع آثار هذه المحاولة",
            }) });
            returnLedgerEntryId = Number(entry.id);
            if (matchedActualPayout.gt(0)) {
              const [out] = await tx.select({ id: receipts.id }).from(receipts)
                .where(and(eq(receipts.invoiceId, matchedInvoice.id), eq(receipts.direction, "OUT")))
                .orderBy(desc(receipts.id)).limit(1);
              generatedReceiptId = out ? Number(out.id) : null;
            }
          } else {
          // Keep the existing paid/independent-cart posting path; invoice core
          // execution above already owns all of its stock and financial effects.
          // ⭐ نسبةُ العميل في **الدفتر** (accountingEntries.customerId) لقيد صرف الاسترداد مشروطةٌ
          // بفاتورةٍ مطابقة: عندئذٍ يحمل القيدُ invoiceId فيُستبعَد من voucherSum في
          // reconcileCustomerBalances. بلا فاتورةٍ مطابقة، قيدُ PAYMENT_OUT بـcustomerId وinvoiceId=NULL
          // يُقرأ «سندَ صرفٍ يرفع AR» بينما لا رصيدَ يتحرّك ⇒ انحرافُ reconcile بقيمة المرتجع. النسبةُ
          // للعميل تبقى على **الإيصال** (partyId) لسلامة المسار (§٥). يحرسه salesReturnCartRefund.test.ts.
          const ledgerCustomerId = matchedInvoice
            ? (matchedInvoice.customerId ? Number(matchedInvoice.customerId) : null)
            : null;

          // ١) تنفيذ حركة المخزون لكل بند مع التوسيع الذري للبكجات وتفادي الخدمات
          const allVariantIds = Array.from(
            new Set(input.items.map((i) => i.variantId)),
          );
          const kindByVariant = await classifyVariants(tx, allVariantIds);

          const consignByVariant = new Map<number, number>();
          if (allVariantIds.length > 0) {
            const crows = await tx
              .select({
                vid: productVariants.id,
                isConsign: products.isConsignment,
                cId: products.consignorId,
              })
              .from(productVariants)
              .innerJoin(products, eq(productVariants.productId, products.id))
              .where(inArray(productVariants.id, allVariantIds));
            for (const row of crows) {
              if (row.isConsign && row.cId != null) {
                consignByVariant.set(Number(row.vid), Number(row.cId));
              }
            }
          }

          if (!matchedInvoice && consignByVariant.size > 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "تعذر تنفيذ مرتجع عابر لصنف أمانة",
                why: "أصناف الأمانة ترتبط باستحقاق مالي للمودِع على الفاتورة الأصلية ولا يمكن عكسها بدون مرجع البيع الأصلي",
                doThis:
                  "أدخل رقم الفاتورة الأصلية لتنفيذ مرتجع صنف الأمانة بدقة",
              }),
            });
          }

          const bundleVariantIds = allVariantIds.filter(
            (id) => kindByVariant.get(id) === "BUNDLE",
          );
          const bundleDefs =
            bundleVariantIds.length > 0
              ? await getBundleDefinitions(tx, bundleVariantIds)
              : new Map();

          const snapshotByItem = new Map<
            number,
            Array<{ componentVariantId: number; componentBaseQuantity: number }>
          >();
          if (matchedInvoice && bundleVariantIds.length > 0) {
            const bdlItemIds = invoiceItemRows
              .filter(
                (ii) => kindByVariant.get(Number(ii.variantId)) === "BUNDLE",
              )
              .map((ii) => Number(ii.id));

            if (bdlItemIds.length > 0) {
              const snapRows = await tx
                .select({
                  invoiceItemId: invoiceItemBundleComponents.invoiceItemId,
                  componentVariantId:
                    invoiceItemBundleComponents.componentVariantId,
                  componentBaseQuantity:
                    invoiceItemBundleComponents.componentBaseQuantity,
                })
                .from(invoiceItemBundleComponents)
                .where(
                  inArray(
                    invoiceItemBundleComponents.invoiceItemId,
                    bdlItemIds,
                  ),
                );

              for (const r of snapRows) {
                const iid = Number(r.invoiceItemId);
                const list = snapshotByItem.get(iid) ?? [];
                list.push({
                  componentVariantId: Number(r.componentVariantId),
                  componentBaseQuantity: Number(r.componentBaseQuantity),
                });
                snapshotByItem.set(iid, list);
              }
            }
          }

          const costLookupVariantIds = Array.from(
            new Set([
              ...allVariantIds,
              ...Array.from(bundleDefs.values()).flatMap((defs: any[]) =>
                defs.map((d) => Number(d.componentVariantId)),
              ),
              ...Array.from(snapshotByItem.values()).flatMap((snaps) =>
                snaps.map((s) => Number(s.componentVariantId)),
              ),
            ]),
          );
          const costPriceByVariantId = new Map<number, Decimal>();
          if (costLookupVariantIds.length > 0) {
            const variantCostRows = await tx
              .select({
                id: productVariants.id,
                costPrice: productVariants.costPrice,
              })
              .from(productVariants)
              .where(inArray(productVariants.id, costLookupVariantIds));
            for (const row of variantCostRows) {
              costPriceByVariantId.set(
                Number(row.id),
                money(row.costPrice ?? "0"),
              );
            }
          }

          let returnedCost = new Decimal(0);
          let returnedGiftCost = new Decimal(0);
          let nonRestoredServicePaidCost = new Decimal(0);
          let nonRestoredServiceGiftCost = new Decimal(0);
          const byConsignor = new Map<number, { paid: Decimal; gift: Decimal }>();
          const accumulatedCostReturnedByItemId = new Map<number, number>();

          for (const itm of input.items) {
            const kind = kindByVariant.get(itm.variantId) ?? "STOCKED";

            const targetItem = matchedInvoice
              ? itm.invoiceItemId
                ? invoiceItemRows.find(
                    (ii) =>
                      ii.id === itm.invoiceItemId &&
                      ii.variantId === itm.variantId,
                  )
                : invoiceItemRows.find((ii) => ii.variantId === itm.variantId)
              : undefined;

            const isGiftLine = Boolean(targetItem?.isGift);
            const effectiveBaseQty =
              resolvedBaseQtyByItem.get(itm) ??
              (await resolveReturnBaseQuantity(tx, itm)).baseQuantity;

            let components: Array<{
              componentVariantId: number;
              componentBaseQuantity: number;
            }> = [];

            if (kind === "BUNDLE") {
              if (itm.invoiceItemId && snapshotByItem.has(itm.invoiceItemId)) {
                components = snapshotByItem.get(itm.invoiceItemId)!;
              } else if (matchedInvoice) {
                const matchingInvItem = invoiceItemRows.find(
                  (ii) => ii.variantId === itm.variantId,
                );
                if (matchingInvItem && snapshotByItem.has(matchingInvItem.id)) {
                  components = snapshotByItem.get(matchingInvItem.id)!;
                }
              }

              // ملاذ آمن: إن لم توجد لقطة تاريخية، نستعمل وصفة البكج الحالية
              if (!components.length) {
                const def = bundleDefs.get(itm.variantId) ?? [];
                components = def.map((d: any) => ({
                  componentVariantId: Number(d.componentVariantId),
                  componentBaseQuantity: Number(d.componentBaseQuantity),
                }));
              }

              if (!components.length && input.disposition === "RESTOCK") {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: `تعذر إرجاع البكج «${itm.productName}» إلى المخزون`,
                    why: "البكج ليس له أي مكونات أو وصفة مسجلة في النظام",
                    doThis: "راجع وصفة البكج من صفحة تعديل المنتج أو اختر مسار تالف",
                  }),
                });
              }
            }

            let lineCostShare = money(0);
            if (targetItem) {
              const priorCostReturned =
                accumulatedCostReturnedByItemId.get(targetItem.id) ??
                Number(targetItem.returnedBaseQuantity ?? 0);
              accumulatedCostReturnedByItemId.set(
                targetItem.id,
                priorCostReturned + effectiveBaseQty,
              );
              if (
                targetItem.lineCost != null &&
                (targetItem.baseQuantity ?? 0) > 0
              ) {
                lineCostShare = allocateLineCost(
                  targetItem.lineCost,
                  Number(targetItem.baseQuantity),
                  priorCostReturned,
                  effectiveBaseQty,
                );
              } else if (money(targetItem.unitCost ?? "0").gt(0)) {
                lineCostShare = round2(
                  money(targetItem.unitCost).times(effectiveBaseQty),
                );
              } else {
                lineCostShare = money(0);
              }
            } else if (kind === "BUNDLE") {
              for (const comp of components) {
                const compUnitCost =
                  costPriceByVariantId.get(comp.componentVariantId) ??
                  money(0);
                if (
                  input.disposition === "RESTOCK" &&
                  directLimitsApply &&
                  !matchedInvoice &&
                  compUnitCost.lte(0)
                ) {
                  throw new TRPCError({
                    code: "PRECONDITION_FAILED",
                    message: appErrorMessage({
                      what: "يتطلب المرتجع موافقة المدير",
                      why: `مكوّن البكج «${itm.productName}» لا يملك كلفة شراء معتمدة في الكتالوج لتقييم إعادة المخزون في المرتجع العابر`,
                      doThis:
                        "اربط المرتجع بالفاتورة الأصلية أو اطلب اعتماد المدير لإرجاع الصنف إلى الرف",
                    }),
                  });
                }
                lineCostShare = lineCostShare.plus(
                  round2(
                    compUnitCost.times(
                      comp.componentBaseQuantity * effectiveBaseQty,
                    ),
                  ),
                );
              }
            } else if (kind !== "SERVICE") {
              const variantUnitCost =
                costPriceByVariantId.get(itm.variantId) ?? money(0);
              if (
                input.disposition === "RESTOCK" &&
                directLimitsApply &&
                !matchedInvoice &&
                variantUnitCost.lte(0)
              ) {
                throw new TRPCError({
                  code: "PRECONDITION_FAILED",
                  message: appErrorMessage({
                    what: "يتطلب المرتجع موافقة المدير",
                    why: `الصنف «${itm.productName}» لا يملك كلفة شراء معتمدة في الكتالوج لتقييم إعادة المخزون في المرتجع العابر`,
                    doThis:
                      "اربط المرتجع بالفاتورة الأصلية أو اطلب اعتماد المدير لإرجاع الصنف إلى الرف",
                  }),
                });
              }
              lineCostShare = round2(variantUnitCost.times(effectiveBaseQty));
            }

            if (isGiftLine) {
              returnedGiftCost = returnedGiftCost.plus(lineCostShare);
            } else {
              returnedCost = returnedCost.plus(lineCostShare);
            }

            const cId = consignByVariant.get(Number(itm.variantId));
            if (cId != null) {
              const current = byConsignor.get(cId) ?? {
                paid: new Decimal(0),
                gift: new Decimal(0),
              };
              if (isGiftLine) current.gift = current.gift.plus(lineCostShare);
              else current.paid = current.paid.plus(lineCostShare);
              byConsignor.set(cId, current);
            } else if (kind === "SERVICE") {
              if (isGiftLine) {
                nonRestoredServiceGiftCost =
                  nonRestoredServiceGiftCost.plus(lineCostShare);
              } else {
                nonRestoredServicePaidCost =
                  nonRestoredServicePaidCost.plus(lineCostShare);
              }
            }

            if (kind === "SERVICE" || input.disposition !== "RESTOCK") {
              continue;
            }

            if (kind === "BUNDLE") {
              for (const comp of components) {
                const compBaseQty =
                  comp.componentBaseQuantity * effectiveBaseQty;
                await applyMovement(tx, {
                  variantId: comp.componentVariantId,
                  branchId: actorBranchId,
                  baseQuantity: compBaseQty,
                  movementType: "RETURN",
                  referenceType: "SALES_RETURN",
                  documentNumber: returnNumber,
                  notes: `إرجاع مكوّن بكج للرف [${returnNumber}] — مكوّن من «${itm.productName}» (${customerName})`,
                  createdBy: ctx.user.id,
                });
              }
            } else {
              await applyMovement(tx, {
                variantId: itm.variantId,
                branchId: actorBranchId,
                baseQuantity: effectiveBaseQty,
                movementType: "RETURN",
                referenceType: "SALES_RETURN",
                documentNumber: returnNumber,
                notes: `إرجاع للرف [${returnNumber}] — ${itm.productName} (${customerName})`,
                createdBy: ctx.user.id,
              });
            }
          }

          // ٢) معالجة التسوية المالية وحركة الصندوق/الدرج/البطاقة/رصيد المتجر
          const splitDebtOffsetDec =
            matchedInvoice &&
            (input.settlement.method === "CASH" ||
              input.settlement.method === "CARD")
              ? Decimal.min(returnTotalDec, matchedDebtAndCustodyCap)
              : money(0);
          const effectivePayoutDec =
            matchedInvoice &&
            (input.settlement.method === "CASH" ||
              input.settlement.method === "CARD")
              ? round2(returnTotalDec.minus(splitDebtOffsetDec))
              : returnTotalDec;

          if (input.settlement.method === "CASH") {
            let targetShiftId = input.settlement.shiftId;
            if (!targetShiftId) {
              const myShift = await openShiftIdTx(tx, ctx.user.id, actorBranchId);
              if (myShift) {
                targetShiftId = myShift;
              } else {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: appErrorMessage({
                    what: "تعذر الصرف النقدي للمرتجع",
                    why: "لم يتم تحديد درج النقدية / الوردية التي سيتم صرف المبلغ منها ولا توجد وردية مفتوحة للمستخدم",
                    doThis:
                      "اختر درج النقدية / الوردية المفتوحة من القائمة قبل التأكيد أو افتح وردية في الفرع",
                  }),
                });
              }
            }

            const [targetShift] = await tx
              .select()
              .from(shifts)
              .where(
                and(
                  eq(shifts.id, targetShiftId),
                  eq(shifts.branchId, actorBranchId),
                ),
              )
              .for("update")
              .limit(1);

            if (!targetShift || targetShift.status !== "OPEN") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر الصرف من الدرج المحدد",
                  why: "الوردية المحددة غير موجودة أو مغلقة حالياً",
                  doThis:
                    "اختر وردية مفتوحة سارية في الفرع أو افتح وردية جديدة للكاشير",
                }),
              });
            }

            if (
              directLimitsApply &&
              Number(targetShift.userId) !== Number(ctx.user.id)
            ) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: appErrorMessage({
                  what: "يتطلب الرد النقدي موافقة المدير",
                  why: "الدرج المحدد لا يخص وردية منفذ المرتجع",
                  doThis:
                    "اصرف الرد من ورديتك المفتوحة المرتبطة بالفاتورة أو أحِل المرتجع للمدير",
                }),
              });
            }

            // فحص كفاية النقد في الدرج لمنع العجز والكسر المالي
            await assertCashOutAvailable(tx, {
              branchId: actorBranchId,
              cashBucket: "DRAWER",
              shiftId: targetShiftId,
              amount: effectivePayoutDec,
              operation: `استرداد نقدي لمرتجع مبيعات [${returnNumber}]`,
            });

            // تسجيل سند إخراج نقد من الدرج (OUT) لضبط Z-report وcomputeExpectedCash بالمليم
            generatedReceiptId = await recordSalesReturnCartReceipt(tx, {
              branchId: actorBranchId,
              shiftId: targetShiftId,
              amount: effectivePayoutDec,
              returnNumber,
              customerName,
              customerId: input.customer?.customerId,
              invoiceId: matchedInvoice?.id ?? null,
              userId: ctx.user.id,
            });

            // قيد صرف النقد من الخزينة/الدرج في الأستاذ العام
            const refundPostingSource = splitDebtOffsetDec.isZero()
              ? {
                  roleDebits: { AR: returnTotalDec },
                  roleCredits: { CASH: returnTotalDec },
                }
              : {
                  roleDebits: { AR: effectivePayoutDec },
                  roleCredits: { CASH: effectivePayoutDec },
                };
            await postEntry(tx, {
              entryType: "PAYMENT_OUT",
              branchId: actorBranchId,
              invoiceId: matchedInvoice?.id ?? null,
              receiptId: generatedReceiptId,
              customerId: ledgerCustomerId,
              amount: effectivePayoutDec,
              notes: `صرف نقدي لمرتجع مبيعات [${returnNumber}] من درج #${targetShiftId}`,
              createdBy: ctx.user.id,
              createdByNameSnapshot: ctx.user.name ?? "كاشير",
              postingIntent: createPostingIntent(
                "PAYMENT_OUT_CUSTOMER_REFUND",
                "PAYMENT_OUT",
                [
                  debitLine("AR", effectivePayoutDec),
                  creditLine("CASH", effectivePayoutDec),
                ],
                refundPostingSource,
              ),
              postingSourceComponents: refundPostingSource,
            });

            if (splitDebtOffsetDec.gt(0)) {
              const effectiveCustomerId = Number(
                input.customer?.customerId ?? matchedInvoice?.customerId,
              );
              if (effectiveCustomerId) {
                await adjustCustomerBalance(
                  tx,
                  effectiveCustomerId,
                  splitDebtOffsetDec.neg(),
                );
              }
            }
          } else if (input.settlement.method === "CARD") {
            generatedReceiptId = await recordSalesReturnCartCardReceipt(tx, {
              branchId: actorBranchId,
              amount: effectivePayoutDec,
              returnNumber,
              customerName,
              customerId: input.customer?.customerId,
              invoiceId: matchedInvoice?.id ?? null,
              reference: input.settlement.reference,
              userId: ctx.user.id,
            });

            const refundPostingSource = splitDebtOffsetDec.isZero()
              ? {
                  roleDebits: { AR: returnTotalDec },
                  roleCredits: { CARD_BANK: returnTotalDec },
                }
              : {
                  roleDebits: { AR: effectivePayoutDec },
                  roleCredits: { CARD_BANK: effectivePayoutDec },
                };
            await postEntry(tx, {
              entryType: "PAYMENT_OUT",
              branchId: actorBranchId,
              invoiceId: matchedInvoice?.id ?? null,
              receiptId: generatedReceiptId,
              customerId: ledgerCustomerId,
              amount: effectivePayoutDec,
              notes: `استرداد بطاقة لمرتجع مبيعات [${returnNumber}]`,
              createdBy: ctx.user.id,
              createdByNameSnapshot: ctx.user.name ?? "كاشير",
              postingIntent: createPostingIntent(
                "PAYMENT_OUT_CUSTOMER_REFUND",
                "PAYMENT_OUT",
                [
                  debitLine("AR", effectivePayoutDec),
                  creditLine("CARD_BANK", effectivePayoutDec),
                ],
                refundPostingSource,
              ),
              postingSourceComponents: refundPostingSource,
            });

            if (splitDebtOffsetDec.gt(0)) {
              const effectiveCustomerId = Number(
                input.customer?.customerId ?? matchedInvoice?.customerId,
              );
              if (effectiveCustomerId) {
                await adjustCustomerBalance(
                  tx,
                  effectiveCustomerId,
                  splitDebtOffsetDec.neg(),
                );
              }
            }
          } else if (input.settlement.method === "CREDIT_OFFSET") {
            const effectiveCustomerId = Number(
              input.customer?.customerId ?? matchedInvoice?.customerId,
            );
            if (!effectiveCustomerId) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر تنفيذ معادلة الذمة",
                  why: "طريقة معادلة الذمم تتطلب تحديد عميل مسجل في النظام لإسقاط المبلغ من حسابه الآجل",
                  doThis: "اختر العميل من CRM أو اربط الفاتورة بعميل مسجل",
                }),
              });
            }
            // خصم ذمة العميل في جدول العملاء بشكل ذري وكامل:
            await adjustCustomerBalance(
              tx,
              effectiveCustomerId,
              returnTotalDec.neg(),
            );
            generatedReceiptId = null;
          } else if (input.settlement.method === "STORE_CREDIT") {
            if (!input.customer?.customerId) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر إيداع رصيد المتجر",
                  why: "طريقة استرداد رصيد المتجر تتطلب تحديد عميل مسجل في النظام لإيداع الرصيد في حسابه",
                  doThis: "اختر العميل من CRM أو حدد طريقة استرداد نقدي",
                }),
              });
            }
            // رصيدُ المتجر التزامٌ دائمٌ على حساب العميل ⇒ يجب أن يُسنَد إلى بيعٍ موثَّق (الفاتورة
            // المُرتجَعة): بها وحدها يُوازِن انخفاضُ AR في الدفتر (returnedTotal) خفضَ currentBalance،
            // فيبقى reconcileCustomerBalances نظيفاً. بلا فاتورةٍ مطابقة يُنشَأ رصيدٌ دائنٌ بلا مُسنَد
            // ⇒ التزامٌ غير متعقَّبٍ وانحرافُ ذمّة. المرتجعُ العابر بلا فاتورةٍ مساره ردٌّ نقديّ فوريّ
            // لا إيداعُ رصيد متجر (مطابقةً للمسار القانونيّ returnSaleInTx الذي يشترط فاتورةً دائماً).
            if (!matchedInvoice) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر إيداع رصيد المتجر",
                  why: "إيداع رصيد المتجر يتطلّب ربطَ المرتجع بالفاتورة الأصليّة — لا يُنشأ رصيدٌ دائنٌ لعميلٍ بلا بيعٍ موثَّق",
                  doThis:
                    "أدخل رقم الفاتورة الأصليّة، أو اختر استرداداً نقدياً/بالبطاقة للمرتجع العابر",
                }),
              });
            }
            await adjustCustomerBalance(
              tx,
              input.customer.customerId,
              returnTotalDec.neg(),
            );
          }

          // ٣) توثيق قيد حدث المرتجع (RETURN) في دفتر الأستاذ العام
          // خالي تماماً من الأسطر الصفرية تجنباً لخطأ PostingIntent
          const restock = input.disposition === "RESTOCK";
          returnedCost = round2(returnedCost);
          returnedGiftCost = round2(returnedGiftCost);
          const reversedCost = restock ? returnedCost : new Decimal(0);
          const reversedGiftCost = restock ? returnedGiftCost : new Decimal(0);
          const consignmentPaidShare = round2(
            Array.from(byConsignor.values()).reduce(
              (sum, split) => sum.plus(split.paid),
              new Decimal(0),
            ),
          );
          const consignmentGiftShare = round2(
            Array.from(byConsignor.values()).reduce(
              (sum, split) => sum.plus(split.gift),
              new Decimal(0),
            ),
          );
          nonRestoredServicePaidCost = round2(nonRestoredServicePaidCost);
          nonRestoredServiceGiftCost = round2(nonRestoredServiceGiftCost);
          const ownedReversedCost = restock
            ? round2(
                Decimal.max(
                  new Decimal(0),
                  reversedCost
                    .minus(consignmentPaidShare)
                    .minus(nonRestoredServicePaidCost),
                ),
              )
            : new Decimal(0);
          const ownedReversedGiftCost = restock
            ? round2(
                Decimal.max(
                  new Decimal(0),
                  reversedGiftCost
                    .minus(consignmentGiftShare)
                    .minus(nonRestoredServiceGiftCost),
                ),
              )
            : new Decimal(0);
          const financiallyReversedGiftCost = restock
            ? round2(
                Decimal.max(
                  new Decimal(0),
                  reversedGiftCost.minus(nonRestoredServiceGiftCost),
                ),
              )
            : new Decimal(0);

          const returnedRevenueDec = round2(
            returnTotalDec.minus(returnedTaxDec),
          );
          let stationeryRevenue = money(0);
          let printRevenue = money(0);
          const returnClasses = new Set<
            "SERVICE" | "CONSIGNMENT" | "INVENTORY"
          >();
          for (const itm of input.items) {
            const itemRev =
              resolvedRevenueByItem.get(itm) ??
              (!matchedInvoice
                ? round2(money(itm.unitPrice).times(itm.quantity))
                : money(0));
            if (itemRev.lte(0)) continue;
            const kind = kindByVariant.get(Number(itm.variantId)) ?? "STOCK";
            const isConsign = consignByVariant.has(Number(itm.variantId));
            returnClasses.add(
              kind === "SERVICE"
                ? "SERVICE"
                : isConsign
                  ? "CONSIGNMENT"
                  : "INVENTORY",
            );
            if (kind === "SERVICE") {
              printRevenue = round2(printRevenue.plus(itemRev));
            } else {
              stationeryRevenue = round2(stationeryRevenue.plus(itemRev));
            }
          }
          const revenueSum = round2(stationeryRevenue.plus(printRevenue));
          if (!revenueSum.eq(returnedRevenueDec)) {
            const diff = round2(returnedRevenueDec.minus(revenueSum));
            if (stationeryRevenue.gt(0) || !returnClasses.has("SERVICE")) {
              stationeryRevenue = round2(
                Decimal.max(0, stationeryRevenue.plus(diff)),
              );
            } else {
              printRevenue = round2(Decimal.max(0, printRevenue.plus(diff)));
            }
          }

          const hasConsignmentReturn = returnClasses.has("CONSIGNMENT");
          const salesReturnProfile: PostingProfile =
            returnClasses.size > 1 ||
            (hasConsignmentReturn && ownedReversedCost.gt(0)) ||
            (printRevenue.gt(0) &&
              (stationeryRevenue.gt(0) || ownedReversedCost.gt(0)))
              ? "RETURN_SALE_MIXED"
              : hasConsignmentReturn
                ? "RETURN_SALE_CONSIGNMENT"
                : printRevenue.gt(0)
                  ? "RETURN_SALE_SERVICE"
                  : "RETURN_SALE_INVENTORY";

          const salesReturnSource = {
            roleDebits: {
              SALES_STATIONERY: stationeryRevenue,
              SALES_PRINT: printRevenue,
              SALES_FLEX: money(0),
              OTHER_REVENUE: money(0),
              DELIVERY_REVENUE: money(0),
              TAX_PAYABLE: returnedTaxDec,
              INVENTORY: ownedReversedCost,
            },
            roleCredits: {
              AR: returnTotalDec,
              COGS: ownedReversedCost,
            },
          };
          const salesReturnIntent = createPostingIntent(
            salesReturnProfile,
            "RETURN",
            [
              ...(stationeryRevenue.gt(0)
                ? [debitLine("SALES_STATIONERY", stationeryRevenue)]
                : []),
              ...(printRevenue.gt(0)
                ? [debitLine("SALES_PRINT", printRevenue)]
                : []),
              ...(returnedTaxDec.gt(0)
                ? [debitLine("TAX_PAYABLE", returnedTaxDec)]
                : []),
              ...(returnTotalDec.gt(0)
                ? [creditLine("AR", returnTotalDec)]
                : []),
              ...(ownedReversedCost.gt(0)
                ? [
                    debitLine("INVENTORY", ownedReversedCost),
                    creditLine("COGS", ownedReversedCost),
                  ]
                : []),
            ],
            salesReturnSource,
          );

          returnLedgerEntryId = await postEntry(tx, {
            entryType: "RETURN",
            branchId: actorBranchId,
            invoiceId: matchedInvoice?.id ?? null,
            receiptId: generatedReceiptId,
            // اتّساقُ رافدَي الردّ: نفس نسبة PAYMENT_OUT (ledgerCustomerId) — بلا فاتورةٍ مطابقة
            // يُستبعَد كلاهما من دفتر العميل معاً، فلا يجمع تقريرٌ قيدَ RETURN بلا مقابله (بلاغ Codex P1).
            customerId: ledgerCustomerId,
            amount: returnTotalDec.neg(),
            revenue: returnedRevenueDec.neg(),
            taxAmount: returnedTaxDec.neg(),
            cost: ownedReversedCost.neg(),
            profit: returnedRevenueDec.minus(ownedReversedCost).neg(),
            notes: `مرتجع مبيعات سلة [${returnNumber}] — ${customerName} (${
              input.settlement.method === "CASH"
                ? `نقدي من درج #${input.settlement.shiftId}`
                : input.settlement.method === "CARD"
                  ? "بطاقة"
                  : input.settlement.method === "CREDIT_OFFSET"
                    ? "معادلة ذمة"
                    : "رصيد متجر"
            })`,
            createdBy: ctx.user.id,
            createdByNameSnapshot: ctx.user.name ?? "كاشير",
            postingIntent: salesReturnIntent,
            postingSourceComponents: salesReturnSource,
          });

          if (financiallyReversedGiftCost.gt(0)) {
            const giftPosting = classifyGiftPosting(
              financiallyReversedGiftCost,
              ownedReversedGiftCost,
              -1,
            );
            await postEntry(tx, {
              entryType: "GIFT_OUT",
              branchId: actorBranchId,
              invoiceId: matchedInvoice?.id ?? null,
              customerId: ledgerCustomerId,
              revenue: new Decimal(0),
              cost: financiallyReversedGiftCost.neg(),
              profit: financiallyReversedGiftCost,
              amount: financiallyReversedGiftCost.neg(),
              createdBy: ctx.user.id,
              createdByNameSnapshot: ctx.user.name ?? "كاشير",
              notes: `عكس هدايا ضمن مرتجع مبيعات سلة [${returnNumber}]؛ consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
              postingIntent: giftPosting.intent,
              postingSourceComponents: giftPosting.sourceComponents,
            });
          }

          if (consignByVariant.size > 0) {
            for (const cId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
              const split = byConsignor.get(cId)!;
              const paidShare = round2(split.paid);
              const giftShare = round2(split.gift);
              const share = round2(paidShare.plus(giftShare));
              if (share.lte(0)) continue;
              await postEntry(tx, {
                entryType: "PURCHASE",
                supplierId: cId,
                invoiceId: matchedInvoice?.id ?? null,
                branchId: actorBranchId,
                amount: share.neg(),
                cost: paidShare.neg(),
                profit: paidShare,
                createdBy: ctx.user.id,
                createdByNameSnapshot: ctx.user.name ?? "كاشير",
                notes: `عكس استحقاق أمانة — مرتجع سلة [${returnNumber}]؛ COGS مبسّط=${toDbMoney(paidShare.neg())}`,
                postingIntent: createPostingIntent(
                  "PURCHASE_CONSIGNMENT",
                  "PURCHASE",
                  [
                    ...signedPostingLines(
                      "COGS",
                      "CONSIGNMENT_PAYABLE",
                      paidShare.neg(),
                    ),
                    ...signedPostingLines(
                      "GIFTS_PROMO",
                      "CONSIGNMENT_PAYABLE",
                      giftShare.neg(),
                    ),
                  ],
                  {
                    roleDebits: { CONSIGNMENT_PAYABLE: share },
                    roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare },
                  },
                ),
                postingSourceComponents: {
                  roleDebits: { CONSIGNMENT_PAYABLE: share },
                  roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare },
                },
              });
              await adjustSupplierBalance(tx, cId, share.neg());
              if (!restock) {
                await postEntry(tx, {
                  entryType: "PURCHASE",
                  supplierId: cId,
                  invoiceId: null,
                  branchId: actorBranchId,
                  amount: share,
                  cost: paidShare,
                  profit: paidShare.neg(),
                  createdBy: ctx.user.id,
                  createdByNameSnapshot: ctx.user.name ?? "كاشير",
                  notes: `استحقاق تلف مرتجع أمانة [${returnNumber}]؛ COGS مبسّط=${toDbMoney(paidShare)}`,
                  postingIntent: createPostingIntent(
                    "PURCHASE_CONSIGNMENT",
                    "PURCHASE",
                    [
                      ...signedPostingLines(
                        "COGS",
                        "CONSIGNMENT_PAYABLE",
                        paidShare,
                      ),
                      ...signedPostingLines(
                        "GIFTS_PROMO",
                        "CONSIGNMENT_PAYABLE",
                        giftShare,
                      ),
                    ],
                    {
                      roleDebits: { COGS: paidShare, GIFTS_PROMO: giftShare },
                      roleCredits: { CONSIGNMENT_PAYABLE: share },
                    },
                  ),
                  postingSourceComponents: {
                    roleDebits: { COGS: paidShare, GIFTS_PROMO: giftShare },
                    roleCredits: { CONSIGNMENT_PAYABLE: share },
                  },
                });
                await adjustSupplierBalance(tx, cId, share);
              }
            }
          }

          // ٤) تحديث بيانات الفاتورة الأصلية وبنودها بالكميات الأساس المحسوبة
          if (matchedInvoice) {
            const deltaByInvoiceItemId = new Map<
              number,
              {
                targetItem: typeof invoiceItems.$inferSelect;
                totalEffectiveBaseQty: number;
                totalRestockBaseQty: number;
              }
            >();

            for (const itm of input.items) {
              const targetItem = itm.invoiceItemId
                ? invoiceItemRows.find(
                    (ii) =>
                      ii.id === itm.invoiceItemId &&
                      ii.variantId === itm.variantId,
                  )
                : invoiceItemRows.find((ii) => ii.variantId === itm.variantId);

              if (targetItem) {
                const effectiveBaseQty =
                  resolvedBaseQtyByItem.get(itm) ??
                  (
                    await resolveReturnBaseQuantity(
                      tx,
                      itm,
                      targetItem.productUnitId,
                    )
                  ).baseQuantity;
                const kind =
                  kindByVariant.get(Number(itm.variantId)) ?? "STOCK";

                const delta = deltaByInvoiceItemId.get(targetItem.id) ?? {
                  targetItem,
                  totalEffectiveBaseQty: 0,
                  totalRestockBaseQty: 0,
                };
                delta.totalEffectiveBaseQty += effectiveBaseQty;
                if (input.disposition === "RESTOCK" && kind !== "SERVICE") {
                  delta.totalRestockBaseQty += effectiveBaseQty;
                }
                deltaByInvoiceItemId.set(targetItem.id, delta);
              }
            }

            for (const delta of Array.from(deltaByInvoiceItemId.values())) {
              await tx
                .update(invoiceItems)
                .set({
                  returnedBaseQuantity: sql`COALESCE(${invoiceItems.returnedBaseQuantity}, 0) + ${delta.totalEffectiveBaseQty}`,
                  ...(delta.totalRestockBaseQty > 0
                    ? {
                        returnedRestockedBaseQuantity: sql`COALESCE(${invoiceItems.returnedRestockedBaseQuantity}, 0) + ${delta.totalRestockBaseQty}`,
                      }
                    : {}),
                })
                .where(eq(invoiceItems.id, delta.targetItem.id));

              // تحديث النسخة المحفوظة في الذاكرة لصون الاتساق الداخلي للمعاملة
              delta.targetItem.returnedBaseQuantity =
                (delta.targetItem.returnedBaseQuantity ?? 0) +
                delta.totalEffectiveBaseQty;
              if (delta.totalRestockBaseQty > 0) {
                delta.targetItem.returnedRestockedBaseQuantity =
                  (delta.targetItem.returnedRestockedBaseQuantity ?? 0) +
                  delta.totalRestockBaseQty;
              }
            }

            const newReturnedTotal = money(
              matchedInvoice.returnedTotal ?? "0",
            ).plus(returnTotalDec);
            const allItemsReturned =
              invoiceItemRows.length === 0 ||
              invoiceItemRows.every(
                (ii) =>
                  Number(ii.returnedBaseQuantity ?? 0) >=
                  Number(ii.baseQuantity ?? 0),
              );
            const isFullyReturned =
              newReturnedTotal.gte(money(matchedInvoice.total)) &&
              allItemsReturned;

            // تسوية إرسالية التوصيل المرتبطة بالفاتورة:
            // فحص ما إذا كانت الإرسالية لديها عهدة مسلّمة غير مورّدة (unremitted custody)
            let reversedDeliveryCustody = money(0);
            const liveDeliveryCustody = matchedDeliveryPreview == null
              ? money(0)
              : (await remainingUnremittedDeliveryCustody(tx, Number(matchedDeliveryPreview.id))).total;
            const hasPriorDeliveryCustodyReturn = matchedDeliveryPreview == null
              ? false
              : Boolean((await tx
                  .select({ id: deliveryLedgerEntries.id })
                  .from(deliveryLedgerEntries)
                  .where(and(
                    eq(deliveryLedgerEntries.consignmentId, Number(matchedDeliveryPreview.id)),
                    inArray(deliveryLedgerEntries.entryType, ["COD_RETURNED", "SHORTFALL_SETTLED"]),
                  ))
                  .limit(1))[0]);
            const isUnremittedDelivery =
              matchedDeliveryPreview != null &&
              (["DELIVERED", "PARTIAL"].includes(matchedDeliveryPreview.status) ||
                ["DELIVERED", "PARTIAL"].includes(matchedDeliveryPreview.parcelStatus)) &&
              (liveDeliveryCustody.gt(0) || hasPriorDeliveryCustodyReturn);

            if (isUnremittedDelivery && matchedDeliveryPreview) {
              const fullAllocation = allocateReturnAgainstInvoice(
                matchedInvoice,
                returnTotalDec,
              );
              const refundAmountForCustody = (input.settlement.method === "CASH" || input.settlement.method === "CARD")
                ? effectivePayoutDec
                : money(0);
              const deliveryReversal = await reverseUnremittedDeliveryConsignment(
                tx,
                matchedDeliveryPreview as UnremittedDeliverySnapshot,
                matchedInvoice.id,
                matchedInvoice.customerId == null ? null : Number(matchedInvoice.customerId),
                matchedInvoice.invoiceNumber,
                ctx.user.id,
                Decimal.max(0, fullAllocation.paidRelief.minus(refundAmountForCustody)),
                fullAllocation.unpaidRelief,
                isFullyReturned,
                clientRequestId?.slice(0, 20) ?? `cart-${matchedInvoice.id}-${matchedDeliveryPreview.counterSettledAmount ?? "0"}`,
                "مرتجع مبيعات عبر سلة المرتجعات",
              );
              reversedDeliveryCustody = deliveryReversal.reversedCustody;
              if (matchedInvoice.customerId != null && deliveryReversal.reversedCustody.gt(0)) {
                await adjustCustomerBalance(
                  tx,
                  Number(matchedInvoice.customerId),
                  deliveryReversal.reversedCustody,
                );
              }
            } else {
              // تسوية أي إرسالية توصيل نشطة (غير مسلّمة أو بلا عهدة نقدية غير مورّدة)
              await reconcileDeliveryOnReturnTx(tx, {
                invoiceId: matchedInvoice.id,
                returnedTotal: returnTotalDec,
                isFullReturn: isFullyReturned,
                actor: {
                  userId: ctx.user.id,
                  branchId: actorBranchId,
                  role: ctx.user.role,
                },
                clientRequestId: clientRequestId
                  ? `${clientRequestId}:delivery-reconcile`
                  : undefined,
              });
            }

            let newPaid = money(matchedInvoice.paidAmount ?? "0");
            if (
              input.settlement.method === "CASH" ||
              input.settlement.method === "CARD"
            ) {
              const paidMinusRefund = newPaid.minus(effectivePayoutDec);
              newPaid = paidMinusRefund.lt(0) ? money(0) : paidMinusRefund;
            }
            if (reversedDeliveryCustody.gt(0)) {
              const paidMinusCustody = newPaid.minus(reversedDeliveryCustody);
              newPaid = paidMinusCustody.lt(0) ? money(0) : paidMinusCustody;
            }
            const newStatus = isFullyReturned
              ? "RETURNED"
              : computeInvoiceStatus(
                  matchedInvoice.total,
                  toDbMoney(newPaid),
                  toDbMoney(newReturnedTotal),
                );
            await tx
              .update(invoices)
              .set({
                returnedTotal: toDbMoney(newReturnedTotal),
                paidAmount: toDbMoney(newPaid),
                status: newStatus,
              })
              .where(eq(invoices.id, matchedInvoice.id));
          }
          }

          const cashOrCardResult = input.settlement.method === "CASH" || input.settlement.method === "CARD";
          const payoutAmount = cashOrCardResult
            ? (matchedInvoice ? matchedActualPayout : returnTotalDec).toFixed(2) : "0.00";
          const debtOffsetAmount = matchedInvoice
            ? Decimal.min(returnTotalDec, matchedDebtAndCustodyCap).toFixed(2) : "0.00";

          // تسجيل مفتاح الـ Idempotency ذرياً داخل المعاملة نفسها
          if (clientRequestId) {
            await recordIdempotencyKey(
              tx,
              "sale.return_cart",
              clientRequestId,
              returnLedgerEntryId,
              requestFingerprint,
            );
          }

          // ٥) توثيق التدقيق الرقابي
          await logAuditTx(tx, ctx, {
            action: "sale.return_cart",
            entityType: "sale",
            entityId: matchedInvoice?.id ?? null,
            newValue: {
              returnNumber,
              customerName,
              customerPhone,
              originalInvoiceNumber: input.invoiceNumber,
              disposition: input.disposition,
              totalAmount: input.settlement.totalAmount,
              method: input.settlement.method,
              shiftId: input.settlement.shiftId,
              receiptId: generatedReceiptId,
              payoutAmount,
              debtOffsetAmount,
              itemsCount: input.items.length,
              reason: returnReason,
              items: input.items.map((i) => ({
                name: i.productName,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                barcode: i.barcode,
              })),
            },
          });

          return {
            ok: true as const,
            returnNumber,
            receiptId: generatedReceiptId,
            payoutAmount,
            debtOffsetAmount,
            customerName,
            customerPhone,
            originalInvoiceNumber: input.invoiceNumber,
            disposition: input.disposition,
            totalAmount: input.settlement.totalAmount,
            method: input.settlement.method,
            noCashNoAccount: input.settlement.method === "CREDIT_OFFSET" && matchedInvoice?.customerId == null,
            reference: input.settlement.reference,
            itemsCount: input.items.length,
            items: input.items.map((i) => ({
              name: i.productName,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              barcode: i.barcode,
            })),
            dateStr: now.toLocaleDateString("ar-IQ-u-nu-latn", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            timeStr: now.toLocaleTimeString("ar-IQ-u-nu-latn", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          };
        },
        { gate: "NONE" },
      );
    });
    }),

  /**
   * تنفيذ مرتجع مشتريات فوري للمورد عبر سلة المنتجات
   * يدعم: اختيار المورد، رقم مرجعي اختياري، سلة الأصناف بتكلفة الشراء
   * طرق التسوية:
   *   - CREDIT_OFFSET: معادلة على الحساب نفسه يقلل الذمم علينا
   *   - CASH_IN: مردود نقدي (توريد نقد للدرج)
   *   - CARD_TRANSFER: تحويل بنكي / بطاقة
   */
  executePurchaseReturnCart: salesManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive("يجب اختيار المورد"),
        reference: z.string().trim().max(64).nullish(),
        items: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive().optional(),
              productName: z.string().min(1),
              barcode: z.string().nullish(),
              quantity: z.number().int().positive(),
              unitCost: nonNegMoneyString,
            }),
          )
          .min(1, "يجب تحديد صنف واحد على الأقل للمرتجع"),
        settlement: z.object({
          method: z.enum(["CREDIT_OFFSET", "CASH_IN", "CARD_TRANSFER"]),
          totalAmount: nonNegMoneyString,
          shiftId: z.number().int().positive().nullish(),
          reference: z.string().trim().max(120).nullish(),
        }),
        reason: z.string().trim().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر تنفيذ مرتجع المشتريات",
            why: "لا يوجد فرع مُسنَد لحسابك الحالي",
            doThis: "تواصل مع مدير النظام لإسناد الفرع التشغيلي لحسابك",
          }),
        });
      }
      const actorBranchId = Number(ctx.user.branchId ?? 1);

      return withTx(
        async (tx) => {
          await assertOperationAuthorityTx(tx, {
            userId: ctx.user.id, role: ctx.user.role, branchId: ctx.user.branchId,
          }, "returns.executePurchaseReturnCart", (current) =>
            moduleAccessAllowed(current.role ?? "user", current.permissionsOverride as PermissionMap | null,
              "sales", "FULL", ["manager"]) && canSeeCostForUser(current));
          await assertPeriodOpen(tx, new Date());

          // التحقق من وجود المورد
          const [supplier] = await tx
            .select()
            .from(suppliers)
            .where(eq(suppliers.id, input.supplierId))
            .limit(1);

          if (!supplier) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: appErrorMessage({
                what: "المورد غير موجود",
                why: "لم يتم العثور على سجل المورد المحدد في قاعدة البيانات",
                doThis: "اختر مورداً صالحاً من القائمة",
              }),
            });
          }

          const now = new Date();
          const randSuffix = Math.floor(1000 + Math.random() * 9000);
          const returnNumber = `PR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${randSuffix}`;
          const returnReason =
            input.reason?.trim() || "مرتجع مشتريات للمورد بالسلة";
          const returnTotalDec = new Decimal(input.settlement.totalAmount);
          if (returnTotalDec.lte(0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "مبلغ المرتجع غير صالح",
                why: "يجب أن يكون إجمالي مرتجع الشراء أكبر من صفر",
                doThis: "تحقق من بنود المرتجع وتكلفتها",
              }),
            });
          }

          // ١) خصم الأصناف من مخزون الفرع (حركة OUT / PURCHASE_RETURN) بالوحدة الأساس
          for (const itm of input.items) {
            const { baseQuantity: effectiveBaseQty } =
              await resolveReturnBaseQuantity(tx, itm);

            await applyMovement(tx, {
              variantId: itm.variantId,
              branchId: actorBranchId,
              baseQuantity: effectiveBaseQty,
              movementType: "OUT",
              referenceType: "PURCHASE_RETURN",
              documentNumber: returnNumber,
              notes: `مرتجع مشتريات للمورد [${returnNumber}] — ${itm.productName} للمورد (${supplier.name})`,
              createdBy: ctx.user.id,
            });
          }

          // ٢) الأثر المالي بحسب طريقة التسوية
          let generatedReceiptId: number | null = null;
          if (input.settlement.method === "CREDIT_OFFSET") {
            // معادلة على الحساب نفسه يقلل الذمم علينا: AP يقل بالقيمة السالبة
            await adjustSupplierBalance(
              tx,
              input.supplierId,
              returnTotalDec.neg(),
            );
          } else if (input.settlement.method === "CASH_IN") {
            const targetShiftId = input.settlement.shiftId;
            if (!targetShiftId) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر إيداع المردود النقدي",
                  why: "لم يتم تحديد درج النقدية / الوردية المستلمة للنقد من المورد",
                  doThis: "اختر درج الوردية المفتوحة من القائمة",
                }),
              });
            }
            const [targetShift] = await tx
              .select()
              .from(shifts)
              .where(
                and(
                  eq(shifts.id, targetShiftId),
                  eq(shifts.branchId, actorBranchId),
                ),
              )
              .for("update")
              .limit(1);

            if (!targetShift || targetShift.status !== "OPEN") {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر توريد النقد للدرج",
                  why: "الوردية المحددة غير موجودة أو مغلقة حالياً",
                  doThis: "اختر وردية مفتوحة سارية في الفرع",
                }),
              });
            }

            generatedReceiptId = await recordPurchaseReturnCartReceipt(tx, {
              branchId: actorBranchId,
              shiftId: targetShiftId,
              amount: returnTotalDec,
              returnNumber,
              supplierId: input.supplierId,
              supplierName: supplier.name,
              userId: ctx.user.id,
            });

            const paymentInSource = {
              roleDebits: { CASH: returnTotalDec },
              roleCredits: { AP: returnTotalDec },
            };
            await postEntry(tx, {
              entryType: "PAYMENT_IN",
              branchId: actorBranchId,
              supplierId: input.supplierId,
              receiptId: generatedReceiptId,
              amount: returnTotalDec,
              notes: `مردود نقدي لمرتجع مشتريات [${returnNumber}] إلى درج #${targetShiftId}`,
              createdBy: ctx.user.id,
              createdByNameSnapshot: ctx.user.name ?? "مدير",
              postingIntent: createPostingIntent(
                "PAYMENT_IN_SUPPLIER_REFUND",
                "PAYMENT_IN",
                [
                  debitLine("CASH", returnTotalDec),
                  creditLine("AP", returnTotalDec),
                ],
                paymentInSource,
              ),
              postingSourceComponents: paymentInSource,
            });
          } else if (input.settlement.method === "CARD_TRANSFER") {
            // مردود بحوالة: المال يدخل حساب البنك (CARD_BANK) لا الدرج. العملية الكاملة (إيصال IN
            // غيرُ نقديّ + قيد PAYMENT_IN عاكسٌ يُصافر خفضَ RETURN لِـAP) تعيش في الخدمة احتراماً
            // لعقد الطبقات. صافي AP صفرٌ على الدفتر و currentBalance ⇒ reconcile نظيف، وللمال مسارٌ
            // وطرفٌ (المورد). كان المسار بلا أثرٍ ماليّ إطلاقاً — RETURN وحده يخصم AP بلا نظير ⇒
            // انحراف reconcile بقيمة المرتجع + مردودٌ بلا إيصالٍ ولا قيد (يخالف مبدأ المالك §٥).
            // المرجع: الواجهة لا تُرسل settlement.reference، فنُمرّر مرجعَ المستند (input.reference)
            // كي لا يُخزَّن مرجعٌ فارغ يُعجز مطابقة كشف البنك (الخدمة تقصّه لطول عمود varchar(100)).
            generatedReceiptId = await postPurchaseReturnCartCardRefund(tx, {
              branchId: actorBranchId,
              amount: returnTotalDec,
              returnNumber,
              supplierId: input.supplierId,
              supplierName: supplier.name,
              reference: input.settlement.reference ?? input.reference,
              userId: ctx.user.id,
              userName: ctx.user.name,
            });
          }

          // ٣) توثيق قيد محاسبي في دفتر الأستاذ العام
          const purchaseReturnSource = {
            roleDebits: {
              AP: returnTotalDec,
            },
            roleCredits: {
              INVENTORY: returnTotalDec,
            },
          };
          const purchaseReturnIntent = createPostingIntent(
            "RETURN_PURCHASE_INVENTORY",
            "RETURN",
            [
              debitLine("AP", returnTotalDec),
              creditLine("INVENTORY", returnTotalDec),
            ],
            purchaseReturnSource,
          );

          await postEntry(tx, {
            entryType: "RETURN",
            branchId: actorBranchId,
            supplierId: input.supplierId,
            receiptId: generatedReceiptId,
            purchaseLiabilityAccount: "AP",
            amount: returnTotalDec.neg(),
            cost: returnTotalDec.neg(),
            profit: new Decimal(0),
            notes: `مرتجع مشتريات للمورد [${returnNumber}] — ${supplier.name} (${input.settlement.method === "CREDIT_OFFSET" ? "معادلة ذمة" : input.settlement.method === "CASH_IN" ? "مردود نقدي" : "تحويل بنكي"})`,
            createdBy: ctx.user.id,
            createdByNameSnapshot: ctx.user.name ?? "مدير",
            postingIntent: purchaseReturnIntent,
            postingSourceComponents: purchaseReturnSource,
          });

          // ٤) توثيق التدقيق الرقابي
          await logAudit(ctx, {
            action: "purchase.return_cart",
            entityType: "purchase",
            entityId: null,
            newValue: {
              returnNumber,
              supplierId: input.supplierId,
              supplierName: supplier.name,
              reference: input.reference,
              totalAmount: input.settlement.totalAmount,
              method: input.settlement.method,
              shiftId: input.settlement.shiftId,
              receiptId: generatedReceiptId,
              itemsCount: input.items.length,
              reason: returnReason,
            },
          });

          return {
            ok: true as const,
            returnNumber,
            supplierName: supplier.name,
            supplierPhone: supplier.phone,
            reference: input.reference,
            totalAmount: input.settlement.totalAmount,
            method: input.settlement.method,
            itemsCount: input.items.length,
            items: input.items.map((i) => ({
              name: i.productName,
              quantity: i.quantity,
              unitCost: i.unitCost,
              barcode: i.barcode,
            })),
            dateStr: now.toLocaleDateString("ar-IQ-u-nu-latn", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            timeStr: now.toLocaleTimeString("ar-IQ-u-nu-latn", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          };
        },
        { gate: "NONE" },
      );
    }),
});

import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { z } from "zod";
import {
  accountingEntries,
  branchStock,
  customers,
  invoiceItems,
  invoices,
  productPrices,
  productUnits,
  productVariants,
  products,
  returnRequests,
  salesControlRequests,
  shifts,
  suppliers,
  users,
  workOrders,
} from "../../drizzle/schema";
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
} from "../services/accounting/postingEngine";
import { money, toDbMoney } from "../services/money";
import { assertCashOutAvailable } from "../services/cash/cashAvailability";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import {
  recordPurchaseReturnCartReceipt,
  recordSalesReturnCartCardReceipt,
  recordSalesReturnCartReceipt,
  returnSaleAsOwner,
  returnSaleDirect,
  returnSaleInTx,
} from "../services/returnService";
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
import {
  router,
  salesCashierProcedure,
  salesManagerProcedure,
  salesReadProcedure,
  workordersCashierProcedure,
  workordersExecProcedure,
} from "../trpc";
import {
  forensicTraceInvoices,
  universalBarcodeScan,
} from "../services/returns/forensicTraceService";
import { applyMovement } from "../services/inventoryService";
import { assertPeriodOpen } from "../services/periodLockService";
import { resolveBarcodeOwner } from "../services/catalog/barcodeAliases";
import {
  createReturnRequest,
  listReturnRequests,
  loadApprovableRequest,
  loadApprovableRequestTx,
  markRequestApprovedTx,
  rejectReturnRequest,
} from "../services/returns/requests";
import { nonNegMoneyString } from "../lib/schemas";
import { escLike } from "../lib/sqlLike";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { randomUUID } from "node:crypto";

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

// المرتجعات تعكس مخزوناً ونقداً ⇒ كاشير بوردية مفتوحة أو مدير فأعلى.
export const returnRouter = router({
  create: salesCashierProcedure
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
        ...payload
      } = input;
      const rawReason = explicitReason || input.resolution?.reason;

      /**
       * ⭐ **مسارُ التنفيذ الفوريّ الذريّ** (مالك، إداريّ، أو كاشير بوردية مفتوحة).
       *
       * المالكُ ينفّذ مرتجعه مباشرةً، ومسؤولو النظام والمدراء والكاشير ينفّذون مباشرةً عبر
       * `returnSaleDirect` افتراضياً (أو عند صراحة directExecution !== false).
       * الأثرُ يمرّ بنفس `returnSaleInTx` بكلّ قيودها وحرّاسها. الاختصارُ في الحوكمة لا في المحاسبة.
       *
       * ⚠️ **العائدُ نوعٌ مُميَّزٌ بـ`mode`**: كلّ مستهلكٍ يتفرّع على `mode` صراحةً.
       */
      const shouldExecuteDirect =
        ctx.user.isOwner === true || input.directExecution === true;

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

      // عزل ملكية الكاشير (نطاق sales.get): الكاشير لا يرجع فاتورة زميله في الفرع نفسه،
      // لكنه يرجع فواتيره وفواتير أوامر الشغل التي استقبلها. المدير وadmin يتجاوزان.
      const scopedOwnerId = getScopedOwnerId(ctx.user);
      if (
        scopedOwnerId != null &&
        Number(invRow.createdBy) !== scopedOwnerId &&
        Number(invRow.workOrderCreatedBy) !== scopedOwnerId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر تسجيل المرتجع",
            why: "لا يملك الكاشير صلاحية إرجاع فاتورة أنشأها موظف آخر",
            doThis: "اطلب من منشئ الفاتورة أو مدير الفرع تنفيذ المرتجع",
          }),
        });
      }

      if (shouldExecuteDirect) {
        /**
         * ⛔ **فاتورةُ أمر الشغل خارج هذا المسار** (أمسكه Codex على PR #932، P1).
         *
         * فواتير WORKORDER تُعالَج من شاشة أمر الشغل (عكس التسليم) لا من مسار المرتجع.
         */
        if (invRow.sourceType === "WORKORDER") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "فاتورة أمر الشغل تُعالَج من شاشة أمر الشغل (عكس التسليم) — لا من مسار المرتجع",
          });
        }
        const executed =
          ctx.user.isOwner === true
            ? await returnSaleAsOwner(
                {
                  ...payload,
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
        },
      });
      const isApproved = res.status === "APPROVED";
      return {
        mode: isApproved ? ("EXECUTED" as const) : ("REQUESTED" as const),
        requestId: res.id,
        status: res.status,
        replayed: res.replayed,
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
          message: "لا فرع مُسنَد لهذا المستخدم",
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

  getInvoice: salesCashierProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;
      const inv = (
        await db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            status: invoices.status,
            branchId: invoices.branchId,
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
            returnedTotal: invoices.returnedTotal,
            paymentMethod: invoices.paymentMethod,
          })
          .from(invoices)
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
          .where(eq(invoices.id, input.invoiceId))
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

      // عزل ملكية الكاشير (نطاق sales.get): الكاشير لا يقرأ تفاصيل فاتورة زميله في الفرع نفسه،
      // لكنه يقرأ فواتيره وفواتير أوامر الشغل التي استقبلها. المدير وadmin يتجاوزان.
      const scopedOwnerId = getScopedOwnerId(ctx.user);
      if (
        scopedOwnerId != null &&
        Number(inv.createdBy) !== scopedOwnerId &&
        Number(inv.workOrderCreatedBy) !== scopedOwnerId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر قراءة تفاصيل الفاتورة للمرتجع",
            why: "لا يملك الكاشير صلاحية الوصول إلى فاتورة أنشأها موظف آخر",
            doThis: "اطلب من منشئ الفاتورة أو مدير الفرع إتمام المرتجع",
          }),
        });
      }

      const rows = await db
        .select({
          invoiceItemId: invoiceItems.id,
          productName: products.name,
          variantName: productVariants.variantName,
          color: productVariants.color,
          size: productVariants.size,
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
        .where(eq(invoiceItems.invoiceId, input.invoiceId));

      const items = rows.map((r) => {
        const variantLabel =
          r.variantName ??
          ([r.color, r.size].filter((v): v is string => !!v).join(" / ") ||
            r.sku);
        const remaining = r.baseQuantity - r.returnedBaseQuantity;
        return {
          invoiceItemId: Number(r.invoiceItemId),
          productName: r.productName,
          variantLabel,
          barcode: r.barcode ?? null,
          sku: r.sku ?? null,
          unitName: r.unitName ?? "",
          // معامل تحويل وحدة البيع (درزن=12…) — الشاشة تعرض «١ درزن = ١٢ قطعة» وتَخطو به،
          // فلا يحسب الموظف الوحدة الأساس ذهنياً (كان أكبر مصدر خطأ كميات المرتجع).
          conversionFactor: Number(r.conversionFactor ?? 1) || 1,
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
      const caps = await loadRefundCaps(db, input.invoiceId);
      const paidByMethod: Array<{ method: string; amount: string }> = [];
      caps.netByMethod.forEach((v, m) => {
        if (v.gt(0)) paidByMethod.push({ method: m, amount: v.toFixed(2) });
      });
      // سقفٌ خامّ لكل طريقة (قبل قصّه بقيمة المرتجع الذي لم تُحدَّد كمّياته بعد) — الشاشة تقصّه
      // لحظياً بقيمة ما اختاره الموظف، فيبقى الطرفان على معادلةٍ واحدة.
      // رافدا الردّ وحدهما (قرار المالك ١٧/٨: نقدٌ أو بطاقة) — لا تُعرَض طريقةٌ لا يريدها العمل.
      const isWalkIn = inv.customerId == null;
      const surfacedMethods = isWalkIn
        ? (["CASH"] as const)
        : SURFACED_REFUND_METHODS;
      const refundOptions = surfacedMethods.map((m) => ({
        method: m,
        cap: (caps.capByMethod.get(m) ?? money(0)).toFixed(2),
        /** صافي المقبوض بهذا الرافد (زين مطويٌّ في النقد) — إفصاحٌ يشرح للموظف مصدر المال. */
        paid: (caps.netByMethod.get(m) ?? money(0)).toFixed(2),
        // الحجب يعني «لا يمكن **ردّ نقدٍ** بهذا الرافد» لا «لا يمكن تسجيل مرتجع». النصّ السابق
        // كان يُقرأ منعاً للمرتجع كلّه على فاتورةٍ لم تُقبض (بلاغ المالك ١٨/٨) — والمرتجع بلا ردّ
        // مقبولٌ خادمياً أصلاً: يُخصَم من المتبقّي ومن ذمّة العميل.
        blockedReason: (caps.capByMethod.get(m) ?? money(0)).lte(0)
          ? isWalkIn
            ? "لا يوجد مقبوض يغطي ردّ الزبون العابر؛ لا تسجّل المرتجع قبل ربطه بعميل أو معالجة أصل الفاتورة."
            : "لا يوجد متبقٍّ من المقبوض على هذه الفاتورة — يبقى المرتجع بلا ردّ نقديّ متاحاً (يُخصَم من المتبقّي/الذمّة)"
          : null,
      }));

      // أدراج الفرع المفتوحة — تُجلب هنا مع التفاصيل لا بطلبٍ ثانٍ مشروط، كي لا تُبنى الشاشة
      // على حالةٍ ناقصة («جارٍ فحص الورديات…» ثمّ رفضٌ عند الحفظ). قرار المالك (١٧/٨): الاسترداد
      // من **وردية منفّذ المرتجع المفتوحة** افتراضاً، أو يختار وردية أخرى مفتوحة صراحةً.
      // النطاق = فرع الفاتورة دائماً (لا فرع الفاعل) — الدرج مورد فرعٍ لا مستخدم.
      const openShifts = await getOpenShifts(
        {},
        {
          scopedBranchId: Number(inv.branchId),
          role: ctx.user.role,
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
            eq(salesControlRequests.invoiceId, input.invoiceId),
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
            eq(returnRequests.invoiceId, input.invoiceId),
            eq(returnRequests.status, "PENDING_APPROVAL"),
          ),
        )
        .limit(1);

      const canReviewRole =
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
                canReviewRole &&
                Number(governedPending.requestedBy) !== Number(ctx.user.id) &&
                Number(invoiceCreatedBy ?? -1) !== Number(ctx.user.id),
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
              method: "CASH" as const,
              exactAmountRequired: true as const,
              reasonRequired: true as const,
              dispositions: ["RESTOCK", "DAMAGED"] as const,
            }
          : null,
        id: Number(inv.id),
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
        /** ما أُرجِع سابقاً — تحتاجه الشاشة لتحسب «المستحقّ للزبون» فلا تُعبّئ ردّاً لمدين. */
        returnedTotal: inv.returnedTotal ?? "0",
        paymentMethod: inv.paymentMethod,
        paidByMethod,
        items,
      };
    }),

  /**
   * التحري والتقصي الجنائي للفواتير المفقودة بعدسات متعددة:
   * باركود الصنف / آخر ٤ أرقام من البطاقة / هاتف العميل / الوردية والتاريخ
   */
  forensicTrace: salesReadProcedure
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
      });
    }),

  /**
   * المسح الكوني للباركود — يتعرف تلقائياً على نوع المعاملة أو الصنف من الرمز الممسوح.
   */
  universalScan: salesReadProcedure
    .input(z.object({ barcode: z.string().trim().min(1, "امسح الباركود") }))
    .query(async ({ input, ctx }) => {
      return universalBarcodeScan(input.barcode, {
        userId: ctx.user.id,
        branchId:
          ctx.user.role === "admin" ? 0 : Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
    }),

  /**
   * الورديات المفتوحة للمستخدم أو الفرع (لإرجاع مالي أو دفع فرق استبدال في الدرج).
   */
  shifts: salesReadProcedure.query(async ({ ctx }) => {
    const actorBranchId =
      ctx.user.role === "admin" || !ctx.user.branchId
        ? null
        : Number(ctx.user.branchId);
    const openShifts = await getOpenShifts(
      {},
      {
        scopedBranchId: actorBranchId,
        role: ctx.user.role,
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
  lookupItemForReturn: salesReadProcedure
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

      if (!owner) {
        // إذا لم يُعثر عليه بالباركود، نحاول بالـ SKU
        const [skuVariant] = await db
          .select({
            variantId: productVariants.id,
            productId: products.id,
            productName: products.name,
            variantName: productVariants.variantName,
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
          .where(
            and(
              eq(invoiceItems.variantId, skuVariant.variantId),
              gte(invoices.createdAt, sixtyDaysAgo),
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
          costPrice,
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
        .where(
          and(
            eq(invoiceItems.variantId, owner.variantId),
            gte(invoices.createdAt, sixtyDaysAgo),
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
        costPrice,
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

          // ١) حركات المخزون للمرتجع (زيادة المخزون إذا كان RESTOCK)
          for (const itm of input.returnItems) {
            if (itm.disposition === "RESTOCK") {
              await applyMovement(tx, {
                variantId: itm.variantId,
                branchId: actorBranchId,
                baseQuantity: itm.quantity,
                movementType: "RETURN",
                referenceType:
                  input.mode === "DIRECT_EXCHANGE"
                    ? "EXCHANGE_RETURN"
                    : "NO_RECEIPT_RETURN",
                notes: `${input.mode === "DIRECT_EXCHANGE" ? "استبدال بضاعة" : "مرتجع استثنائي بدون وصل"} [${voucherCode}] — ${returnReason} (${customerName})`,
                createdBy: ctx.user.id,
              });
            }
          }

          // ٢) حركات المخزون للبديل الجديد (خصم المخزون OUT) في حالة الاستبدال المباشر
          if (
            input.mode === "DIRECT_EXCHANGE" &&
            input.exchangeItems &&
            input.exchangeItems.length > 0
          ) {
            for (const itm of input.exchangeItems) {
              await applyMovement(tx, {
                variantId: itm.variantId,
                branchId: actorBranchId,
                baseQuantity: itm.quantity,
                movementType: "OUT",
                referenceType: "EXCHANGE_ISSUE",
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
            dateStr: now.toLocaleDateString("ar-IQ", {
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
  getOpenRefundDrawers: salesCashierProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      if (
        ctx.user.branchId == null &&
        ctx.user.role !== "admin" &&
        !input?.branchId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذر استعراض أدراج النقدية المفتوحة",
            why: "لا يوجد فرع مُسنَد لحسابك الحالي",
            doThis: "تواصل مع مدير النظام لإسناد الفرع التشغيلي لحسابك",
          }),
        });
      }
      const actorBranchId =
        input?.branchId ??
        (ctx.user.branchId ? Number(ctx.user.branchId) : undefined);
      if (!actorBranchId) {
        return [];
      }
      const openShifts = await getOpenShifts(
        { branchId: actorBranchId },
        {
          scopedBranchId: actorBranchId,
          role: ctx.user.role,
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
  executeSalesReturnCart: salesCashierProcedure
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
              productName: z.string().min(1),
              barcode: z.string().nullish(),
              quantity: z.number().int().positive(),
              unitPrice: nonNegMoneyString,
            }),
          )
          .min(1, "يجب تحديد صنف واحد على الأقل للإرجاع"),
        settlement: z.object({
          method: z.enum(["CASH", "CARD", "STORE_CREDIT"]),
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

      return withTx(
        async (tx) => {
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

          // ٠) التحقق من الفاتورة الأصلية إن أدخلت
          let matchedInvoice: typeof invoices.$inferSelect | null = null;
          if (input.invoiceNumber?.trim()) {
            const [found] = await tx
              .select()
              .from(invoices)
              .where(
                and(
                  eq(invoices.invoiceNumber, input.invoiceNumber.trim()),
                  eq(invoices.branchId, actorBranchId),
                ),
              )
              .limit(1);
            if (found) {
              matchedInvoice = found;
            }
          }

          // ⭐ نسبةُ العميل في **الدفتر** (accountingEntries.customerId) لقيد صرف الاسترداد مشروطةٌ
          // بفاتورةٍ مطابقة: عندئذٍ يحمل القيدُ invoiceId فيُستبعَد من voucherSum في
          // reconcileCustomerBalances. بلا فاتورةٍ مطابقة، قيدُ PAYMENT_OUT بـcustomerId وinvoiceId=NULL
          // يُقرأ «سندَ صرفٍ يرفع AR» بينما لا رصيدَ يتحرّك ⇒ انحرافُ reconcile بقيمة المرتجع. النسبةُ
          // للعميل تبقى على **الإيصال** (partyId) لسلامة المسار (§٥). يحرسه salesReturnCartRefund.test.ts.
          const ledgerCustomerId = matchedInvoice
            ? (input.customer?.customerId ?? null)
            : null;

          // ١) تنفيذ حركة المخزون لكل بند
          for (const itm of input.items) {
            if (input.disposition === "RESTOCK") {
              // إعادة للرف/المخزون
              await applyMovement(tx, {
                variantId: itm.variantId,
                branchId: actorBranchId,
                baseQuantity: itm.quantity,
                movementType: "RETURN",
                referenceType: "SALES_RETURN",
                notes: `إرجاع للرف [${returnNumber}] — ${itm.productName} (${customerName})`,
                createdBy: ctx.user.id,
              });
            }
            // إذا كان تالفاً (DAMAGED) لا يُعاد إلى مخزون الرف الصالح للبيع، ويُكتفى بتوثيقه محاسبياً ورقابياً
          }

          // ٢) معالجة التسوية المالية وحركة الصندوق/الدرج/البطاقة/رصيد المتجر
          let generatedReceiptId: number | null = null;

          if (input.settlement.method === "CASH") {
            const targetShiftId = input.settlement.shiftId;
            if (!targetShiftId) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: appErrorMessage({
                  what: "تعذر الصرف النقدي للمرتجع",
                  why: "لم يتم تحديد درج النقدية / الوردية التي سيتم صرف المبلغ منها",
                  doThis:
                    "اختر درج النقدية / الوردية المفتوحة من القائمة قبل التأكيد",
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
                  what: "تعذر الصرف من الدرج المحدد",
                  why: "الوردية المحددة غير موجودة أو مغلقة حالياً",
                  doThis:
                    "اختر وردية مفتوحة سارية في الفرع أو افتح وردية جديدة للكاشير",
                }),
              });
            }

            // فحص كفاية النقد في الدرج لمنع العجز والكسر المالي
            await assertCashOutAvailable(tx, {
              branchId: actorBranchId,
              cashBucket: "DRAWER",
              shiftId: targetShiftId,
              amount: returnTotalDec,
              operation: `استرداد نقدي لمرتجع مبيعات [${returnNumber}]`,
            });

            // تسجيل سند إخراج نقد من الدرج (OUT) لضبط Z-report وcomputeExpectedCash بالمليم
            generatedReceiptId = await recordSalesReturnCartReceipt(tx, {
              branchId: actorBranchId,
              shiftId: targetShiftId,
              amount: returnTotalDec,
              returnNumber,
              customerName,
              customerId: input.customer?.customerId,
              userId: ctx.user.id,
            });

            // قيد صرف النقد من الخزينة/الدرج في الأستاذ العام
            const refundPostingSource = {
              roleDebits: { AR: returnTotalDec },
              roleCredits: { CASH: returnTotalDec },
            };
            await postEntry(tx, {
              entryType: "PAYMENT_OUT",
              branchId: actorBranchId,
              invoiceId: matchedInvoice?.id ?? null,
              receiptId: generatedReceiptId,
              customerId: ledgerCustomerId,
              amount: returnTotalDec,
              notes: `صرف نقدي لمرتجع مبيعات [${returnNumber}] من درج #${targetShiftId}`,
              createdBy: ctx.user.id,
              createdByNameSnapshot: ctx.user.name ?? "كاشير",
              postingIntent: createPostingIntent(
                "PAYMENT_OUT_CUSTOMER_REFUND",
                "PAYMENT_OUT",
                [
                  debitLine("AR", returnTotalDec),
                  creditLine("CASH", returnTotalDec),
                ],
                refundPostingSource,
              ),
              postingSourceComponents: refundPostingSource,
            });
          } else if (input.settlement.method === "CARD") {
            generatedReceiptId = await recordSalesReturnCartCardReceipt(tx, {
              branchId: actorBranchId,
              amount: returnTotalDec,
              returnNumber,
              customerName,
              customerId: input.customer?.customerId,
              reference: input.settlement.reference,
              userId: ctx.user.id,
            });

            const refundPostingSource = {
              roleDebits: { AR: returnTotalDec },
              roleCredits: { CARD_BANK: returnTotalDec },
            };
            await postEntry(tx, {
              entryType: "PAYMENT_OUT",
              branchId: actorBranchId,
              invoiceId: matchedInvoice?.id ?? null,
              receiptId: generatedReceiptId,
              customerId: ledgerCustomerId,
              amount: returnTotalDec,
              notes: `استرداد بطاقة لمرتجع مبيعات [${returnNumber}]`,
              createdBy: ctx.user.id,
              createdByNameSnapshot: ctx.user.name ?? "كاشير",
              postingIntent: createPostingIntent(
                "PAYMENT_OUT_CUSTOMER_REFUND",
                "PAYMENT_OUT",
                [
                  debitLine("AR", returnTotalDec),
                  creditLine("CARD_BANK", returnTotalDec),
                ],
                refundPostingSource,
              ),
              postingSourceComponents: refundPostingSource,
            });
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
          const salesReturnSource = {
            roleDebits: {
              SALES_STATIONERY: returnTotalDec,
              DELIVERY_REVENUE: money(0),
              TAX_PAYABLE: money(0),
              INVENTORY: money(0),
            },
            roleCredits: {
              AR: returnTotalDec,
              COGS: money(0),
            },
          };
          const salesReturnIntent = createPostingIntent(
            "RETURN_SALE_INVENTORY",
            "RETURN",
            [
              debitLine("SALES_STATIONERY", returnTotalDec),
              creditLine("AR", returnTotalDec),
            ],
            salesReturnSource,
          );

          await postEntry(tx, {
            entryType: "RETURN",
            branchId: actorBranchId,
            invoiceId: matchedInvoice?.id ?? null,
            receiptId: generatedReceiptId,
            // اتّساقُ رافدَي الردّ: نفس نسبة PAYMENT_OUT (ledgerCustomerId) — بلا فاتورةٍ مطابقة
            // يُستبعَد كلاهما من دفتر العميل معاً، فلا يجمع تقريرٌ قيدَ RETURN بلا مقابله (بلاغ Codex P1).
            customerId: ledgerCustomerId,
            amount: returnTotalDec.neg(),
            revenue: returnTotalDec.neg(),
            cost: new Decimal(0),
            profit: returnTotalDec.neg(),
            notes: `مرتجع مبيعات سلة [${returnNumber}] — ${customerName} (${
              input.settlement.method === "CASH"
                ? `نقدي من درج #${input.settlement.shiftId}`
                : input.settlement.method === "CARD"
                  ? "بطاقة"
                  : "رصيد متجر"
            })`,
            createdBy: ctx.user.id,
            createdByNameSnapshot: ctx.user.name ?? "كاشير",
            postingIntent: salesReturnIntent,
            postingSourceComponents: salesReturnSource,
          });

          // ٤) تحديث بيانات الفاتورة الأصلية إن وُجدت
          if (matchedInvoice) {
            const newReturnedTotal = money(
              matchedInvoice.returnedTotal ?? "0",
            ).plus(returnTotalDec);
            let newPaid = money(matchedInvoice.paidAmount ?? "0");
            if (
              input.settlement.method === "CASH" ||
              input.settlement.method === "CARD"
            ) {
              const paidMinusRefund = newPaid.minus(returnTotalDec);
              newPaid = paidMinusRefund.lt(0) ? money(0) : paidMinusRefund;
            }
            const isFullyReturned = newReturnedTotal.gte(
              money(matchedInvoice.total),
            );
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

          // ٥) توثيق التدقيق الرقابي
          await logAudit(ctx, {
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
              itemsCount: input.items.length,
              reason: returnReason,
            },
          });

          return {
            ok: true as const,
            returnNumber,
            customerName,
            customerPhone,
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
            dateStr: now.toLocaleDateString("ar-IQ", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            timeStr: now.toLocaleTimeString("ar-IQ", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          };
        },
        { gate: "NONE" },
      );
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

          // ١) خصم الأصناف من مخزون الفرع (حركة OUT / PURCHASE_RETURN)
          for (const itm of input.items) {
            await applyMovement(tx, {
              variantId: itm.variantId,
              branchId: actorBranchId,
              baseQuantity: itm.quantity,
              movementType: "OUT",
              referenceType: "PURCHASE_RETURN",
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
            dateStr: now.toLocaleDateString("ar-IQ", {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
            timeStr: now.toLocaleTimeString("ar-IQ", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          };
        },
        { gate: "NONE" },
      );
    }),
});

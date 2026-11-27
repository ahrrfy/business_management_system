// راوتر العمل دون اتصال — محوّل tRPC نحيف يوثّق المدخلات والاعتمادات ويُفوّض منطق الأعمال
// بالكامل إلى طبقة الخدمات تحت `server/services/offline/`.

import { TRPCError } from "@trpc/server";
import { recipeSelectionsSchema } from "@shared/recipeVariantSelection";
import { appErrorMessage } from "@shared/errors";
import { isDupEntry } from "@shared/errorMap.ar";
import { managerApprovalSchema } from "@shared/managerApproval";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { z } from "zod";
import { canCrossBranches } from "../lib/branchAuthority";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { logger } from "../logger";
import { publishRealtimeEvent } from "../realtime";
import { auditMetadataFromContext, logAudit } from "../services/auditService";
import {
  buildCatalogSnapshot,
  buildCustomersSnapshot,
  buildOfflineVersions,
  buildStockSnapshot,
} from "../services/offline/catalogSnapshot";
import {
  dismissOutboxItemService,
  lookupInvoiceNumberById,
  lookupPreflightSaleOutcomeService,
  reissueOutboxSaleService,
  resolveOfflineEffectiveBranchId,
  throwNoAssignedBranchError,
  verifyAndPrepareReplaySaleService,
} from "../services/offline/preflightReconciliation";
import {
  captureRejectedReplay,
  discardRecoveryItem,
  listRecoveryQueue,
  postRecoveryItem,
} from "../services/offline/recovery";
import { replayOfflinePrintSale } from "../services/offline/replayPrintSale";
import { replayOfflineReception } from "../services/offline/replayReception";
import { replayOfflineReturn } from "../services/offline/replayReturn";
import {
  replayOfflineSale,
  type ReplayOfflineSaleInput,
} from "../services/offline/replaySale";
import { buildOfflineSalesReport } from "../services/offline/salesReport";
import { RETURN_EXECUTED_AUDIT_ACTION } from "../services/returns/auditActions";
import {
  customersReadProcedure,
  posCashierProcedure,
  productsReadProcedure,
  reportViewerProcedure,
  returnsProcedure,
  router,
  salesCashierProcedure,
  salesManagerProcedure,
  workordersCashierProcedure,
} from "../trpc";
import { verifyManagerApproval } from "./saleRouter";

/** نفس حارس IDOR في catalogRouter: غير المرتفعين محصورون بفرعهم المُسنَد. */
function scopeBranch(
  ctx: {
    user: { role: string; branchId?: number | null; isOwner?: boolean | null };
  },
  requested: number,
): number {
  const elevated = canCrossBranches(ctx.user);
  if (elevated) return requested;
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : requested;
}

/** عزل الفرع + بناء الفاعل — مرآة `saleRouter.create` حرفياً (منع IDOR). */
function scopeActor(
  ctx: {
    user: {
      id: number;
      role: string;
      branchId?: number | null;
      isOwner?: boolean | null;
    };
  },
  requestedBranchId: number,
) {
  const crossBranch = canCrossBranches(ctx.user);
  let effectiveBranchId = requestedBranchId;
  if (!crossBranch) {
    if (ctx.user.branchId == null) {
      throwNoAssignedBranchError();
    }
    effectiveBranchId = Number(ctx.user.branchId);
  }
  const canApprove = ctx.user.role === "admin" || ctx.user.role === "manager";
  return {
    canApprove,
    effectiveBranchId,
    actor: {
      userId: ctx.user.id,
      branchId: effectiveBranchId,
      role: ctx.user.role,
      isOwner: Boolean(ctx.user.isOwner),
    },
  };
}

/** غلاف تنفيذ الترحيل: إعادة محاولة تصادم ترقيم الفاتورة + أثر تدقيقيّ + التقاط الرفض خادمياً. */
async function runReplay<
  T extends { invoiceId?: number; idempotentReplay?: boolean },
>(
  run: () => Promise<T>,
  meta: {
    ctx: Parameters<typeof logAudit>[0];
    action: string;
    offlineReceiptNumber: string;
    capturedAt: string;
    deviceId: string | null;
    lines: number;
    capture?: {
      input: ReplayOfflineSaleInput;
      submittedByUserId: number;
      channel: "RETAIL" | "PRINT" | "RECEPTION" | "RETURN";
      captureOnCodes?: ReadonlyArray<TRPCError["code"]>;
    };
  },
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await run();
      if (!res.idempotentReplay) {
        await logAudit(meta.ctx, {
          action: meta.action,
          entityType: "invoice",
          entityId: res.invoiceId ?? 0,
          newValue: {
            offlineReceiptNumber: meta.offlineReceiptNumber,
            capturedAt: meta.capturedAt,
            deviceId: meta.deviceId,
            lines: meta.lines,
          },
        });
      }
      return res;
    } catch (e: unknown) {
      if (isDupEntry(e) && attempt < 2) continue;
      if (e instanceof TRPCError) {
        const capturableCodes =
          meta.capture?.captureOnCodes ?? (["PRECONDITION_FAILED"] as const);
        if (meta.capture && capturableCodes.includes(e.code)) {
          await captureRejectedReplay(
            meta.capture.input,
            e.code,
            e.message,
            meta.capture.submittedByUserId,
            meta.capture.channel,
          );
        }
        throw e;
      }
      const err = e as {
        message?: string;
        code?: string;
        sqlMessage?: string;
        sql?: string;
      };
      logger.error(
        {
          err: {
            message: err?.message,
            code: err?.code,
            sqlMessage: err?.sqlMessage,
            sql: err?.sql,
          },
          offlineReceiptNumber: meta.offlineReceiptNumber,
          action: meta.action,
        },
        "ترحيل أوفلايني فشل بخطأ غير متوقّع",
      );
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "تعذّر ترحيل العملية الأوفلاينية",
      });
    }
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: appErrorMessage({
      what: "تعذّر توليد رقم فاتورة فريد",
      why: "استُنفدت محاولات حجز رقم الفاتورة على الخادم بسبب تزامن عالٍ",
      doThis:
        "سيعيد النظام محاولة المزامنة تلقائياً؛ وإن بقيت معلّقة اضغط إعادة المحاولة من شارة الأوفلاين",
    }),
  });
}

const replaySaleInputSchema = z.object({
  branchId: z.number().int().positive(),
  shiftId: z.number().int().positive().optional(),
  customerId: z.number().int().positive().optional(),
  priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
  lines: z
    .array(
      z.object({
        variantId: z.number().int().positive(),
        productUnitId: z.number().int().positive(),
        quantity: z
          .string()
          .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ثلاث منازل)"),
        unitPriceOverride: nonNegMoneyString,
        discountPercent: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة")
          .optional(),
        discountAmount: nonNegMoneyString.optional(),
        promotionId: z.number().int().positive().nullish(),
        promotionDiscount: nonNegMoneyString.optional(),
        cashierDiscountAmount: nonNegMoneyString.optional(),
        recipeSelections: recipeSelectionsSchema.optional(),
      }),
    )
    .min(1),
  invoiceDiscount: nonNegMoneyString.optional(),
  payment: z.object({ amount: positiveMoneyString, method: z.literal("CASH") }),
  clientRequestId: z.string().min(8).max(50),
  notes: z.string().max(1000).optional(),
  cashRoundIQD: z.boolean().optional(),
  capturedAt: z.string().min(10).max(40),
  offlineReceiptNumber: z.string().min(4).max(40),
  deviceId: z.string().max(40).optional(),
  capturedByUserId: z.number().int().positive().optional(),
  capturedShiftId: z.number().int().positive().optional(),
  captureProof: z.string().min(32).max(128).optional(),
  keyId: z.string().min(1).max(24).optional(),
  grantId: z.string().min(16).max(64).optional(),
  grantIssuedAtMs: z.number().int().positive().optional(),
  grantExpiresAtMs: z.number().int().positive().optional(),
  grantToken: z.string().min(32).max(128).optional(),
  salesRepId: z.number().int().positive().nullish(),
  attribution: z
    .object({
      repId: z.number().int().positive().nullish(),
      mode: z.enum(["DIRECT", "SPLIT", "POOL"]).optional(),
    })
    .optional(),
  managerApproval: managerApprovalSchema.optional(),
});

export const offlineRouter = router({
  /** نسخ رخيصة تُقارَن كل مزامنة — تغيّر نسخة ⇒ جلب اللقطة الموافقة كاملة. */
  versions: productsReadProcedure.query(() => buildOfflineVersions()),

  catalogSnapshot: productsReadProcedure.query(() => buildCatalogSnapshot()),

  stockSnapshot: productsReadProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) =>
      buildStockSnapshot(scopeBranch(ctx, input.branchId)),
    ),

  customersSnapshot: customersReadProcedure.query(() =>
    buildCustomersSnapshot(),
  ),

  lookupPreflightSaleOutcome: salesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        clientRequestId: z.string().min(4).max(120),
        expectedSemanticSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .optional(),
        mode: z.enum(["OBSERVE", "FENCE_IF_UNCOMMITTED"]).default("OBSERVE"),
        kind: z.enum(["SALE", "PRINT_SALE", "RECEPTION", "RETURN"]).optional(),
        offlineReceiptNumber: z.string().trim().max(40).optional(),
      }),
    )
    .query(({ input, ctx }) =>
      lookupPreflightSaleOutcomeService(
        input,
        ctx.user,
        auditMetadataFromContext(ctx),
      ),
    ),

  /** تقرير «المبيعات الأوفلاين» للإدارة: ربط OFF↔INV + زمن الترحيل. */
  salesReport: reportViewerProcedure
    .input(
      z.object({
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const canCross = ctx.canCrossBranches ?? canCrossBranches(ctx.user);
      const branchId = canCross
        ? input.branchId
        : (ctx.scopedBranchId ??
          (ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined));
      if (!canCross && branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "لا فرع مُسنَد لهذا المستخدم",
            why: "حسابك غير مرتبط بفرع محدّد ولا يملك صلاحية استعراض كافة الفروع",
            doThis:
              "اطلب من مدير النظام إسناد حسابك إلى الفرع الصحيح من شاشة المستخدمين",
          }),
        });
      }
      return buildOfflineSalesReport({ ...input, branchId });
    }),

  /** إعادة تشغيل بيعٍ التُقط دون اتصال — غلاف idempotent حول createSale. */
  replaySale: salesCashierProcedure
    .input(replaySaleInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { managerApproval, ...payload } = input;
      const effectiveBranchId = resolveOfflineEffectiveBranchId(
        ctx.user,
        input.branchId,
      );
      let approvedBy: number | null = null;
      if (managerApproval) {
        approvedBy = await verifyManagerApproval(
          managerApproval,
          ctx,
          effectiveBranchId,
        );
      }
      const prepared = await verifyAndPrepareReplaySaleService(
        payload,
        ctx.user,
        { approvedBy },
      );
      const {
        actor,
        replayInput,
        verifiedQuarantineOwnerId,
        delegatedSellerUserId,
        priceOverrideApprovedBy,
      } = prepared;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await replayOfflineSale(
            {
              ...replayInput,
              branchId: prepared.effectiveBranchId,
              priceOverrideApproved: priceOverrideApprovedBy != null,
            },
            actor,
            delegatedSellerUserId != null
              ? { attributeToUserId: delegatedSellerUserId }
              : undefined,
          );
          if (!res.idempotentReplay) {
            await logAudit(ctx, {
              action: "sale.offlineReplay",
              entityType: "invoice",
              entityId: res.invoiceId,
              newValue: {
                offlineReceiptNumber: input.offlineReceiptNumber,
                capturedAt: input.capturedAt,
                deviceId: input.deviceId ?? null,
                lines: input.lines.length,
              },
            });
            if (res.priceOverride) {
              await logAudit(ctx, {
                action: "sale.priceOverride",
                entityType: "invoice",
                entityId: res.invoiceId,
                newValue: {
                  approvedByUserId: priceOverrideApprovedBy,
                  byRole: ctx.user.role,
                  offlineReplay: true,
                },
              });
            }
            publishRealtimeEvent(
              REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
              {
                branchId: prepared.effectiveBranchId,
                deviceId: input.deviceId ?? undefined,
                syncedCount: 1,
                totalAmount: input.payment.amount,
                timestamp: Date.now(),
              },
              {
                branchId: prepared.effectiveBranchId,
              },
            );
          }
          return res;
        } catch (e: unknown) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) {
            if (e.code === "PRECONDITION_FAILED") {
              await captureRejectedReplay(
                { ...replayInput, branchId: prepared.effectiveBranchId },
                e.code,
                e.message,
                verifiedQuarantineOwnerId,
                "RETAIL",
              );
            }
            throw e;
          }
          const err = e as {
            message?: string;
            code?: string;
            sqlMessage?: string;
            sql?: string;
          };
          logger.error(
            {
              err: {
                message: err?.message,
                code: err?.code,
                sqlMessage: err?.sqlMessage,
                sql: err?.sql,
              },
              userId: actor.userId,
              branchId: actor.branchId,
              offlineReceiptNumber: input.offlineReceiptNumber,
            },
            "offline.replaySale فشل بخطأ غير متوقّع",
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "تعذّر ترحيل البيع الأوفلايني",
          });
        }
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: appErrorMessage({
          what: "تعذّر توليد رقم فاتورة فريد",
          why: "استُنفدت محاولات حجز رقم الفاتورة على الخادم بسبب تزامن عالٍ",
          doThis:
            "سيعيد النظام محاولة المزامنة تلقائياً؛ وإن بقيت معلّقة اضغط إعادة المحاولة من شارة الأوفلاين",
        }),
      });
    }),

  /** إعادة معالجة بيع أوفلايني معلّق يحمل معرّف طلب مُسيّج خادمياً (`refId = -1`). */
  reissueOutboxSale: salesCashierProcedure
    .input(
      replaySaleInputSchema.extend({
        targetShiftId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { managerApproval, ...payload } = input;
      const effectiveBranchId = resolveOfflineEffectiveBranchId(
        ctx.user,
        input.branchId,
      );
      const canApprove =
        Boolean(ctx.user.isOwner) ||
        ctx.user.role === "admin" ||
        ctx.user.role === "manager";
      let approvedBy: number | null = canApprove ? ctx.user.id : null;
      if (managerApproval) {
        approvedBy = await verifyManagerApproval(
          managerApproval,
          ctx,
          effectiveBranchId,
        );
      }
      return reissueOutboxSaleService(
        payload,
        ctx.user,
        auditMetadataFromContext(ctx),
        approvedBy,
      );
    }),

  /** ترحيل بيع خدمات طباعةٍ التُقط دون اتصال (كاشير الطباعة). */
  replayPrintSale: posCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        contactName: z.string().trim().max(255).optional(),
        contactPhone: z.string().trim().max(32).optional(),
        priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z
                .string()
                .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
              unitPriceOverride: nonNegMoneyString,
              recipeSelections: recipeSelectionsSchema.optional(),
            }),
          )
          .min(1),
        invoiceDiscount: nonNegMoneyString.optional(),
        payment: z.object({
          amount: positiveMoneyString,
          method: z.literal("CASH"),
        }),
        clientRequestId: z.string().min(8).max(50),
        notes: z.string().max(1000).optional(),
        cashRoundIQD: z.boolean().optional(),
        capturedAt: z.string().min(10).max(40),
        offlineReceiptNumber: z.string().min(4).max(40),
        deviceId: z.string().max(40).optional(),
        managerApproval: managerApprovalSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { effectiveBranchId, actor } = scopeActor(
        ctx,
        input.branchId,
      );
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) {
        approvedBy = await verifyManagerApproval(
          managerApproval,
          ctx,
          effectiveBranchId,
        );
      }
      const priceOverrideApproved = approvedBy != null;
      return runReplay(
        () =>
          replayOfflinePrintSale(
            {
              ...replayInput,
              branchId: effectiveBranchId,
              priceOverrideApproved,
            },
            actor,
          ),
        {
          ctx,
          action: "printSale.offlineReplay",
          capture: {
            input: {
              ...replayInput,
              branchId: effectiveBranchId,
            } as unknown as ReplayOfflineSaleInput,
            submittedByUserId: ctx.user.id,
            channel: "PRINT" as const,
          },
          offlineReceiptNumber: input.offlineReceiptNumber,
          capturedAt: input.capturedAt,
          deviceId: input.deviceId ?? null,
          lines: input.lines.length,
        },
      );
    }),

  /** ترحيل سلّة استقبالٍ التُقطت دون اتصال (كاشير خدمات الزبائن). */
  replayReception: workordersCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive(),
        customerId: z.number().int().positive().optional(),
        contactName: z.string().trim().max(255).optional(),
        contactPhone: z.string().trim().max(32).optional(),
        priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
        paymentMethod: z.literal("CASH"),
        paidAmount: positiveMoneyString,
        regularSale: z
          .object({
            lines: z
              .array(
                z.object({
                  variantId: z.number().int().positive(),
                  productUnitId: z.number().int().positive(),
                  quantity: z
                    .string()
                    .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
                  unitPriceOverride: nonNegMoneyString,
                  discountPercent: z
                    .string()
                    .regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة")
                    .optional(),
                  discountAmount: nonNegMoneyString.optional(),
                  promotionId: z.number().int().positive().nullish(),
                  promotionDiscount: nonNegMoneyString.optional(),
                  cashierDiscountAmount: nonNegMoneyString.optional(),
                  recipeSelections: recipeSelectionsSchema.optional(),
                }),
              )
              .min(1),
            amount: positiveMoneyString,
            invoiceDiscount: nonNegMoneyString.optional(),
          })
          .nullish(),
        printSale: z
          .object({
            lines: z
              .array(
                z.object({
                  variantId: z.number().int().positive(),
                  productUnitId: z.number().int().positive(),
                  quantity: z
                    .string()
                    .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
                  unitPriceOverride: nonNegMoneyString,
                  recipeSelections: recipeSelectionsSchema.optional(),
                }),
              )
              .min(1),
            amount: positiveMoneyString,
          })
          .nullish(),
        clientRequestId: z.string().min(8).max(50),
        capturedAt: z.string().min(10).max(40),
        offlineReceiptNumber: z.string().min(4).max(40),
        deviceId: z.string().max(40).optional(),
        managerApproval: managerApprovalSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { effectiveBranchId, actor } = scopeActor(
        ctx,
        input.branchId,
      );
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) {
        approvedBy = await verifyManagerApproval(
          managerApproval,
          ctx,
          effectiveBranchId,
        );
      }
      const priceOverrideApproved = approvedBy != null;
      return runReplay(
        () =>
          replayOfflineReception(
            {
              ...replayInput,
              branchId: effectiveBranchId,
              priceOverrideApproved,
            },
            actor,
          ),
        {
          ctx,
          action: "reception.offlineReplay",
          capture: {
            input: {
              ...replayInput,
              branchId: effectiveBranchId,
            } as unknown as ReplayOfflineSaleInput,
            submittedByUserId: ctx.user.id,
            channel: "RECEPTION" as const,
          },
          offlineReceiptNumber: input.offlineReceiptNumber,
          capturedAt: input.capturedAt,
          deviceId: input.deviceId ?? null,
          lines:
            (input.regularSale?.lines.length ?? 0) +
            (input.printSale?.lines.length ?? 0),
        },
      );
    }),

  /** ترحيلُ مرتجعٍ التُقط دون اتصال. */
  replayReturn: salesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        invoiceId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              invoiceItemId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
            }),
          )
          .min(1),
        refund: z.object({
          amount: positiveMoneyString,
          method: z.literal("CASH"),
          shiftId: z.number().int().positive().optional(),
        }),
        restock: z.boolean(),
        reason: z.string().trim().min(3).max(500),
        clientRequestId: z.string().min(8).max(50),
        capturedAt: z.string().min(10).max(40),
        offlineReceiptNumber: z.string().min(4).max(40),
        deviceId: z.string().max(40).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { effectiveBranchId, actor } = scopeActor(ctx, input.branchId);
      const { branchId: _branchId, ...replayInput } = input;
      return runReplay(
        async () => {
          const out = await replayOfflineReturn(replayInput, actor);
          const invoiceNumber = await lookupInvoiceNumberById(
            replayInput.invoiceId,
          );
          return { ...out, invoiceNumber };
        },
        {
          ctx,
          action: RETURN_EXECUTED_AUDIT_ACTION,
          capture: {
            input: {
              ...replayInput,
              branchId: effectiveBranchId,
            } as unknown as ReplayOfflineSaleInput,
            submittedByUserId: ctx.user.id,
            channel: "RETURN" as const,
            captureOnCodes: ["PRECONDITION_FAILED", "BAD_REQUEST"] as const,
          },
          offlineReceiptNumber: input.offlineReceiptNumber,
          capturedAt: input.capturedAt,
          deviceId: input.deviceId ?? null,
          lines: input.lines.length,
        },
      );
    }),

  /** طابور الاسترداد: مبيعاتٌ أوفلاينية مدفوعة رفضها الخادم ولم تدخل الدفتر بعد. */
  recoveryQueue: salesManagerProcedure.query(async ({ ctx }) => {
    return listRecoveryQueue({
      userId: ctx.user.id,
      branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
      role: ctx.user.role,
      isOwner: Boolean(ctx.user.isOwner),
    });
  }),

  /** ترحيل عنصرٍ محتجَز إلى وردية مفتوحة — هنا فقط يُكتب القيد. */
  postRecoveryItem: salesManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        targetShiftId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return postRecoveryItem(
        input.id,
        input.targetShiftId,
        {
          userId: ctx.user.id,
          branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
          role: ctx.user.role,
          isOwner: Boolean(ctx.user.isOwner),
        },
        ctx,
      );
    }),

  /** إهمال عنصر (إيصال فحص/تجربة) — بسببٍ إلزاميّ وأثرٍ تدقيقيّ. */
  discardRecoveryItem: salesManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        reason: z.string().min(5).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return discardRecoveryItem(
        input.id,
        input.reason,
        {
          userId: ctx.user.id,
          branchId: ctx.user.branchId == null ? -1 : Number(ctx.user.branchId),
          role: ctx.user.role,
          isOwner: Boolean(ctx.user.isOwner),
        },
        ctx,
      );
    }),

  /** إغلاق وإنهاء عنصر أوفلايني معلّق (PARKED) من طابور المتصفح بأمان ودون ثغرات. */
  dismissOutboxItem: returnsProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        clientRequestId: z.string().min(4).max(64),
        kind: z
          .enum(["SALE", "PRINT_SALE", "RECEPTION", "RETURN"])
          .default("SALE"),
        offlineReceiptNumber: z.string().trim().min(1).max(60),
        total: z.string().max(40).optional(),
        lastError: z.string().max(1000).optional(),
        reason: z.string().trim().max(500).optional(),
        managerApproval: managerApprovalSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { managerApproval, ...payload } = input;
      const effectiveBranchId = resolveOfflineEffectiveBranchId(
        ctx.user,
        input.branchId,
      );
      const canApprove =
        Boolean(ctx.user.isOwner) ||
        ctx.user.role === "admin" ||
        ctx.user.role === "manager";
      let preverifiedApproverId: number | null = canApprove
        ? ctx.user.id
        : null;
      if (managerApproval) {
        preverifiedApproverId = await verifyManagerApproval(
          managerApproval,
          ctx,
          effectiveBranchId,
        );
      }
      return dismissOutboxItemService(
        payload,
        ctx.user,
        auditMetadataFromContext(ctx),
        preverifiedApproverId,
      );
    }),
});

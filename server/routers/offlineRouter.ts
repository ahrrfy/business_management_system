// راوتر العمل دون اتصال — الشريحة ٢ من خطة الأوفلاين: نقاط جلب النموذج المحلي (لقطات
// الكتالوج/المخزون/العملاء + النسخ). القراءة فقط هنا؛ إعادة تشغيل المبيعات (replaySale)
// تأتي في الشريحة ٣.
//
// البوّابات مرآة catalogRouter/customerRouter: الكتالوج والأسعار خلف products READ،
// والعملاء خلف crm READ — نفس ما يصل إليه الكاشير أونلاين، لا أوسع (اللقطة ليست تصديراً
// أوسع من الشاشة). المخزون مقيَّد بفرع المستخدم غير المرتفع (نفس حارس IDOR في posList).

import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { isDupEntry } from "@shared/errorMap.ar";
import { z } from "zod";
import { logger } from "../logger";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import {
  buildCatalogSnapshot,
  buildCustomersSnapshot,
  buildOfflineVersions,
  buildStockSnapshot,
} from "../services/offline/catalogSnapshot";
import { replayOfflineSale, type ReplayOfflineSaleInput } from "../services/offline/replaySale";
import { replayOfflinePrintSale } from "../services/offline/replayPrintSale";
import { replayOfflineReception } from "../services/offline/replayReception";
import { replayOfflineReturn } from "../services/offline/replayReturn";
import { RETURN_EXECUTED_AUDIT_ACTION } from "../services/returns/auditActions";
import { and, eq, sql } from "drizzle-orm";
import { idempotencyKeys, invoices, shifts, users } from "../../drizzle/schema";
import { requireDb, withTx } from "../services/tx";
import { getInProcessActiveSaleFlight } from "../services/sale/create";
import { canUseStation, type PermissionMap } from "@shared/permissions";
import { normalizeOwnerAuthority, resolveCustomRole, type AuthUser } from "../context";
import { assertOperationAuthorized } from "../operationAuthorization";
import { verifyOfflineCaptureProofServer } from "../lib/offlineCaptureGrant";
import { buildOfflineSalesReport } from "../services/offline/salesReport";
import {
  captureRejectedReplay,
  discardRecoveryItem,
  listRecoveryQueue,
  postRecoveryItem,
} from "../services/offline/recovery";
import { verifyManagerApproval } from "./saleRouter";
import { managerApprovalSchema } from "@shared/managerApproval";
import { canCrossBranches } from "../lib/branchAuthority";
import {
  customersReadProcedure,
  posCashierProcedure,
  productsReadProcedure,
  reportViewerProcedure,
  router,
  salesCashierProcedure,
  salesManagerProcedure,
  workordersCashierProcedure,
} from "../trpc";
import { publishRealtimeEvent } from "../realtime";
import { REALTIME_EVENT_TYPES } from "../../shared/realtimeEvents";

function throwNoAssignedBranchError(): never {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: "لا فرع مُسنَد لهذا المستخدم",
      why: "حسابك غير مرتبط بفرع عامل لتنفيذ أو مراجعة العمليات الأوفلاينية",
      doThis: "اطلب من مدير النظام ربط حسابك بفرع من شاشة المستخدمين",
    }),
  });
}

function throwForeignBranchIdempotencyError(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "معرّف الطلب مستعمَل لبيع فرع آخر",
      why: "مفتاح idempotency مسجّل على فرع مختلف ولا يجوز كشفه أو استخدامه عبر الفروع",
      doThis: "أنشئ طلب بيع جديد داخل فرعك بمعرّف مستقل",
    }),
  });
}

function throwSemanticPayloadConflictError(targetLabel: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: `تعارض في بصمة حمولة البيع مقابل ${targetLabel}`,
      why: "بصمة الحمولة الدلالية للنية لا تطابق البيانات المسجلة لنفس المعرّف",
      doThis: "راجع بنود السلة والمبلغ الأصلي أو أنشئ عملية جديدة بمعرّف مختلف",
    }),
  });
}

/** نفس حارس IDOR في catalogRouter: غير المرتفعين محصورون بفرعهم المُسنَد. */
function scopeBranch(ctx: { user: { role: string; branchId?: number | null; isOwner?: boolean | null } }, requested: number): number {
  const elevated = canCrossBranches(ctx.user); // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
  if (elevated) return requested;
  return ctx.user.branchId != null ? Number(ctx.user.branchId) : requested;
}

/** عزل الفرع + بناء الفاعل — مرآة `saleRouter.create` حرفياً (منع IDOR): غير المرتفع يُجبَر
 *  على فرعه المُسنَد ولا يُصدَّق `branchId` القادم من العميل. مشتركٌ بين مسارات الترحيل الثلاثة
 *  كي لا ينجرف حارسُ أحدها عن الآخرين. */
function scopeActor(
  ctx: { user: { id: number; role: string; branchId?: number | null; isOwner?: boolean | null } },
  requestedBranchId: number,
) {
  // عزل مدير الفرع (قرار المالك ١٢/٨): عبور الفروع للمالك/الأدمن فقط. **فصلٌ عن السلطة** (P2 Codex):
  // canApprove (سلطة اعتماد التسعير تحت التكلفة) تبقى للمدير — لا الفرع.
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
    actor: { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role, isOwner: Boolean(ctx.user.isOwner) },
  };
}

/** غلاف تنفيذ الترحيل: إعادة محاولة تصادم ترقيم الفاتورة + أثر تدقيقيّ + تحويل الأخطاء غير
 *  المتوقّعة إلى رسالةٍ عربية بلا تسريب SQL. مشتركٌ بين الأنواع الثلاثة (كان محصوراً بـreplaySale). */
async function runReplay<T extends { invoiceId?: number; idempotentReplay?: boolean }>(
  run: () => Promise<T>,
  meta: {
    ctx: Parameters<typeof logAudit>[0];
    action: string;
    offlineReceiptNumber: string;
    capturedAt: string;
    deviceId: string | null;
    lines: number;
    /** حمولة الالتقاط + هوية المُرسِل + القناة — لتوثيق الرفض خادمياً (و-٤) في كل القنوات. */
    capture?: {
      input: ReplayOfflineSaleInput;
      submittedByUserId: number;
      channel: "RETAIL" | "PRINT" | "RECEPTION" | "RETURN";
      /**
       * رموزُ الرفض التي تُلتقَط للاسترداد. الافتراض `PRECONDITION_FAILED` وحده (نافذةُ
       * الالتقاط/الوردية…). أمّا **المرتجع** فرفضُه الماليّ الأهمّ — تجاوزُ سقف الاسترداد —
       * يأتي `BAD_REQUEST` من `returnSaleInTx`، وكان يمرّ بلا التقاطٍ بينما النقدُ خرج فعلاً
       * (أمسكه Codex على PR #932، P2). الدليلُ يبقى على متصفّحٍ واحد وحده لولا هذا.
       */
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
        // و-٤: رفضُ الأعمال يعني عمليةً **مدفوعة** لا مكان لها في الدفتر ⇒ تُلتقط خادمياً قبل
        // إعادة رمي الرفض. هنا في الغلاف المشترك كي تشمل الطباعة والاستقبال لا البيع وحده.
        const capturableCodes = meta.capture?.captureOnCodes ?? (["PRECONDITION_FAILED"] as const);
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
      const err = e as { message?: string; code?: string; sqlMessage?: string; sql?: string };
      logger.error(
        {
          err: { message: err?.message, code: err?.code, sqlMessage: err?.sqlMessage, sql: err?.sql },
          offlineReceiptNumber: meta.offlineReceiptNumber,
          action: meta.action,
        },
        "ترحيل أوفلايني فشل بخطأ غير متوقّع",
      );
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر ترحيل العملية الأوفلاينية" });
    }
  }
  throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
}

export const offlineRouter = router({
  /** نسخ رخيصة تُقارَن كل مزامنة — تغيّر نسخة ⇒ جلب اللقطة الموافقة كاملة. */
  versions: productsReadProcedure.query(() => buildOfflineVersions()),

  catalogSnapshot: productsReadProcedure.query(() => buildCatalogSnapshot()),

  stockSnapshot: productsReadProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .query(({ input, ctx }) => buildStockSnapshot(scopeBranch(ctx, input.branchId))),

  customersSnapshot: customersReadProcedure.query(() => buildCustomersSnapshot()),

  lookupPreflightSaleOutcome: salesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        clientRequestId: z.string().min(4).max(120),
        expectedSemanticSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
        mode: z.enum(["OBSERVE", "FENCE_IF_UNCOMMITTED"]).default("OBSERVE"),
      }),
    )
    .query(async ({ input, ctx }) => {
      const crossBranch = canCrossBranches(ctx.user);
      let effectiveBranchId = input.branchId;
      if (!crossBranch) {
        if (ctx.user.branchId == null) {
          throwNoAssignedBranchError();
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      const canAdminReconcile =
        Boolean(ctx.user.isOwner) || ctx.user.role === "admin" || ctx.user.role === "manager";
      const normalizedExpectedHash = input.expectedSemanticSha256?.toLowerCase() ?? null;

      // 1) Check in-process active sale flight map first (detects requests even before/during InnoDB lock acquisition)
      const activeFlight = getInProcessActiveSaleFlight(input.clientRequestId);
      if (activeFlight) {
        if (Number(activeFlight.branchId) !== effectiveBranchId) {
          throwForeignBranchIdempotencyError();
        }
        const isFlightOwner = Number(activeFlight.sellerUserId) === Number(ctx.user.id);
        if (!isFlightOwner && !canAdminReconcile) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر الاستعلام عن فاتورة قيد التنفيذ لموظف آخر",
              why: "الطلب الجاري يعود لكاشير آخر ولا تملك صلاحية مدير أو أدمن للمصالحة",
              doThis: "استدعِ مدير الفرع لمراجعة الفاتورة المعلّقة أو سجّل الدخول بحساب الكاشير الأصلي",
            }),
          });
        }
        if (
          normalizedExpectedHash &&
          activeFlight.semanticSha256.toLowerCase() !== normalizedExpectedHash
        ) {
          throwSemanticPayloadConflictError("الطلب الجاري");
        }
        return { outcome: "UNKNOWN_IN_FLIGHT" as const };
      }

      const isNowaitLockContention = (err: unknown): boolean => {
        const anyErr = err as {
          errno?: number;
          code?: string;
          message?: string;
          cause?: { errno?: number; code?: string; message?: string };
        } | null;
        const errno = anyErr?.errno ?? anyErr?.cause?.errno;
        const code = anyErr?.code ?? anyErr?.cause?.code ?? "";
        const msg = `${anyErr?.message ?? ""} ${anyErr?.cause?.message ?? ""}`;
        return (
          errno === 3572 ||
          errno === 1205 ||
          errno === 1213 ||
          code === "ER_LOCK_NOWAIT" ||
          msg.includes("NOWAIT") ||
          msg.includes("could not be acquired immediately")
        );
      };

      let pendingPostTxAudit: Parameters<typeof logAudit>[1] | null = null;
      try {
        const txOutcome = await withTx(
          async (tx) => {
          const lockQuery =
            input.mode === "FENCE_IF_UNCOMMITTED"
              ? sql`SELECT refId, payloadHash FROM idempotencyKeys WHERE operation = 'sale.create' AND clientRequestId = ${input.clientRequestId} LIMIT 1 FOR UPDATE NOWAIT`
              : sql`SELECT refId, payloadHash FROM idempotencyKeys WHERE operation = 'sale.create' AND clientRequestId = ${input.clientRequestId} LIMIT 1 FOR SHARE NOWAIT`;
          const rawLockRes = await tx.execute(lockQuery);
          const lockRows = (
            Array.isArray(rawLockRes) && Array.isArray(rawLockRes[0])
              ? rawLockRes[0]
              : rawLockRes
          ) as Array<{ refId: number; payloadHash: string | null }>;
          const idempRow = lockRows[0] ?? null;

          const [semHashRow] = await tx
            .select({
              refId: idempotencyKeys.refId,
              payloadHash: idempotencyKeys.payloadHash,
            })
            .from(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.operation, "sale.create.semhash"),
                eq(idempotencyKeys.clientRequestId, input.clientRequestId),
              ),
            )
            .limit(1);

          const rawInvRes = await tx.execute(
            sql`SELECT id, invoiceNumber, total, shiftId, branchId, createdBy FROM invoices WHERE sourceType = 'POS' AND sourceId = ${input.clientRequestId} LIMIT 1 FOR SHARE NOWAIT`,
          );
          const invRows = (
            Array.isArray(rawInvRes) && Array.isArray(rawInvRes[0])
              ? rawInvRes[0]
              : rawInvRes
          ) as Array<{
            id: number;
            invoiceNumber: string;
            total: string;
            shiftId: number | null;
            branchId: number;
            createdBy: number;
          }>;
          const existing = invRows[0] ?? null;

          if (existing) {
            if (Number(existing.branchId) !== effectiveBranchId) {
              throwForeignBranchIdempotencyError();
            }
            const isOriginalSeller = Number(existing.createdBy) === Number(ctx.user.id);
            if (!isOriginalSeller && !canAdminReconcile) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: appErrorMessage({
                  what: "تعذّر الاستعلام عن فاتورة معلّقة لموظف آخر",
                  why: "الفاتورة مسجّلة لكاشير مختلف ولا تملك صلاحية مدير أو أدمن",
                  doThis: "اطلب من المدير مصالحة الحالة أو سجّل الدخول بحساب الموظف الأصلي",
                }),
              });
            }
            if (
              normalizedExpectedHash &&
              semHashRow?.payloadHash &&
              semHashRow.payloadHash.toLowerCase() !== normalizedExpectedHash
            ) {
              throwSemanticPayloadConflictError("الفاتورة الملتزمة");
            }
            if (!isOriginalSeller && canAdminReconcile) {
              pendingPostTxAudit = {
                action: "offline.preflight.adminLookup",
                entityType: "invoice",
                entityId: Number(existing.id),
                newValue: {
                  clientRequestId: input.clientRequestId,
                  originalSellerId: Number(existing.createdBy),
                  branchId: effectiveBranchId,
                },
              };
            }
            return {
              outcome: "COMMITTED" as const,
              invoiceId: Number(existing.id),
              invoiceNumber: existing.invoiceNumber,
              total: String(existing.total),
              shiftId: existing.shiftId != null ? Number(existing.shiftId) : null,
              createdBy: Number(existing.createdBy),
              semanticPayloadSha256: semHashRow?.payloadHash ?? null,
            };
          }

          if (idempRow) {
            const refNum = Number(idempRow.refId);
            if (refNum === 0) {
              return { outcome: "UNKNOWN_IN_FLIGHT" as const };
            }
            if (refNum === -1) {
              if (
                normalizedExpectedHash &&
                idempRow.payloadHash &&
                idempRow.payloadHash.toLowerCase() !== normalizedExpectedHash
              ) {
                throwSemanticPayloadConflictError("السجل المسيّج");
              }
              return { outcome: "FENCED_NOT_COMMITTED" as const };
            }
          }

          // Mere row absence NEVER claims `NOT_COMMITTED`!
          if (input.mode === "OBSERVE") {
            return { outcome: "UNKNOWN" as const };
          }

          // `mode === "FENCE_IF_UNCOMMITTED"`: atomically insert `refId = -1` under `FOR UPDATE NOWAIT`
          // so no delayed original packet can EVER commit under `input.clientRequestId` after this transaction!
          if (!normalizedExpectedHash) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "بيانات التسييج غير مكتملة",
                why: "يلزم تمرير البصمة الدلالية للنية expectedSemanticSha256 عند طلب التسييج الصريح",
                doThis: "حدّث الواجهة وأعِد طلب التسييج متضمناً بصمة الحمولة",
              }),
            });
          }
          await tx.insert(idempotencyKeys).values([
            {
              operation: "sale.create",
              clientRequestId: input.clientRequestId,
              refId: -1,
              payloadHash: normalizedExpectedHash,
            },
            {
              operation: "sale.create.semhash",
              clientRequestId: input.clientRequestId,
              refId: -1,
              payloadHash: normalizedExpectedHash,
            },
          ]);
          pendingPostTxAudit = {
            action: "offline.preflight.fencedUncommitted",
            entityType: "invoice",
            entityId: 0,
            newValue: {
              clientRequestId: input.clientRequestId,
              branchId: effectiveBranchId,
              expectedSemanticSha256: normalizedExpectedHash,
              fencedByUserId: Number(ctx.user.id),
            },
          };
          return { outcome: "FENCED_NOT_COMMITTED" as const };
        },
        { gate: "NONE" },
        );
        if (pendingPostTxAudit) {
          await logAudit(ctx, pendingPostTxAudit);
        }
        return txOutcome;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        if (isNowaitLockContention(err) || isDupEntry(err)) {
          return { outcome: "UNKNOWN_IN_FLIGHT" as const };
        }
        throw err;
      }
    }),

  /** ش٥ — تقرير «المبيعات الأوفلاين» للإدارة: ربط OFF↔INV + زمن الترحيل + وسم «مُزامنة
   *  لاحقاً». خلف بوّابة التقارير القياسية (القائمة + المنح الصريح + عزل فرع غير الأدمن). */
  salesReport: reportViewerProcedure
    .input(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const canCross = ctx.canCrossBranches ?? canCrossBranches(ctx.user);
      const branchId = canCross
        ? input.branchId
        : (ctx.scopedBranchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : undefined));
      if (!canCross && branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "لا فرع مُسنَد لهذا المستخدم",
            why: "حسابك غير مرتبط بفرع محدّد ولا يملك صلاحية استعراض كافة الفروع",
            doThis: "اطلب من مدير النظام إسناد حسابك إلى الفرع الصحيح من شاشة المستخدمين",
          }),
        });
      }
      return buildOfflineSalesReport({ ...input, branchId });
    }),

  /**
   * إعادة تشغيل بيعٍ التُقط دون اتصال (ش٣) — غلاف idempotent حول createSale (نفس sourceType
   * "POS" + نفس clientRequestId ⇒ لا ازدواج حتى مع بيعٍ نصف-ناجح قبل الانقطاع).
   * لا عروض/كوبونات/آجل هنا عمداً (قرار الخطة: الأوفلاين نقدي مبسَّط).
   */
  replaySale: salesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]).optional(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ثلاث منازل)"),
              // السعر الملتقَط إلزامي: النقد قُبض بالسعر المطبوع — لا إعادة تسعير صامتة عند الترحيل.
              unitPriceOverride: nonNegMoneyString,
              discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة").optional(),
              discountAmount: nonNegMoneyString.optional(),
              promotionId: z.number().int().positive().nullish(),
              promotionDiscount: nonNegMoneyString.optional(),
              cashierDiscountAmount: nonNegMoneyString.optional(),
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
        // ش٤: اعتماد مدير لترحيل عنصرٍ معلَّق تحت التكلفة (شارة باركود / PIN / بريد وكلمة مرور).
        managerApproval: managerApprovalSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const crossBranch = canCrossBranches(ctx.user);
      let effectiveBranchId = input.branchId;
      if (!crossBranch) {
        if (ctx.user.branchId == null) {
          throwNoAssignedBranchError();
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role, isOwner: Boolean(ctx.user.isOwner) };
      const canApprove = Boolean(ctx.user.isOwner) || ctx.user.role === "admin" || ctx.user.role === "manager";
      const {
        managerApproval,
        capturedByUserId,
        capturedShiftId,
        captureProof,
        keyId,
        grantId,
        grantIssuedAtMs,
        grantExpiresAtMs,
        grantToken,
        ...replayInput
      } = input;
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);

      const db = requireDb();
      const [existingCommittedInv] = await db
        .select({
          id: invoices.id,
          createdBy: invoices.createdBy,
          branchId: invoices.branchId,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.sourceType, "POS"),
            eq(invoices.sourceId, input.clientRequestId),
          ),
        )
        .limit(1);

      // Preserve verified same-branch original capturer ID in recovery queue WITHOUT fabricating any proof!
      let verifiedQuarantineOwnerId: number = ctx.user.id;
      if (capturedByUserId != null) {
        const [maybeUser] = await db
          .select({ id: users.id, branchId: users.branchId })
          .from(users)
          .where(eq(users.id, Number(capturedByUserId)))
          .limit(1);
        if (
          maybeUser &&
          (crossBranch || maybeUser.branchId == null || Number(maybeUser.branchId) === effectiveBranchId)
        ) {
          verifiedQuarantineOwnerId = Number(maybeUser.id);
        }
      }

      const quarantineAndReject = async (
        reasonMsg: string,
        usePreconditionFailed = false,
        quarantineMeta?: Record<string, unknown>,
      ): Promise<never> => {
        const errCode = usePreconditionFailed ? "PRECONDITION_FAILED" : "FORBIDDEN";
        if (!existingCommittedInv) {
          await captureRejectedReplay(
            {
              ...replayInput,
              branchId: effectiveBranchId,
              priceOverrideApproved: false,
              unverifiedOriginalCapturedByUserId: capturedByUserId ?? null,
              submittedByPresenterUserId: ctx.user.id,
              ...(usePreconditionFailed && !quarantineMeta ? { legacyMissingProof: true } : {}),
              ...(quarantineMeta ?? {}),
            },
            errCode,
            reasonMsg,
            verifiedQuarantineOwnerId,
            "RETAIL",
          );
        }
        throw new TRPCError({ code: errCode, message: reasonMsg });
      };

      // Case A: Legacy row that ALREADY committed on the server before HTTP response dropped (`existingCommittedInv` exists)
      // and carries no `captureProof`: allow idempotent reconciliation via `replayOfflineSale` (`createSaleInTx` still
      // enforces exact semantic/legacy payload hash match and throws CONFLICT on any altered payload!).
      let delegatedSellerUserId: number | null = null;
      if (existingCommittedInv && captureProof == null) {
        if (Number(existingCommittedInv.branchId) !== effectiveBranchId) {
          throwForeignBranchIdempotencyError();
        }
        const committedSellerId = Number(existingCommittedInv.createdBy);
        if (capturedByUserId != null && Number(capturedByUserId) !== committedSellerId) {
          await quarantineAndReject("تعارض هوية الملتقط مع الفاتورة الملتزمة مسبقاً على الخادم");
        }
        if (committedSellerId !== Number(ctx.user.id)) {
          if (!canApprove && approvedBy == null) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: appErrorMessage({
                what: "تعذّر مصالحة فاتورة ملتزمة لموظف آخر",
                why: "الموظف الحالي ليس صاحب الفاتورة الأصلي ولا يحمل اعتماد مدير أو أدمن",
                doThis: "أرفق اعتماد المدير أو نفّذ المصالحة بحساب الموظف الأصلي",
              }),
            });
          }
          delegatedSellerUserId = committedSellerId;
        }
      } else {
        // Case B: Uncommitted row OR any row supplying `captureProof` — strict v4 verification!
        if (capturedByUserId == null) {
          await quarantineAndReject(
            "هوية الموظف الملتقط الأصلي مفقودة — عُلّقت العملية للمراجعة الإدارية ولا تُرحَّل تلقائياً",
            true,
          );
        }

        const [capturedUserRow] = await db
          .select()
          .from(users)
          .where(eq(users.id, Number(capturedByUserId)))
          .limit(1);
        if (!capturedUserRow) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر تحديد موظف الالتقاط الأصلي",
              why: "معرّف موظف الالتقاط المرسل غير موجود في جدول المستخدمين",
              doThis: "راجع طابور الاسترداد الأوفلايني مع مدير النظام لإسناد العملية يدوياً",
            }),
          });
        }
        if (
          !crossBranch &&
          capturedUserRow.branchId != null &&
          Number(capturedUserRow.branchId) !== effectiveBranchId
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر ترحيل بيع موظف ينتمي لفرع آخر",
              why: "موظف الالتقاط الأصلي مسجّل على فرع مختلف عن فرع العملية",
              doThis: "رحّل العملية من الفرع الصحيح أو عبر حساب أدمن مخوّل بعبور الفروع",
            }),
          });
        }

        if (Number(capturedByUserId) !== Number(ctx.user.id)) {
          if (!canApprove && approvedBy == null) {
            await quarantineAndReject(
              "لا يجوز ترحيل بيع التُقط بجلسة موظف آخر دون اعتماد مدير/أدمن",
            );
          }
          delegatedSellerUserId = Number(capturedUserRow.id);
        }

        // Re-verify authoritative server-side retail sale permissions for the original capturer!
        if (!existingCommittedInv) {
          if (capturedUserRow.isActive === false) {
            await quarantineAndReject(
              "حساب الموظف الملتقط موقوف حالياً — عُلّقت العملية للمراجعة الإدارية",
            );
          }
          const hydratedCapturer = { ...capturedUserRow } as unknown as AuthUser;
          await resolveCustomRole(hydratedCapturer);
          normalizeOwnerAuthority(hydratedCapturer);
          const stationAllowed = canUseStation(
            "RETAIL",
            hydratedCapturer.role,
            hydratedCapturer.permissionsOverride as PermissionMap | null,
          );
          if (!stationAllowed && !hydratedCapturer.isOwner) {
            await quarantineAndReject(
              "صلاحية محطة مبيعات التجزئة مسحوبة من الموظف الملتقط — عُلّقت العملية للمراجعة الإدارية",
            );
          }
          try {
            assertOperationAuthorized(hydratedCapturer, "sales.create");
          } catch {
            await quarantineAndReject(
              "سياسة العمليات تمنع الموظف الملتقط من إنشاء بيع تجزئة — عُلّقت العملية للمراجعة الإدارية",
            );
          }
        }

        const effectiveCapturedShiftId = Number(capturedShiftId ?? input.shiftId ?? 0);
        let shiftOpenedAtMs: number | null = null;
        if (!existingCommittedInv) {
          if (
            !effectiveCapturedShiftId ||
            !captureProof ||
            !keyId ||
            !grantId ||
            grantIssuedAtMs == null ||
            grantExpiresAtMs == null ||
            !grantToken
          ) {
            await quarantineAndReject(
              "صف قديم غير مرسل يفتقر إلى ختم ومنحة الالتقاط الموقّعة — حُجر في طابور الاسترداد الإداري دون اختلاق إثبات",
              true,
            );
          }
          const [originShift] = await db
            .select({
              id: shifts.id,
              userId: shifts.userId,
              branchId: shifts.branchId,
              openedAt: shifts.openedAt,
            })
            .from(shifts)
            .where(eq(shifts.id, effectiveCapturedShiftId))
            .limit(1);
          if (
            !originShift ||
            Number(originShift.branchId) !== effectiveBranchId ||
            Number(originShift.userId) !== Number(capturedByUserId)
          ) {
            await quarantineAndReject(
              "عدم تطابق وردية الالتقاط الأصلية مع هوية الموظف الملتقط",
            );
          }
          shiftOpenedAtMs = originShift.openedAt ? new Date(originShift.openedAt).getTime() : null;
          if (
            Number(capturedByUserId) === Number(ctx.user.id) &&
            input.shiftId != null &&
            Number(input.shiftId) !== effectiveCapturedShiftId
          ) {
            await quarantineAndReject(
              "لا يجوز للكاشير تغيير وردية الالتقاط الأصلية لعملية غير مرسلة",
            );
          }
        }

        const verifyRes = verifyOfflineCaptureProofServer(
          captureProof ?? "",
          {
            kind: "SALE",
            keyId: keyId ?? "",
            grantId: grantId ?? "",
            grantIssuedAtMs: Number(grantIssuedAtMs ?? 0),
            grantExpiresAtMs: Number(grantExpiresAtMs ?? 0),
            grantToken: grantToken ?? "",
            clientRequestId: input.clientRequestId,
            offlineReceiptNumber: input.offlineReceiptNumber,
            capturedAt: input.capturedAt,
            branchId: effectiveBranchId,
            capturedShiftId: effectiveCapturedShiftId,
            capturedByUserId: Number(capturedByUserId),
            payload: replayInput,
          },
          { shiftOpenedAtMs },
        );
        if (!verifyRes.ok) {
          if (verifyRes.code === "LATE_ARRIVAL_BEYOND_OFFLINE_GRACE") {
            await quarantineAndReject(verifyRes.message, true, {
              quarantineClassification: "LATE_ARRIVAL_BEYOND_GRACE_CRYPTO_VERIFIED",
              cryptoProofVerifiedAtQuarantine: true,
              clientClockUnverifiedByServerWallClock: true,
              grantId: grantId ?? null,
              grantIssuedAtMs: grantIssuedAtMs ?? null,
              grantExpiresAtMs: grantExpiresAtMs ?? null,
            });
          }
          await quarantineAndReject(verifyRes.message);
        }
      }

      const priceOverrideApprovedBy: number | null = approvedBy ?? (canApprove ? ctx.user.id : null);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await replayOfflineSale(
            { ...replayInput, branchId: effectiveBranchId, priceOverrideApproved: priceOverrideApprovedBy != null },
            actor,
            delegatedSellerUserId != null ? { attributeToUserId: delegatedSellerUserId } : undefined,
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
            // SALES-01/02: أثر تدقيقي صريح للترحيل تحت التكلفة المعتمَد (مرآة saleRouter).
            if (res.priceOverride) {
              await logAudit(ctx, {
                action: "sale.priceOverride",
                entityType: "invoice",
                entityId: res.invoiceId,
                newValue: { approvedByUserId: priceOverrideApprovedBy, byRole: ctx.user.role, offlineReplay: true },
              });
            }
            publishRealtimeEvent(
              REALTIME_EVENT_TYPES.BATCH_SALES_SYNCED,
              {
                branchId: effectiveBranchId,
                deviceId: input.deviceId ?? undefined,
                syncedCount: 1,
                totalAmount: input.payment.amount,
                timestamp: Date.now(),
              },
              {
                branchId: effectiveBranchId,
              },
            );
          }
          return res;
        } catch (e: unknown) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) {
            // و-٤: رفضُ الأعمال (وردية مقفلة / خارج نافذة الالتقاط) يعني بيعاً **مدفوعاً** لا
            // مكان له في الدفتر. نلتقط الحمولة خادمياً لحظتها فلا تعتمد نجاتها على جهازٍ قد
            // يُمسح، ثم نُعيد رمي الرفض كما هو — سلوك العميل لم يتغيّر.
            if (e.code === "PRECONDITION_FAILED") {
              await captureRejectedReplay(
                { ...replayInput, branchId: effectiveBranchId },
                e.code,
                e.message,
                ctx.user.id,
                "RETAIL",
              );
            }
            throw e;
          }
          const err = e as { message?: string; code?: string; sqlMessage?: string; sql?: string };
          logger.error(
            {
              err: { message: err?.message, code: err?.code, sqlMessage: err?.sqlMessage, sql: err?.sql },
              userId: actor.userId,
              branchId: actor.branchId,
              offlineReceiptNumber: input.offlineReceiptNumber,
            },
            "offline.replaySale فشل بخطأ غير متوقّع",
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر ترحيل البيع الأوفلايني" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),
  /**
   * ترحيل بيع خدمات طباعةٍ التُقط دون اتصال (كاشير الطباعة).
   * البوّابة `posCashierProcedure` مرآةُ `printPos.createSale` بالضبط — لا أوسع: مَن يبيع
   * أونلاين هو مَن يُرحّل ما التقطه أوفلاين، لا أحدَ سواه.
   */
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
              quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
              unitPriceOverride: nonNegMoneyString,
            }),
          )
          .min(1),
        payment: z.object({ amount: positiveMoneyString, method: z.literal("CASH") }),
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
      const { effectiveBranchId, actor, canApprove } = scopeActor(ctx, input.branchId);
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      const priceOverrideApproved = (approvedBy ?? (canApprove ? ctx.user.id : null)) != null;
      return runReplay(
        () =>
          replayOfflinePrintSale(
            { ...replayInput, branchId: effectiveBranchId, priceOverrideApproved },
            actor,
          ),
        {
          ctx,
          action: "printSale.offlineReplay",
          capture: {
            input: { ...replayInput, branchId: effectiveBranchId } as unknown as ReplayOfflineSaleInput,
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

  /**
   * ترحيل سلّة استقبالٍ التُقطت دون اتصال (كاشير خدمات الزبائن).
   * البوّابة `workordersCashierProcedure` مرآةُ `workOrders.receptionCheckout` — و**ليست**
   * `salesCashierProcedure`: دور «موظف استقبال» المبذور يملك `sales: READ` فقط، فلو وُضع هذا
   * المسار خلف بوّابة المبيعات لَرُفض كلُّ ترحيلٍ منه بـFORBIDDEN وبقي طابوره عالقاً للأبد.
   * أوامر الشغل مرفوضةٌ بنيوياً — العقد لا يحملها أصلاً (راجع replayReception.ts).
   */
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
                  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
                  unitPriceOverride: nonNegMoneyString,
                  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة").optional(),
                  discountAmount: nonNegMoneyString.optional(),
                  promotionId: z.number().int().positive().nullish(),
                  promotionDiscount: nonNegMoneyString.optional(),
                  cashierDiscountAmount: nonNegMoneyString.optional(),
                }),
              )
              .min(1),
            amount: positiveMoneyString,
            // ٢٣/٨ — خصمُ رأس الفاتورة على البيع المباشر (مرآةُ العقد المتصل في workOrderRouter).
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
                  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
                  unitPriceOverride: nonNegMoneyString,
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
      const { effectiveBranchId, actor, canApprove } = scopeActor(ctx, input.branchId);
      const { managerApproval, ...replayInput } = input;
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      const priceOverrideApproved = (approvedBy ?? (canApprove ? ctx.user.id : null)) != null;
      return runReplay(
        () =>
          replayOfflineReception(
            { ...replayInput, branchId: effectiveBranchId, priceOverrideApproved },
            actor,
          ),
        {
          ctx,
          action: "reception.offlineReplay",
          capture: {
            input: { ...replayInput, branchId: effectiveBranchId } as unknown as ReplayOfflineSaleInput,
            submittedByUserId: ctx.user.id,
            channel: "RECEPTION" as const,
          },
          offlineReceiptNumber: input.offlineReceiptNumber,
          capturedAt: input.capturedAt,
          deviceId: input.deviceId ?? null,
          lines: (input.regularSale?.lines.length ?? 0) + (input.printSale?.lines.length ?? 0),
        },
      );
    }),
  /**
   * ترحيلُ مرتجعٍ التُقط دون اتصال (تدقيق ١/٩/٢٦).
   *
   * ⛔ **البوّابة `salesManagerProcedure` ليست السلطة النهائيّة**: `replayOfflineReturn` يعيد
   * قراءة `isOwner`/`isActive` **داخل معاملته** ويرفض غير المالك. السببُ أنّ التنفيذ الفوريّ
   * سلطةُ المالك وحده بعد قرار ١/٩، والتقاطُ «طلبٍ» أوفلاينياً عبثٌ: النقدُ خرج فعلاً فلا
   * يصحّ ترحيلُه إلى طابور انتظار.
   */
  replayReturn: salesManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        invoiceId: z.number().int().positive(),
        lines: z
          .array(z.object({
            invoiceItemId: z.number().int().positive(),
            baseQuantity: z.number().int().positive(),
          }))
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
          // درجُ المزامنة يربط الرقم المؤقّت OFF بالرقم الرسميّ INV — يحتاج `invoiceNumber`.
          const db = requireDb();
          const [row] = await db
            .select({ invoiceNumber: invoices.invoiceNumber })
            .from(invoices)
            .where(eq(invoices.id, replayInput.invoiceId))
            .limit(1);
          return { ...out, invoiceNumber: row?.invoiceNumber ?? "" };
        },
        {
          ctx,
          // الفعلُ المشترك لا فعلٌ خاصّ بالأوفلاين: رقيبُ D3-ب يعدّ
          // `RETURN_EXECUTED_AUDIT_ACTION` وحده، والكتابةُ المتخصّصة تُلغي الصفَّ التلقائيّ
          // ⇒ كان كلُّ مرتجعٍ أوفلاينيّ يغيب عن رصد تركّز المرتجعات (Codex، P2).
          action: RETURN_EXECUTED_AUDIT_ACTION,
          capture: {
            input: { ...replayInput, branchId: effectiveBranchId } as unknown as ReplayOfflineSaleInput,
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
    .input(z.object({ id: z.number().int().positive(), targetShiftId: z.number().int().positive() }))
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
    .input(z.object({ id: z.number().int().positive(), reason: z.string().min(5).max(500) }))
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
});

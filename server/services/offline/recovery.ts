// طابور استرداد المبيعات الأوفلاينية المرفوضة — المسار و-٤ (ورقة الإصلاحات ١٦/٨).
//
// الجذر: بيعٌ نقديّ التُقط أوفلاين ووصل بعد إغلاق ورديته (أو بعد ٧٢ ساعة) يُرفض ولا يُكتب
// منه شيء، بينما **الزبون دفع والبضاعة خرجت**. رسالة الرفض نفسها تُحيل إلى «مراجعة التسوية
// اللاحقة» — ولم تكن موجودة. هنا هي.
//
// الثابت الحاكم: هذا الملفّ **لا يُنشئ أثراً مالياً**. الالتقاط تسجيلُ ادّعاءٍ لا قيد؛ والقيد
// يُكتب حصراً عند ترحيل المدير بنواة البيع/المرتجع داخل معاملة عنصر الاسترداد نفسها.
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
  invoices,
  idempotencyKeys,
  offlineRecoveryItems,
  shifts,
  users,
} from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { logger } from "../../logger";
import { logAuditTx } from "../auditService";
import {
  enqueuePostCommit,
  requireDb,
  withGovernanceTx,
  withTx,
  type Actor,
} from "../tx";
import { offlineSaleInput, type ReplayOfflineSaleInput } from "./replaySale";
import {
  replayOfflineReturnInTx,
  type ReplayOfflineReturnInput,
} from "./replayReturn";
import { createSaleInTx, notifySaleCustomerAfterCommit } from "../sale/create";
import { appErrorMessage } from "@shared/errors";
import { idempotencyHash, payloadHashMatches } from "../idempotency";

type AuditContext = Pick<TrpcContext, "user" | "req">;

/**
 * التقاط رفضٍ خادمياً — يُستدعى من الراوتر لحظة رفض الترحيل لسببِ أعمال.
 *
 * **صامتٌ عمداً عند الفشل:** الالتقاط خدمةُ إنقاذ، ولا يجوز أن يُحوِّل رفضاً مفهوماً إلى خطأ
 * ٥٠٠ يُربك الكاشير. وidempotent بـ`clientRequestId` (قيد فريد) لأنّ الجهاز يُعيد المحاولة
 * بطبعه ⇒ الطابور يعكس عدد العمليات لا عدد المحاولات.
 */
export async function captureRejectedReplay(
  input: ReplayOfflineSaleInput,
  rejectCode: string,
  rejectReason: string,
  submittedByUserId: number,
  channel: "RETAIL" | "PRINT" | "RECEPTION" | "RETURN" = "RETAIL",
): Promise<void> {
  try {
    const db = requireDb();
    await db
      .insert(offlineRecoveryItems)
      .values({
        branchId: input.branchId,
        deviceId: input.deviceId ?? null,
        clientRequestId: input.clientRequestId,
        offlineReceiptNumber: input.offlineReceiptNumber,
        capturedAt: new Date(input.capturedAt),
        payload: JSON.stringify(input),
        rejectCode,
        rejectReason,
        submittedByUserId,
        channel,
      })
      .onDuplicateKeyUpdate({
        set: { rejectCode, rejectReason, submittedByUserId },
      });
  } catch (e) {
    // فشل الالتقاط لا يُغيّر نتيجة الترحيل ولا يجوز أن يحجب رسالة الرفض عن المستخدم —
    // **لكنّه لا يُبتلَع صامتاً**: صمتٌ هنا يعني بيعاً مدفوعاً يضيع بلا أثر، وهو العطل نفسه
    // الذي جاءت هذه الشريحة لتغلقه. يُسجَّل بمستوى error كي يظهر في مراقبة الإنتاج.
    logger.error(
      {
        err: e instanceof Error ? { message: e.message } : e,
        offlineReceiptNumber: input.offlineReceiptNumber,
        branchId: input.branchId,
      },
      "offline.recovery: تعذّر التقاط بيعٍ أوفلاينيّ مرفوض — خطر ضياع نقد",
    );
  }
}

export interface RecoveryQueueRow {
  id: number;
  branchId: number;
  offlineReceiptNumber: string;
  capturedAt: Date;
  amount: string;
  lineCount: number;
  deviceId: string | null;
  rejectCode: string;
  rejectReason: string | null;
  ageDays: number;
  channel: "RETAIL" | "PRINT" | "RECEPTION" | "RETURN";
  /** الترحيل الآليّ لبيع التجزئة وحده؛ البقيّة تُعرَض للرصد وتُسوَّى يدوياً. */
  postable: boolean;
}

/** الطابور المعلَّق في نطاق المدير — admin يعبُر الفروع، وغيره فرعه وحده. */
export async function listRecoveryQueue(
  actor: Actor,
): Promise<RecoveryQueueRow[]> {
  const elevated = actor.role === "admin";
  const rows = await requireDb()
    .select()
    .from(offlineRecoveryItems)
    .where(
      and(
        or(
          eq(offlineRecoveryItems.recoveryStatus, "PENDING"),
          and(
            eq(offlineRecoveryItems.recoveryStatus, "POSTED"),
            isNull(offlineRecoveryItems.invoiceId),
          ),
        ),
        ...(elevated
          ? []
          : [eq(offlineRecoveryItems.branchId, actor.branchId)]),
      ),
    )
    .orderBy(asc(offlineRecoveryItems.capturedAt));

  const now = Date.now();
  return rows.map((r) => {
    let amount = "0";
    let lineCount = 0;
    try {
      /**
       * حمولةُ RETURN تحمل المبلغ في `refund.amount` لا `payment.amount` — وقراءتُها بعقد
       * البيع كانت تُظهر كلّ مرتجعٍ مُلتقَط **بصفرٍ** للمدير بينما النقدُ خرج فعلاً، فيسقط من
       * أولويّته ومطابقته (أمسكه Codex على PR #932، P2).
       */
      const p = JSON.parse(r.payload) as ReplayOfflineSaleInput & {
        refund?: { amount?: string };
      };
      amount =
        (r.channel === "RETURN" ? p.refund?.amount : p.payment?.amount) ?? "0";
      lineCount = p.lines?.length ?? 0;
    } catch {
      // حمولةٌ تالفة تبقى مرئيّةً بأرقام صفرية — إخفاؤها أسوأ من عرضها ناقصة.
    }
    const captured =
      r.capturedAt instanceof Date
        ? r.capturedAt.getTime()
        : new Date(r.capturedAt).getTime();
    return {
      id: Number(r.id),
      branchId: Number(r.branchId),
      offlineReceiptNumber: r.offlineReceiptNumber,
      capturedAt: r.capturedAt,
      amount,
      lineCount,
      deviceId: r.deviceId,
      rejectCode: r.rejectCode,
      rejectReason:
        r.recoveryStatus === "POSTED"
          ? legacyRecoveryMessage()
          : r.rejectReason,
      ageDays: Math.max(0, Math.floor((now - captured) / 86_400_000)),
      channel: r.channel,
      // RETURN قابلٌ للترحيل أيضاً: نقدٌ خرج فعلاً وتجميدُه على «إهمال» وحده يترك عجزاً
      // بلا مخرج — أخطرُ حالةٍ هي مرتجعٌ مُجمَّدٌ على وردية أُقفلت (Codex، P1).
      postable:
        r.recoveryStatus === "PENDING" &&
        (r.channel === "RETAIL" || r.channel === "RETURN"),
    };
  });
}

/**
 * ترحيل عنصرٍ محتجَز إلى وردية **مفتوحة** بقرار المدير.
 *
 * يُعاد استعمال نواة البيع/المرتجع نفسها داخل معاملة العنصر مع تجاوز حارس عمر الالتقاط —
 * لأنّ العمر هو **سبب** وجود العنصر هنا، وقد راجعه إنسانٌ الآن. أمّا حارس الوردية المفتوحة
 * فيبقى نافذاً: الإقفال حدٌّ محاسبيّ لا يُكتب بأثر رجعيّ، ولذلك يختار المدير ورديةً جارية.
 * الرقم الأوفلاينيّ المطبوع للزبون يُحمَل كما هو ⇒ يبقى الإيصال الورقيّ مربوطاً بالفاتورة.
 */
function legacyRecoveryMessage(): string {
  return appErrorMessage({
    what: "عنصر استرداد قديم بلا فاتورة مرتبطة",
    why: "حالة POSTED وحدها لا تثبت التزام العملية",
    doThis:
      "راجع المفتاح الأصلي وحمولة الطلب والقيود مع مسؤول النظام قبل أي ترحيل أو إهمال",
  });
}

function missingOriginalHashError(): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذّر إثبات نتيجة الطلب الأصلي",
      why: "المفتاح القديم لا يحمل بصمة حمولة قابلة للتحقق",
      doThis:
        "راجع المفتاح والحمولة والقيود الأصلية مع مسؤول النظام قبل أي ترحيل أو إهمال",
    }),
  });
}

export async function postRecoveryItem(
  id: number,
  targetShiftId: number,
  actor: Actor,
  auditCtx?: AuditContext,
): Promise<{
  recoveryItemId: number;
  invoiceId: number;
  offlineReceiptNumber: string;
}> {
  return withTx(async (tx) => {
    // Post and discard serialize on the same recovery row until commit/rollback.
    const [item] = await tx
      .select()
      .from(offlineRecoveryItems)
      .where(eq(offlineRecoveryItems.id, id))
      .for("update")
      .limit(1);
    if (!item)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "العنصر غير موجود في طابور الاسترداد",
      });
    if (
      actor.role !== "admin" &&
      Number(item.branchId) !== Number(actor.branchId)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "العنصر لا يخصّ فرعك",
      });
    }
    const response = (invoiceId: number) => ({
      recoveryItemId: id,
      invoiceId,
      offlineReceiptNumber: item.offlineReceiptNumber,
    });
    const complete = async (
      invoiceId: number,
      effectiveShiftId: number | null,
      priceOverride = false,
    ) => {
      if (auditCtx) {
        await logAuditTx(tx, auditCtx, {
          action: "offline.recovery.post",
          entityType: "invoice",
          entityId: invoiceId,
          oldValue: {
            recoveryItemId: id,
            offlineReceiptNumber: item.offlineReceiptNumber,
            rejectCode: item.rejectCode,
          },
          newValue: {
            invoiceId,
            targetShiftId: effectiveShiftId,
            branchId: Number(item.branchId),
          },
        });
        if (priceOverride)
          await logAuditTx(tx, auditCtx, {
            action: "sale.priceOverride",
            entityType: "invoice",
            entityId: invoiceId,
            newValue: {
              approvedByUserId: actor.userId,
              byRole: actor.role ?? null,
              offlineRecovery: true,
            },
          });
      }
      await tx
        .update(offlineRecoveryItems)
        .set({
          recoveryStatus: "POSTED",
          invoiceId,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
        })
        .where(eq(offlineRecoveryItems.id, id));
      return response(invoiceId);
    };
    // Replay the committed saved result before validating a fresh target drawer.
    if (item.recoveryStatus === "POSTED") {
      if (item.invoiceId == null)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: legacyRecoveryMessage(),
        });
      return response(Number(item.invoiceId));
    }
    if (item.recoveryStatus !== "PENDING")
      throw new TRPCError({
        code: "CONFLICT",
        message: "العنصر رُحِّل أو أُهمل سابقاً",
      });
    const payload = JSON.parse(item.payload) as ReplayOfflineSaleInput &
      ReplayOfflineReturnInput;
    if (
      payload.clientRequestId !== item.clientRequestId ||
      payload.offlineReceiptNumber !== item.offlineReceiptNumber
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر ترحيل عنصر الاسترداد",
          why: "هوية الحمولة لا تطابق العنصر المحفوظ",
          doThis: "راجع الطلب الأصلي مع مسؤول النظام",
        }),
      });
    }
    // A rejected retry may describe an original offline commit whose response
    // was lost. Replay its EXACT saved input/hash and original cash scope first.
    // Evidence lookup never authorizes changed payloads: domain hash checks run.
    if (item.channel === "RETAIL") {
      const [existing] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.sourceType, "POS"),
            eq(invoices.sourceId, item.clientRequestId),
          ),
        )
        .limit(1);
      if (existing) {
        let originalInput = offlineSaleInput(
          { ...payload, branchId: Number(item.branchId) },
          { skipCaptureWindow: true },
        );
        // The capture router historically omitted this server-derived approval
        // bit. Reconstruct it only with proof from the full stored request hash.
        const [savedKey] = await tx
          .select({ payloadHash: idempotencyKeys.payloadHash })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.operation, "sale.create"),
              eq(idempotencyKeys.clientRequestId, item.clientRequestId),
            ),
          )
          .limit(1);
        if (!savedKey?.payloadHash) throw missingOriginalHashError();
        if (
          payload.priceOverrideApproved == null &&
          savedKey?.payloadHash &&
          !payloadHashMatches(
            idempotencyHash(originalInput),
            savedKey.payloadHash,
          )
        ) {
          const approvedInput = {
            ...originalInput,
            priceOverrideApproved: true,
          };
          if (
            payloadHashMatches(
              idempotencyHash(approvedInput),
              savedKey.payloadHash,
            )
          )
            originalInput = approvedInput;
        }
        const result = await createSaleInTx(tx, originalInput, actor);
        enqueuePostCommit(tx, () =>
          notifySaleCustomerAfterCommit(originalInput, result),
        );
        return complete(result.invoiceId, result.shiftId ?? null);
      }
    } else if (item.channel === "RETURN") {
      const [existing] = await tx
        .select({
          refId: idempotencyKeys.refId,
          payloadHash: idempotencyKeys.payloadHash,
        })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.operation, "sale.return"),
            eq(idempotencyKeys.clientRequestId, item.clientRequestId),
          ),
        )
        .limit(1);
      if (existing) {
        if (!existing.payloadHash) throw missingOriginalHashError();
        const [source] = await tx
          .select({ branchId: invoices.branchId })
          .from(invoices)
          .where(eq(invoices.id, payload.invoiceId))
          .limit(1);
        if (!source || Number(source.branchId) !== Number(item.branchId))
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر استرداد نتيجة المرتجع",
              why: "فرع المصدر لا يطابق عنصر الاسترداد",
              doThis: "راجع المستند الأصلي قبل إعادة المحاولة",
            }),
          });
        await replayOfflineReturnInTx(tx, payload, actor, {
          skipCaptureWindow: true,
        });
        return complete(payload.invoiceId, payload.refund.shiftId ?? null);
      }
    }
    const [shift] = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, targetShiftId))
      .limit(1);
    if (!shift || Number(shift.branchId) !== Number(item.branchId))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الوردية الهدف لا تخصّ فرع العنصر",
      });
    if (shift.status !== "OPEN")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "اختر ورديةً مفتوحة — لا يُكتب في وردية مقفلة",
      });
    if (item.channel !== "RETAIL" && item.channel !== "RETURN")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "الترحيل الآليّ متاحٌ لبيع التجزئة والمرتجع؛ عمليات الطباعة/الاستقبال مُسجَّلة هنا للرصد وتُسوَّى يدوياً",
      });
    if (item.channel === "RETAIL" && shift.shiftType !== "RETAIL")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "وردية التجزئة وحدها تقبل ترحيل بيعٍ أوفلاينيّ",
      });
    let invoiceId: number;
    let priceOverride = false;
    if (item.channel === "RETURN") {
      const [source] = await tx
        .select({ branchId: invoices.branchId })
        .from(invoices)
        .where(eq(invoices.id, payload.invoiceId))
        .limit(1);
      if (!source || Number(source.branchId) !== Number(item.branchId))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر ترحيل المرتجع",
            why: "فاتورة المصدر لا تخص فرع العنصر",
            doThis: "راجع الفاتورة الأصلية وفرعها",
          }),
        });
      await replayOfflineReturnInTx(
        tx,
        { ...payload, refund: { ...payload.refund, shiftId: targetShiftId } },
        actor,
        { skipCaptureWindow: true },
      );
      invoiceId = payload.invoiceId;
    } else {
      const saleInput = offlineSaleInput(
        {
          ...payload,
          branchId: Number(item.branchId),
          shiftId: targetShiftId,
          priceOverrideApproved: true,
        },
        {
          skipCaptureWindow: true,
          attributeToUserId: item.submittedByUserId ?? actor.userId,
        },
      );
      const result = await createSaleInTx(tx, saleInput, actor);
      invoiceId = result.invoiceId;
      priceOverride = !!result.priceOverride;
      // Existing invoice attribution is never rewritten during idempotent replay.
      enqueuePostCommit(tx, () =>
        notifySaleCustomerAfterCommit(saleInput, result),
      );
    }
    return complete(invoiceId, targetShiftId, priceOverride);
  });
}

/** إهمال عنصرٍ محتجَز (إيصال فحصٍ/تجربة) — **بسببٍ إلزاميّ وأثرٍ تدقيقيّ**: إسقاط بيعٍ مدفوع قرارٌ يُنسَب. */
export async function discardRecoveryItem(
  id: number,
  reason: string,
  actor: Actor,
  auditCtx?: AuditContext,
): Promise<{ recoveryItemId: number }> {
  const trimmed = reason.trim();
  if (trimmed.length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سبب الإهمال إلزاميّ (٥ أحرف على الأقل)",
    });
  }
  // Exclusive before any snapshot/domain lock: a standalone replay either
  // commits first (the original-result probe sees it), or sees DISCARDED after
  // this decision commits. Recovery-row locking alone cannot protect replay.
  return withGovernanceTx(async (tx) => {
    const item = (
      await tx
        .select()
        .from(offlineRecoveryItems)
        .where(eq(offlineRecoveryItems.id, id))
        .for("update")
        .limit(1)
    )[0];
    if (!item)
      throw new TRPCError({ code: "NOT_FOUND", message: "العنصر غير موجود" });
    if (item.recoveryStatus !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "العنصر رُحِّل أو أُهمل سابقاً",
      });
    }
    if (
      actor.role !== "admin" &&
      Number(item.branchId) !== Number(actor.branchId)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "العنصر لا يخصّ فرعك",
      });
    }
    const originalResult =
      item.channel === "RETURN"
        ? await tx
            .select({ id: idempotencyKeys.id })
            .from(idempotencyKeys)
            .where(
              and(
                eq(idempotencyKeys.operation, "sale.return"),
                eq(idempotencyKeys.clientRequestId, item.clientRequestId),
              ),
            )
            .limit(1)
        : item.channel === "RETAIL"
          ? await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(
                and(
                  eq(invoices.sourceType, "POS"),
                  eq(invoices.sourceId, item.clientRequestId),
                ),
              )
              .limit(1)
          : [];
    if (originalResult.length)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إهمال عنصر الاسترداد",
          why: "يوجد أثر أصلي مسجّل بهذا المفتاح ولم يُربط بالعنصر بعد",
          doThis:
            "استرد النتيجة الأصلية أو راجع دليلها مع مسؤول النظام قبل الإهمال",
        }),
      });
    await tx
      .update(offlineRecoveryItems)
      .set({
        recoveryStatus: "DISCARDED",
        discardReason: trimmed,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
      })
      .where(eq(offlineRecoveryItems.id, id));

    if (auditCtx) {
      await logAuditTx(tx, auditCtx, {
        action: "offline.recovery.discard",
        entityType: "offlineRecoveryItem",
        entityId: id,
        oldValue: {
          offlineReceiptNumber: item.offlineReceiptNumber,
          amountPayload: item.payload.slice(0, 200),
        },
        newValue: { reason: trimmed, byUserId: actor.userId },
      });
    }
    return { recoveryItemId: id };
  });
}

/** يُستعمل في الاختبارات/الأدوات فقط. */
export { users as _usersTableRef };

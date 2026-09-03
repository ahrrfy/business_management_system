import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  branches,
  payrollAccountingEvents,
  payrollObligationAllocations,
  payrollObligations,
  payrollRemittanceRequests,
  receipts,
  users,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { assertValidImageDataUrl, parseImageDimensions } from "../../lib/imageValidation";
import { isDupEntry } from "@shared/errorMap.ar";
import {
  assertApprovedTreasuryOutAvailable,
  authorizeExternalTreasuryDisbursement,
  lockMaterializedCashReceiptSourceForWrite,
} from "../cash/cashAvailability";
import { baghdadToday } from "../businessDay";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { requireDb, type Actor, withTx } from "../tx";
import {
  payrollSettlementPosting,
  postPayrollAccountingEvent,
} from "./accounting";
import { payrollHash } from "./helpers";
import type {
  CreatePayrollRemittanceInput,
  PayrollPaymentMethod,
  PayrollRemittanceKind,
  PayrollRemittancePaymentInput,
} from "./types";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function obligationKind(kind: PayrollRemittanceKind) {
  return kind === "INCOME_TAX" ? "INCOME_TAX" : "SOCIAL_SECURITY";
}

export function assertValidRemittanceDocument(value: string): void {
  // Evidence is stored inline today, so accept only raster image data URLs with
  // canonical base64, a matching magic signature, bounded bytes and dimensions.
  // This excludes javascript:, HTML/SVG payloads and remote mutable documents.
  assertValidImageDataUrl(value.trim(), 2_000_000, true);
  const normalized = value.trim();
  const comma = normalized.indexOf(",");
  const mime = normalized.slice(5, normalized.indexOf(";"));
  const dimensions = parseImageDimensions(Buffer.from(normalized.slice(comma + 1), "base64"), mime);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبول مستند التحويل",
        why: "الصورة غير مكتملة أو غير قابلة للقراءة (أبعاد الصورة غير صالحة)",
        doThis: "أعد تصوير المستند بوضوحٍ كامل ثم أرفق الصورة الجديدة، بحدٍّ أقصى 2 ميجابايت",
      }),
    });
  }
}

function paymentDate(value?: string | null): string {
  const ymd = value?.trim() || baghdadToday();
  const parsed = Date.parse(`${ymd}T00:00:00Z`);
  if (
    !YMD_RE.test(ymd) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== ymd
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبول تاريخ التحويل",
        why: `التاريخ (${ymd}) غير صالح — الصيغة المطلوبة YYYY-MM-DD`,
        doThis: "أعد إدخال تاريخ التحويل بصيغة YYYY-MM-DD (مثلاً 2026-09-03)",
      }),
    });
  }
  if (ymd > baghdadToday()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبول تاريخ التحويل",
        why: `تاريخ التحويل (${ymd}) مستقبليّ (اليوم ${baghdadToday()}) — لا يقبل النظام تسجيل تحويلاتٍ لم تقع بعد`,
        doThis: "استعمل تاريخ اليوم أو تاريخاً سابقاً، ثم أعد الإرسال",
      }),
    });
  }
  return ymd;
}

export function payrollRemittancePaymentReference(
  method: PayrollPaymentMethod,
  reference: string | null | undefined,
): string | null {
  const normalized = reference?.trim() || null;
  if (method === "CASH") return null;
  if (method === "CARD" && !/^\d{4}$/.test(normalized ?? "")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبول دليل البطاقة",
        why: "إثبات البطاقة يجب أن يكون آخر أربعة أرقامٍ فقط لا غير",
        doThis: "أدخل آخر أربعة أرقام من البطاقة (مثلاً 1234) بدل نصٍّ آخر",
      }),
    });
  }
  if ((method === "TRANSFER" || method === "WALLET") && !normalized) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبول التحويل",
        why: "رقم مرجع التحويل أو المحفظة مفقود — إثبات الطريقة إلزاميّ للحوالة والمحفظة",
        doThis: "أدخل رقم مرجع الحوالة أو معرّف المحفظة، ثم أعد الإرسال",
      }),
    });
  }
  return normalized;
}

/**
 * ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — أُزيل شرط «مختلفٌ عن صانع العملية»
 * (نظيرٌ مستقلّ لِـauthorizeExternalTreasuryDisbursement في cashAvailability.ts ولـ
 * assertPayrollActiveOwnerChecker في payroll/settlement.ts، التفصيل هناك).
 * `_forbidden` يبقى في التوقيع توثيقاً لهوية الطالب في مواضع الاستدعاء — الأثر التدقيقي
 * (createdBy/approvedBy/paidBy) يبقى مسجَّلاً كما هو.
 */
async function assertOwner(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  actor: Actor,
  _forbidden: Array<number | null | undefined>,
  operation: string,
): Promise<void> {
  const [owner] = await tx
    .select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .for("share")
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: `تعذّر تنفيذ العملية «${operation}»`,
        why: "هذا الاعتماد محصورٌ بحساب المالك النشط — دورك لا يملك الصلاحية",
        doThis: "أحل الطلب إلى المالك ليعتمده، أو سجّل الدخول بحساب المالك إن كان بحوزتك",
      }),
    });
  }
}

function sameRequest(
  row: typeof payrollRemittanceRequests.$inferSelect,
  input: CreatePayrollRemittanceInput,
): boolean {
  return (
    row.kind === input.kind &&
    Number(row.payingBranchId) === input.payingBranchId &&
    money(row.requestedAmount).eq(money(input.amount)) &&
    row.authorityName === input.authorityName.trim() &&
    row.referenceNumber === input.referenceNumber.trim() &&
    row.supportingDocumentUrl === input.supportingDocumentUrl
  );
}

async function existingBySourceKey(sourceKey: string) {
  const [row] = await requireDb()
    .select()
    .from(payrollRemittanceRequests)
    .where(eq(payrollRemittanceRequests.sourceKey, sourceKey))
    .limit(1);
  return row ?? null;
}

export async function createRemittanceRequest(
  input: CreatePayrollRemittanceInput,
  actor: Actor,
) {
  assertValidRemittanceDocument(input.supportingDocumentUrl);
  if (!actor.isOwner && actor.role !== "admin" && Number(actor.branchId) !== input.payingBranchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر إنشاء التحويل القانوني",
        why: `دورك يعمل على فرع (${actor.branchId}) والتحويل مطلوبٌ على فرع (${input.payingBranchId})`,
        doThis: "أنشئ التحويل من الفرع الدافع بحسابٍ يخصّه، أو اطلب من المدير التنفيذ",
      }),
    });
  }
  const amount = round2(money(input.amount));
  if (amount.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل التحويل",
        why: `مبلغ التحويل (${amount.toString()}) صفر أو سالب — لا يُسجَّل تحويلٌ بلا قيمة`,
        doThis: "أدخل مبلغاً موجباً بالدينار العراقيّ ثم أعد الإرسال",
      }),
    });
  }
  const authorityName = input.authorityName.trim();
  const referenceNumber = input.referenceNumber.trim();
  if (!authorityName || !referenceNumber || !input.supportingDocumentUrl.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل التحويل القانوني",
        why: "الجهة أو رقم المرجع أو المستند المؤيّد فارغ — كلّها إلزاميّة",
        doThis: "أكمل الجهة (الضريبة/الضمان)، ورقم المرجع، وأرفق صورة إيصال، ثم أعد الإرسال",
      }),
    });
  }
  const sourceKey = `PAYROLL:REMIT-REQ:${input.clientRequestId.trim()}`;
  const replay = await existingBySourceKey(sourceKey);
  if (replay) {
    if (!sameRequest(replay, input)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل التحويل",
          why: "مفتاح الطلب مستعمل لتحويلٍ قانونيّ بحمولةٍ مختلفة — التزامن يمنع إعادة استعمال نفس المفتاح",
          doThis: "أنشئ تحويلاً جديداً بمفتاح فريد، أو استرجع نتيجة الطلب السابق بمفتاحه الأصليّ",
        }),
      });
    }
    return { ...replay, replayed: true };
  }
  try {
    return await withTx(async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, input.payingBranchId))
        .for("update")
        .limit(1);
      if (!branch)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تسجيل التحويل",
            why: `الفرع رقم ${input.payingBranchId} غير موجود — الرقم مغلوط أو الفرع محذوف`,
            doThis: "افتح قائمة الفروع واختر فرعاً صالحاً، ثم أعد الإرسال",
          }),
        });
      // The branch lock serializes all reservations for this liability grain.
      // Re-read the idempotency key as a current locking read after waiting: a
      // concurrent first request may have committed while this transaction was
      // queued, and reservation arithmetic must not turn that retry into an error.
      const [lockedReplay] = await tx
        .select()
        .from(payrollRemittanceRequests)
        .where(eq(payrollRemittanceRequests.sourceKey, sourceKey))
        .for("update")
        .limit(1);
      if (lockedReplay) {
        if (!sameRequest(lockedReplay, input)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر تسجيل التحويل",
              why: "مفتاح الطلب مستعمل لتحويلٍ قانونيّ بحمولةٍ مختلفة — التزامن يمنع إعادة استعمال نفس المفتاح",
              doThis: "أنشئ تحويلاً جديداً بمفتاح فريد، أو استرجع نتيجة الطلب السابق بمفتاحه الأصليّ",
            }),
          });
        }
        return { ...lockedReplay, replayed: true };
      }
      // Global lock order for remittances is request rows, then obligation rows.
      // payRemittanceRequest uses the same order; reversing it here deadlocked a
      // concurrent create (obligation -> request) against pay (request -> obligation).
      const reservations = await tx
        .select({ amount: payrollRemittanceRequests.requestedAmount })
        .from(payrollRemittanceRequests)
        .where(
          and(
            eq(payrollRemittanceRequests.payingBranchId, input.payingBranchId),
            eq(payrollRemittanceRequests.kind, input.kind),
            inArray(payrollRemittanceRequests.status, ["PENDING", "APPROVED"]),
          ),
        )
        .for("update");
      const reserved = reservations.reduce(
        (sum, row) => sum.plus(money(row.amount)),
        money(0),
      );
      const obligations = await tx
        .select({ remaining: payrollObligations.remainingAmount })
        .from(payrollObligations)
        .where(
          and(
            eq(payrollObligations.branchIdSnapshot, input.payingBranchId),
            eq(payrollObligations.kind, obligationKind(input.kind)),
            inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
          ),
        )
        .for("update");
      const outstanding = obligations.reduce(
        (sum, row) => sum.plus(money(row.remaining)),
        money(0),
      );
      if (amount.gt(round2(outstanding.minus(reserved)))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذّر تسجيل التحويل",
            why: `مبلغ الطلب (${amount.toString()}) يتجاوز المتاح للحجز — الالتزام المفتوح ${outstanding.toString()} والمحجوز ${reserved.toString()}`,
            doThis: `اخفض مبلغ الطلب إلى ${round2(outstanding.minus(reserved)).toString()} أو أقلّ، أو انتظر انتهاء الطلبات المعلَّقة السابقة`,
          }),
        });
      }
      const result = await tx.insert(payrollRemittanceRequests).values({
        kind: input.kind,
        payingBranchId: input.payingBranchId,
        requestedAmount: toDbMoney(amount),
        authorityName,
        referenceNumber,
        supportingDocumentUrl: input.supportingDocumentUrl,
        status: "PENDING",
        sourceKey,
        createdBy: actor.userId,
      });
      const id = extractInsertId(result);
      const [created] = await tx
        .select()
        .from(payrollRemittanceRequests)
        .where(eq(payrollRemittanceRequests.id, id))
        .limit(1);
      return { ...created!, replayed: false };
    });
  } catch (error) {
    if (!isDupEntry(error)) throw error;
    const concurrent = await existingBySourceKey(sourceKey);
    if (concurrent && sameRequest(concurrent, input)) {
      return { ...concurrent, replayed: true };
    }
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تسجيل التحويل",
        why: "طلبٌ متزامن آخر استعمل نفس مفتاح الطلب بحمولة مختلفة — تعارض على المفتاح الفريد",
        doThis: "أنشئ طلباً بمفتاح فريد جديد وأعد الإرسال",
      }),
    });
  }
}

export async function approveRemittanceRequest(id: number, actor: Actor) {
  return withTx(async (tx) => {
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, id))
      .for("update")
      .limit(1);
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب التحويل بالرقم ${id} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات التحويل واختر طلباً موجوداً، أو تحقّق من رقمه",
        }),
      });
    await assertOwner(tx, actor, [request.createdBy], "اعتماد تحويل الاستقطاعات");
    if (request.status === "APPROVED" || request.status === "PAID") {
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر اعتماد الطلب",
          why: `حالة الطلب ${request.status} — الاعتماد مسموحٌ لطلبٍ معلَّق (PENDING) فقط`,
          doThis: "افتح قائمة الطلبات وتحقّق من الحالة — الطلب المعتمد أو المرفوض لا يقبل اعتماداً ثانياً",
        }),
      });
    }
    await tx
      .update(payrollRemittanceRequests)
      .set({ status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() })
      .where(eq(payrollRemittanceRequests.id, id));
    return { ...request, status: "APPROVED" as const, approvedBy: actor.userId, replayed: false };
  });
}

export async function rejectRemittanceRequest(
  id: number,
  reason: string,
  actor: Actor,
) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 255) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر رفض الطلب",
        why: `سبب الرفض بطول ${normalizedReason.length} محرفاً والمطلوب بين 5 و255`,
        doThis: "اكتب سبباً واضحاً للرفض بين 5 و255 محرف، ثم أعد الإرسال",
      }),
    });
  }
  return withTx(async (tx) => {
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, id))
      .for("update")
      .limit(1);
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب التحويل بالرقم ${id} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات التحويل واختر طلباً موجوداً، أو تحقّق من رقمه",
        }),
      });
    await assertOwner(tx, actor, [request.createdBy], "رفض تحويل الاستقطاعات");
    if (request.status === "REJECTED") {
      if (request.rejectionReason !== normalizedReason) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر رفض الطلب",
            why: "سبب المحاولة الجديد لا يطابق سبب الرفض المحفوظ للطلب — لا يجوز تغيير سبب رفضٍ صار نافذاً",
            doThis: "أعد إرسال الرفض بالسبب المحفوظ للاسترجاع، أو راجع سجلّ الطلب للاطّلاع على السبب الصحيح",
          }),
        });
      }
      return { ...request, replayed: true };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر رفض الطلب",
          why: `حالة الطلب ${request.status} — الرفض مسموحٌ لطلبٍ معلَّق (PENDING) فقط`,
          doThis: "افتح قائمة الطلبات وتحقّق من الحالة — الطلب المعتمد أو المدفوع لا يقبل رفضاً",
        }),
      });
    }
    await tx
      .update(payrollRemittanceRequests)
      .set({
        status: "REJECTED",
        rejectedBy: actor.userId,
        rejectedAt: new Date(),
        rejectionReason: normalizedReason,
      })
      .where(eq(payrollRemittanceRequests.id, id));
    return { ...request, status: "REJECTED" as const, replayed: false };
  });
}

export async function payRemittanceRequest(
  input: PayrollRemittancePaymentInput,
  actor: Actor,
) {
  const ymd = paymentDate(input.paymentDate);
  const referenceNumber = payrollRemittancePaymentReference(input.paymentMethod, input.referenceNumber);
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, input.requestId))
      .limit(1);
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب التحويل بالرقم ${input.requestId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات التحويل واختر طلباً موجوداً، أو تحقّق من رقمه",
        }),
      });
    let approval: Awaited<ReturnType<typeof authorizeExternalTreasuryDisbursement>> | null = null;
    if (input.paymentMethod === "CASH") {
      approval = await authorizeExternalTreasuryDisbursement(tx, {
        actor,
        makerUserIds: [preview.createdBy],
        branchIds: [Number(preview.payingBranchId)],
        operation: "تحويل الاستقطاعات القانونية",
      });
    } else {
      await assertOwner(
        tx,
        actor,
        [preview.createdBy],
        "تحويل الاستقطاعات القانونية",
      );
    }
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, input.requestId))
      .for("update")
      .limit(1);
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب التحويل بالرقم ${input.requestId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات التحويل واختر طلباً موجوداً، أو تحقّق من رقمه",
        }),
      });
    if (request.status === "PAID") {
      const [savedReceipt] = request.receiptId == null
        ? [undefined]
        : await tx
            .select({
              paymentMethod: receipts.paymentMethod,
              referenceNumber: receipts.referenceNumber,
              voucherYmd: sql<string>`DATE_FORMAT(${receipts.voucherDate}, '%Y-%m-%d')`,
              status: receipts.status,
            })
            .from(receipts)
            .where(eq(receipts.id, Number(request.receiptId)))
            .for("update")
            .limit(1);
      if (
        !savedReceipt || savedReceipt.status !== "COMPLETED" ||
        savedReceipt.paymentMethod !== input.paymentMethod ||
        (savedReceipt.referenceNumber?.trim() || null) !== referenceNumber ||
        savedReceipt.voucherYmd !== ymd
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تسجيل تحويل التنفيذ",
            why: "بيانات إعادة المحاولة (طريقة/مرجع/تاريخ) لا تطابق إيصال الدفع المحفوظ للطلب — لا يجوز تغيير إيصالٍ نافذ",
            doThis: "أعد الإرسال بنفس بيانات الإيصال المحفوظ، أو راجع سجلّ الطلب للاطّلاع على القيم الصحيحة",
          }),
        });
      }
      return { replayed: true, request };
    }
    if (request.status !== "APPROVED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تنفيذ التحويل",
          why: `حالة الطلب ${request.status} — التنفيذ مسموحٌ لطلبٍ معتمَد فقط`,
          doThis: "افتح الطلب واعتمده أوّلاً (بواسطة المالك)، ثم أعد التنفيذ",
        }),
      });
    }
    if (request.createdBy !== preview.createdBy || request.requestedAmount !== preview.requestedAmount) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تنفيذ التحويل",
          why: "تغيّر الطلب أثناء التنفيذ (تنافس مع مسار آخر) — القيم المعروضة لم تعد مطابقةً للمحفوظ",
          doThis: "أعد تحميل صفحة الطلب وابدأ التنفيذ من جديد بالقيم المحدَّثة",
        }),
      });
    }
    const amount = money(request.requestedAmount);
    if (input.paymentMethod === "CASH") {
      if (!approval) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "إثبات اعتماد تحويل الاستقطاعات النقدي مفقود.",
        });
      }
      await assertApprovedTreasuryOutAvailable(
        tx,
        {
          branchId: Number(request.payingBranchId),
          amount,
          operation: "تحويل الاستقطاعات القانونية",
        },
        approval,
      );
    }
    const obligations = await tx
      .select()
      .from(payrollObligations)
      .where(
        and(
          eq(payrollObligations.branchIdSnapshot, Number(request.payingBranchId)),
          eq(payrollObligations.kind, obligationKind(request.kind)),
          inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
        ),
      )
      .orderBy(asc(payrollObligations.dueDate), asc(payrollObligations.id))
      .for("update");
    const available = obligations.reduce(
      (sum, row) => sum.plus(money(row.remainingAmount)),
      money(0),
    );
    if (available.lt(amount)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تنفيذ التحويل",
          why: `الرصيد المفتوح للفرع (${available.toString()}) لا يكفي مبلغ الطلب (${amount.toString()}) — قد يكون التزامٌ آخر استنفده`,
          doThis: "افتح شاشة الالتزامات المفتوحة وتحقّق من الرصيد، أو اخفض مبلغ الطلب ثم أعد الإرسال",
        }),
      });
    }
    const receiptResult = await tx.insert(receipts).values({
      branchId: Number(request.payingBranchId),
      shiftId: null,
      cashBucket: input.paymentMethod === "CASH" ? "TREASURY" : null,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: input.paymentMethod,
      referenceNumber,
      cardLastFour: input.paymentMethod === "CARD" ? referenceNumber : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      partyType: "OTHER",
      partyId: null,
      counterpartyName: request.authorityName,
      voucherDate: new Date(`${ymd}T00:00:00.000Z`),
      attachmentUrl: request.supportingDocumentUrl,
      description: `تحويل ${request.kind === "INCOME_TAX" ? "ضريبة الدخل" : "الضمان الاجتماعي"} — ${request.authorityName}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptResult);
    const occurredAt = new Date(`${ymd}T12:00:00.000Z`);
    const kind = request.kind === "INCOME_TAX" ? "INCOME_TAX" : "SOCIAL_SECURITY";
    const posting = payrollSettlementPosting({
      kind,
      direction: "OUT",
      paymentMethod: input.paymentMethod,
      amount,
    });
    const sourceKey = `STATREMIT:PAY:${Number(request.id)}`;
    const event = await postPayrollAccountingEvent(tx, {
      remittanceRequestId: Number(request.id),
      branchId: Number(request.payingBranchId),
      revisionNo: 0,
      eventKind: request.kind === "INCOME_TAX" ? "TAX_REMITTANCE" : "SOCIAL_SECURITY_REMITTANCE",
      receiptId,
      sourceKey,
      sourceHashPayload: {
        kind: "REMITTANCE",
        requestSourceKey: request.sourceKey,
        amount: amount.toFixed(2),
        paymentMethod: input.paymentMethod,
        referenceNumber,
        ymd,
      },
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount,
      paymentMethod: input.paymentMethod,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `تحويل استقطاعات — ${request.authorityName} — ${request.referenceNumber}`,
    });
    let left = amount;
    for (const obligation of obligations) {
      if (left.lte(0)) break;
      if (obligation.dueDate != null && ymd < String(obligation.dueDate).slice(0, 10)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تاريخ التحويل يسبق تاريخ نشوء الالتزام المخصّص له.",
        });
      }
      const before = money(obligation.remainingAmount);
      const applied = round2(Decimal.min(left, before));
      const after = round2(before.minus(applied));
      left = round2(left.minus(applied));
      await tx.insert(payrollObligationAllocations).values({
        obligationId: Number(obligation.id),
        accountingEventId: event.eventId,
        remittanceRequestId: Number(request.id),
        direction: "APPLY",
        amount: toDbMoney(applied),
        sourceKey: `PAYROLL:REMIT-ALLOC:${Number(request.id)}:${Number(obligation.id)}`,
        occurredAt,
        createdBy: actor.userId,
      });
      await tx
        .update(payrollObligations)
        .set({
          remainingAmount: toDbMoney(after),
          status: after.isZero() ? "SETTLED" : "PARTIAL",
        })
        .where(eq(payrollObligations.id, Number(obligation.id)));
    }
    if (!left.isZero()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تنفيذ التحويل",
          why: `تعذّر تخصيص كامل مبلغ التحويل — تبقّى ${left.toString()} بلا التزامٍ مفتوحٍ يستوعبه`,
          doThis: "أعد تحميل شاشة الالتزامات وابدأ التحويل من جديد بمبلغٍ يطابق ما يتّسع له الوعاء",
        }),
      });
    }
    await tx
      .update(payrollRemittanceRequests)
      .set({
        status: "PAID",
        receiptId,
        paidBy: actor.userId,
        paidAt: new Date(),
      })
      .where(eq(payrollRemittanceRequests.id, Number(request.id)));
    return { replayed: false, requestId: Number(request.id), receiptId, eventId: event.eventId };
  });
}

export async function returnRemittance(
  requestId: number,
  reason: string,
  actor: Actor,
  input?: { returnedAt?: string | null; referenceNumber?: string | null },
) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 5 || normalizedReason.length > 255) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إعادة التحويل",
        why: `سبب الإعادة بطول ${normalizedReason.length} محرفاً والمطلوب بين 5 و255`,
        doThis: "اكتب سبباً واضحاً للإعادة بين 5 و255 محرف، ثم أعد الإرسال",
      }),
    });
  }
  const ymd = paymentDate(input?.returnedAt);
  return withTx(async (tx) => {
    const [requestPreview] = await tx
      .select({
        status: payrollRemittanceRequests.status,
        payingBranchId: payrollRemittanceRequests.payingBranchId,
        receiptId: payrollRemittanceRequests.receiptId,
      })
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, requestId))
      .limit(1);
    let prelockedCashReceiptId: number | null = null;
    if (requestPreview?.status === "PAID" && requestPreview.receiptId != null) {
      const [receiptPreview] = await tx
        .select({ paymentMethod: receipts.paymentMethod })
        .from(receipts)
        .where(eq(receipts.id, Number(requestPreview.receiptId)))
        .limit(1);
      if (receiptPreview?.paymentMethod === "CASH") {
        prelockedCashReceiptId = Number(requestPreview.receiptId);
        await lockMaterializedCashReceiptSourceForWrite(tx, {
          branchId: Number(requestPreview.payingBranchId),
          shiftId: null,
          cashBucket: "TREASURY",
          paymentMethod: "CASH",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        });
      }
    }
    const [request] = await tx
      .select()
      .from(payrollRemittanceRequests)
      .where(eq(payrollRemittanceRequests.id, requestId))
      .for("update")
      .limit(1);
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب التحويل بالرقم ${requestId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات التحويل واختر طلباً موجوداً، أو تحقّق من رقمه",
        }),
      });
    await assertOwner(tx, actor, [request.createdBy, request.paidBy], "إعادة تحويل قانوني");
    if (request.status === "REVERSED") {
      if (request.reversalReason !== normalizedReason) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: "سبب المحاولة الجديد لا يطابق سبب الإعادة المحفوظ — لا يجوز تغيير سبب إعادةٍ نافذة",
            doThis: "أعد الإرسال بسبب الإعادة المحفوظ، أو راجع سجلّ الطلب للاطّلاع على السبب الصحيح",
          }),
        });
      }
      const events = await tx
        .select()
        .from(payrollAccountingEvents)
        .where(eq(payrollAccountingEvents.remittanceRequestId, requestId))
        .orderBy(asc(payrollAccountingEvents.id))
        .for("update");
      const originalEvent = events.find((event) => event.eventKind !== "REMITTANCE_RETURN");
      const returnEvent = events.find((event) => event.eventKind === "REMITTANCE_RETURN");
      if (!originalEvent || !returnEvent?.receiptId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: "دليل إعادة التحويل المحفوظ غير مكتمل (لا حدث أصليّ أو إيصال إعادةٍ مربوط)",
            doThis: "أبلغ الدعم الفنّي — الطلب يحتاج فحصاً بيانياً قبل إعادة المحاولة",
          }),
        });
      }
      const [returnReceipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(returnEvent.receiptId)))
        .for("update")
        .limit(1);
      if (!returnReceipt || returnReceipt.status !== "COMPLETED") {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: "إيصال إعادة التحويل المحفوظ غير مكتمل أو ليس بحالة COMPLETED",
            doThis: "أبلغ الدعم الفنّي — الإيصال يحتاج فحصاً بيانياً قبل إعادة المحاولة",
          }),
        });
      }
      const method = returnReceipt.paymentMethod as PayrollPaymentMethod;
      if (!["CASH", "CARD", "TRANSFER", "WALLET"].includes(method)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: `طريقة الإعادة المحفوظة غير مدعومة (${method}) — يُقبل النقد/البطاقة/الحوالة/المحفظة`,
            doThis: "أبلغ الدعم الفنّي — طريقة الدفع تحتاج تصحيحاً بيانياً قبل إعادة المحاولة",
          }),
        });
      }
      const referenceNumber = payrollRemittancePaymentReference(
        method,
        input?.referenceNumber ?? returnReceipt.referenceNumber,
      );
      const expectedHash = payrollHash({
        kind: "REMITTANCE_RETURN",
        originalSourceHash: originalEvent.sourceHash,
        amount: money(request.requestedAmount).toFixed(2),
        method,
        referenceNumber,
        ymd,
        reason: normalizedReason,
      });
      if (returnEvent.sourceHash !== expectedHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: "المحاولة الجديدة لا تطابق دليل الإعادة المحفوظ (طريقة/مرجع/تاريخ/سبب مختلف)",
            doThis: "أعد الإرسال بنفس بيانات الإعادة المحفوظة، أو راجع سجلّ الطلب للاطّلاع على القيم الصحيحة",
          }),
        });
      }
      return { replayed: true, requestId };
    }
    if (request.status !== "PAID" || request.receiptId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إعادة التحويل",
          why: `حالة الطلب ${request.status} — الإعادة مسموحةٌ لتحويلٍ مدفوعٍ فقط (PAID)`,
          doThis: "تحقّق من حالة الطلب — إن كان معلَّقاً أو مرفوضاً فلا حاجة لإعادةٍ، وإن مدفوعاً فأعد تحميل الصفحة",
        }),
      });
    }
    const [originalReceipt] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, Number(request.receiptId)))
      .for("update")
      .limit(1);
    const [originalEvent] = await tx
      .select()
      .from(payrollAccountingEvents)
      .where(eq(payrollAccountingEvents.remittanceRequestId, requestId))
      .for("update")
      .limit(1);
    if (!originalReceipt || !originalEvent || originalEvent.eventKind === "REMITTANCE_RETURN") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إعادة التحويل",
          why: "دليل التحويل الأصليّ ناقص (لا إيصال أصليّ أو حدث محاسبيّ صالح)",
          doThis: "أبلغ الدعم الفنّي — الطلب يحتاج فحصاً بيانياً قبل الإعادة",
        }),
      });
    }
    if (originalReceipt.status !== "COMPLETED") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إعادة التحويل",
          why: `إيصال التحويل الأصليّ بحالة ${originalReceipt.status} — إمّا سبق عكسه أو ليس مكتملاً`,
          doThis: "افتح سجلّ الطلب وتحقّق من حالة الإيصال — الإعادة لا تجوز مرّتين على نفس الأصل",
        }),
      });
    }
    const originalYmd = originalReceipt.voucherDate
      ? toDateStr(new Date(originalReceipt.voucherDate))
      : toDateStr(new Date(originalReceipt.createdAt));
    if (ymd < originalYmd) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر قبول تاريخ الإعادة",
          why: `تاريخ الإعادة (${ymd}) يسبق تاريخ الدفع الأصليّ (${originalYmd}) — الإعادة لا تسبق الدفع`,
          doThis: `استعمل تاريخاً بعد ${originalYmd}، ثم أعد الإرسال`,
        }),
      });
    }
    const method = originalReceipt.paymentMethod as PayrollPaymentMethod;
    if (!["CASH", "CARD", "TRANSFER", "WALLET"].includes(method)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر إعادة التحويل",
          why: `طريقة التحويل الأصليّ غير مدعومة للإعادة (${method}) — يُقبل النقد/البطاقة/الحوالة/المحفظة`,
          doThis: "أبلغ الدعم الفنّي — الطريقة تحتاج تصحيحاً بيانياً قبل إعادة المحاولة",
        }),
      });
    }
    if (method === "CASH" && prelockedCashReceiptId !== Number(request.receiptId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إعادة التحويل",
          why: "تغيّر مصدر إعادة التحويل أثناء قفل النقد — إيصالٌ مختلف صار مربوطاً بالطلب",
          doThis: "أعد تحميل شاشة الطلب وكرّر الإعادة على المصدر الحاليّ",
        }),
      });
    }
    const referenceNumber = payrollRemittancePaymentReference(method, input?.referenceNumber ?? originalReceipt.referenceNumber);
    const amount = money(request.requestedAmount);
    const receiptResult = await tx.insert(receipts).values({
      branchId: Number(request.payingBranchId),
      shiftId: null,
      cashBucket: method === "CASH" ? "TREASURY" : null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: method,
      referenceNumber,
      cardLastFour: method === "CARD" ? referenceNumber : null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      partyType: "OTHER",
      partyId: null,
      counterpartyName: request.authorityName,
      voucherDate: new Date(`${ymd}T00:00:00.000Z`),
      description: `إعادة تحويل قانوني — ${request.authorityName}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(receiptResult);
    const occurredAt = new Date(`${ymd}T12:00:00.000Z`);
    const kind = request.kind === "INCOME_TAX" ? "INCOME_TAX" : "SOCIAL_SECURITY";
    const posting = payrollSettlementPosting({ kind, direction: "IN", paymentMethod: method, amount });
    const sourceKey = `STATREMIT:RETURN:${requestId}`;
    const event = await postPayrollAccountingEvent(tx, {
      remittanceRequestId: requestId,
      branchId: Number(request.payingBranchId),
      revisionNo: 0,
      eventKind: "REMITTANCE_RETURN",
      receiptId,
      reversalOfId: Number(originalEvent.id),
      sourceKey,
      sourceHashPayload: {
        kind: "REMITTANCE_RETURN",
        originalSourceHash: originalEvent.sourceHash,
        amount: amount.toFixed(2),
        method,
        referenceNumber,
        ymd,
        reason: normalizedReason,
      },
      occurredAt,
      actorUserId: actor.userId,
      entryType: posting.entryType,
      amount,
      paymentMethod: method,
      postingIntent: posting.intent,
      postingSourceComponents: posting.source,
      notes: `إعادة تحويل استقطاعات — ${request.authorityName} — ${normalizedReason}`,
    });
    const allocations = await tx
      .select()
      .from(payrollObligationAllocations)
      .where(
        and(
          eq(payrollObligationAllocations.remittanceRequestId, requestId),
          eq(payrollObligationAllocations.direction, "APPLY"),
        ),
      )
      .orderBy(asc(payrollObligationAllocations.id))
      .for("update");
    for (const allocation of allocations) {
      const [obligation] = await tx
        .select()
        .from(payrollObligations)
        .where(eq(payrollObligations.id, Number(allocation.obligationId)))
        .for("update")
        .limit(1);
      if (!obligation)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: "الالتزام المرتبط بأحد تخصيصات التحويل مفقود — لعلّه حُذف بعد الدفع",
            doThis: "أبلغ الدعم الفنّي — عكس التخصيص يحتاج فحصاً بيانياً قبل الاستكمال",
          }),
        });
      const after = round2(money(obligation.remainingAmount).plus(money(allocation.amount)));
      if (after.gt(money(obligation.originalAmount))) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إعادة التحويل",
            why: "مبلغ العكس يتجاوز أصل الالتزام — يعيد إلى الوعاء أكثر مما استقبله",
            doThis: "افحص سجلّ التخصيصات — إن كنت تحاول عكسَ عمليتين، فافصلهما وأعد كلاًّ على حدة",
          }),
        });
      }
      await tx.insert(payrollObligationAllocations).values({
        obligationId: Number(obligation.id),
        accountingEventId: event.eventId,
        remittanceRequestId: requestId,
        direction: "REVERSE",
        amount: allocation.amount,
        reversalOfId: Number(allocation.id),
        sourceKey: `PAYROLL:REMIT-ALLOC-REV:${requestId}:${Number(allocation.id)}`,
        occurredAt,
        createdBy: actor.userId,
      });
      await tx
        .update(payrollObligations)
        .set({
          remainingAmount: toDbMoney(after),
          status: after.eq(money(obligation.originalAmount)) ? "OPEN" : "PARTIAL",
        })
        .where(eq(payrollObligations.id, Number(obligation.id)));
    }
    await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(originalReceipt.id)));
    await tx
      .update(payrollRemittanceRequests)
      .set({
        status: "REVERSED",
        reversedBy: actor.userId,
        reversedAt: new Date(),
        reversalReason: normalizedReason,
      })
      .where(eq(payrollRemittanceRequests.id, requestId));
    return { replayed: false, requestId, receiptId, eventId: event.eventId };
  });
}

export async function listRemittanceRequests(input?: {
  kind?: PayrollRemittanceKind;
  status?: "PENDING" | "APPROVED" | "PAID" | "REJECTED" | "REVERSED";
  branchId?: number;
}) {
  const filters = [
    input?.kind ? eq(payrollRemittanceRequests.kind, input.kind) : undefined,
    input?.status ? eq(payrollRemittanceRequests.status, input.status) : undefined,
    input?.branchId ? eq(payrollRemittanceRequests.payingBranchId, input.branchId) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  return requireDb()
    .select()
    .from(payrollRemittanceRequests)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(payrollRemittanceRequests.id));
}

export async function listPayrollObligations(input?: {
  runId?: number;
  employeeId?: number;
  branchId?: number;
  kind?: "SALARY_NET" | "INCOME_TAX" | "SOCIAL_SECURITY" | "EOS_PROVISION";
  status?: "OPEN" | "PARTIAL" | "SETTLED" | "REVERSED";
}) {
  const filters = [
    input?.runId ? eq(payrollObligations.runId, input.runId) : undefined,
    input?.employeeId ? eq(payrollObligations.employeeId, input.employeeId) : undefined,
    input?.branchId ? eq(payrollObligations.branchIdSnapshot, input.branchId) : undefined,
    input?.kind ? eq(payrollObligations.kind, input.kind) : undefined,
    input?.status ? eq(payrollObligations.status, input.status) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  return requireDb()
    .select()
    .from(payrollObligations)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(payrollObligations.dueDate), asc(payrollObligations.id));
}

export async function listStatutoryObligationSummary(input?: { branchId?: number }) {
  const filters = [
    inArray(payrollObligations.kind, ["INCOME_TAX", "SOCIAL_SECURITY"]),
    inArray(payrollObligations.status, ["OPEN", "PARTIAL"]),
    input?.branchId
      ? eq(payrollObligations.branchIdSnapshot, input.branchId)
      : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = await requireDb()
    .select({
      kind: payrollObligations.kind,
      branchIdSnapshot: payrollObligations.branchIdSnapshot,
      remainingAmount: sql<string>`COALESCE(SUM(${payrollObligations.remainingAmount}), 0)`,
      openCount: sql<number>`COUNT(*)`,
    })
    .from(payrollObligations)
    .where(and(...filters))
    .groupBy(payrollObligations.kind, payrollObligations.branchIdSnapshot)
    .orderBy(payrollObligations.branchIdSnapshot, payrollObligations.kind);
  return rows.map((row) => ({
    kind: row.kind as "INCOME_TAX" | "SOCIAL_SECURITY",
    branchIdSnapshot: Number(row.branchIdSnapshot),
    remainingAmount: money(row.remainingAmount).toFixed(2),
    openCount: Number(row.openCount),
  }));
}

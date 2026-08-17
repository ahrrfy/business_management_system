// إلغاء سند قبض/صرف مستقلّ — المرآة الدقيقة لـcreateVoucher (إيصال تعويضي + قيد معاكس + عكس رصيد).
import { TRPCError } from "@trpc/server";
import { asc, eq, inArray } from "drizzle-orm";
import { accountingEntries, receipts, shifts } from "../../../drizzle/schema";
import { money, toDbMoney } from "../money";
import { getActiveLock } from "../periodLockService";
import { type Actor, withTx } from "../tx";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import { assertBranchOwnership } from "./helpers";
import {
  createVoucherTx,
  hasSystemPaymentRequestEnvelope,
  isCanonicalSystemPaymentRequest,
  isSystemPaymentReference,
  parseSystemPaymentRequest,
} from "./create";
import { assertEmployeeAdvanceVoucherRequestTx } from "../advancesService";
import type { PartyType, PaymentMethod } from "./types";
import { loadVoucherCategoryForPosting } from "./categoryAccounting";
import { lockUntouchedEmployeeAdvanceForCancellationTx } from "./employeeAdvanceCancellation";

export interface CancelVoucherResult {
  receiptId: number;
  voucherNumber: string;
  status: "REVERSED" | "PENDING_APPROVAL";
  approvalReceiptId?: number;
}

/**
 * إلغاء سند قبض/صرف مستقلّ — المرآة الدقيقة لـcreateVoucher:
 *   - الأصل يُعلَّم REVERSED (يبقى في السجلّ للتدقيق).
 *   - إيصال تعويضي بالاتجاه المعاكس على نفس الوردية/الطريقة/المبلغ
 *     (تسوية الصندوق تجمع COMPLETED وREVERSED وتستبعد PENDING/FAILED؛ قلب الحالة وحده
 *     يُفسد الصندوق، بينما جمع الأصل المعكوس مع التعويض يصافر الأثر).
 *   - قيد دفتر معاكس (PAYMENT_OUT لإلغاء قبض، PAYMENT_IN لإلغاء صرف) بمبلغ موجب —
 *     ⚠️ ليس ADJUST: صيَغ reconcile تتجاهل ADJUST ⇒ انحراف وهمي دائم.
 *   - عكس رصيد الطرف بإشارة معاكسة تماماً لما كتبه createVoucher.
 *
 * إن كان السند PENDING_APPROVAL ⇒ لا أثر مالي لإلغائه (لم يُسجَّل أصلاً) ⇒ نُعلّمه REVERSED مباشرة.
 * يُمنع الإلغاء على وردية مغلقة (Z-report صدر بالأرقام القديمة).
 */
export async function cancelVoucher(
  receiptId: number,
  actor: Actor,
): Promise<CancelVoucherResult> {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId))
      .limit(1);
    if (!preview || preview.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    const cancellationReference = `CANCEL-VCH-${receiptId}`;
    const previewAttemptIds = (
      await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.referenceNumber, cancellationReference))
        .orderBy(asc(receipts.id))
    ).map((row) => Number(row.id));
    const previewBucket = preview.cashBucket as "DRAWER" | "TREASURY" | null;
    const materialCash =
      preview.paymentMethod === "CASH" && previewBucket != null;
    if (materialCash) {
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: previewBucket,
        shiftId: preview.shiftId != null ? Number(preview.shiftId) : null,
      });
    }
    // اعتماد طلب الإلغاء يقفل الطلب والأصل بترتيب id. يجب أن يسلك إنشاء/إعادة
    // طلب الإلغاء الترتيب نفسه، وإلا انعكس R1→R2 مقابل R2→R1 لغير النقد.
    const receiptIdsToLock = Array.from(
      new Set([receiptId, ...previewAttemptIds]),
    ).sort((left, right) => left - right);
    const lockedReceiptRows = await tx
      .select()
      .from(receipts)
      .where(inArray(receipts.id, receiptIdsToLock))
      .orderBy(asc(receipts.id))
      .for("update");
    const r = lockedReceiptRows.find((row) => Number(row.id) === receiptId);
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (
      materialCash &&
      (r.paymentMethod !== "CASH" ||
        r.direction !== preview.direction ||
        r.cashBucket !== previewBucket ||
        Number(r.branchId) !== Number(preview.branchId) ||
        Number(r.shiftId ?? 0) !== Number(preview.shiftId ?? 0))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر مصدر السند النقدي أثناء الإلغاء — أعد المحاولة",
      });
    }
    // تدقيق ١٧/٧: السند المستقل قد يُربَط توثيقياً بفاتورة بيع (ميزة ٥/٧، receipts.invoiceId) — والربط
    // توثيقيٌّ بحت لا يمسّ invoice.paidAmount (createVoucher يُخزّن الرابط فقط)، فعكسه آمنٌ بمرآة الإنشاء
    // (استعادة رصيد العميل + قيد معاكس). الحارس القديم كان يمنع كلّ سندٍ مربوط ⇒ يستحيل عكسه إطلاقاً.
    // نمنع فقط الإيصالات **غير-السندية** المرتبطة (مدفوعات فاتورة/تسليم أمر شغل) — وهي لا تبلغ هنا أصلاً
    // (السطر أعلاه يرفض voucherNumber == null)، فالشرط دفاعٌ متعمّق موثِّق للنيّة.
    if (
      r.voucherNumber == null &&
      (r.invoiceId != null || r.workOrderId != null)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء إيصال مرتبط بفاتورة/طلب خدمة من هنا",
      });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السند ملغى بالفعل",
      });
    }
    if (
      r.status !== "COMPLETED" &&
      r.approvalStatus !== "PENDING_APPROVAL" &&
      r.approvalStatus !== "REJECTED"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء سند غير مكتمل",
      });
    }
    if (r.paymentMethod === "EXCHANGE") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "هذا السند مرتبط بعملية صيرفة؛ اعكس العملية من وحدة الصيرفة كي يُستعاد رصيد المورد والصيرفة معاً",
      });
    }
    await assertBranchOwnership(
      tx,
      actor,
      r.branchId != null ? Number(r.branchId) : null,
      "سند",
    );
    const originalSystemRequest = parseSystemPaymentRequest(r.internalNote);
    const reservedSystemSource =
      hasSystemPaymentRequestEnvelope(r.internalNote) ||
      isSystemPaymentReference(r.referenceNumber);
    if (
      reservedSystemSource &&
      (!originalSystemRequest ||
        !isCanonicalSystemPaymentRequest(
          originalSystemRequest,
          r.referenceNumber,
        ))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "بيانات الطلب النظامي غير صالحة؛ أوقف الإلغاء وراجع سجل التدقيق",
      });
    }
    if (
      originalSystemRequest &&
      originalSystemRequest.kind !== "EMPLOYEE_ADVANCE"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "هذا طلب دفع لعملية نظامية وله قيد/التزام مستقل؛ يُرفض أو يُعكس من الوحدة المصدر كي لا يبقى أصل أو مصروف بلا مسار تسوية",
      });
    }

    // قفل الفترة (تدقيق ١٧/٧): الإلغاء يقلب الأصل إلى REVERSED فيختفي من تدفّق الشهر النقدي — لو كان
    // السند مؤرَّخاً داخل فترة مُقفَلة تتغيّر أرقامها بأثر رجعي. نرفض الإلغاء ونطلب فتح الفترة أولاً
    // (يبقى مبدأ العكس بقيد مؤرَّخ اليوم للحالات المفتوحة فقط — مطابق لدلالة assertPeriodOpen).
    const lock = await getActiveLock(tx);
    if (lock) {
      // voucherDate عمود DATE: drizzle يُصنّفه string لكن mysql2 يعيد Date وقت التشغيل ⇒ new Date()
      // يعمل للحالتين، ثم toISOString (UTC) مطابقاً لدلالة assertPeriodOpen.
      const vDay = r.voucherDate
        ? new Date(r.voucherDate).toISOString().slice(0, 10)
        : "";
      if (vDay && vDay <= lock.cutoffDate) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `الفترة المالية مُقفَلة حتى ${lock.cutoffDate} — لا يمكن إلغاء سند مؤرَّخ داخلها. يلزم فتح الفترة أوّلاً (admin).`,
        });
      }
    }

    if (r.shiftId != null) {
      const sh = (
        await tx
          .select({ status: shifts.status })
          .from(shifts)
          .where(eq(shifts.id, Number(r.shiftId)))
          .limit(1)
      )[0];
      if (sh && sh.status === "CLOSED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن إلغاء سند على وردية مغلقة",
        });
      }
    }

    const voucherNumber = String(r.voucherNumber);

    // سند مُعلَّق غير مُعتمَد ⇒ لا أثَر مالي لعَكسه. نَكتفي بتَعليمه REVERSED.
    if (
      r.approvalStatus === "PENDING_APPROVAL" ||
      r.approvalStatus === "REJECTED"
    ) {
      await tx
        .update(receipts)
        .set({ status: "REVERSED" })
        .where(eq(receipts.id, receiptId));
      return { receiptId, voucherNumber, status: "REVERSED" as const };
    }

    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";
    const materializedEntries = await tx
      .select({
        id: accountingEntries.id,
        entryType: accountingEntries.entryType,
        amount: accountingEntries.amount,
        customerId: accountingEntries.customerId,
        supplierId: accountingEntries.supplierId,
      })
      .from(accountingEntries)
      .where(eq(accountingEntries.receiptId, receiptId))
      .for("update")
      .limit(2);
    const materialized = materializedEntries[0];
    if (
      materializedEntries.length !== 1 ||
      !materialized ||
      materialized.entryType !==
        (direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT") ||
      !money(materialized.amount).eq(amount) ||
      Number(materialized.customerId ?? 0) !==
        (r.partyType === "CUSTOMER" ? Number(r.partyId ?? 0) : 0) ||
      Number(materialized.supplierId ?? 0) !==
        (r.partyType === "SUPPLIER" ? Number(r.partyId ?? 0) : 0)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "تعذر إثبات القيد المالي المنفذ للسند؛ أوقف الإلغاء وراجع التدقيق",
      });
    }

    const requestPaymentMethod = r.paymentMethod as Exclude<PaymentMethod, "EXCHANGE">;
    const requestPartyType = (r.partyType as PartyType | null) ?? "OTHER";
    if (originalSystemRequest?.kind === "EMPLOYEE_ADVANCE") {
      await assertEmployeeAdvanceVoucherRequestTx(
        tx,
        {
          id: receiptId,
          branchId: r.branchId != null ? Number(r.branchId) : null,
          direction,
          amount: String(r.amount),
          paymentMethod: requestPaymentMethod,
          partyType: r.partyType,
          referenceNumber: r.referenceNumber,
          createdBy: r.createdBy != null ? Number(r.createdBy) : null,
        },
        originalSystemRequest,
        { requireMaterialized: true },
      );
      await lockUntouchedEmployeeAdvanceForCancellationTx(tx, {
        originalReceiptId: receiptId,
        employeeId: originalSystemRequest.employeeId,
        branchId: originalSystemRequest.branchId,
        expectedAmount: originalSystemRequest.expectedAmount,
      });
    } else if (requestPartyType === "OTHER") {
      if (r.voucherCategoryId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "السند التاريخي بلا فئة محاسبية؛ عيّن تصنيفاً معتمداً قبل طلب الإلغاء كي ينعكس الحساب الأصلي نفسه",
        });
      }
      await loadVoucherCategoryForPosting(
        tx,
        Number(r.voucherCategoryId),
        direction,
        { allowInactive: true, lock: true },
      );
    }

    const currentAttemptIds = (
      await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.referenceNumber, cancellationReference))
        .orderBy(asc(receipts.id))
    ).map((row) => Number(row.id));
    if (
      JSON.stringify(currentAttemptIds) !== JSON.stringify(previewAttemptIds) ||
      lockedReceiptRows.length !== receiptIdsToLock.length
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "تغيّرت سلسلة محاولات إلغاء السند أثناء الطلب؛ أعد المحاولة على أحدث حالة",
      });
    }
    const previewAttemptIdSet = new Set(previewAttemptIds);
    const priorAttempts = lockedReceiptRows.filter((row) =>
      previewAttemptIdSet.has(Number(row.id)),
    );
    for (const prior of priorAttempts) {
      const priorRequest = parseSystemPaymentRequest(prior.internalNote);
      if (
        priorRequest?.kind !== "VOUCHER_CANCELLATION" ||
        priorRequest.originalReceiptId !== receiptId ||
        !isCanonicalSystemPaymentRequest(priorRequest, prior.referenceNumber)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "سجل محاولات إلغاء السند غير canonical؛ أوقف الإلغاء وراجع التدقيق",
        });
      }
    }
    const priorAttempt = priorAttempts.at(-1) ?? null;
    if (
      priorAttempt?.status === "PENDING" &&
      priorAttempt.approvalStatus === "PENDING_APPROVAL"
    ) {
      return {
        receiptId,
        voucherNumber,
        status: "PENDING_APPROVAL" as const,
        approvalReceiptId: Number(priorAttempt.id),
      };
    }
    if (
      priorAttempt &&
      priorAttempt.status !== "FAILED" &&
      priorAttempt.status !== "REVERSED" &&
      priorAttempt.approvalStatus !== "REJECTED"
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "آخر محاولة إلغاء ليست منتهية بالرفض ولا تسمح بإعادة الإصدار",
      });
    }
    const attempt = priorAttempts.length + 1;
    const priorCancellationReceiptId =
      priorAttempt == null ? null : Number(priorAttempt.id);
    const reissueReason =
      priorAttempt == null
        ? null
        : `إعادة إصدار طلب الإلغاء بعد رفض المحاولة #${priorAttempt.id}`;

    const request = await createVoucherTx(
      tx,
      {
        voucherType: direction === "IN" ? "PAYMENT" : "RECEIPT",
        branchId: Number(r.branchId),
        amount: toDbMoney(amount),
        paymentMethod: requestPaymentMethod,
        partyType: requestPartyType,
        partyId: r.partyId != null ? Number(r.partyId) : null,
        // يحمل السند المضادّ فاتورةَ الأصل كي يعكس تخصيصها عند اعتماده (اتجاهٌ معاكس ⇒
        // `paidAmount` ينقص بنفس المقدار). بلا هذا كان الإلغاء يُعيد رصيد العميل والقيد
        // ويترك الفاتورة «مدفوعة» بمالٍ استُرجع — وهو ما يجعل الربط الماليّ نصفَ عكوس.
        invoiceId:
          requestPartyType === "CUSTOMER" && r.invoiceId != null
            ? Number(r.invoiceId)
            : null,
        counterpartyName:
          requestPartyType === "OTHER"
            ? r.counterpartyName?.trim() || `إلغاء سند ${r.voucherNumber}`
            : null,
        description: `طلب إلغاء سند ${r.voucherNumber} — المحاولة A${attempt}${reissueReason ? ` — ${reissueReason}` : ""}`,
        referenceNumber: cancellationReference,
        checkNumber: r.checkNumber?.trim() || null,
        cardLastFour: r.cardLastFour?.trim() || null,
        voucherCategoryId:
          r.voucherCategoryId != null ? Number(r.voucherCategoryId) : null,
        clientRequestId: `voucher-cancellation-${receiptId}-A${attempt}`,
      },
      actor,
      {
        systemRequest: {
          kind: "VOUCHER_CANCELLATION",
          originalReceiptId: receiptId,
          originalCreatorId:
            r.createdBy != null ? Number(r.createdBy) : null,
          originalDirection: direction,
          originalPaymentMethod: requestPaymentMethod,
          originalReferenceNumber: r.referenceNumber?.trim() || null,
          originalCheckNumber: r.checkNumber?.trim() || null,
          originalCardLastFour: r.cardLastFour?.trim() || null,
          originalCategoryId:
            r.voucherCategoryId != null ? Number(r.voucherCategoryId) : null,
          attempt,
          priorCancellationReceiptId,
          reissueReason,
        },
      },
    );
    return {
      receiptId,
      voucherNumber,
      status: "PENDING_APPROVAL" as const,
      approvalReceiptId: request.receiptId,
    };
  });
}

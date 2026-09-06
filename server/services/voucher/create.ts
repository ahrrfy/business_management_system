// إنشاء سند قبض/صرف مستقلّ ذرّياً (Maker-Checker + idempotency).
import { TRPCError } from "@trpc/server";
import { isDeadInvoice } from "@shared/predicates";
import { allocateVoucherToInvoiceTx } from "./invoiceAllocation";
import { eq } from "drizzle-orm";
import {
  customers,
  invoices,
  receipts,
  suppliers,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import {
  adjustCustomerBalance,
  adjustSupplierBalance,
  postEntry,
} from "../ledgerService";
import { baghdadToday, todayUtcDate, utcDayStart } from "../businessDay";
import { money, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { lockBranchMonthCloseGate } from "../reports/monthCloseGate";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import {
  assertNonPhysicalOutReceipt,
  lockMaterializedCashReceiptSourceForWrite,
} from "../cash/cashAvailability";
import { assertInboundPaymentMethodEnabled } from "../inboundPaymentPolicy";
import type { Tx } from "../../db";
import { type Actor, enqueuePostCommit, withTx } from "../tx";
import { notifyApprovalPendingByReceipt } from "../approvalEventNotifier";
import {
  computeSignature,
  nextVoucherNumber,
  validateCategory,
} from "./helpers";
import { loadVoucherCategoryForPosting } from "./categoryAccounting";
import { voucherPostingPlan } from "./posting";
import { withMysqlDeadlockRetry } from "./deadlockRetry";
import type { VoucherInput, VoucherResult } from "./types";
import { createHash } from "node:crypto";
import { voucherApprovalTrigger } from "@shared/approvalTriggers";
import { planApproval, resolveApprovalActor } from "../approval/ownerGate";
import {
  isCanonicalPurchaseUsdSystemPaymentRequest,
  PURCHASE_USD_REFERENCE_PREFIX,
  type PurchaseSupplierUsdSystemPaymentRequest,
} from "../purchase/usdSettlementRequest";

const SYSTEM_REQUEST_PREFIX = "@SYSTEM_PAYMENT_REQUEST:";
const SYSTEM_REFERENCE_PREFIXES = [
  "ASSET-ACQ-",
  "ASSET-REACQ-",
  "ASSET-MAINT-",
  "ASSET-SUP-SETTLE-",
  "PO-PAY-",
  PURCHASE_USD_REFERENCE_PREFIX,
  "SHIP-",
  "EXCHANGE-IQD-DEP-",
  "DIGITAL-WALLET-DEP-",
  "CANCEL-VCH-",
  "TERM-SETTLEMENT-",
  "EMP-ADV-",
  "ACCRUAL-REFUND-",
] as const;

export function isSystemPaymentReference(
  reference: string | null | undefined,
): boolean {
  return (
    !!reference &&
    SYSTEM_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix))
  );
}

/** Fail-closed envelope detection only; callers must still parse and validate the canonical payload. */
export function hasSystemPaymentRequestEnvelope(
  note: string | null | undefined,
): boolean {
  return note?.startsWith(SYSTEM_REQUEST_PREFIX) === true;
}

export type TerminationSettlementSystemPaymentRequest = {
  kind: "TERMINATION_SETTLEMENT";
  terminationId: number;
  employeeId: number;
  expectedAmount: string;
  /** Monotonic request-issue sequence, serialized under the termination lock. */
  attempt: number;
  /** The payment-return event that made this repayment payable, or null initially. */
  originReturnEventId: number | null;
  /** Instrument evidence belongs in the signed internal request, never in the system reference. */
  paymentEvidenceReference: string | null;
  settlementSnapshotHash: string;
  obligationId: number;
};

export type ParsedTerminationSettlementReference = {
  terminationId: number;
  attempt: number;
  originReturnEventId: number | null;
};

const TERMINATION_SETTLEMENT_REFERENCE_RE =
  /^TERM-SETTLEMENT-([1-9]\d*)(?:-REPAY-([1-9]\d*))?-A([1-9]\d*)$/;

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Parses only the canonical system reference; no evidence or trailing text is accepted. */
export function parseTerminationSettlementReference(
  reference: string | null | undefined,
): ParsedTerminationSettlementReference | null {
  if (!reference) return null;
  const match = TERMINATION_SETTLEMENT_REFERENCE_RE.exec(reference);
  if (!match) return null;
  const terminationId = Number(match[1]);
  const originReturnEventId = match[2] == null ? null : Number(match[2]);
  const attempt = Number(match[3]);
  if (
    !isPositiveSafeInteger(terminationId) ||
    !isPositiveSafeInteger(attempt) ||
    (originReturnEventId != null && !isPositiveSafeInteger(originReturnEventId))
  ) {
    return null;
  }
  return { terminationId, attempt, originReturnEventId };
}

/** Derives the one canonical reference from the typed internal request. */
export function terminationSettlementReference(
  request: Pick<
    TerminationSettlementSystemPaymentRequest,
    "terminationId" | "attempt" | "originReturnEventId"
  >,
): string | null {
  if (
    !isPositiveSafeInteger(request.terminationId) ||
    !isPositiveSafeInteger(request.attempt) ||
    (request.originReturnEventId != null &&
      !isPositiveSafeInteger(request.originReturnEventId))
  ) {
    return null;
  }
  const repayment =
    request.originReturnEventId == null
      ? ""
      : `-REPAY-${request.originReturnEventId}`;
  return `TERM-SETTLEMENT-${request.terminationId}${repayment}-A${request.attempt}`;
}

export type AccrualObligationSystemSource = {
  obligationId: number;
  obligationSourceHash: string;
  beneficiaryType: "SUPPLIER" | "OTHER";
  beneficiaryId: number | null;
  beneficiaryNameSnapshot: string;
  sourceEvidenceReference: string;
};

export type SystemPaymentRequest =
  | ({
      kind: "ASSET_ACQUISITION";
      assetId: number;
    } & AccrualObligationSystemSource)
  | ({
      kind: "ASSET_MAINTENANCE";
      assetId: number;
      maintenanceId: number;
    } & AccrualObligationSystemSource)
  | ({
      kind: "ASSET_SUPPLIER_SETTLEMENT";
      assetId: number;
      supplierId: number;
      expectedAmount: string;
    } & AccrualObligationSystemSource)
  | {
      kind: "PURCHASE_SUPPLIER";
      purchaseOrderId: number;
      requestToken: string;
      expectedAmount: string;
      sourceTotal: string;
      /** غياب الحقل = طلب تاريخي استعمل AP؛ القيمة الجديدة تجمّد حساب التسوية عند الإنشاء. */
      liabilityAccount?: "AP" | "CASH_CLEARING";
    }
  | PurchaseSupplierUsdSystemPaymentRequest
  | ({
      kind: "PURCHASE_SHIPPING";
      purchaseOrderId: number;
      requestToken: string;
      expectedAmount: string;
      sourceShippingTotal: string;
      /** دليل أداة الدفع غير النقدية (مرجع تحويل/صك أو آخر 4 للبطاقة). */
      paymentReference?: string | null;
    } & AccrualObligationSystemSource)
  | {
      kind: "EXCHANGE_IQD_DEPOSIT";
      transactionId: number;
      exchangeHouseId: number;
      expectedAmount: string;
    }
  | {
      kind: "DIGITAL_WALLET_CASH_DEPOSIT";
      transactionId: number;
      walletId: number;
      expectedAmount: string;
    }
  | TerminationSettlementSystemPaymentRequest
  | {
      kind: "ACCRUAL_CORRECTION_REFUND";
      correctionRequestId: number;
      obligationId: number;
      obligationSourceHash: string;
      expectedAmount: string;
      originalSettlementReceiptId: number;
      providerEvidenceReference: string;
    }
  | {
      kind: "EMPLOYEE_ADVANCE";
      employeeId: number;
      branchId: number;
      expectedAmount: string;
      monthlyDeduction: string | null;
      note: string | null;
      sourceClientRequestId: string;
      sourceHash: string;
    }
  | {
      kind: "VOUCHER_CANCELLATION";
      originalReceiptId: number;
      originalCreatorId: number | null;
      originalDirection: "IN" | "OUT";
      originalPaymentMethod: "CASH" | "CARD" | "TRANSFER" | "CHECK" | "WALLET";
      originalReferenceNumber: string | null;
      originalCheckNumber: string | null;
      originalCardLastFour: string | null;
      originalCategoryId: number | null;
      attempt: number;
      priorCancellationReceiptId: number | null;
      reissueReason: string | null;
    };

type EmployeeAdvanceSource = Pick<
  Extract<SystemPaymentRequest, { kind: "EMPLOYEE_ADVANCE" }>,
  | "employeeId"
  | "branchId"
  | "expectedAmount"
  | "monthlyDeduction"
  | "note"
  | "sourceClientRequestId"
>;

export function employeeAdvanceSourceHash(
  source: EmployeeAdvanceSource,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        employeeId: source.employeeId,
        branchId: source.branchId,
        expectedAmount: source.expectedAmount,
        monthlyDeduction: source.monthlyDeduction,
        note: source.note,
        sourceClientRequestId: source.sourceClientRequestId,
      }),
    )
    .digest("hex");
}

export function employeeAdvanceReference(
  request: Extract<SystemPaymentRequest, { kind: "EMPLOYEE_ADVANCE" }>,
): string | null {
  if (
    !isPositiveSafeInteger(request.employeeId) ||
    !isPositiveSafeInteger(request.branchId) ||
    !/^[a-f0-9]{64}$/.test(request.sourceHash) ||
    employeeAdvanceSourceHash(request) !== request.sourceHash
  ) {
    return null;
  }
  return `EMP-ADV-${request.employeeId}-${request.sourceHash.slice(0, 16)}`;
}

function isCanonicalAccrualObligationSystemSource(
  request: AccrualObligationSystemSource,
): boolean {
  return (
    isPositiveSafeInteger(request.obligationId) &&
    typeof request.obligationSourceHash === "string" &&
    /^[a-f0-9]{64}$/.test(request.obligationSourceHash) &&
    (request.beneficiaryType === "SUPPLIER" ||
      request.beneficiaryType === "OTHER") &&
    (request.beneficiaryType === "SUPPLIER"
      ? request.beneficiaryId != null &&
        isPositiveSafeInteger(request.beneficiaryId)
      : request.beneficiaryId == null) &&
    typeof request.beneficiaryNameSnapshot === "string" &&
    request.beneficiaryNameSnapshot.trim() ===
      request.beneficiaryNameSnapshot &&
    request.beneficiaryNameSnapshot.length > 0 &&
    typeof request.sourceEvidenceReference === "string" &&
    request.sourceEvidenceReference.trim() ===
      request.sourceEvidenceReference &&
    request.sourceEvidenceReference.length > 0
  );
}

/** Pure structural reference check. Source services still revalidate their locked DB rows. */
export function isCanonicalSystemPaymentRequest(
  request: SystemPaymentRequest,
  reference: string | null | undefined,
): boolean {
  if (!reference) return false;
  switch (request.kind) {
    case "ASSET_ACQUISITION":
      return (
        isPositiveSafeInteger(request.assetId) &&
        isCanonicalAccrualObligationSystemSource(request) &&
        reference === `ASSET-ACQ-${request.assetId}`
      );
    case "ASSET_MAINTENANCE":
      return (
        isPositiveSafeInteger(request.assetId) &&
        isPositiveSafeInteger(request.maintenanceId) &&
        isCanonicalAccrualObligationSystemSource(request) &&
        reference === `ASSET-MAINT-${request.maintenanceId}`
      );
    case "ASSET_SUPPLIER_SETTLEMENT":
      return (
        isPositiveSafeInteger(request.assetId) &&
        isPositiveSafeInteger(request.supplierId) &&
        typeof request.expectedAmount === "string" &&
        /^(?:0|[1-9]\d*)\.\d{2}$/.test(request.expectedAmount) &&
        money(request.expectedAmount).gt(0) &&
        isCanonicalAccrualObligationSystemSource(request) &&
        request.beneficiaryType === "SUPPLIER" &&
        request.beneficiaryId === request.supplierId &&
        reference ===
          `ASSET-SUP-SETTLE-${request.assetId}-${request.obligationId}`
      );
    case "PURCHASE_SUPPLIER":
      return (
        isPositiveSafeInteger(request.purchaseOrderId) &&
        !!request.requestToken &&
        (request.liabilityAccount == null ||
          request.liabilityAccount === "AP" ||
          request.liabilityAccount === "CASH_CLEARING") &&
        reference.endsWith(`-${request.requestToken}`) &&
        reference.startsWith("PO-PAY-")
      );
    case "PURCHASE_SUPPLIER_USD":
      return isCanonicalPurchaseUsdSystemPaymentRequest(request, reference);
    case "PURCHASE_SHIPPING":
      return (
        isPositiveSafeInteger(request.purchaseOrderId) &&
        !!request.requestToken &&
        isCanonicalAccrualObligationSystemSource(request) &&
        reference.endsWith(`-${request.requestToken}`) &&
        reference.startsWith("SHIP-")
      );
    case "EXCHANGE_IQD_DEPOSIT":
      return (
        isPositiveSafeInteger(request.transactionId) &&
        isPositiveSafeInteger(request.exchangeHouseId) &&
        reference === `EXCHANGE-IQD-DEP-${request.transactionId}`
      );
    case "DIGITAL_WALLET_CASH_DEPOSIT":
      return (
        isPositiveSafeInteger(request.transactionId) &&
        isPositiveSafeInteger(request.walletId) &&
        reference === `DIGITAL-WALLET-DEP-${request.transactionId}`
      );
    case "TERMINATION_SETTLEMENT":
      return (
        terminationSettlementReference(request) === reference &&
        parseTerminationSettlementReference(reference) != null
      );
    case "EMPLOYEE_ADVANCE":
      return employeeAdvanceReference(request) === reference;
    case "ACCRUAL_CORRECTION_REFUND":
      return (
        isPositiveSafeInteger(request.correctionRequestId) &&
        isPositiveSafeInteger(request.obligationId) &&
        isPositiveSafeInteger(request.originalSettlementReceiptId) &&
        typeof request.obligationSourceHash === "string" &&
        /^[a-f0-9]{64}$/.test(request.obligationSourceHash) &&
        typeof request.expectedAmount === "string" &&
        /^(?:0|[1-9]\d*)\.\d{2}$/.test(request.expectedAmount) &&
        money(request.expectedAmount).gt(0) &&
        typeof request.providerEvidenceReference === "string" &&
        request.providerEvidenceReference.trim() ===
          request.providerEvidenceReference &&
        request.providerEvidenceReference.length > 0 &&
        reference === `ACCRUAL-REFUND-${request.correctionRequestId}`
      );
    case "VOUCHER_CANCELLATION":
      return (
        isPositiveSafeInteger(request.originalReceiptId) &&
        (request.originalCreatorId == null ||
          isPositiveSafeInteger(request.originalCreatorId)) &&
        (request.originalDirection === "IN" ||
          request.originalDirection === "OUT") &&
        ["CASH", "CARD", "TRANSFER", "CHECK", "WALLET"].includes(
          request.originalPaymentMethod,
        ) &&
        (request.originalReferenceNumber == null ||
          typeof request.originalReferenceNumber === "string") &&
        (request.originalCheckNumber == null ||
          typeof request.originalCheckNumber === "string") &&
        (request.originalCardLastFour == null ||
          typeof request.originalCardLastFour === "string") &&
        (request.originalCategoryId == null ||
          isPositiveSafeInteger(request.originalCategoryId)) &&
        isPositiveSafeInteger(request.attempt) &&
        (request.attempt === 1
          ? request.priorCancellationReceiptId == null &&
            request.reissueReason == null
          : isPositiveSafeInteger(Number(request.priorCancellationReceiptId)) &&
            typeof request.reissueReason === "string" &&
            request.reissueReason.trim() === request.reissueReason &&
            request.reissueReason.length >= 5) &&
        reference === `CANCEL-VCH-${request.originalReceiptId}`
      );
  }
}

export function encodeSystemPaymentRequest(
  request: SystemPaymentRequest,
): string {
  return `${SYSTEM_REQUEST_PREFIX}${JSON.stringify(request)}`;
}

export function parseSystemPaymentRequest(
  note: string | null | undefined,
): SystemPaymentRequest | null {
  if (!note || !hasSystemPaymentRequestEnvelope(note)) return null;
  try {
    const parsed = JSON.parse(note.slice(SYSTEM_REQUEST_PREFIX.length)) as {
      kind?: unknown;
    };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.kind !== "string"
    )
      return null;
    switch (parsed.kind) {
      case "ASSET_ACQUISITION":
      case "ASSET_MAINTENANCE":
      case "ASSET_SUPPLIER_SETTLEMENT":
      case "PURCHASE_SUPPLIER":
      case "PURCHASE_SUPPLIER_USD":
      case "PURCHASE_SHIPPING":
      case "EXCHANGE_IQD_DEPOSIT":
      case "DIGITAL_WALLET_CASH_DEPOSIT":
      case "TERMINATION_SETTLEMENT":
      case "EMPLOYEE_ADVANCE":
      case "ACCRUAL_CORRECTION_REFUND":
      case "VOUCHER_CANCELLATION":
        return parsed as SystemPaymentRequest;
      default:
        // Legacy/unknown system requests are not generic vouchers. Returning null
        // makes the reserved-reference guard fail closed before any cash effect.
        return null;
    }
  } catch {
    return null;
  }
}

/** يُنشئ سند قبض (IN) أو صرف (OUT) ذريّاً.
 *
 * Maker-Checker: كل سند صرف يُسجَّل بـapprovalStatus=PENDING_APPROVAL، بصرف النظر
 * عن المبلغ أو صفة المُنشئ، بلا قيد دفتر ولا تأثير على الرصيد/الصندوق. الاعتماد اللاحق
 * من مالك نشط مختلف عبر approveVoucher() هو منفذ الأثر المالي الوحيد (SOD).
 * سند القبض يحتفظ بسياسة الاعتماد القائمة.
 */
export async function createVoucherTx(
  tx: Tx,
  input: VoucherInput,
  actor: Actor,
  options?: {
    systemRequest?: SystemPaymentRequest;
    /** يؤجل اعتماد المالك حتى تربط الوحدة الأم السند بمصدره داخل المعاملة نفسها. */
    deferOwnerAutoApproval?: boolean;
  },
): Promise<VoucherResult> {
  const normalizedReferenceNumber = input.referenceNumber?.trim() || null;
  const normalizedInternalNote = options?.systemRequest
    ? encodeSystemPaymentRequest(options.systemRequest)
    : input.internalNote?.trim() || null;
  const reservedReferenceHadOuterWhitespace =
    normalizedReferenceNumber != null &&
    input.referenceNumber !== normalizedReferenceNumber &&
    isSystemPaymentReference(normalizedReferenceNumber);
  const reservedEnvelopeHadOuterWhitespace =
    normalizedInternalNote != null &&
    !options?.systemRequest &&
    input.internalNote !== normalizedInternalNote &&
    hasSystemPaymentRequestEnvelope(normalizedInternalNote);
  // سند القبض ينشئ إيصالاً وقيد PAYMENT_IN ويحرّك ذمة الطرف فوراً. لا يكفي
  // مرجع يكتبه الموظف لإثبات مال خارجي؛ ارفضه قبل idempotency أو أي قراءة DB.
  if (
    input.voucherType === "RECEIPT" &&
    options?.systemRequest?.kind !== "VOUCHER_CANCELLATION"
  ) {
    assertInboundPaymentMethodEnabled(input.paymentMethod);
  }
  if (input.paymentMethod === "EXCHANGE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "سند الصيرفة يُنشأ حصراً من شاشة «تسديد مورد عبر الصيرفة» لضمان تحريك الطرفين ذرّياً",
    });
  }
  if (!input.clientRequestId?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفتاح idempotency إلزامي لإنشاء السند",
    });
  }
  // Validate the privileged envelope before idempotency lookup/replay. A stale key must never
  // turn reserved metadata or a non-canonical source request into an accepted operation.
  if (
    reservedEnvelopeHadOuterWhitespace ||
    (!options?.systemRequest &&
      hasSystemPaymentRequestEnvelope(input.internalNote))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "بادئة الملاحظات النظامية محجوزة",
    });
  }
  if (
    reservedReferenceHadOuterWhitespace ||
    (!options?.systemRequest &&
      isSystemPaymentReference(normalizedReferenceNumber))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع السند النظامي محجوز",
    });
  }
  if (
    options?.systemRequest &&
    !isCanonicalSystemPaymentRequest(
      options.systemRequest,
      normalizedReferenceNumber,
    )
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "طلب الدفع النظامي لا يطابق مرجعه canonical — أوقف الإنشاء وراجع الوحدة المصدرية",
    });
  }
  // Idempotency: تكرار نفس المفتاح يُعاد بنتيجة السند الأول (لا قيد/نقد مزدوج).
  // المفتاح immutable حتى بعد الرفض/العكس: إعادة الإصدار تحتاج مفتاحاً جديداً صريحاً. حذف المفتاح
  // القديم كان يسمح لمحاولة شبكة متأخرة بإحياء السند الميت وإعادة تحريك النقد/الذمة.
  if (input.clientRequestId) {
    const existingRefId = await findIdempotentRefId(tx, "voucher.create", input.clientRequestId);
    if (existingRefId != null) {
      const r = (
        await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, existingRefId))
          .limit(1)
      )[0];
      if (!r) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "سند idempotency مفقود — تحقّق من الإيصال",
        });
      }
      const isDead =
        r.status === "REVERSED" ||
        r.status === "FAILED" ||
        r.approvalStatus === "REJECTED";
      {
        const storedPartyId = r.partyId != null ? Number(r.partyId) : null;
        const requestedPartyId =
          input.partyType === "OTHER" ? null : (input.partyId ?? null);
        const storedInvoiceId =
          r.invoiceId != null ? Number(r.invoiceId) : null;
        const requestedInvoiceId = input.invoiceId ?? null;
        const storedCategoryId =
          r.voucherCategoryId != null ? Number(r.voucherCategoryId) : null;
        const requestedCategoryId = input.voucherCategoryId ?? null;
        const requestedDirection =
          input.voucherType === "RECEIPT" ? "IN" : "OUT";
        const requestedReference = normalizedReferenceNumber;
        const requestedInternalNote = normalizedInternalNote;
        const requestedDescription = input.description?.trim() || null;
        const requestedCounterpartyName =
          input.counterpartyName?.trim() || null;
        const requestedCheckNumber = input.checkNumber?.trim() || null;
        const requestedCardLastFour = input.cardLastFour?.trim() || null;
        const requestedAttachmentUrl = input.attachmentUrl?.trim() || null;
        const requestedVoucherDate =
          input.voucherDate?.trim().slice(0, 10) || null;
        const storedVoucherDate = r.voucherDate
          ? new Date(r.voucherDate).toISOString().slice(0, 10)
          : null;
        if (
          Number(r.branchId) !== Number(input.branchId) ||
          r.direction !== requestedDirection ||
          r.paymentMethod !== input.paymentMethod ||
          (r.partyType ?? null) !== (input.partyType ?? null) ||
          storedPartyId !== requestedPartyId ||
          storedInvoiceId !== requestedInvoiceId ||
          storedCategoryId !== requestedCategoryId ||
          (r.referenceNumber ?? null) !== requestedReference ||
          (r.internalNote ?? null) !== requestedInternalNote ||
          (r.description?.trim() || null) !== requestedDescription ||
          (r.counterpartyName?.trim() || null) !== requestedCounterpartyName ||
          (r.checkNumber?.trim() || null) !== requestedCheckNumber ||
          (r.cardLastFour?.trim() || null) !== requestedCardLastFour ||
          (r.attachmentUrl?.trim() || null) !== requestedAttachmentUrl ||
          (requestedVoucherDate != null &&
            storedVoucherDate !== requestedVoucherDate) ||
          money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "تعارض idempotency: المفتاح مستعمَل لسند بطرف/فرع/مبلغ/فاتورة مختلفة",
          });
        }
        if (isDead) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "مفتاح idempotency مرتبط بسند منتهٍ أو معكوس؛ أعد الإصدار من المسار الصريح بمفتاح جديد",
          });
        }
        return {
          receiptId: existingRefId,
          voucherNumber: r.voucherNumber ?? "",
          direction: (r.direction as "IN" | "OUT") ?? "IN",
          approvalStatus:
            (r.approvalStatus as VoucherResult["approvalStatus"]) ?? "APPROVED",
        };
      }
    }
  }
  const amount = money(input.amount);
  if (amount.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مبلغ السند يجب أن يكون موجباً",
    });
  }
  const description = input.description?.trim();
  if (!description) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وصف السند مطلوب" });
  }
  // تَحقّقات الإلزام المَشروط (vouchers-pro):
  if (input.paymentMethod === "TRANSFER" && !normalizedReferenceNumber) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "الرقم المرجعي إلزامي لطريقة الدفع «تحويل» (للتطابق مع كَشف البنك)",
    });
  }
  if (input.paymentMethod === "CARD") {
    const tail = input.cardLastFour?.trim() ?? "";
    // A governed reversal may mirror a pre-governance CARD receipt that never
    // stored the last four. The original evidence is revalidated from its
    // locked system source; inventing "0000" here would corrupt the audit trail.
    if (
      !/^\d{4}$/.test(tail) &&
      options?.systemRequest?.kind !== "VOUCHER_CANCELLATION"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "آخر ٤ من البطاقة إلزامي لطريقة الدفع «بطاقة» (٤ أرقام)",
      });
    }
  }
  if (input.paymentMethod === "CHECK" && !input.checkNumber?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رقم الصكّ إلزامي لطريقة الدفع «صكّ»",
    });
  }
  // المُرفق **اختياريّ دائماً** (٣١/٧، قرار المالك: لا مُرفق إلزامي في النظام كله) — أُلغيت عَتبة
  // إلزام المُرفق التي كانت تَرفض السندات ≥ ٢٥٠.٠٠٠ د.ع بلا attachmentUrl.
  // attachment-upload (٥/٧): المُرفق إمّا data URL صورة مضغوطة (رفع من الواجهة الجديدة) أو رابط/مَسار
  // نصّي كما كان سابقاً (اختبارات vouchers-pro القائمة تُرسل روابط https:// عادية عمداً — تبقى صالحة).
  // لا فرض صيغة صورة هنا؛ الطباعة/العرض يُميّزان data:image بأنفسهما (voucherPrint.ts، Vouchers.tsx).

  const direction: "IN" | "OUT" =
    input.voucherType === "RECEIPT" ? "IN" : "OUT";

  // تَحقّق الفئة (إن مُرّرت) — الاتجاه يَجب أن يَتسق مع نوع السند.
  const requiresCategoryAccounting =
    input.partyType === "OTHER" && !options?.systemRequest;
  if (requiresCategoryAccounting && input.voucherCategoryId == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "فئة السند والحساب المقابل إلزاميان لسندات «أخرى» — عيّن فئة محاسبية مهيأة قبل الحفظ",
    });
  }
  if (input.voucherCategoryId != null) {
    if (requiresCategoryAccounting) {
      await loadVoucherCategoryForPosting(
        tx,
        input.voucherCategoryId,
        direction,
        { lock: true },
      );
    } else if (options?.systemRequest?.kind !== "VOUCHER_CANCELLATION") {
      await validateCategory(tx, input.voucherCategoryId, direction);
    }
  }

  // attachment-upload (٥/٧): ربط سند بفاتورة — العميل فقط (السندات receipts.invoiceId يُشير لـinvoices
  // وهي فواتير بيع دائماً؛ المشتريات/الموردون تُدار عبر أوامر الشراء بلا عمود مماثل بعد).
  if (input.invoiceId != null && input.partyType !== "CUSTOMER") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "ربط السند بفاتورة مُتاح لسندات العميل فقط",
    });
  }

  // بضاعة الأمانة (ش٥): يُرفَع لو كان الصرف لمودِع أمانة (اعتماد ثنائيّ دائماً).
  let forcePendingApproval = false;
  // تَحقّق الطرف: يَجب أن يَكون نشطاً.
  if (input.partyType === "CUSTOMER") {
    if (!input.partyId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "العميل مطلوب لسند مرتبط بعميل",
      });
    const c = (
      await tx
        .select()
        .from(customers)
        .where(eq(customers.id, input.partyId))
        .limit(1)
    )[0];
    if (!c)
      throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (!c.isActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إصدار سند لعميل مُعطَّل",
      });
    }
    if (input.invoiceId != null) {
      const inv = (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, input.invoiceId))
          .limit(1)
      )[0];
      if (!inv)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "الفاتورة المرتبطة غير موجودة",
        });
      if (Number(inv.customerId) !== Number(input.partyId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الفاتورة المرتبطة لا تخصّ هذا العميل",
        });
      }
      // المُستبدَلة كانت تمرّ: `correct.ts` يتركها بـ`total` كاملاً و`returnedTotal` مُصفَّراً
      // ⇒ تجتاز فلتر «مستحقّة» وتُعرَض للمحاسب في مُنتقي الفواتير بمتبقٍّ = إجماليها، فيُربَط
      // بها قبضٌ بينما الالتزام الحقيقيّ على البديلة (مالٌ يُنسَب لمستندٍ عُكِس بالكامل).
      // ⚠️ السند المضادّ (إلغاء) مُستثنى: عكسُ تخصيصٍ سابق يجب أن يبقى ممكناً مهما صارت
      // حالة الفاتورة لاحقاً، وإلّا احتُجز مالٌ مخصَّصٌ لفاتورةٍ ماتت بلا أيّ مخرج.
      if (
        options?.systemRequest?.kind !== "VOUCHER_CANCELLATION" &&
        isDeadInvoice(inv)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن الربط بفاتورة ملغاة أو مرتجعة أو مستبدَلة بمصحّحة",
        });
      }
    }
  } else if (input.partyType === "SUPPLIER") {
    if (!input.partyId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المورد مطلوب لسند مرتبط بمورد",
      });
    const sup = (
      await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, input.partyId))
        .limit(1)
    )[0];
    if (!sup)
      throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
    if (!sup.isActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إصدار سند لمورد مُعطَّل",
      });
    }
    // بضاعة الأمانة (ش٥): أيّ صرفٍ لمودِع أمانة يمرّ باعتمادٍ ثنائيّ **دائماً** مهما صغُر المبلغ
    // (قرار المالك ٣ — يغلق التفاف «سند حرّ تحت العتبة بفاعل واحد»). + سقف ≤ المستحق (currentBalance)
    // يُعاد فحصه عند الاعتماد تحت القفل. §٥ حاصرة ٢.
    if (direction === "OUT" && sup.supplierKind === "CONSIGNOR") {
      forcePendingApproval = true;
      if (money(sup.currentBalance ?? "0").lt(amount)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `مبلغ الصرف يتجاوز مستحقّ المودِع (${money(sup.currentBalance ?? "0").toFixed(2)})`,
        });
      }
    }
  } else if (input.partyType === "OTHER") {
    if (!input.counterpartyName?.trim()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "اسم الطرف المقابل إلزامي لسندات «أخرى»",
      });
    }
    // قبض OTHER يخلق نقداً من مصدر خارجي مجهول وقابل للتجزئة؛ لذلك يخضع دائماً إلى Maker‑Checker.
    if (input.voucherType === "RECEIPT") forcePendingApproval = true;
  }

  // أساسا التاريخ متمايزان عمداً (إصلاح انحدار #604):
  //  - الحارس «لا تأريخ في المستقبل» يقيس بيوم **بغداد** (متسامح): مستخدمٌ في بغداد بعد منتصف
  //    الليل يرسل تاريخ يومه المحلّي، فلا يجوز أن يُرفض بوصفه «مستقبلاً» لأنّ UTC ما زال أمس.
  //  - أمّا **الختم الافتراضيّ** فيوم UTC: `entryDate` يُشتقّ من `voucherDate`، وكلّ قارئٍ ماليّ
  //    يرشّح على أساس UTC (`utcDayRange`/`todayUtcDate` — إطار businessDay §٦). ختمُ يوم بغداد
  //    كان يُخرج كل سندٍ يُنشأ بين ٢١:٠٠ و٢٤:٠٠ UTC من نافذة يومه في تقرير التدفّق النقديّ
  //    والخزينة — أساسٌ مزدوجٌ صامت، وهو بالضبط ما يحذّر منه توثيق `baghdadToday` نفسه.
  const today = baghdadToday();
  const voucherDate = (input.voucherDate?.trim() || todayUtcDate()).slice(
    0,
    10,
  );
  if (voucherDate > today) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `لا يجوز تأريخ السند في المستقبل (${voucherDate})`,
    });
  }

  // بوابة الفرع تتسلسل مع اعتماد إقفال الشركة. نعيد فحص تاريخ السند بعد نيلها حتى لا
  // يُنشأ PENDING_APPROVAL بأثر رجعي بعد أن التزم القفل في أثناء الانتظار.
  await lockBranchMonthCloseGate(tx, input.branchId);
  await assertPeriodOpen(tx, utcDayStart(voucherDate));

  const voucherNumber = await nextVoucherNumber(
    tx,
    input.voucherType,
    input.branchId,
  );
  // عقد المالك: كل سند صرف يُنشأ طلباً معلّقاً، بصرف النظر عن المبلغ أو صفة المنشئ.
  // سند القبض يبقى على سياسته القائمة (OTHER يحتاج Maker-Checker، وغيره مباشر).
  const needsApproval =
    direction === "OUT" ||
    forcePendingApproval ||
    options?.systemRequest?.kind === "VOUCHER_CANCELLATION";
  const resolvedActor = await resolveApprovalActor(tx, actor);
  const ownerApprovalPlan = planApproval({
    actor: resolvedActor,
    trigger: voucherApprovalTrigger(
      direction,
      options?.systemRequest?.kind ?? null,
    ),
  });
  const ownerAutoApproves =
    needsApproval &&
    resolvedActor.isOwner &&
    ownerApprovalPlan.executeNow &&
    !options?.deferOwnerAutoApproval &&
    // الطلبات النظامية تربط المستند الأم بعد رجوع الإنشاء؛ تعتمدها الوحدة الأم بعد اكتمال الربط.
    (!options?.systemRequest ||
      options.systemRequest.kind === "VOUCHER_CANCELLATION" ||
      options.systemRequest.kind === "EMPLOYEE_ADVANCE" ||
      options.systemRequest.kind === "TERMINATION_SETTLEMENT" ||
      options.systemRequest.kind === "PURCHASE_SUPPLIER" ||
      options.systemRequest.kind === "PURCHASE_SUPPLIER_USD");

  // shiftId + cashBucket — سياسة الخزينة الإدارية vs درج الكاشير (تدقيق ١٧/٦).
  //  - PENDING_APPROVAL: لا نَقفل وردية ولا نُحدّد دلواً (لا تأثير على الصندوق حتى الاعتماد).
  let shiftId: number | null = null;
  let cashBucket: "DRAWER" | "TREASURY" | null = null;
  if (!needsApproval) {
    if (input.paymentMethod === "CASH") {
      const g = await shiftIdForCashTx(tx, actor, input.branchId, "سند نقدي");
      shiftId = g.shiftId;
      cashBucket = g.cashBucket;
    } else {
      shiftId = await openShiftIdTx(tx, actor.userId, input.branchId);
    }
  }

  if (needsApproval && direction === "OUT") {
    assertNonPhysicalOutReceipt({
      classification: "DEFERRED_APPROVAL",
      paymentMethod: input.paymentMethod,
      cashBucket: null,
      approvalStatus: "PENDING_APPROVAL",
      operation: "إنشاء طلب سند صرف",
    });
  }
  await lockMaterializedCashReceiptSourceForWrite(tx, {
    branchId: input.branchId,
    shiftId,
    cashBucket,
    paymentMethod: input.paymentMethod,
    status: needsApproval ? "PENDING" : "COMPLETED",
    approvalStatus: needsApproval ? "PENDING_APPROVAL" : "APPROVED",
  });
  const rRes = await tx.insert(receipts).values({
    branchId: input.branchId,
    invoiceId:
      input.partyType === "CUSTOMER" ? (input.invoiceId ?? null) : null,
    shiftId,
    cashBucket,
    direction,
    amount: toDbMoney(amount),
    paymentMethod: input.paymentMethod,
    referenceNumber: normalizedReferenceNumber,
    checkNumber: input.checkNumber?.trim() || null,
    cardLastFour: input.cardLastFour?.trim() || null,
    status: needsApproval ? "PENDING" : "COMPLETED",
    voucherNumber,
    partyType: input.partyType,
    partyId: input.partyType === "OTHER" ? null : (input.partyId ?? null),
    description,
    createdBy: actor.userId,
    // vouchers-pro:
    voucherCategoryId: input.voucherCategoryId ?? null,
    counterpartyName: input.counterpartyName?.trim() || null,
    voucherDate: new Date(voucherDate),
    attachmentUrl: input.attachmentUrl?.trim() || null,
    internalNote: normalizedInternalNote,
    approvalStatus: needsApproval ? "PENDING_APPROVAL" : "APPROVED",
  });
  const receiptId = extractInsertId(rRes);

  // الأثر المالي يُطبَّق فقط عند الاعتماد (PENDING_APPROVAL ⇒ صفّ معلَّق بلا أثَر).
  if (!needsApproval) {
    const posting = voucherPostingPlan({
      entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      partyType: input.partyType,
      paymentMethod: input.paymentMethod,
      cashBucket,
      amount,
      referenceNumber: input.referenceNumber,
    });
    if (!posting) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "تعذر بناء قيد السند من طريقة الدفع والطرف المحددين",
      });
    }
    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      branchId: input.branchId,
      createdBy: actor.userId,
      receiptId,
      customerId:
        input.partyType === "CUSTOMER" ? (input.partyId ?? null) : null,
      supplierId:
        input.partyType === "SUPPLIER" ? (input.partyId ?? null) : null,
      amount,
      paymentMethod: input.paymentMethod,
      postingIntent: posting.intent,
      postingSourceComponents: posting.sourceComponents,
      // يُفرض قفل الفترة على تاريخ السند الفعلي لا تاريخ اليوم — سند بتاريخ رجعي داخل فترة مُقفَلة
      // كان يمرّ لأن postEntry يأخذ new Date() افتراضاً (تدقيق ١٧/٧: قفل الفترة مخترَق عبر السندات).
      entryDate: new Date(voucherDate),
    });

    // تخصيص السند لفاتورته: الربط قرارُ تخصيصٍ ماليّ لا حاشية توثيقية (انظر invoiceAllocation.ts).
    // بلا هذا كانت الفاتورة تعرض «المدفوع: ٠» فوق سجلّ دفعاتٍ يحوي هذا الإيصال نفسه، و`sales.pay`
    // يشتقّ المتبقّي من `paidAmount` وحده ⇒ يُحصَّل المبلغ مرّةً ثانية بلا أيّ حارس.
    //
    // ⚠️ **يسبق تعديل رصيد الطرف عمداً** (فحص الحمل ٣١/٨/٢٦ — إتمام تقويم ترتيب الأقفال):
    // التخصيص يأخذ `FOR UPDATE` على صفّ الفاتورة، وتعديلُ الرصيد يأخذ X ضمنياً على صفّ العميل.
    // كان الترتيب «عميل ← فاتورة» بينما كل نظائره تأخذ «فاتورة ← عميل» (sale/payment،
    // delivery/dispatch، returnService) ⇒ ABBA بين محاسبٍ يخصّص سنداً على فاتورةٍ حيّة وكاشيرٍ
    // يقبض عليها في اللحظة نفسها. الكتابتان مستقلّتان (التخصيص لا يقرأ العميل ولا يمسّه) فالتبديل
    // لا يغيّر أثراً ماليّاً — ويبقى كلاهما في معاملةٍ واحدة تتراجع كاملةً عند أيّ رمي.
    if (input.partyType === "CUSTOMER" && input.invoiceId != null) {
      await allocateVoucherToInvoiceTx(tx, {
        invoiceId: input.invoiceId,
        amount,
        direction,
        paymentMethod: input.paymentMethod,
      });
    }

    if (input.partyType === "CUSTOMER" && input.partyId) {
      await adjustCustomerBalance(
        tx,
        input.partyId,
        direction === "IN" ? amount.neg() : amount,
      );
    } else if (input.partyType === "SUPPLIER" && input.partyId) {
      await adjustSupplierBalance(tx, input.partyId, amount);
    }

    // البَصمة بَعد كل الكتابات ⇒ تَختم السند بكل عناصره المُستقرّة.
    const hash = computeSignature({
      id: receiptId,
      amount: toDbMoney(amount),
      partyType: input.partyType,
      partyId: input.partyType === "OTHER" ? null : (input.partyId ?? null),
      paymentMethod: input.paymentMethod,
      voucherDate,
      voucherNumber,
      createdBy: actor.userId,
      approvedBy: null, // لا اعتماد مَطلوب
      branchId: input.branchId,
    });
    await tx
      .update(receipts)
      .set({ signatureHash: hash })
      .where(eq(receipts.id, receiptId));
  }

  if (input.clientRequestId) {
    await recordIdempotencyKey(
      tx,
      "voucher.create",
      input.clientRequestId,
      receiptId,
    );
  }

  if (ownerAutoApproves) {
    // الاستيراد الديناميكي يمنع دورة create ⇄ approval وقت تهيئة الوحدات؛ الاعتماد نفسه
    // يجري داخل tx الحالية، لذلك لا يمكن أن يبقى طلب المالك معلّقاً إذا فشل الأثر المالي.
    const { approveVoucherTx } = await import("./approval");
    await approveVoucherTx(tx, receiptId, resolvedActor);
  }

  return {
    receiptId,
    voucherNumber,
    direction,
    approvalStatus:
      needsApproval && !ownerAutoApproves ? "PENDING_APPROVAL" : "APPROVED",
  };
}

/** يعتمد سنداً نظامياً للمالك داخل معاملة الوحدة الأم، بعد اكتمال كل روابط المصدر. */
export async function finalizeOwnerSystemVoucherTx(
  tx: Tx,
  receiptId: number,
  actor: Actor,
): Promise<boolean> {
  const resolvedActor = await resolveApprovalActor(tx, actor);
  if (!resolvedActor.isOwner) return false;
  const { approveVoucherTx } = await import("./approval");
  await approveVoucherTx(tx, receiptId, resolvedActor);
  return true;
}

/** طلب دفع نظامي يعيد استعمال عقد السند الواحد؛ طلب الموظف معلّق، وطلب المالك النشط معتمد تلقائياً. */
export async function createSystemPaymentRequestTx(
  tx: Tx,
  input: Omit<VoucherInput, "voucherType">,
  actor: Actor,
  request: SystemPaymentRequest,
): Promise<VoucherResult> {
  const result = await createVoucherTx(tx, { ...input, voucherType: "PAYMENT" }, actor, {
    systemRequest: request,
  });
  // ن-٢-هـ (Codex ٢٩/٨): إشعارُ المُعتمِدين مركزيّاً هنا — كلّ مسارٍ يُنشئ سنداً
  // PENDING_APPROVAL يُخطر تلقائياً بلا حاجةِ كلِّ مُستدعٍ لتذكّر الوصلة. الهوك يفرغ
  // بعد commit — لا يفرغ على rollback (راجع `tx.ts.drainPostCommitHooks`).
  if (result.approvalStatus === "PENDING_APPROVAL") {
    enqueuePostCommit(tx, () => notifyApprovalPendingByReceipt(result.receiptId));
  }
  return result;
}

/**
 * Canonical accrual-correction refund request. It is always an OTHER receipt,
 * stays PENDING_APPROVAL, and has no cash/journal effect until a second owner
 * validates the locked source obligation in the approval service.
 */
export async function createSystemReceiptRequestTx(
  tx: Tx,
  input: Omit<VoucherInput, "voucherType">,
  actor: Actor,
  request: Extract<SystemPaymentRequest, { kind: "ACCRUAL_CORRECTION_REFUND" }>,
  options?: { deferOwnerAutoApproval?: boolean },
): Promise<VoucherResult> {
  if (
    input.partyType !== "OTHER" ||
    input.partyId != null ||
    input.voucherCategoryId != null ||
    !input.counterpartyName?.trim()
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "طلب استرداد تصحيح الاستحقاق يتطلب طرف OTHER موثقاً بلا فئة يدوية",
    });
  }
  if (!input.attachmentUrl?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرفق دليل استرداد المبلغ إلزامي",
    });
  }
  const result = await createVoucherTx(tx, { ...input, voucherType: "RECEIPT" }, actor, {
    systemRequest: request,
    deferOwnerAutoApproval: options?.deferOwnerAutoApproval,
  });
  // ن-٢-هـ (Codex ٢٩/٨): إشعار مركزيّ لطلب استرداد تصحيح الاستحقاق أيضاً.
  if (result.approvalStatus === "PENDING_APPROVAL") {
    enqueuePostCommit(tx, () => notifyApprovalPendingByReceipt(result.receiptId));
  }
  return result;
}

export async function createVoucher(
  input: VoucherInput,
  actor: Actor,
): Promise<VoucherResult> {
  // الحارس الخارجي يمنع حتى فتح transaction عند إعادة المحاولة غير الموثقة.
  // يبقى الحارس داخل createVoucherTx دفاعاً عن المستدعين الذين يملكون Tx أصلاً.
  if (input.voucherType === "RECEIPT") {
    assertInboundPaymentMethodEnabled(input.paymentMethod);
  }
  return withMysqlDeadlockRetry(() =>
    withTx(async (tx) => {
      const result = await createVoucherTx(tx, input, actor);
      // ن-٢-هـ (Codex ٢٩/٨): مسارُ الراوتر (`vouchers.create`) يمرّ هنا — إشعارٌ
      // مركزيٌّ يُغني عن حاجةِ الراوتر لاستدعاءِ notifier يدوياً.
      if (result.approvalStatus === "PENDING_APPROVAL") {
        enqueuePostCommit(tx, () => notifyApprovalPendingByReceipt(result.receiptId));
      }
      return result;
    })
  );
}

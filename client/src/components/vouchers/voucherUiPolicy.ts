export type VoucherUiRecord = {
  direction?: string | null;
  approvalStatus?: string | null;
  paymentMethod?: string | null;
  cashBucket?: string | null;
  shiftId?: number | null;
};

const RESUBMITTABLE_SYSTEM_PREFIXES = [
  "SHIP-",
  "ASSET-MAINT-",
  "ASSET-ACQ-",
] as const;

export function isAccrualPaymentReference(referenceNumber?: string | null): boolean {
  return !!referenceNumber && RESUBMITTABLE_SYSTEM_PREFIXES.some((prefix) =>
    referenceNumber.startsWith(prefix),
  );
}

export function canShowAccrualPaymentResubmit(input: {
  referenceNumber?: string | null;
  approvalStatus?: string | null;
  resubmitLineageStatus?: "NONE" | "VALID" | "BROKEN" | null;
  canManage: boolean;
}): boolean {
  return input.canManage &&
    input.approvalStatus === "REJECTED" &&
    input.resubmitLineageStatus !== "BROKEN" &&
    isAccrualPaymentReference(input.referenceNumber);
}

export function validAccrualReissueReason(value: string): boolean {
  const reason = value.trim();
  return reason.length >= 5 && reason.length <= 500;
}

export function accrualPaymentResubmitPayload(input: {
  receiptId: number;
  reissueReason: string;
  attachmentUrl?: string | null;
  note?: string | null;
}) {
  const reissueReason = input.reissueReason.trim();
  if (!Number.isSafeInteger(input.receiptId) || input.receiptId <= 0 || !validAccrualReissueReason(reissueReason)) {
    throw new Error("بيانات إعادة إصدار طلب الدفع غير صالحة");
  }
  return {
    receiptId: input.receiptId,
    priorReceiptId: input.receiptId,
    reissueReason,
    attachmentUrl: input.attachmentUrl?.trim() || null,
    note: input.note?.trim() || null,
  };
}

export function accrualPaymentAttemptLabel(input: {
  attempt?: number | null;
  rootReceiptId?: number | null;
  priorReceiptId?: number | null;
}): string | null {
  if (
    input.attempt == null || input.attempt < 1 ||
    input.rootReceiptId == null || input.rootReceiptId < 1 ||
    input.priorReceiptId == null || input.priorReceiptId < 1
  ) return null;
  return `المحاولة A${input.attempt} · الأصل #${input.rootReceiptId} · السابقة #${input.priorReceiptId}`;
}

const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  CHECK: "صكّ",
  TRANSFER: "تحويل مصرفي",
  WALLET: "محفظة",
  EXCHANGE: "صيرفة",
  TELECOM: "رصيد زين",
};

/** تسميات دورة الصرف الجديدة مع إبقاء سندات القبض كما هي. */
export function voucherApprovalLabel(row: VoucherUiRecord): string {
  if (row.approvalStatus === "PENDING_APPROVAL") {
    return row.direction === "OUT"
      ? "بانتظار الاعتماد والصرف"
      : "بانتظار الاعتماد";
  }
  if (row.approvalStatus === "REJECTED") return "مَرفوض";
  if (row.approvalStatus === "APPROVED" || !row.approvalStatus) {
    return row.direction === "OUT" ? "معتمد ومصروف" : "مُعتمَد";
  }
  return row.approvalStatus;
}

/**
 * سياسة عرض فقط. الخادم ملزم بإعادة فحص isOwner وحالة الحساب وفصل الواجبات؛
 * إخفاء الزر هنا لا يُعد حارس صلاحية.
 */
export function canShowVoucherApprovalAction(input: {
  direction?: string | null;
  approvalStatus?: string | null;
  isOwner: boolean;
  canManageLegacyReceipt: boolean;
}): boolean {
  if (input.approvalStatus !== "PENDING_APPROVAL") return false;
  return input.isOwner;
}

/** نفس ملكية قرار الاعتماد لرفض طلب الصرف؛ سند القبض القديم يحتفظ بمساره. */
export function canShowVoucherRejectAction(input: {
  direction?: string | null;
  approvalStatus?: string | null;
  isOwner: boolean;
  canManageLegacyReceipt: boolean;
}): boolean {
  return canShowVoucherApprovalAction(input);
}

/** لا تُطبع وثيقة مالية رسمية قبل أن يصبح السند معتمداً فعلاً. */
export function canPrintOfficialVoucher(row: VoucherUiRecord): boolean {
  return row.approvalStatus === "APPROVED";
}

export function voucherCashUiPolicy(input: {
  direction: "IN" | "OUT";
  paymentMethod: string;
  hasOpenShift: boolean;
  shiftLoading: boolean;
  isElevated: boolean;
}): { hardBlock: boolean; treasuryNotice: boolean } {
  if (input.paymentMethod !== "CASH") {
    return { hardBlock: false, treasuryNotice: false };
  }
  if (input.direction === "OUT") {
    return { hardBlock: false, treasuryNotice: true };
  }
  const needsShift = !input.hasOpenShift && !input.shiftLoading;
  return {
    hardBlock: needsShift && !input.isElevated,
    treasuryNotice: needsShift && input.isElevated,
  };
}

export function expectedVoucherSourceLabel(row: VoucherUiRecord): string {
  if (row.paymentMethod !== "CASH") {
    return (
      METHOD_LABEL[row.paymentMethod ?? ""] ?? row.paymentMethod ?? "غير محدد"
    );
  }
  // عقد الصرف النقدي النهائي: المالك يصرف من الخزينة الإدارية فقط، بلا درج وردية.
  return "الخزينة الإدارية";
}

export function voucherCreateActionLabel(
  direction: "IN" | "OUT",
  pending: boolean,
): string {
  if (pending) return direction === "OUT" ? "جارٍ إرسال الطلب…" : "جارٍ الحفظ…";
  return direction === "OUT" ? "إرسال طلب صرف" : "حفظ سند القبض";
}

export function voucherCreateSuccessMessage(input: {
  direction: "IN" | "OUT";
  voucherNumber: string;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
}): string {
  if (input.direction === "OUT") {
    return `أُرسل طلب الصرف ${input.voucherNumber} — بانتظار اعتماد وصرف المالك.`;
  }
  return input.approvalStatus === "PENDING_APPROVAL"
    ? `أُنشئ السند ${input.voucherNumber} — بانتظار اعتماد مالك نشط آخر (Maker-Checker).`
    : `تَمّ إنشاء سند القبض ${input.voucherNumber}`;
}

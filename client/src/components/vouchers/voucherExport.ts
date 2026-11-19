import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { voucherApprovalLabel } from "@/components/vouchers/voucherUiPolicy";
import {
  printVoucherA4,
  printVoucherReceipt,
  type VoucherPrintData,
} from "@/lib/printing/voucherPrint";
import {
  releaseReservedPrintWindow,
  reservePrintWindow,
} from "@/lib/printing/brand";
import { advanceRefundLinkText } from "@shared/purchasePaymentEvidence";
import type { PrintAuditMetadata } from "@/hooks/usePrintAudit";
import type { PrintOpenResult } from "@shared/printAudit";
import type { ExportColumn } from "@/lib/export";
import type { RouterOutputs } from "@/lib/trpc";

export type VoucherRow = RouterOutputs["vouchers"]["list"][number];
export type VoucherDetailRecord = NonNullable<RouterOutputs["vouchers"]["get"]>;

export function voucherDirectionText(direction: string): string {
  return direction === "IN" ? "قبض" : "صرف";
}

export function voucherPartyKindText(partyType?: string | null): string {
  switch (partyType) {
    case "CUSTOMER":
      return "عميل";
    case "SUPPLIER":
      return "مورّد";
    case "DELIVERY_PARTY":
      return "جهة توصيل";
    default:
      return "أخرى";
  }
}

export function voucherShortHash(h?: string | null): string {
  return h ? String(h).slice(0, 8).toUpperCase() : "—";
}

const NON_PO_SYSTEM_PAYMENT_PREFIXES = [
  "ASSET-ACQ-",
  "ASSET-REACQ-",
  "ASSET-MAINT-",
  "ASSET-SUP-SETTLE-",
  "SHIP-",
  "EXCHANGE-IQD-DEP-",
  "DIGITAL-WALLET-DEP-",
  "CANCEL-VCH-",
  "TERM-SETTLEMENT-",
  "ACCRUAL-REFUND-",
] as const;

export function isPurchaseSupplierVoucherRef(ref?: string | null): boolean {
  return Boolean(ref && (ref.startsWith("PO-PAY-") || ref.startsWith("PO-USD-PAY-")));
}

export function isNonPoVoucherSystemRef(ref?: string | null): boolean {
  if (!ref || isPurchaseSupplierVoucherRef(ref)) return false;
  return NON_PO_SYSTEM_PAYMENT_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

export function voucherPartyStatementHref(
  partyType?: string | null,
  partyId?: number | null,
): string | null {
  if (partyId == null) return null;
  if (partyType === "CUSTOMER") return `/customers-statement?id=${partyId}`;
  if (partyType === "SUPPLIER") return `/suppliers-statement?id=${partyId}`;
  return null;
}

export type VoucherPeriodPreset = "today" | "last7" | "thisMonth" | "lastMonth" | "all";

export function computeVoucherPeriodRange(
  preset: VoucherPeriodPreset,
  now: Date = new Date(),
): { from: string; to: string } {
  if (preset === "all") return { from: "", to: "" };
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  const toYmd = (dt: Date) => dt.toISOString().slice(0, 10);
  if (preset === "today") return { from: today, to: today };
  if (preset === "last7") {
    return { from: toYmd(new Date(Date.UTC(y, m - 1, d - 6))), to: today };
  }
  if (preset === "thisMonth") {
    return { from: toYmd(new Date(Date.UTC(y, m - 1, 1))), to: today };
  }
  return {
    from: toYmd(new Date(Date.UTC(y, m - 2, 1))),
    to: toYmd(new Date(Date.UTC(y, m - 1, 0))),
  };
}

export type ExtendedVoucherPrintData = VoucherPrintData & {
  partyType?: "SUPPLIER" | "CUSTOMER" | "DELIVERY_PARTY" | "OTHER";
  partyBalanceBefore?: string | number | null;
  partyBalanceAfter?: string | number | null;
};

export function toVoucherPrintPayload(
  v: VoucherDetailRecord,
  branchName?: string | null,
): ExtendedVoucherPrintData {
  const extra = v as VoucherDetailRecord & {
    partyBalanceBefore?: string | null;
    partyBalanceAfter?: string | null;
    supplierReceiptPurpose?: string | null;
  };
  const pt = v.partyType === "CUSTOMER" || v.partyType === "SUPPLIER" ? v.partyType : undefined;
  return {
    voucherNumber: v.voucherNumber ?? "",
    direction: v.direction as "IN" | "OUT",
    voucherDate: String(v.voucherDate ?? fmtDate(v.createdAt)).slice(0, 10),
    createdAt: String(v.createdAt),
    branchName: branchName ?? null,
    amount: fmt(v.amount),
    paymentMethod: v.paymentMethod,
    paymentMethodLabel: paymentMethodLabel(v.paymentMethod),
    referenceNumber: v.referenceNumber,
    checkNumber: v.checkNumber,
    cardLastFour: v.cardLastFour,
    partyType: pt,
    partyTypeLabel: voucherPartyKindText(v.partyType),
    partyName: v.partyName ?? v.counterpartyName ?? "—",
    partyBalance: extra.partyBalanceBefore != null ? fmt(extra.partyBalanceBefore) : null,
    partyBalanceBefore: extra.partyBalanceBefore ?? null,
    partyBalanceAfter: extra.partyBalanceAfter ?? null,
    categoryName: v.categoryName,
    description: [v.description, advanceRefundLinkText(v.advanceRefund)]
      .filter(Boolean)
      .join("\n"),
    counterpartyName: v.counterpartyName,
    approvalStatus: v.approvalStatus as
      | "APPROVED"
      | "PENDING_APPROVAL"
      | "REJECTED",
    status: v.status,
    approvedByName: v.approvedByName,
    approvedAt: v.approvedAt ? String(v.approvedAt) : null,
    createdByName: v.createdByName,
    cashBucket: v.cashBucket as "DRAWER" | "TREASURY" | null,
    signatureHash: v.signatureHash,
    attachmentUrl: v.attachmentUrl,
    relatedInvoiceNumber: v.invoiceNumber ?? null,
  };
}

export function listRowToBatchPrintPayload(
  r: VoucherRow,
  ctx: { branchMap: Map<number, string>; categoryMap: Map<number, string> },
): ExtendedVoucherPrintData {
  const extra = r as VoucherRow & {
    approvedByName?: string | null;
    partyBalanceBefore?: string | null;
    partyBalanceAfter?: string | null;
  };
  const pt = r.partyType === "CUSTOMER" || r.partyType === "SUPPLIER" ? r.partyType : undefined;
  return {
    voucherNumber: r.voucherNumber ?? `#${r.id}`,
    direction: r.direction as "IN" | "OUT",
    voucherDate: String(r.voucherDate ?? fmtDate(r.createdAt)).slice(0, 10),
    createdAt: String(r.createdAt),
    branchName:
      r.branchId != null
        ? (ctx.branchMap.get(Number(r.branchId)) ?? null)
        : null,
    amount: fmt(r.amount),
    paymentMethod: r.paymentMethod,
    paymentMethodLabel: paymentMethodLabel(r.paymentMethod),
    referenceNumber: r.referenceNumber,
    checkNumber: r.checkNumber,
    cardLastFour: r.cardLastFour,
    partyType: pt,
    partyTypeLabel: voucherPartyKindText(r.partyType),
    partyName: r.partyName ?? r.counterpartyName ?? "—",
    partyBalance: extra.partyBalanceBefore != null ? fmt(extra.partyBalanceBefore) : null,
    partyBalanceBefore: extra.partyBalanceBefore ?? null,
    partyBalanceAfter: extra.partyBalanceAfter ?? null,
    categoryName: r.voucherCategoryId
      ? (ctx.categoryMap.get(Number(r.voucherCategoryId)) ?? null)
      : null,
    description: r.description ?? "",
    counterpartyName: r.counterpartyName,
    approvalStatus: r.approvalStatus as
      | "APPROVED"
      | "PENDING_APPROVAL"
      | "REJECTED",
    status: r.status,
    approvedByName: extra.approvedByName ?? null,
    approvedAt: r.approvedAt ? String(r.approvedAt) : null,
    createdByName: r.createdByName ?? null,
    cashBucket: r.cashBucket as "DRAWER" | "TREASURY" | null,
    signatureHash: r.signatureHash,
    attachmentUrl: r.attachmentUrl,
    relatedInvoiceNumber: r.invoiceNumber ?? null,
  };
}

export async function printVoucherWithAudit(args: {
  receiptId: number;
  mode: "thermal" | "a4";
  fetchVoucher: (receiptId: number) => Promise<VoucherDetailRecord | null | undefined>;
  branchMap?: Map<number, string>;
  runPrintAudit: (input: {
    documentType: "VOUCHER";
    documentId: number;
    branchId: number | null;
    channel: "BROWSER" | "THERMAL";
    open: (audit: PrintAuditMetadata) => Promise<PrintOpenResult>;
  }) => Promise<unknown>;
  onError: (err: unknown) => void;
}) {
  if (args.mode === "a4" && !reservePrintWindow()) {
    args.onError("تعذر فتح نافذة الطباعة — تحقق من مانع النوافذ المنبثقة");
    return;
  }
  try {
    const v = await args.fetchVoucher(args.receiptId);
    if (!v) {
      if (args.mode === "a4") releaseReservedPrintWindow();
      args.onError("تعذر جلب تفاصيل السند");
      return;
    }
    const branchName =
      v.branchId != null
        ? (args.branchMap?.get(Number(v.branchId)) ?? null)
        : null;
    const payload = toVoucherPrintPayload(v, branchName);
    const result = await args.runPrintAudit({
      documentType: "VOUCHER",
      documentId: args.receiptId,
      branchId: v.branchId == null ? null : Number(v.branchId),
      channel: args.mode === "a4" ? "BROWSER" : "THERMAL",
      open: (audit): Promise<PrintOpenResult> => {
        const auditedPayload = {
          ...payload,
          printedByName: audit.actorName,
          printRequestedAt: String(audit.requestedAt),
        };
        return args.mode === "a4"
          ? printVoucherA4(auditedPayload)
          : printVoucherReceipt(auditedPayload);
      },
    });
    if (typeof result === "boolean" && !result) {
      args.onError("تعذر فتح نافذة الطباعة — تأكد من السماح بالنوافذ المنبثقة.");
    }
  } catch (e) {
    if (args.mode === "a4") releaseReservedPrintWindow();
    args.onError(e);
  }
}

export function getVoucherExportColumns(ctx: {
  branchMap: Map<number, string>;
  categoryMap: Map<number, string>;
}): ExportColumn<VoucherRow>[] {
  return [
    { key: "voucherNumber", header: "رقم السند" },
    {
      key: "voucherDate",
      header: "تاريخ السند",
      map: (r) => fmtDate(r.voucherDate),
    },
    {
      key: "createdAt",
      header: "تاريخ الإدخال",
      map: (r) => fmtDate(r.createdAt),
    },
    {
      key: "branchId",
      header: "الفرع",
      map: (r) =>
        r.branchId != null
          ? (ctx.branchMap.get(Number(r.branchId)) ?? String(r.branchId))
          : "—",
    },
    {
      key: "direction",
      header: "النوع",
      map: (r) => voucherDirectionText(r.direction),
    },
    {
      key: "partyType",
      header: "نوع الطرف",
      map: (r) => voucherPartyKindText(r.partyType),
    },
    {
      key: "partyName",
      header: "اسم الطرف",
      map: (r) => r.partyName ?? r.counterpartyName ?? "",
    },
    {
      key: "createdByName",
      header: "المنفذ",
      map: (r) =>
        r.createdByName ??
        (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق"),
    },
    {
      key: "voucherCategoryId",
      header: "الفئة",
      map: (r) =>
        r.voucherCategoryId
          ? (ctx.categoryMap.get(Number(r.voucherCategoryId)) ?? "—")
          : "—",
    },
    { key: "description", header: "الوصف" },
    {
      key: "amount",
      header: "المبلغ",
      map: (r) => fmt(r.amount ?? "0"),
    },
    {
      key: "paymentMethod",
      header: "الدفع",
      map: (r) => paymentMethodLabel(r.paymentMethod),
    },
    { key: "referenceNumber", header: "الرقم المرجعي" },
    { key: "checkNumber", header: "مرجع التحويل/الصك" },
    { key: "cardLastFour", header: "آخر 4 بطاقة" },
    {
      key: "approvalStatus",
      header: "حالة الاعتماد",
      map: (r) => voucherApprovalLabel(r),
    },
    {
      key: "status",
      header: "الحالة",
      map: (r) => (r.status === "REVERSED" ? "ملغى" : "مكتمل"),
    },
    {
      key: "attachmentUrl",
      header: "مرفق",
      map: (r) => (r.attachmentUrl ? "نعم" : "لا"),
    },
    {
      key: "invoiceNumber",
      header: "الفاتورة المرتبطة",
      map: (r) => r.invoiceNumber ?? "—",
    },
    {
      key: "signatureHash",
      header: "بصمة",
      map: (r) => voucherShortHash(r.signatureHash),
    },
    {
      key: "cashBucket",
      header: "نوع النقد",
      map: (r) =>
        r.cashBucket === "DRAWER"
          ? "درج كاشير"
          : r.cashBucket === "TREASURY"
            ? "خزينة إدارية"
            : "—",
    },
    {
      key: "resubmitAttempt",
      header: "محاولة إعادة الإصدار",
      map: (r) =>
        r.resubmitAttempt == null ? "—" : `A${r.resubmitAttempt}`,
    },
    {
      key: "resubmitRootReceiptId",
      header: "سند أصل السلسلة",
      map: (r) => r.resubmitRootReceiptId ?? "—",
    },
    {
      key: "resubmitPriorReceiptId",
      header: "السند السابق",
      map: (r) => r.resubmitPriorReceiptId ?? "—",
    },
    {
      key: "resubmitReason",
      header: "سبب إعادة الإصدار",
      map: (r) => r.resubmitReason ?? "—",
    },
  ];
}

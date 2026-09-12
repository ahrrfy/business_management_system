import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { voucherApprovalLabel } from "@/components/vouchers/voucherUiPolicy";
import type { ExportColumn } from "@/lib/export";
import type { RouterOutputs } from "@/lib/trpc";

type VoucherRow = RouterOutputs["vouchers"]["list"][number];

const TYPE_LABEL: Record<string, string> = { IN: "قبض", OUT: "صرف" };
const PARTY_LABEL: Record<string, string> = {
  CUSTOMER: "عميل",
  SUPPLIER: "مورّد",
  DELIVERY_PARTY: "جهة توصيل",
  OTHER: "أخرى",
};

function shortHash(h?: string | null): string {
  return h ? String(h).slice(0, 8).toUpperCase() : "—";
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
      map: (r) => TYPE_LABEL[r.direction] ?? r.direction,
    },
    {
      key: "partyType",
      header: "نوع الطرف",
      map: (r) => PARTY_LABEL[r.partyType ?? "OTHER"] ?? "—",
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
    { key: "checkNumber", header: "مرجع التحويل/الصكّ" },
    { key: "cardLastFour", header: "آخر ٤ بطاقة" },
    {
      key: "approvalStatus",
      header: "حالة الاعتماد",
      map: (r) => voucherApprovalLabel(r),
    },
    {
      key: "status",
      header: "الحالة",
      map: (r) => (r.status === "REVERSED" ? "مُلغى" : "مكتمل"),
    },
    {
      key: "attachmentUrl",
      header: "مُرفَق؟",
      map: (r) => (r.attachmentUrl ? "نعم" : "لا"),
    },
    {
      key: "invoiceNumber",
      header: "الفاتورة المرتبطة",
      map: (r) => r.invoiceNumber ?? "—",
    },
    {
      key: "signatureHash",
      header: "بَصمة",
      map: (r) => shortHash(r.signatureHash),
    },
    {
      key: "cashBucket",
      header: "نوع النَقد",
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

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/DataTable";
import { D, fmt } from "@/lib/money";
import { voucherApprovalLabel } from "./voucherUiPolicy";
import { Link } from "wouter";
import {
  advanceRefundLinkText,
  type PurchaseAdvanceRefundLinks,
} from "@shared/purchasePaymentEvidence";

type SavedAllocation = {
  supplierInvoiceId: number;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
};
type SavedSettlement = {
  status: string;
  allocations: readonly SavedAllocation[];
};
const columns: ColumnDef<SavedAllocation, unknown>[] = [
  {
    id: "invoice",
    header: "فاتورة المورّد",
    accessorFn: (row) => row.invoiceNumber,
    enableSorting: false,
    cell: ({ row }) => row.original.invoiceNumber,
  },
  {
    id: "date",
    header: "تاريخ الفاتورة",
    meta: { kind: "date" },
    enableSorting: false,
    cell: ({ row }) => row.original.invoiceDate.slice(0, 10),
  },
  {
    id: "amount",
    header: "مبلغ التسوية د.ع",
    meta: { kind: "money" },
    enableSorting: false,
    cell: ({ row }) => fmt(row.original.amount),
  },
];

/** Displays only the settlement persisted by the server; it never proposes or edits allocations. */
function NativeSettlementSummary({
  settlement,
}: {
  settlement: SavedSettlement | null | undefined;
}) {
  if (!settlement) return null;
  const status = voucherApprovalLabel({
    direction: "OUT",
    approvalStatus:
      settlement.status === "PENDING" ? "PENDING_APPROVAL" : settlement.status,
  });
  return (
    <section
      dir="rtl"
      aria-label="تسوية فواتير المورد المحفوظة"
      className="space-y-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-semibold">تسوية فواتير المورّد</span>
        <span>{status}</span>
      </div>
      <DataTable<SavedAllocation>
        embedded
        searchable={false}
        bounded={false}
        pageSize={Infinity}
        columns={columns}
        data={[...settlement.allocations]}
        mobileCardRenderer={(allocation) => (
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold">{allocation.invoiceNumber}</span>
              <span dir="ltr" className="tabular-nums">
                {fmt(allocation.amount)} د.ع
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              تاريخ الفاتورة:{" "}
              <span dir="ltr" className="inline-block">
                {allocation.invoiceDate.slice(0, 10)}
              </span>
            </p>
          </div>
        )}
        emptyText="لا توجد فواتير مرتبطة بهذا السند."
      />
    </section>
  );
}

type BookAllocation = {
  id: number;
  targetKind?: string;
  openingEntryId?: number | null;
  invoiceNumber: string | null;
  targetDate?: string | null;
  invoiceDate?: string | null;
  accountingEntryId?: number;
  amount: string;
  reversedAmount: string;
  currency: string | null;
  currencyAmount: string;
  reversedCurrencyAmount?: string;
};
type BookSettlement = {
  kind: "BOOK";
  unallocatedAmount?: string;
  status: string;
  accountingEntryId: number;
  allocations: readonly BookAllocation[];
  credits: readonly BookAllocation[];
};
const targetLabel = (row: BookAllocation) =>
  row.targetKind === "OPENING"
    ? `رصيد افتتاحي #${row.openingEntryId}`
    : (row.invoiceNumber ?? "فاتورة مورد");
const bookColumns: ColumnDef<BookAllocation, unknown>[] = [
  {
    id: "target",
    header: "هدف التسوية",
    enableSorting: false,
    cell: ({ row }) => targetLabel(row.original),
  },
  {
    id: "date",
    header: "تاريخ الالتزام",
    enableSorting: false,
    cell: ({ row }) =>
      (row.original.targetDate ?? row.original.invoiceDate)?.slice(0, 10) ??
      "—",
  },
  {
    id: "amount",
    header: "المخصص د.ع",
    meta: { kind: "money" },
    enableSorting: false,
    cell: ({ row }) => fmt(row.original.amount),
  },
  {
    id: "reversed",
    header: "المعكوس د.ع",
    meta: { kind: "money" },
    enableSorting: false,
    cell: ({ row }) => fmt(row.original.reversedAmount),
  },
  {
    id: "net",
    header: "الصافي د.ع",
    meta: { kind: "money" },
    enableSorting: false,
    cell: ({ row }) =>
      fmt(D(row.original.amount).minus(row.original.reversedAmount).toFixed(2)),
  },
  {
    id: "currency",
    header: "صافي كمية عملة الفاتورة",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.currency
        ? `${fmt(
            D(row.original.currencyAmount)
              .minus(row.original.reversedCurrencyAmount ?? 0)
              .toFixed(2),
          )} ${row.original.currency}`
        : "—",
  },
  {
    id: "entry",
    header: "القيد المرجعي",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.accountingEntryId
        ? `#${row.original.accountingEntryId}`
        : "—",
  },
];
function BookRows({ rows }: { rows: readonly BookAllocation[] }) {
  return (
    <DataTable<BookAllocation>
      embedded
      searchable={false}
      bounded={false}
      pageSize={Infinity}
      columns={bookColumns}
      data={[...rows]}
      mobileCardRenderer={(row) => (
        <div className="space-y-1 text-sm">
          <p>{targetLabel(row)}</p>
          <p>
            {fmt(row.amount)} د.ع · المعكوس {fmt(row.reversedAmount)} د.ع
          </p>
          <p>
            صافي كمية عملة الفاتورة:{" "}
            {row.currency
              ? `${fmt(
                  D(row.currencyAmount)
                    .minus(row.reversedCurrencyAmount ?? 0)
                    .toFixed(2),
                )} ${row.currency}`
              : "—"}
          </p>
          {row.accountingEntryId && (
            <p>القيد المرجعي #{row.accountingEntryId}</p>
          )}
        </div>
      )}
    />
  );
}

export function SupplierVoucherSettlementSummary({
  settlement,
  bookSettlement,
  advanceRefund,
}: {
  settlement: SavedSettlement | null | undefined;
  bookSettlement?: BookSettlement | null;
  advanceRefund?: PurchaseAdvanceRefundLinks | null;
}) {
  const refundText = advanceRefundLinkText(advanceRefund);
  if (!settlement && !bookSettlement && !refundText) return null;
  return (
    <>
      {advanceRefund && refundText ? (
        <section
          dir="rtl"
          aria-label="ترابط استرداد الدفعة السابقة"
          className="space-y-2 rounded-md border p-3 text-sm"
        >
          <p className="font-semibold">{refundText}</p>
          {advanceRefund.kind !== "ADVANCE_SOURCE" ? (
            <p>
              الدفعة الأصلية:{" "}
              <Link
                className="text-primary underline"
                href={`/treasury?tab=vouchers&voucherId=${advanceRefund.sourceReceiptId}`}
              >
                سند #{advanceRefund.sourceReceiptId}
              </Link>
            </p>
          ) : null}
          {advanceRefund.kind === "ADVANCE_REFUND_CANCELLATION" &&
          advanceRefund.refundedReceiptId ? (
            <p>
              سند الاسترداد:{" "}
              <Link
                className="text-primary underline"
                href={`/treasury?tab=vouchers&voucherId=${advanceRefund.refundedReceiptId}`}
              >
                سند #{advanceRefund.refundedReceiptId}
              </Link>
            </p>
          ) : null}
          {advanceRefund.refundReceiptIds.length ? (
            <p>
              سندات الاسترداد:{" "}
              {advanceRefund.refundReceiptIds.map((id) => (
                <Link
                  key={id}
                  className="ms-2 text-primary underline"
                  href={`/treasury?tab=vouchers&voucherId=${id}`}
                >
                  #{id}
                </Link>
              ))}
            </p>
          ) : null}
          {advanceRefund.cancellationReceiptIds.length ? (
            <p>
              عكس الاسترداد:{" "}
              {advanceRefund.cancellationReceiptIds.map((id) => (
                <Link
                  key={id}
                  className="ms-2 text-primary underline"
                  href={`/treasury?tab=vouchers&voucherId=${id}`}
                >
                  #{id}
                </Link>
              ))}
            </p>
          ) : null}
        </section>
      ) : null}
      <NativeSettlementSummary settlement={settlement} />
      {bookSettlement && (
        <section
          dir="rtl"
          aria-label="التسوية الدفترية للسند الأصلي"
          className="space-y-2 rounded-md border p-3"
        >
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <span className="font-semibold">التسوية الدفترية للسند الأصلي</span>
            <span>
              {bookSettlement.status === "REVERSED"
                ? "معكوسة"
                : bookSettlement.status === "PARTIALLY_REVERSED"
                  ? "عكس جزئي"
                  : "مثبتة"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            القيد الأصلي #{bookSettlement.accountingEntryId} · كميات العملة تخص
            رصيد الفاتورة الدفتري.
          </p>
          <BookRows rows={bookSettlement.allocations} />
          {D(bookSettlement.unallocatedAmount ?? "0").gt(0) ? (
            <p className="text-sm font-medium">
              رصيد دفعة سابقة متاح للتخصيص:{" "}
              {fmt(bookSettlement.unallocatedAmount!)} د.ع
            </p>
          ) : null}
          {bookSettlement.credits.length > 0 && (
            <div className="space-y-2 border-t pt-2">
              <p className="text-sm font-semibold">
                تخفيضات دفترية مستقلة على الفواتير
              </p>
              <p className="text-xs text-muted-foreground">
                هذه التخفيضات تخص قيود الائتمان الخاصة بها ولا تمثل صرفاً من هذا
                السند.
              </p>
              <BookRows rows={bookSettlement.credits} />
            </div>
          )}
        </section>
      )}
    </>
  );
}

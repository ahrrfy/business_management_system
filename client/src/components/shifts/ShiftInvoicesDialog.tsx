import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import { fmtDateTime } from "@/lib/date";
import { fmt, D } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { Link } from "wouter";
import type { RouterOutputs } from "@/lib/trpc";

type ShiftInvoiceRow = RouterOutputs["sales"]["list"][number];

const fmtDT = (d: string | number | Date | null | undefined) => fmtDateTime(d);

export interface ShiftInvoicesDialogProps {
  invoicesShiftId: number | null;
  invoicesShiftRowUserName?: string | null;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  invoices: ShiftInvoiceRow[];
  onRetry: () => void;
  onClose: () => void;
}

export function ShiftInvoicesDialog({
  invoicesShiftId,
  invoicesShiftRowUserName,
  isLoading,
  isError,
  errorMessage,
  invoices,
  onRetry,
  onClose,
}: ShiftInvoicesDialogProps) {
  return (
    <Dialog
      open={invoicesShiftId != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            فواتير وردية #{invoicesShiftId} —{" "}
            {invoicesShiftRowUserName ?? ""}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <LoadingState />
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {invoices.length} فاتورة — الإجمالي{" "}
              <b className="tabular-nums" dir="ltr">
                {fmt(
                  invoices
                    .reduce((s, r) => s.plus(D(r.total)), D(0))
                    .toString(),
                )}
              </b>{" "}
              د.ع
            </div>
            <DataTable<ShiftInvoiceRow>
              embedded
              searchable={false}
              pageSize={Infinity}
              maxHeightClass="max-h-[60vh]"
              data={invoices}
              errorState={{
                isError,
                message: errorMessage,
                onRetry,
              }}
              emptyText="لا فواتير على هذه الوردية."
              columns={[
                {
                  id: "invoiceNumber",
                  header: "رقم الفاتورة",
                  accessorFn: (inv) => inv.invoiceNumber,
                  meta: { kind: "code" },
                  cell: ({ row }) => <span className="font-medium">{row.original.invoiceNumber}</span>,
                },
                {
                  id: "invoiceDate",
                  header: "الوقت",
                  accessorFn: (inv) => fmtDT(inv.invoiceDate),
                  meta: { kind: "datetime" },
                  cell: ({ row }) => <span className="text-xs">{fmtDT(row.original.invoiceDate)}</span>,
                },
                {
                  id: "paymentMethod",
                  header: "طريقة الدفع",
                  accessorFn: (inv) => (inv.paymentMethod ? paymentMethodLabel(inv.paymentMethod) : "—"),
                  cell: ({ row }) => (
                    <span className="text-xs">
                      {row.original.paymentMethod ? paymentMethodLabel(row.original.paymentMethod) : "—"}
                    </span>
                  ),
                },
                {
                  id: "total",
                  header: "الإجمالي",
                  accessorFn: (inv) => fmt(inv.total),
                  meta: { kind: "money" },
                  cell: ({ row }) => fmt(row.original.total),
                },
                {
                  id: "paidAmount",
                  header: "المدفوع",
                  accessorFn: (inv) => fmt(inv.paidAmount),
                  meta: { kind: "money" },
                  cell: ({ row }) => fmt(row.original.paidAmount),
                },
                {
                  id: "status",
                  header: "الحالة",
                  accessorFn: (inv) => invoiceStatusLabel(inv.status),
                  meta: { kind: "status" },
                  cell: ({ row }) => <span className="text-xs">{invoiceStatusLabel(row.original.status)}</span>,
                },
                {
                  id: "open",
                  header: "فتح",
                  enableSorting: false,
                  meta: { kind: "actions" },
                  cell: ({ row }) => (
                    <Link href={`/invoices/${row.original.id}`} className="text-primary underline-offset-2 hover:underline">
                      فتح
                    </Link>
                  ),
                },
              ]}
            />
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

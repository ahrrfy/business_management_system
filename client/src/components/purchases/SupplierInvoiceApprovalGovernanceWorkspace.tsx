import { useMemo, useState } from "react";
import { ExternalLink, Eye, FileWarning, RotateCcw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "wouter";
import { ACTION_LABELS } from "@shared/actionLabels";
import { DataTable } from "@/components/data-table/DataTable";
import {
  GovernanceApprovalQueue,
  type GovernanceQueueRow,
} from "./GovernanceApprovalQueue";
import { GovernanceRequestNotice } from "./GovernanceRequestNotice";
import { SupplierInvoiceDetailDrawer } from "./SupplierInvoiceDetailDrawer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { cn } from "@/lib/utils";
import { newGovernanceKey } from "./purchaseGovernanceUiPolicy";

export type SupplierInvoiceListRow = {
  id: number;
  invoiceNumber: string;
  externalInvoiceNumber: string | null;
  version: number;
  status: "DRAFT" | "ON_HOLD" | "MATCHED" | "POSTED" | "REVERSED";
  supplierId?: number;
  supplierName?: string;
  supplierPhone?: string | null;
  purchaseOrderId?: number | null;
  purchaseOrderNumber?: string | null;
  settlementType?: "CASH" | "CREDIT" | null;
  createdByName?: string | null;
  postedByName?: string | null;
  postedAt?: string | Date | null;
  totalAmount: string;
  subtotal?: string | null;
  discountAmount?: string | null;
  taxAmount?: string | null;
  currency?: string;
  dueDate?: string | Date | null;
  invoiceDate: string | Date;
};

const STATUS_LABEL: Record<SupplierInvoiceListRow["status"], string> = {
  DRAFT: "مسودة",
  ON_HOLD: "محجوزة",
  MATCHED: "مطابقة — بانتظار الترحيل",
  POSTED: "مرحلة",
  REVERSED: "معكوسة",
};

const STATUS_CLASS: Record<SupplierInvoiceListRow["status"], string> = {
  DRAFT: "badge-status-pending",
  ON_HOLD: "badge-status-warning",
  MATCHED: "badge-status-info",
  POSTED: "badge-status-active",
  REVERSED: "badge-status-cancelled",
};

export function SupplierInvoiceApprovalGovernanceWorkspace({
  invoices,
  pendingApprovals,
  currentUserId,
  isOwner,
  documentsLoading,
  documentsError,
  onRetryDocuments,
  pendingLoading,
  pendingError,
  onRetryPending,
  requestPending,
  decisionPending,
  onRequestReversal,
  onDecideApproval,
}: {
  invoices: SupplierInvoiceListRow[];
  pendingApprovals: GovernanceQueueRow[];
  currentUserId: number | null | undefined;
  isOwner?: boolean;
  documentsLoading: boolean;
  documentsError?: unknown;
  onRetryDocuments: () => void;
  pendingLoading: boolean;
  pendingError?: unknown;
  onRetryPending: () => void;
  requestPending: boolean;
  decisionPending: boolean;
  onRequestReversal: (input: {
    supplierInvoiceId: number;
    expectedInvoiceVersion: number;
    requestKey: string;
    reason: string;
    evidenceReference: string;
  }) => Promise<unknown>;
  onDecideApproval: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
}) {
  const [target, setTarget] = useState<SupplierInvoiceListRow | null>(null);
  const [detailInvoiceId, setDetailInvoiceId] = useState<number | null>(null);
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [settlementFilter, setSettlementFilter] = useState<string>("ALL");

  const requestValid =
    target != null && evidenceReference.trim().length > 0 && reason.trim().length >= 3;

  function close() {
    if (requestPending) return;
    setTarget(null);
    setEvidenceReference("");
    setReason("");
  }

  async function submit() {
    if (!requestValid || !target) return;
    try {
      await onRequestReversal({
        supplierInvoiceId: target.id,
        expectedInvoiceVersion: target.version,
        requestKey: newGovernanceKey(`supplier-invoice-reversal-${target.id}`),
        reason: reason.trim(),
        evidenceReference: evidenceReference.trim(),
      });
      close();
    } catch {
      // يبقى الحوار مفتوحاً لإعادة المحاولة.
    }
  }

  const filteredInvoices = useMemo(() => {
    return invoices.filter((row) => {
      if (statusFilter !== "ALL" && row.status !== statusFilter) return false;
      if (settlementFilter !== "ALL" && row.settlementType !== settlementFilter) return false;
      return true;
    });
  }, [invoices, statusFilter, settlementFilter]);

  const columns = useMemo<ColumnDef<SupplierInvoiceListRow, unknown>[]>(
    () => [
      {
        accessorKey: "invoiceNumber",
        header: "رقم الفاتورة",
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <div className="font-mono font-semibold" dir="ltr">
              {row.original.invoiceNumber}
            </div>
            {row.original.externalInvoiceNumber && (
              <div className="text-[11px] text-muted-foreground font-mono" dir="ltr">
                فاتورة المورد: {row.original.externalInvoiceNumber}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "supplierName",
        header: "المورد",
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <div className="font-medium text-foreground">{row.original.supplierName ?? "—"}</div>
            {row.original.supplierPhone && (
              <div className="text-[11px] text-muted-foreground font-mono" dir="ltr">
                {row.original.supplierPhone}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "purchaseOrderNumber",
        header: "أمر الشراء",
        cell: ({ row }) =>
          row.original.purchaseOrderNumber ? (
            <Link
              href={`/purchases/${row.original.purchaseOrderId ?? ""}`}
              className="font-mono text-xs text-primary font-medium hover:underline inline-flex items-center gap-1"
            >
              <span>{row.original.purchaseOrderNumber}</span>
              <ExternalLink aria-hidden className="size-3" />
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "settlementType",
        header: "طريقة السداد",
        cell: ({ row }) => {
          if (row.original.settlementType === "CASH") {
            return (
              <span className="px-2 py-0.5 text-xs rounded-md font-medium badge-status-active">
                نقدي
              </span>
            );
          }
          if (row.original.settlementType === "CREDIT") {
            return (
              <span className="px-2 py-0.5 text-xs rounded-md font-medium badge-status-pending">
                آجل
              </span>
            );
          }
          return <span className="text-muted-foreground">—</span>;
        },
      },
      {
        accessorKey: "invoiceDate",
        header: "التاريخ",
        cell: ({ row }) => (
          <div className="space-y-0.5 text-xs">
            <div className="font-mono">{fmtDate(row.original.invoiceDate)}</div>
            {row.original.dueDate && (
              <div className="text-[11px] text-muted-foreground font-mono">
                الاستحقاق: {fmtDate(row.original.dueDate)}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "totalAmount",
        header: "المبلغ",
        cell: ({ row }) => (
          <span dir="ltr" className="font-mono font-semibold">
            {fmt(row.original.totalAmount)} {row.original.currency === "USD" ? "$" : "د.ع"}
          </span>
        ),
      },
      {
        accessorKey: "createdByName",
        header: "المنفذ",
        cell: ({ row }) => (
          <div className="space-y-0.5 text-xs">
            <div>أنشأها: {row.original.createdByName ?? "—"}</div>
            {row.original.postedByName && (
              <div className="text-[11px] text-muted-foreground">
                رحلها: {row.original.postedByName}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "الحالة",
        cell: ({ row }) => (
          <span
            className={cn(
              "px-2 py-0.5 text-xs rounded-md font-medium",
              STATUS_CLASS[row.original.status] ?? "bg-muted",
            )}
          >
            {STATUS_LABEL[row.original.status] ?? row.original.status}
          </span>
        ),
      },
      {
        id: "actions",
        header: "الإجراء",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2 gap-1 text-xs"
              onClick={() => setDetailInvoiceId(row.original.id)}
            >
              <Eye aria-hidden className="size-3.5" />
              <span>تفاصيل</span>
            </Button>
            {row.original.status === "POSTED" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-2 text-xs"
                onClick={() => setTarget(row.original)}
              >
                طلب عكس
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <FileWarning aria-hidden className="size-4" />
              فواتير الموردين
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={documentsLoading}
              onClick={onRetryDocuments}
            >
              <RotateCcw aria-hidden className="size-4" />
              {ACTION_LABELS.refresh}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <GovernanceRequestNotice>
            الترحيل الاعتيادي يتم تلقائياً عند اعتماد أمر الشراء المكتمل الاستلام والمطابق. هذه
            الشاشة تمكنك من استعراض تفاصيل الفواتير، وفحص القيود، أو طلب عكس فاتورة مرحلة لاعتمادها
            بشكل ذري ومستقل.
          </GovernanceRequestNotice>

          <div className="flex flex-wrap items-center gap-3 pt-1 pb-1">
            <div className="flex items-center gap-2">
              <Label htmlFor="filter-status" className="text-xs text-muted-foreground whitespace-nowrap">
                الحالة:
              </Label>
              <AppSelect
                id="filter-status"
                value={statusFilter}
                onValueChange={setStatusFilter}
                className="w-40 h-8 text-xs"
              >
                <option value="ALL">جميع الحالات</option>
                <option value="POSTED">مرحلة</option>
                <option value="DRAFT">مسودة</option>
                <option value="MATCHED">مطابقة</option>
                <option value="ON_HOLD">محجوزة</option>
                <option value="REVERSED">معكوسة</option>
              </AppSelect>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="filter-settlement" className="text-xs text-muted-foreground whitespace-nowrap">
                طريقة السداد:
              </Label>
              <AppSelect
                id="filter-settlement"
                value={settlementFilter}
                onValueChange={setSettlementFilter}
                className="w-36 h-8 text-xs"
              >
                <option value="ALL">جميع الطرق</option>
                <option value="CASH">نقدي</option>
                <option value="CREDIT">آجل</option>
              </AppSelect>
            </div>
          </div>

          {documentsError ? (
            <p role="alert" className="text-sm text-destructive">
              تعذر تحميل فواتير الموردين. أعد المحاولة.
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={filteredInvoices}
            loading={documentsLoading}
            searchable
            searchPlaceholder="بحث برقم الفاتورة أو المورد"
            emptyText="لا توجد فواتير موردين مطابقة للبحث."
          />
        </CardContent>
      </Card>

      <GovernanceApprovalQueue
        title="طلبات عكس فواتير الموردين"
        scope="supplier-invoice-reversal"
        rows={pendingApprovals}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={pendingLoading}
        error={pendingError}
        pending={decisionPending}
        onRetry={onRetryPending}
        onDecide={onDecideApproval}
      />

      <SupplierInvoiceDetailDrawer
        supplierInvoiceId={detailInvoiceId}
        open={detailInvoiceId != null}
        onClose={() => setDetailInvoiceId(null)}
        onRequestReversal={(invoice) => {
          setDetailInvoiceId(null);
          setTarget({
            id: Number(invoice.id),
            invoiceNumber: invoice.invoiceNumber,
            externalInvoiceNumber: invoice.externalInvoiceNumber,
            version: Number(invoice.version),
            status: invoice.status as any,
            supplierId: Number(invoice.supplierId),
            supplierName: invoice.supplierName,
            supplierPhone: invoice.supplierPhone,
            purchaseOrderId: invoice.purchaseOrderId,
            purchaseOrderNumber: invoice.purchaseOrderNumber,
            settlementType: invoice.settlementType,
            createdByName: invoice.createdByName,
            postedByName: invoice.postedByName,
            postedAt: invoice.postedAt,
            totalAmount: invoice.totalAmount,
            subtotal: invoice.subtotal,
            discountAmount: invoice.discountAmount,
            taxAmount: invoice.taxAmount,
            currency: invoice.currency,
            dueDate: invoice.dueDate,
            invoiceDate: invoice.invoiceDate,
          });
        }}
      />

      <Dialog open={target != null} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب عكس فاتورة {target?.invoiceNumber}</DialogTitle>
            <DialogDescription>
              الطلب لا يغير القيود أو ذمة المورد حتى يعتمده مستخدم مستقل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="supplier-invoice-reversal-evidence">مرجع الدليل</Label>
              <Input
                id="supplier-invoice-reversal-evidence"
                value={evidenceReference}
                maxLength={500}
                onChange={(event) => setEvidenceReference(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="supplier-invoice-reversal-reason">السبب</Label>
              <Textarea
                id="supplier-invoice-reversal-reason"
                value={reason}
                rows={4}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={requestPending} onClick={close}>
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={requestPending}
              pendingText={ACTION_LABELS.sending}
              disabled={!requestValid}
              onClick={() => void submit()}
            >
              إرسال طلب العكس للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

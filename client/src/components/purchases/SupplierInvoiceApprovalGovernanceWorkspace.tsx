import { useMemo, useState } from "react";
import { FileWarning, RotateCcw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { ACTION_LABELS } from "@shared/actionLabels";
import { DataTable } from "@/components/data-table/DataTable";
import {
  GovernanceApprovalQueue,
  type GovernanceQueueRow,
} from "./GovernanceApprovalQueue";
import { GovernanceRequestNotice } from "./GovernanceRequestNotice";
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
import { fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { newGovernanceKey } from "./purchaseGovernanceUiPolicy";

export type SupplierInvoiceListRow = {
  id: number;
  invoiceNumber: string;
  externalInvoiceNumber: string | null;
  version: number;
  status: "DRAFT" | "ON_HOLD" | "MATCHED" | "POSTED" | "REVERSED";
  totalAmount: string;
  invoiceDate: string | Date;
};

const STATUS_LABEL: Record<SupplierInvoiceListRow["status"], string> = {
  DRAFT: "مسودّة",
  ON_HOLD: "محجوزة",
  MATCHED: "مطابَقة — بانتظار الترحيل الآلي",
  POSTED: "مرحّلة",
  REVERSED: "معكوسة",
};

export function SupplierInvoiceApprovalGovernanceWorkspace({
  invoices,
  pendingApprovals,
  currentUserId,
  isOwner,
  loading,
  error,
  onRetry,
  requestPending,
  decisionPending,
  onRequestReversal,
  onDecideApproval,
}: {
  invoices: SupplierInvoiceListRow[];
  pendingApprovals: GovernanceQueueRow[];
  currentUserId: number | null | undefined;
  isOwner?: boolean;
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
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
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");
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

  const columns = useMemo<ColumnDef<SupplierInvoiceListRow, unknown>[]>(
    () => [
      {
        accessorKey: "invoiceNumber",
        header: "رقم الفاتورة",
        cell: ({ row }) => <bdi dir="ltr">{row.original.invoiceNumber}</bdi>,
      },
      {
        accessorKey: "externalInvoiceNumber",
        header: "رقم فاتورة المورّد",
        cell: ({ row }) => (
          <bdi dir="ltr">{row.original.externalInvoiceNumber || "—"}</bdi>
        ),
      },
      {
        accessorKey: "invoiceDate",
        header: "التاريخ",
        cell: ({ row }) => fmtDate(row.original.invoiceDate),
      },
      {
        accessorKey: "totalAmount",
        header: "المبلغ",
        cell: ({ row }) => (
          <span dir="ltr" className="font-semibold">
            {fmt(row.original.totalAmount)} د.ع
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "الحالة",
        cell: ({ row }) => STATUS_LABEL[row.original.status],
      },
      {
        id: "actions",
        header: "الإجراء",
        cell: ({ row }) =>
          row.original.status === "POSTED" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setTarget(row.original)}
            >
              طلب عكس
            </Button>
          ) : (
            "—"
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
              disabled={loading}
              onClick={onRetry}
            >
              <RotateCcw aria-hidden className="size-4" />
              {ACTION_LABELS.refresh}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <GovernanceRequestNotice>
            الترحيل الاعتياديّ يتمّ تلقائياً عند اعتماد أمر الشراء المكتمل الاستلام. هذه
            الشاشة لعكس فاتورةٍ مرحَّلة فقط — قيدٌ عكسيّ يمحو التزام الذمّة، ويحتاج اعتماداً
            مستقلاً قبل أي أثر، ولا يُتاح إن كان عليها سدادٌ أو مرتجعٌ مرتبط لم يُسوَّ.
          </GovernanceRequestNotice>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              تعذّر تحميل فواتير الموردين. أعد المحاولة.
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={invoices}
            loading={loading}
            searchable
            searchPlaceholder="بحث برقم الفاتورة"
            emptyText="لا توجد فواتير موردين بعد."
          />
        </CardContent>
      </Card>

      <GovernanceApprovalQueue
        title="طلبات عكس فواتير الموردين"
        scope="supplier-invoice-reversal"
        rows={pendingApprovals}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={loading}
        error={error}
        pending={decisionPending}
        onRetry={onRetry}
        onDecide={onDecideApproval}
      />

      <Dialog open={target != null} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب عكس فاتورة {target?.invoiceNumber}</DialogTitle>
            <DialogDescription>
              الطلب لا يغيّر القيود أو ذمّة المورّد حتى يعتمده مستخدمٌ مستقل.
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

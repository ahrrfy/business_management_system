import { useEffect, useMemo, useState } from "react";
import { FileWarning } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import type { GovernanceQueueRow } from "@/components/purchases/GovernanceApprovalQueue";
import {
  SupplierInvoiceApprovalGovernanceWorkspace,
  type SupplierInvoiceListRow,
} from "@/components/purchases/SupplierInvoiceApprovalGovernanceWorkspace";
import { governanceDecisionMessage } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { AppSelect } from "@/components/ui/AppSelect";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export default function SupplierInvoiceApprovalGovernance() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  // ⭐ (مراجعة Codex على #1001) عبورُ الفروع صلاحيّةٌ، لا غيابُ فرعٍ رئيسيّ — طابِق
  // Purchases.tsx وGoodsReceiptReversalGovernance.tsx.
  const canCrossBranches = me.data?.role === "admin" || me.data?.isOwner === true;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canCrossBranches });
  const [pickedBranchId, setPickedBranchId] = useState("");
  useEffect(() => {
    if (me.data?.branchId != null) setPickedBranchId(String(me.data.branchId));
  }, [me.data?.branchId]);
  const branchId =
    canCrossBranches && pickedBranchId
      ? Number(pickedBranchId)
      : me.data?.branchId != null
        ? Number(me.data.branchId)
        : null;
  const queryBranchId = branchId === null ? 0 : branchId;
  const enabled = queryBranchId > 0;

  const invoicesQuery = trpc.supplierInvoiceApproval.list.useQuery(
    { branchId: queryBranchId, limit: 200 },
    { enabled },
  );
  const pendingQuery = trpc.supplierInvoiceApproval.pendingApprovals.useQuery(
    { branchId: queryBranchId },
    { enabled },
  );

  const invoices = useMemo<SupplierInvoiceListRow[]>(
    () =>
      (invoicesQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        invoiceNumber: row.invoiceNumber,
        externalInvoiceNumber: row.externalInvoiceNumber,
        version: Number(row.version),
        status: row.status,
        totalAmount: row.totalAmount,
        invoiceDate: row.invoiceDate,
      })),
    [invoicesQuery.data],
  );
  const pendingApprovals = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        requestedBy: Number(row.requestedBy),
        requestedAt: row.requestedAt,
        title: row.kind === "REVERSE_INVOICE" ? "عكس فاتورة مورّد" : "ترحيل فاتورة مورّد",
        reference: `INVOICE-${row.supplierInvoiceId}`,
        reason: row.reason,
        evidence: row.evidenceReference,
      })),
    [pendingQuery.data],
  );

  async function invalidateAll() {
    await Promise.all([
      utils.supplierInvoiceApproval.list.invalidate(),
      utils.supplierInvoiceApproval.pendingApprovals.invalidate(),
    ]);
  }
  const requestReversal = trpc.supplierInvoiceApproval.requestApproval.useMutation({
    onSuccess: async () => {
      notify.info("تم إرسال طلب عكس الفاتورة للاعتماد", "لم تتغيّر الذمّة أو القيد بعد");
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideApproval = trpc.supplierInvoiceApproval.decideApproval.useMutation({
    onSuccess: async (result) => {
      const message = governanceDecisionMessage(result.status);
      result.status === "APPROVED" ? notify.ok(message) : notify.info(message);
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="اعتماد فواتير الموردين"
        description="ترحيل فاتورة المورّد يتم تلقائياً عند استلام أمر الشراء كاملاً؛ هنا يُدار عكسها فقط."
        icon={<FileWarning aria-hidden className="size-6" />}
        backHref="/purchases"
        backLabel="المشتريات"
        actions={
          canCrossBranches || me.data?.branchId == null ? (
            <AppSelect
              value={pickedBranchId}
              onValueChange={setPickedBranchId}
              className="w-52"
              aria-label="الفرع"
            >
              <option value="">اختر الفرع</option>
              {(branches.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </AppSelect>
          ) : undefined
        }
      />
      {me.isLoading ? (
        <LoadingState />
      ) : branchId == null ? (
        <div
          role="status"
          className="rounded-md border p-8 text-center text-sm text-muted-foreground"
        >
          اختر فرعاً لعرض فواتير الموردين.
        </div>
      ) : (
        <SupplierInvoiceApprovalGovernanceWorkspace
          invoices={invoices}
          pendingApprovals={pendingApprovals}
          currentUserId={me.data?.id}
          isOwner={me.data?.isOwner === true}
          documentsLoading={invoicesQuery.isLoading}
          documentsError={invoicesQuery.error}
          onRetryDocuments={() => void invoicesQuery.refetch()}
          pendingLoading={pendingQuery.isLoading}
          pendingError={pendingQuery.error}
          onRetryPending={() => void pendingQuery.refetch()}
          requestPending={requestReversal.isPending}
          decisionPending={decideApproval.isPending}
          onRequestReversal={(input) =>
            requestReversal.mutateAsync({ ...input, kind: "REVERSE_INVOICE" })
          }
          onDecideApproval={(input) => decideApproval.mutateAsync(input)}
        />
      )}
    </div>
  );
}

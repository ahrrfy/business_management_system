import { useEffect, useMemo, useState } from "react";
import { PackageMinus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import {
  PurchaseReturnGovernanceWorkspace,
  type ReturnSource,
  type ReversalSource,
} from "@/components/purchases/PurchaseReturnGovernanceWorkspace";
import type { GovernanceQueueRow } from "@/components/purchases/GovernanceApprovalQueue";
import { governanceDecisionMessage } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { variantDisplayName } from "@shared/variantDisplay";

export default function PurchaseReturnsGovernance() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const [pickedBranchId, setPickedBranchId] = useState("");
  const canReadSuppliers = useOperationPermission("suppliers.list").allowed;
  const canReadReturnSources = useOperationPermission(
    "purchaseReturnGovernance.returnSources",
  ).allowed;
  const canReadReversalSources = useOperationPermission(
    "purchaseReturnGovernance.reversalSources",
  ).allowed;
  const canReadPendingReturns = useOperationPermission(
    "purchaseReturnGovernance.pendingReturns",
  ).allowed;
  const canReadPendingReversals = useOperationPermission(
    "purchaseReturnGovernance.pendingReversals",
  ).allowed;
  const canRequestReturnOperation = useOperationPermission(
    "purchaseReturnGovernance.requestReturn",
  ).allowed;
  const canRequestReversalOperation = useOperationPermission(
    "purchaseReturnGovernance.requestReversal",
  ).allowed;
  const canDecideReturnOperation = useOperationPermission(
    "purchaseReturnGovernance.decideReturn",
  ).allowed;
  const canDecideReversalOperation = useOperationPermission(
    "purchaseReturnGovernance.decideReversal",
  ).allowed;
  const canRequestReturn = canReadReturnSources && canRequestReturnOperation;
  const canRequestReversal =
    canReadReversalSources && canRequestReversalOperation;
  const canDecideReturn = canReadPendingReturns && canDecideReturnOperation;
  const canDecideReversal =
    canReadPendingReversals && canDecideReversalOperation;
  const canChooseBranch =
    me.data?.isOwner === true ||
    me.data?.role === "admin" ||
    me.data?.branchId == null;
  const branches = trpc.branches.list.useQuery(undefined, {
    enabled: canChooseBranch,
  });
  const suppliers = trpc.suppliers.list.useQuery(undefined, {
    enabled: canReadSuppliers,
  });

  useEffect(() => {
    if (me.data?.branchId != null && !pickedBranchId)
      setPickedBranchId(String(me.data.branchId));
  }, [me.data?.branchId, pickedBranchId]);

  const branchId = canChooseBranch
    ? pickedBranchId
      ? Number(pickedBranchId)
      : null
    : me.data?.branchId != null
      ? Number(me.data.branchId)
      : null;
  const queryBranchId = branchId === null ? 0 : branchId;
  const queryInput = { branchId: queryBranchId, limit: 200 };
  const enabled = branchId != null && branchId > 0;
  const returnSourcesQuery =
    trpc.purchaseReturnGovernance.returnSources.useQuery(queryInput, {
      enabled: enabled && canReadReturnSources,
    });
  const reversalSourcesQuery =
    trpc.purchaseReturnGovernance.reversalSources.useQuery(queryInput, {
      enabled: enabled && canReadReversalSources,
    });
  const pendingReturnsQuery =
    trpc.purchaseReturnGovernance.pendingReturns.useQuery(
      { branchId: queryBranchId },
      { enabled: enabled && canReadPendingReturns },
    );
  const pendingReversalsQuery =
    trpc.purchaseReturnGovernance.pendingReversals.useQuery(
      { branchId: queryBranchId },
      { enabled: enabled && canReadPendingReversals },
    );

  const supplierNames = useMemo(
    () =>
      new Map((suppliers.data ?? []).map((row) => [Number(row.id), row.name])),
    [suppliers.data],
  );
  const returnSources = useMemo<ReturnSource[]>(
    () =>
      (returnSourcesQuery.data ?? []).map((row) => ({
        supplierInvoiceId: Number(row.id),
        invoiceNumber: row.externalInvoiceNumber || row.invoiceNumber,
        invoiceVersion: Number(row.version),
        matchRunId: Number(row.matchRun.id),
        supplierLabel:
          supplierNames.get(Number(row.supplierId)) ??
          `مورد #${row.supplierId}`,
        allocations: row.allocations.map((allocation) => ({
          matchAllocationId: Number(allocation.id),
          description: allocation.description,
          availableBaseQuantity: Number(allocation.availableBaseQuantity),
        })),
      })),
    [returnSourcesQuery.data, supplierNames],
  );
  const reversalSources = useMemo<ReversalSource[]>(
    () =>
      (reversalSourcesQuery.data ?? []).map((row) => ({
        purchaseReturnId: Number(row.id),
        returnNumber: row.returnNumber,
        returnVersion: Number(row.version),
        supplierLabel:
          supplierNames.get(Number(row.supplierId)) ??
          `مورد #${row.supplierId}`,
        items: row.items.map((item) => ({
          purchaseReturnItemId: Number(item.id),
          description: variantDisplayName(item),
          remainingBaseQuantity: Number(item.remainingBaseQuantity),
        })),
      })),
    [reversalSourcesQuery.data, supplierNames],
  );

  const pendingReturns = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingReturnsQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        requestedBy: Number(row.requestedBy),
        requestedAt: row.requestedAt,
        title:
          row.sourceKind === "OWNER_EXCEPTION"
            ? "استثناء مرتجع باعتماد المالك"
            : "مرتجع فاتورة مورد",
        reference:
          row.sourceKind === "OWNER_EXCEPTION"
            ? row.evidenceReference
            : `INV-${row.supplierInvoiceId}`,
        reason: row.reason,
        amount: `${fmt(row.requestedTotalAmount)} د.ع`,
        evidence: row.evidenceReference,
        details: [
          {
            label: "التسوية",
            value: row.settlement === "CREDIT" ? "تخفيض الذمة" : "استرداد فعلي",
          },
        ],
      })),
    [pendingReturnsQuery.data],
  );
  const pendingReversals = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingReversalsQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        requestedBy: Number(row.requestedBy),
        requestedAt: row.requestedAt,
        title: "عكس مرتجع شراء",
        reference: `RETURN-${row.purchaseReturnId}`,
        reason: row.reason,
        evidence: row.evidenceReference,
      })),
    [pendingReversalsQuery.data],
  );

  async function invalidateAll() {
    await Promise.all([
      utils.purchaseReturnGovernance.returnSources.invalidate(),
      utils.purchaseReturnGovernance.reversalSources.invalidate(),
      utils.purchaseReturnGovernance.pendingReturns.invalidate(),
      utils.purchaseReturnGovernance.pendingReversals.invalidate(),
      utils.purchaseIntegrity.monthCloseBlockers.invalidate(),
    ]);
  }
  const requestReturn = trpc.purchaseReturnGovernance.requestReturn.useMutation(
    {
      onSuccess: async (result) => {
        if (result.status === "APPROVED") {
          notify.ok(
            "تم تنفيذ مرتجع الشراء فوراً",
            `رقم المرتجع #${(result as { purchaseReturnId?: number }).purchaseReturnId ?? result.requestId} — تم تحديث المخزون ورصيد المورد.`,
          );
        } else {
          notify.info(
            "تم إرسال طلب المرتجع للاعتماد",
            "لم يتغير المخزون أو رصيد المورد بعد",
          );
        }
        await invalidateAll();
      },
      onError: (error) => notify.err(error),
    },
  );
  const requestReversal =
    trpc.purchaseReturnGovernance.requestReversal.useMutation({
      onSuccess: async (result) => {
        if (result.status === "APPROVED") {
          notify.ok(
            "تم تنفيذ عكس المرتجع فوراً",
            `رقم العكس #${(result as { purchaseReturnReversalId?: number }).purchaseReturnReversalId ?? result.requestId} — تم عكس حركة المخزون والرصيد.`,
          );
        } else {
          notify.info(
            "تم إرسال طلب عكس المرتجع",
            "لم يتغير المخزون أو الرصيد بعد",
          );
        }
        await invalidateAll();
      },
      onError: (error) => notify.err(error),
    });
  const decideReturn = trpc.purchaseReturnGovernance.decideReturn.useMutation({
    onSuccess: async (result) => {
      const message = governanceDecisionMessage(result.status);
      result.status === "APPROVED" ? notify.ok(message) : notify.info(message);
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideReversal =
    trpc.purchaseReturnGovernance.decideReversal.useMutation({
      onSuccess: async (result) => {
        const message = governanceDecisionMessage(result.status);
        result.status === "APPROVED"
          ? notify.ok(message)
          : notify.info(message);
        await invalidateAll();
      },
      onError: (error) => notify.err(error),
    });

  const retrySources = () => {
    const retries: Array<Promise<unknown>> = [];
    if (canReadReturnSources) retries.push(returnSourcesQuery.refetch());
    if (canReadReversalSources) retries.push(reversalSourcesQuery.refetch());
    void Promise.all(retries);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="حوكمة مرتجعات الشراء"
        description="طلب المرتجع وعكسه، اعتماد مستقل، وأثر مخزون وذمة موثّق بعد القرار فقط."
        icon={<PackageMinus aria-hidden className="size-6" />}
        backHref="/purchases"
        backLabel="المشتريات"
        actions={
          canChooseBranch ? (
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
          اختر فرعاً لعرض الطلبات والمستندات المؤهلة.
        </div>
      ) : (
        <PurchaseReturnGovernanceWorkspace
          canRequestReturn={canRequestReturn}
          canRequestReversal={canRequestReversal}
          canDecideReturn={canDecideReturn}
          canDecideReversal={canDecideReversal}
          returnSources={returnSources}
          reversalSources={reversalSources}
          pendingReturns={pendingReturns}
          pendingReversals={pendingReversals}
          currentUserId={me.data?.id}
          isOwner={me.data?.isOwner === true}
          loadingSources={
            (canReadReturnSources && returnSourcesQuery.isLoading) ||
            (canReadReversalSources && reversalSourcesQuery.isLoading)
          }
          sourcesError={
            (canReadReturnSources ? returnSourcesQuery.error : null) ??
            (canReadReversalSources ? reversalSourcesQuery.error : null)
          }
          onRetrySources={retrySources}
          requestPending={requestReturn.isPending || requestReversal.isPending}
          decisionPending={decideReturn.isPending || decideReversal.isPending}
          onRequestReturn={(input) => requestReturn.mutateAsync(input)}
          onRequestReversal={(input) => requestReversal.mutateAsync(input)}
          onDecideReturn={(input) => decideReturn.mutateAsync(input)}
          onDecideReversal={(input) => decideReversal.mutateAsync(input)}
          pendingReturnLoading={
            canReadPendingReturns && pendingReturnsQuery.isLoading
          }
          pendingReversalLoading={
            canReadPendingReversals && pendingReversalsQuery.isLoading
          }
          pendingReturnError={
            canReadPendingReturns ? pendingReturnsQuery.error : null
          }
          pendingReversalError={
            canReadPendingReversals ? pendingReversalsQuery.error : null
          }
          onRetryPendingReturns={() => {
            if (canReadPendingReturns) void pendingReturnsQuery.refetch();
          }}
          onRetryPendingReversals={() => {
            if (canReadPendingReversals) void pendingReversalsQuery.refetch();
          }}
        />
      )}
    </div>
  );
}

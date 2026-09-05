import { useEffect, useMemo, useState } from "react";
import { HandCoins } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import type { GovernanceQueueRow } from "@/components/purchases/GovernanceApprovalQueue";
import {
  SupplierPaymentsGovernanceWorkspace,
  type SupplierPaymentSource,
  type SupplierRefundSource,
} from "@/components/purchases/SupplierPaymentsGovernanceWorkspace";
import { governanceDecisionMessage } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";

export default function SupplierPaymentsGovernance() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const suppliers = trpc.suppliers.list.useQuery();
  const [pickedBranchId, setPickedBranchId] = useState("");

  useEffect(() => {
    if (me.data?.branchId != null) setPickedBranchId(String(me.data.branchId));
  }, [me.data?.branchId]);
  const branchId =
    me.data?.branchId != null
      ? Number(me.data.branchId)
      : pickedBranchId
        ? Number(pickedBranchId)
        : null;
  const canDecide =
    me.data != null &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "treasury",
      "FULL",
      ["manager", "accountant"],
    );
  const decisionBlockedReason =
    "القرار المالي يتطلب صلاحية الخزينة الكاملة؛ صلاحية المشتريات تتيح إنشاء الطلب ومتابعته فقط.";
  const queryBranchId = branchId === null ? 0 : branchId;
  const enabled = queryBranchId > 0;
  const paymentSourcesQuery = trpc.supplierPayments.paymentSources.useInfiniteQuery(
    { branchId: queryBranchId, limit: 100 },
    { enabled, getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const refundSourcesQuery = trpc.supplierPayments.refundSources.useInfiniteQuery(
    { branchId: queryBranchId, limit: 100 },
    { enabled, getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const pendingPaymentsQuery = trpc.supplierPayments.pendingPayments.useQuery(
    { branchId: queryBranchId },
    { enabled },
  );
  const pendingRefundsQuery =
    trpc.supplierPayments.pendingRefunds.useInfiniteQuery(
      { branchId: queryBranchId, limit: 100 },
      { enabled, getNextPageParam: (last) => last.nextCursor ?? undefined },
    );
  const supplierNames = useMemo(
    () =>
      new Map((suppliers.data ?? []).map((row) => [Number(row.id), row.name])),
    [suppliers.data],
  );

  const paymentSources = useMemo<SupplierPaymentSource[]>(
    () =>
      (paymentSourcesQuery.data?.pages.flatMap((page) => page.rows) ?? []).map((row) => ({
        supplierInvoiceId: Number(row.id),
        invoiceNumber: row.externalInvoiceNumber || row.invoiceNumber,
        invoiceVersion: Number(row.version),
        supplierId: Number(row.supplierId),
        supplierLabel:
          supplierNames.get(Number(row.supplierId)) ??
          `مورد #${row.supplierId}`,
        currency: row.currency,
        exchangeRate: row.agreedRate,
        remainingAmount: row.remainingAmount,
        remainingCurrencyAmount: row.remainingCurrencyAmount,
      })),
    [paymentSourcesQuery.data, supplierNames],
  );
  const refundSources = useMemo<SupplierRefundSource[]>(
    () =>
      (refundSourcesQuery.data?.pages.flatMap((page) => page.rows) ?? []).map((row) => ({
        supplierPaymentId: Number(row.id),
        paymentNumber: row.paymentNumber,
        paymentVersion: Number(row.version),
        supplierId: Number(row.supplierId),
        supplierLabel:
          supplierNames.get(Number(row.supplierId)) ??
          `مورد #${row.supplierId}`,
        currency: row.currency,
        allocations: row.allocations.map((allocation) => ({
          supplierPaymentAllocationId: Number(allocation.id),
          invoiceNumber: `فاتورة #${allocation.supplierInvoiceId}`,
          refundableAmount: allocation.refundableAmount,
          refundableCurrencyAmount: allocation.refundableCurrencyAmount,
        })),
      })),
    [refundSourcesQuery.data, supplierNames],
  );
  const pendingPayments = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingPaymentsQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        requestedBy: Number(row.requestedBy),
        requestedAt: row.requestedAt,
        title: "سداد فواتير مورد",
        reference: `SUP-${row.supplierId}`,
        reason: row.reason,
        amount: `${fmt(row.requestedAmount)} د.ع`,
        evidence: row.evidenceReference,
        details: [
          { label: "العملة", value: row.currency },
          { label: "طريقة الدفع", value: row.paymentMethod },
        ],
      })),
    [pendingPaymentsQuery.data],
  );
  const pendingRefunds = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingRefundsQuery.data?.pages.flatMap((page) => page.rows) ?? []).map(
        (row) => ({
          id: Number(row.id),
          requestedBy: Number(row.requestedBy),
          requestedAt: row.requestedAt,
          title: "استرداد دفعة مورد",
          reference: `PAY-${row.supplierPaymentId}`,
          reason: row.reason,
          amount: `${fmt(row.requestedAmount)} د.ع`,
          evidence: row.evidenceReference,
          details: [{ label: "طريقة الاسترداد", value: row.refundMethod }],
        }),
      ),
    [pendingRefundsQuery.data],
  );

  async function invalidateAll() {
    await Promise.all([
      utils.supplierPayments.paymentSources.invalidate(),
      utils.supplierPayments.refundSources.invalidate(),
      utils.supplierPayments.pendingPayments.invalidate(),
      utils.supplierPayments.pendingRefunds.invalidate(),
      utils.purchaseIntegrity.monthCloseBlockers.invalidate(),
    ]);
  }
  const requestPayment = trpc.supplierPayments.requestPayment.useMutation({
    onSuccess: async () => {
      notify.info(
        "تم إرسال طلب السداد للاعتماد",
        "لم تتغير ذمة المورد ولم يخرج مال بعد",
      );
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const requestRefund = trpc.supplierPayments.requestRefund.useMutation({
    onSuccess: async () => {
      notify.info(
        "تم إرسال طلب استرداد الدفعة",
        "لم يدخل مال ولم تتغير التخصيصات بعد",
      );
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const decidePayment = trpc.supplierPayments.decidePayment.useMutation({
    onSuccess: async (result) => {
      const message = governanceDecisionMessage(result.status);
      result.status === "APPROVED" ? notify.ok(message) : notify.info(message);
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideRefund = trpc.supplierPayments.decideRefund.useMutation({
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
        title="حوكمة سداد الموردين"
        description="تخصيص دفعات المورد واستردادها بمستند ودليل واعتماد مستقل."
        icon={<HandCoins aria-hidden className="size-6" />}
        backHref="/purchases"
        backLabel="المشتريات"
        actions={
          me.data?.branchId == null ? (
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
          اختر فرعاً لعرض الفواتير والدفعات المؤهلة.
        </div>
      ) : (
        <SupplierPaymentsGovernanceWorkspace
          branchId={branchId}
          paymentSources={paymentSources}
          refundSources={refundSources}
          pendingPayments={pendingPayments}
          pendingRefunds={pendingRefunds}
          currentUserId={me.data?.id}
          isOwner={me.data?.isOwner === true}
          canDecide={canDecide}
          decisionBlockedReason={decisionBlockedReason}
          loadingSources={
            paymentSourcesQuery.isLoading || refundSourcesQuery.isLoading
          }
          sourcesError={paymentSourcesQuery.error ?? refundSourcesQuery.error}
          onRetrySources={() =>
            void Promise.all([
              paymentSourcesQuery.refetch(),
              refundSourcesQuery.refetch(),
            ])
          }
          paymentSourcesHasMore={Boolean(paymentSourcesQuery.hasNextPage)}
          refundSourcesHasMore={Boolean(refundSourcesQuery.hasNextPage)}
          loadingMoreSources={
            paymentSourcesQuery.isFetchingNextPage ||
            refundSourcesQuery.isFetchingNextPage
          }
          onLoadMorePaymentSources={() => void paymentSourcesQuery.fetchNextPage()}
          onLoadMoreRefundSources={() => void refundSourcesQuery.fetchNextPage()}
          requestPending={requestPayment.isPending || requestRefund.isPending}
          decisionPending={decidePayment.isPending || decideRefund.isPending}
          onRequestPayment={(input) => requestPayment.mutateAsync(input)}
          onRequestRefund={(input) => requestRefund.mutateAsync(input)}
          onDecidePayment={(input) => decidePayment.mutateAsync(input)}
          onDecideRefund={(input) => decideRefund.mutateAsync(input)}
          pendingPaymentLoading={pendingPaymentsQuery.isLoading}
          pendingRefundLoading={pendingRefundsQuery.isLoading}
          pendingPaymentError={pendingPaymentsQuery.error}
          pendingRefundError={pendingRefundsQuery.error}
          onRetryPendingPayments={() => void pendingPaymentsQuery.refetch()}
          onRetryPendingRefunds={() => void pendingRefundsQuery.refetch()}
        />
      )}
    </div>
  );
}

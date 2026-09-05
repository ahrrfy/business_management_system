import { useEffect, useMemo, useState } from "react";
import { ReceiptText } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import type { GovernanceQueueRow } from "@/components/purchases/GovernanceApprovalQueue";
import {
  PurchaseChargesGovernanceWorkspace,
  type PurchaseChargeListRow,
  type PurchaseChargeSource,
} from "@/components/purchases/PurchaseChargesGovernanceWorkspace";
import { governanceDecisionMessage } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterInputs } from "@/lib/trpc";

export default function PurchaseChargesGovernance() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
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
  const queryBranchId = branchId === null ? 0 : branchId;
  const enabled = queryBranchId > 0;
  const sourcesQuery = trpc.purchaseCharges.sources.useQuery(
    { branchId: queryBranchId, limit: 200 },
    { enabled },
  );
  const chargesQuery = trpc.purchaseCharges.list.useQuery(
    { branchId: queryBranchId, limit: 200 },
    { enabled },
  );
  const pendingQuery = trpc.purchaseCharges.pendingControls.useQuery(
    { branchId: queryBranchId },
    { enabled },
  );

  const sources = useMemo<PurchaseChargeSource[]>(() => {
    const data = sourcesQuery.data;
    if (!data) return [];
    return [
      ...data.orders.map((row) => ({
        key: `PO:${row.id}`,
        kind: "PURCHASE_ORDER" as const,
        id: Number(row.id),
        label: `أمر ${row.poNumber}`,
        supplierId: Number(row.supplierId),
        amount: row.total,
      })),
      ...data.goodsReceipts.map((row) => ({
        key: `GRN:${row.id}`,
        kind: "GOODS_RECEIPT" as const,
        id: Number(row.id),
        label: `استلام ${row.receiptNumber}`,
        supplierId: Number(row.supplierId),
        amount: row.totalAmount,
      })),
      ...data.supplierInvoices.map((row) => ({
        key: `INV:${row.id}`,
        kind: "SUPPLIER_INVOICE" as const,
        id: Number(row.id),
        label: `فاتورة ${row.externalInvoiceNumber || row.invoiceNumber}`,
        supplierId: Number(row.supplierId),
        amount: row.totalAmount,
      })),
    ];
  }, [sourcesQuery.data]);
  const charges = useMemo<PurchaseChargeListRow[]>(
    () =>
      (chargesQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        chargeNumber: row.chargeNumber,
        version: Number(row.version),
        status: row.status,
        chargeType: row.chargeType,
        settlement: row.settlement,
        amount: row.amount,
        expenseDate: row.expenseDate,
      })),
    [chargesQuery.data],
  );
  const pendingControls = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        requestedBy: Number(row.requestedBy),
        requestedAt: row.requestedAt,
        title: row.kind === "POST" ? "ترحيل مصروف شراء" : "عكس مصروف شراء",
        reference: `CHARGE-${row.purchaseChargeId}`,
        reason: row.reason,
        evidence: row.evidenceReference,
      })),
    [pendingQuery.data],
  );
  const expenseAccounts = useMemo(
    () =>
      (sourcesQuery.data?.expenseAccounts ?? []).map((row) => ({
        id: Number(row.id),
        label: `${row.code} — ${row.name}`,
      })),
    [sourcesQuery.data],
  );
  const suppliers = useMemo(
    () =>
      (sourcesQuery.data?.suppliers ?? []).map((row) => ({
        id: Number(row.id),
        label: row.name,
      })),
    [sourcesQuery.data],
  );

  async function invalidateAll() {
    await Promise.all([
      utils.purchaseCharges.sources.invalidate(),
      utils.purchaseCharges.list.invalidate(),
      utils.purchaseCharges.pendingControls.invalidate(),
      utils.purchaseIntegrity.monthCloseBlockers.invalidate(),
    ]);
  }
  const create = trpc.purchaseCharges.create.useMutation({
    onSuccess: async () => {
      await utils.purchaseCharges.list.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const requestControl = trpc.purchaseCharges.requestControl.useMutation({
    onSuccess: async () => {
      notify.info(
        "تم إرسال إجراء المصروف للاعتماد",
        "لم يُرحّل قيد ولم يتحرك نقد بعد",
      );
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideControl = trpc.purchaseCharges.decideControl.useMutation({
    onSuccess: async (result) => {
      const message = governanceDecisionMessage(result.status);
      result.status === "APPROVED" ? notify.ok(message) : notify.info(message);
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });

  async function createAndRequestPost(
    input: RouterInputs["purchaseCharges"]["create"],
    control: { requestKey: string; evidenceReference: string; reason: string },
  ) {
    const result = await create.mutateAsync(input);
    return requestControl.mutateAsync({
      purchaseChargeId: result.purchaseChargeId,
      expectedChargeVersion: 1,
      kind: "POST",
      ...control,
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مصاريف الشراء"
        description="الشحن والكمرك والنقل كمصروف شركة موزّع على مستنداته، بلا تحميل على المخزون."
        icon={<ReceiptText aria-hidden className="size-6" />}
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
          اختر فرعاً لعرض مصاريف الشراء.
        </div>
      ) : (
        <PurchaseChargesGovernanceWorkspace
          branchId={branchId}
          sources={sources}
          charges={charges}
          expenseAccounts={expenseAccounts}
          suppliers={suppliers}
          pendingControls={pendingControls}
          currentUserId={me.data?.id}
          isOwner={me.data?.isOwner === true}
          loading={
            sourcesQuery.isLoading ||
            chargesQuery.isLoading ||
            pendingQuery.isLoading
          }
          error={sourcesQuery.error ?? chargesQuery.error ?? pendingQuery.error}
          onRetry={() =>
            void Promise.all([
              sourcesQuery.refetch(),
              chargesQuery.refetch(),
              pendingQuery.refetch(),
            ])
          }
          requestPending={create.isPending || requestControl.isPending}
          decisionPending={decideControl.isPending}
          onCreateAndRequestPost={createAndRequestPost}
          onRequestControl={(input) => requestControl.mutateAsync(input)}
          onDecideControl={(input) => decideControl.mutateAsync(input)}
        />
      )}
    </div>
  );
}

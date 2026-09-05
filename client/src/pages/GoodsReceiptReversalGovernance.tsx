import { useEffect, useMemo, useState } from "react";
import { PackageMinus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import type { GovernanceQueueRow } from "@/components/purchases/GovernanceApprovalQueue";
import {
  GoodsReceiptReversalGovernanceWorkspace,
  type GoodsReceiptDetailItem,
  type GoodsReceiptListRow,
} from "@/components/purchases/GoodsReceiptReversalGovernanceWorkspace";
import { governanceDecisionMessage } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { AppSelect } from "@/components/ui/AppSelect";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export default function GoodsReceiptReversalGovernance() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  // ⭐ (مراجعة Codex على #1001) عبورُ الفروع صلاحيّةٌ، لا غيابُ فرعٍ رئيسيّ — أدمن/مالكٌ
  // بفرعٍ أساسيّ محدَّد كان لا يرى منتقي الفرع إطلاقاً فيُحبَس على فرعه رغم تخويله عبور
  // الفروع خادمياً (assertPurchaseBranch يسمح لـrole==='admin'). طابِق Purchases.tsx.
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
  const [selectedReceiptId, setSelectedReceiptId] = useState<number | null>(null);

  const receiptsQuery = trpc.goodsReceiptReversal.list.useQuery(
    { branchId: queryBranchId, limit: 200 },
    { enabled },
  );
  const pendingQuery = trpc.goodsReceiptReversal.pendingReversals.useQuery(
    { branchId: queryBranchId },
    { enabled },
  );
  const detailQuery = trpc.goodsReceiptReversal.get.useQuery(
    { goodsReceiptId: selectedReceiptId ?? 0 },
    { enabled: selectedReceiptId != null },
  );

  const receipts = useMemo<GoodsReceiptListRow[]>(
    () =>
      (receiptsQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        receiptNumber: row.receiptNumber,
        version: Number(row.version),
        status: row.status,
        totalAmount: row.totalAmount,
        receivedAt: row.receivedAt,
      })),
    [receiptsQuery.data],
  );
  const pendingReversals = useMemo<GovernanceQueueRow[]>(
    () =>
      (pendingQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        requestedBy: Number(row.requestedBy),
        requestedAt: row.requestedAt,
        title: "عكس استلام بضاعة",
        reference: `GRN-REVERSAL-${row.goodsReceiptId}`,
        reason: row.reason,
      })),
    [pendingQuery.data],
  );
  const detailItems = useMemo<GoodsReceiptDetailItem[]>(
    () =>
      (detailQuery.data?.items ?? []).map((row) => ({
        id: Number(row.id),
        lineNo: Number(row.lineNo),
        productName: row.productName,
        variantSku: row.variantSku,
        acceptedBaseQuantity: Number(row.acceptedBaseQuantity),
        reversedBaseQuantity: Number(row.reversedBaseQuantity),
        returnedBaseQuantity: Number(row.returnedBaseQuantity),
      })),
    [detailQuery.data],
  );

  async function invalidateAll() {
    await Promise.all([
      utils.goodsReceiptReversal.list.invalidate(),
      utils.goodsReceiptReversal.pendingReversals.invalidate(),
      utils.goodsReceiptReversal.get.invalidate(),
    ]);
  }
  const requestReversal = trpc.goodsReceiptReversal.requestReversal.useMutation({
    onSuccess: async () => {
      notify.info("تم إرسال طلب عكس الاستلام للاعتماد", "لم يتغيّر المخزون أو القيد بعد");
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const decideReversal = trpc.goodsReceiptReversal.decideReversal.useMutation({
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
        title="عكس استلام البضاعة"
        description="عكسُ إذن استلامٍ مستندٌ لأثرٍ ماليّ ومخزنيّ حقيقيّ — يحتاج طلباً واعتماداً مستقلَّين."
        icon={<PackageMinus aria-hidden className="size-6" />}
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
          اختر فرعاً لعرض أذون الاستلام.
        </div>
      ) : (
        <GoodsReceiptReversalGovernanceWorkspace
          receipts={receipts}
          pendingReversals={pendingReversals}
          currentUserId={me.data?.id}
          isOwner={me.data?.isOwner === true}
          documentsLoading={receiptsQuery.isLoading}
          documentsError={receiptsQuery.error}
          onRetryDocuments={() => void receiptsQuery.refetch()}
          pendingLoading={pendingQuery.isLoading}
          pendingError={pendingQuery.error}
          onRetryPending={() => void pendingQuery.refetch()}
          requestPending={requestReversal.isPending}
          decisionPending={decideReversal.isPending}
          selectedReceiptId={selectedReceiptId}
          onSelectReceipt={setSelectedReceiptId}
          detailItems={detailItems}
          detailLoading={detailQuery.isLoading}
          onRequestReversal={(input) => requestReversal.mutateAsync(input)}
          onDecideReversal={(input) => decideReversal.mutateAsync(input)}
        />
      )}
    </div>
  );
}

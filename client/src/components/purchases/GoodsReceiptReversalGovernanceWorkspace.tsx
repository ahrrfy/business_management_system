import { useEffect, useMemo, useState } from "react";
import { PackageMinus, RotateCcw } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { newGovernanceKey } from "./purchaseGovernanceUiPolicy";

export type GoodsReceiptListRow = {
  id: number;
  receiptNumber: string;
  version: number;
  status: "POSTED" | "PARTIALLY_REVERSED" | "REVERSED";
  totalAmount: string;
  receivedAt: string | Date;
};

export type GoodsReceiptDetailItem = {
  id: number;
  lineNo: number;
  productName: string;
  variantSku: string;
  acceptedBaseQuantity: number;
  reversedBaseQuantity: number;
  returnedBaseQuantity: number;
};

const STATUS_LABEL: Record<GoodsReceiptListRow["status"], string> = {
  POSTED: "مستلَم بالكامل",
  PARTIALLY_REVERSED: "عُكِس جزئياً",
  REVERSED: "معكوسٌ بالكامل",
};

export function GoodsReceiptReversalGovernanceWorkspace({
  receipts,
  pendingReversals,
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
  selectedReceiptId,
  onSelectReceipt,
  detailItems,
  detailLoading,
  onRequestReversal,
  onDecideReversal,
}: {
  receipts: GoodsReceiptListRow[];
  pendingReversals: GovernanceQueueRow[];
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
  selectedReceiptId: number | null;
  onSelectReceipt: (receiptId: number | null) => void;
  detailItems: GoodsReceiptDetailItem[];
  detailLoading: boolean;
  onRequestReversal: (input: {
    goodsReceiptId: number;
    expectedReceiptVersion: number;
    requestKey: string;
    reason: string;
    lines: Array<{ goodsReceiptItemId: number; baseQuantity: number }>;
  }) => Promise<unknown>;
  onDecideReversal: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
}) {
  const [reason, setReason] = useState("");
  const selectedReceipt = receipts.find((row) => row.id === selectedReceiptId) ?? null;

  useEffect(() => {
    if (!selectedReceiptId) setReason("");
  }, [selectedReceiptId]);

  // ⛔ (مراجعة Codex على #1001) عكسٌ كاملٌ إلزاميّ — لا اختيار كمّيةٍ جزئية: الشاشات
  // الحاليّة بلا مسار استلامٍ أو فوترة يدويّ (الدورة كلّها آليّة ضمن purchases.decideControl)،
  // فعكسٌ جزئيّ يُبقي الإذن PARTIALLY_REVERSED وأمر الشراء CONFIRMED بلا أيّ طريقٍ لاحقٍ
  // لإعادة استلام الباقي أو فوترته — بضاعةٌ ومالٌ عالقان بلا مخرج. كلّ بندٍ بمتاحه بالكامل
  // أو لا شيء.
  const lines = useMemo(
    () =>
      detailItems
        .map((item) => ({
          goodsReceiptItemId: item.id,
          baseQuantity:
            item.acceptedBaseQuantity - item.reversedBaseQuantity - item.returnedBaseQuantity,
        }))
        .filter((line) => line.baseQuantity > 0),
    [detailItems],
  );
  const requestValid = selectedReceipt != null && lines.length > 0 && reason.trim().length >= 3;

  function close() {
    if (requestPending) return;
    onSelectReceipt(null);
  }

  async function submit() {
    if (!requestValid || !selectedReceipt) return;
    try {
      await onRequestReversal({
        goodsReceiptId: selectedReceipt.id,
        expectedReceiptVersion: selectedReceipt.version,
        requestKey: newGovernanceKey(`grn-reversal-${selectedReceipt.id}`),
        reason: reason.trim(),
        lines,
      });
      onSelectReceipt(null);
    } catch {
      // يبقى الحوار مفتوحاً لإعادة المحاولة.
    }
  }

  const columns = useMemo<ColumnDef<GoodsReceiptListRow, unknown>[]>(
    () => [
      {
        accessorKey: "receiptNumber",
        header: "رقم الإذن",
        cell: ({ row }) => <bdi dir="ltr">{row.original.receiptNumber}</bdi>,
      },
      {
        accessorKey: "receivedAt",
        header: "تاريخ الاستلام",
        cell: ({ row }) => fmtDate(row.original.receivedAt),
      },
      {
        accessorKey: "totalAmount",
        header: "القيمة",
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
          row.original.status === "REVERSED" ? (
            "—"
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onSelectReceipt(row.original.id)}
            >
              طلب عكس
            </Button>
          ),
      },
    ],
    [onSelectReceipt],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <PackageMinus aria-hidden className="size-4" />
              أذون الاستلام
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
            عكس الاستلام يُخرج مخزوناً أُدخل ويمحو التزام GRNI — طلبٌ يحتاج اعتماداً مستقلاً
            قبل أي أثر، ولا يُتاح لبنودٍ سبق ربطها بفاتورة مورّد مطابَقة أو مرتجعٍ سابق.
            العكسُ يشمل الإذن بالكامل دائماً — لا عكس جزئيّ.
          </GovernanceRequestNotice>
          {documentsError ? (
            <p role="alert" className="text-sm text-destructive">
              تعذّر تحميل أذون الاستلام. أعد المحاولة.
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={receipts}
            loading={documentsLoading}
            searchable
            searchPlaceholder="بحث برقم الإذن"
            emptyText="لا توجد أذون استلامٍ بعد."
          />
        </CardContent>
      </Card>

      <GovernanceApprovalQueue
        title="طلبات عكس الاستلام"
        scope="goods-receipt-reversal"
        rows={pendingReversals}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={pendingLoading}
        error={pendingError}
        pending={decisionPending}
        onRetry={onRetryPending}
        onDecide={onDecideReversal}
      />

      <Dialog open={selectedReceiptId != null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>طلب عكس إذن الاستلام {selectedReceipt?.receiptNumber}</DialogTitle>
            <DialogDescription>
              يعكس الطلب الإذن بالكامل — كل بندٍ بكامل كمّيته المتاحة. الطلب لا يغيّر
              المخزون أو القيود حتى يعتمده مستخدمٌ مستقل.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {detailLoading ? (
              <p className="text-sm text-muted-foreground">جارٍ تحميل بنود الإذن…</p>
            ) : (
              <div className="space-y-2 rounded-md border p-3">
                {detailItems.map((item) => {
                  const available =
                    item.acceptedBaseQuantity -
                    item.reversedBaseQuantity -
                    item.returnedBaseQuantity;
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <div>
                        <p>{item.productName}</p>
                        <p className="text-xs text-muted-foreground">
                          <bdi dir="ltr">{item.variantSku}</bdi>
                        </p>
                      </div>
                      <span
                        dir="ltr"
                        className={
                          available > 0
                            ? "font-semibold"
                            : "text-muted-foreground line-through"
                        }
                      >
                        {available > 0 ? `يُعكَس بالكامل: ${available}` : "لا شيء متاحٌ للعكس"}
                      </span>
                    </div>
                  );
                })}
                {!detailLoading && lines.length === 0 ? (
                  <p role="alert" className="text-sm text-destructive">
                    لا كمّيةَ متاحةً للعكس على هذا الإذن — كلّ بنودها مربوطةٌ بفاتورة مورّدٍ
                    مطابَقة أو مرتجعٍ سابق.
                  </p>
                ) : null}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="grn-reversal-reason">سبب العكس</Label>
              <Textarea
                id="grn-reversal-reason"
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
              إرسال طلب عكس الإذن كاملاً للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

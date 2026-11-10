import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PurchaseCashSourceField,
  usePurchaseCashSourceState,
} from "@/components/purchases/PurchaseCashSourceField";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export interface QuickApprovalTarget {
  id: number;
  poNumber: string;
  controlRequestId?: number;
  creatorId?: number | null;
  version: number;
  settlementType: "CASH" | "CREDIT";
  branchId: number;
  agreedCurrency: string | null;
  total: string | null;
}

export interface PurchaseQuickApproveDialogProps {
  target: QuickApprovalTarget | null;
  currentUserId?: number | null;
  onClose: () => void;
  onApproved: () => Promise<void> | void;
}

export function PurchaseQuickApproveDialog({
  target,
  currentUserId,
  onClose,
  onApproved,
}: PurchaseQuickApproveDialogProps) {
  const [reason, setReason] = useState("اعتماد واستلام البضاعة كاملة");

  useEffect(() => {
    if (target != null) {
      setReason("اعتماد واستلام البضاعة كاملة");
    }
  }, [target?.id, target?.controlRequestId]);

  const isQuickCashIqd =
    target != null &&
    target.settlementType === "CASH" &&
    target.agreedCurrency !== "USD";

  const quickPoDetail = trpc.purchases.get.useQuery(
    { purchaseOrderId: target?.id ?? 0 },
    { enabled: Boolean(isQuickCashIqd && target?.id) },
  );
  const quickHasCanonicalTender = Boolean(quickPoDetail.data?.tender);

  const quickCashSourceState = usePurchaseCashSourceState({
    branchId: target?.branchId,
    enabled: Boolean(
      isQuickCashIqd &&
        quickPoDetail.data != null &&
        !quickHasCanonicalTender,
    ),
    context: "approval",
    isCreator:
      target?.creatorId != null &&
      currentUserId != null &&
      Number(target.creatorId) === Number(currentUserId),
  });

  const decideControlMut = trpc.purchases.decideControl.useMutation({
    onSuccess: async (res) => {
      const wasCash = target?.settlementType === "CASH";
      notify.ok(
        res.status === "APPROVED"
          ? wasCash
            ? "تم اعتماد الفاتورة النقدية واستلام البضاعة وسداد المورد بالكامل — الذمة المتبقية 0.00"
            : "تم اعتماد أمر الشراء واستلام البضاعة بالكامل وترحيل الفاتورة بنجاح"
          : "تم تحديث حالة طلب الاعتماد",
      );
      quickCashSourceState.reset();
      onClose();
      await onApproved();
    },
    onError: (err) => notify.err(err),
  });

  const handleClose = () => {
    quickCashSourceState.reset();
    onClose();
  };

  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 aria-hidden className="size-5 text-primary" />
            <span>اعتماد واستلام أمر الشراء {target?.poNumber}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            اعتماد هذا الأمر يعني تأكيد استلام كامل الأصناف في المستودع وترحيل فاتورة المورد في قيد متوازن وإتاحتها للبيع فوراً.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <Label htmlFor="row-approve-reason" className="text-xs">
              بيان الاعتماد / السبب
            </Label>
            <Input
              id="row-approve-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="text-xs"
              placeholder="اعتماد واستلام البضاعة كاملة"
            />
          </div>
          {isQuickCashIqd ? (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
              <p className="font-medium">
                هذه فاتورة شراء نقدية: اعتمادها يرحل البضاعة ويسدد كامل قيمتها فورا في نفس العملية وتصبح الذمة المتبقية 0.00.
              </p>
              {quickPoDetail.isLoading ? (
                <p className="text-muted-foreground">
                  جارٍ التحقق من مصدر السداد المحفوظ…
                </p>
              ) : quickHasCanonicalTender && quickPoDetail.data?.goodsPaymentSummary ? (
                <div className="space-y-1.5 rounded border bg-background p-2">
                  <div>
                    مصدر سداد البضاعة المثبّت:{" "}
                    <span className="font-semibold">
                      {quickPoDetail.data.goodsPaymentSummary.sourceMode === "DRAWER"
                        ? `درج وردية المنشئ${quickPoDetail.data.goodsPaymentSummary.shiftId ? ` #${quickPoDetail.data.goodsPaymentSummary.shiftId}` : ""}`
                        : quickPoDetail.data.goodsPaymentSummary.sourceMode === "TREASURY"
                          ? "خزينة الفرع"
                          : quickPoDetail.data.goodsPaymentSummary.sourceMode === "CARD"
                            ? `بطاقة الشركة${quickPoDetail.data.goodsPaymentSummary.cardLastFour ? ` (${quickPoDetail.data.goodsPaymentSummary.cardLastFour})` : ""}`
                            : "المصدر المثبّت"}
                    </span>
                  </div>
                  <div>
                    المتبقي للصرف على البضاعة:{" "}
                    <span className="font-semibold">
                      {fmt(quickPoDetail.data.goodsPaymentSummary.remainingPayable)} د.ع
                    </span>
                    {quickPoDetail.data.goodsPaymentSummary.availableCash != null
                      ? ` · المتاح: ${fmt(quickPoDetail.data.goodsPaymentSummary.availableCash)} د.ع`
                      : ""}
                  </div>
                  {quickPoDetail.data.goodsPaymentSummary.hasShortage &&
                  quickPoDetail.data.goodsPaymentSummary.warningMessage ? (
                    <p role="alert" className="text-[var(--sem-warn)]">
                      {quickPoDetail.data.goodsPaymentSummary.warningMessage}
                    </p>
                  ) : null}
                  <p className="text-[11px] text-muted-foreground">
                    لتغيير مصدر السداد قبل الصرف، افتح{" "}
                    <Link
                      href={`/purchases/${target?.id}`}
                      className="underline text-primary"
                    >
                      تفاصيل الأمر
                    </Link>{" "}
                    واستخدم «تصحيح مصدر السداد».
                  </p>
                </div>
              ) : (
                <PurchaseCashSourceField
                  idPrefix="quick-approve"
                  context="approval"
                  state={quickCashSourceState}
                />
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleClose}
            disabled={decideControlMut.isPending}
          >
            إلغاء
          </Button>
          <SubmitButton
            size="sm"
            pending={decideControlMut.isPending}
            onClick={() => {
              if (!target?.controlRequestId) return;
              decideControlMut.mutate({
                requestId: target.controlRequestId,
                decisionKey: `decide-row-${target.controlRequestId}-${crypto.randomUUID()}`,
                approve: true,
                reason: reason.trim() || "اعتماد واستلام البضاعة كاملة",
                confirmedFullReceipt: true,
                cashSource:
                  isQuickCashIqd && !quickHasCanonicalTender
                    ? quickCashSourceState.payload
                    : undefined,
              });
            }}
            disabled={
              reason.trim().length < 3 ||
              (isQuickCashIqd && quickPoDetail.isLoading) ||
              (isQuickCashIqd && quickPoDetail.isError) ||
              (!quickHasCanonicalTender && quickCashSourceState.isActionBlocked)
            }
          >
            {isQuickCashIqd
              ? "اعتماد واستلام وسداد نقدي فوري"
              : "تأكيد الاعتماد والاستلام"}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

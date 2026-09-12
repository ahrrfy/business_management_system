import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ACTION_LABELS } from "@shared/actionLabels";

export interface ShiftFundingDecisionDialogsProps {
  rejectFundingId: number | null;
  fundingRejectionReason: string;
  setFundingRejectionReason: (v: string) => void;
  onCloseReject: () => void;
  onConfirmReject: () => void;
  isRejectPending: boolean;

  cancelFundingId: number | null;
  fundingCancellationReason: string;
  setFundingCancellationReason: (v: string) => void;
  onCloseCancel: () => void;
  onConfirmCancel: () => void;
  isCancelPending: boolean;
}

export function ShiftFundingDecisionDialogs({
  rejectFundingId,
  fundingRejectionReason,
  setFundingRejectionReason,
  onCloseReject,
  onConfirmReject,
  isRejectPending,
  cancelFundingId,
  fundingCancellationReason,
  setFundingCancellationReason,
  onCloseCancel,
  onConfirmCancel,
  isCancelPending,
}: ShiftFundingDecisionDialogsProps) {
  return (
    <>
      <Dialog
        open={rejectFundingId != null}
        onOpenChange={(open) => {
          if (!open) onCloseReject();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>رفض استلام العهدة النقدية</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="shift-funding-rejection" className="text-sm font-bold">
              سبب عدم الاستلام
            </label>
            <Textarea
              id="shift-funding-rejection"
              rows={3}
              maxLength={500}
              value={fundingRejectionReason}
              onChange={(event) => setFundingRejectionReason(event.target.value)}
              placeholder="لم أستلم النقد فعلياً أو المبلغ لا يطابق الطلب"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCloseReject}>
              رجوع
            </Button>
            <Button
              variant="destructive"
              disabled={isRejectPending || fundingRejectionReason.trim().length < 5}
              onClick={onConfirmReject}
            >
              {isRejectPending ? ACTION_LABELS.rejecting : "تأكيد الرفض بلا أثر نقدي"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelFundingId != null}
        onOpenChange={(open) => {
          if (!open) onCloseCancel();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إلغاء طلب تسليم العهدة</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              الإلغاء لا يغيّر الخزينة أو الدرج، ويعيد إتاحة سحب المصدر لطلب صحيح لاحقاً.
            </p>
            <label htmlFor="shift-funding-cancellation" className="text-sm font-bold">
              سبب الإلغاء
            </label>
            <Textarea
              id="shift-funding-cancellation"
              rows={3}
              maxLength={500}
              value={fundingCancellationReason}
              onChange={(event) => setFundingCancellationReason(event.target.value)}
              placeholder="تعذّر التسليم الفعلي أو لم تعد الوردية تحتاج المبلغ"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCloseCancel}>
              رجوع
            </Button>
            <Button
              variant="destructive"
              disabled={isCancelPending || fundingCancellationReason.trim().length < 5}
              onClick={onConfirmCancel}
            >
              {isCancelPending ? ACTION_LABELS.cancelling : "إلغاء الطلب بلا أثر نقدي"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

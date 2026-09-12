import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_LABELS } from "@shared/actionLabels";

export interface VoucherRejectTarget {
  id: number | string;
  voucherNumber?: string | null;
  referenceNumber?: string | null;
}

interface VoucherRejectDialogProps {
  rejectTarget: VoucherRejectTarget | null;
  rejectReason: string;
  setRejectReason: (reason: string) => void;
  isPending: boolean;
  onClose: () => void;
  onSubmit: () => void;
}

function isPurchaseSupplierPaymentReference(
  reference?: string | null,
): boolean {
  return (
    !!reference &&
    (reference.startsWith("PO-PAY-") || reference.startsWith("PO-USD-PAY-"))
  );
}

function getRejectDescription(referenceNumber?: string | null): string {
  if (referenceNumber?.startsWith("TERM-SETTLEMENT-")) {
    return "سبب الرفض إلزامي. يُرفض طلب الدفع فقط؛ يبقى إنهاء الخدمة مثبتاً وتبقى التسوية غير مدفوعة، ويمكن إعادة تقديمها صراحةً من السجل بلا تكرار.";
  }
  if (isPurchaseSupplierPaymentReference(referenceNumber)) {
    return "سبب الرفض إلزامي. لا تتغير ذمة المورد أو أمر الشراء، ويمكن إعادة تقديم الطلب مرتبطاً بالأمر نفسه بعد التصحيح.";
  }
  if (referenceNumber?.startsWith("ASSET-ACQ-")) {
    return "سبب الرفض إلزامي. يُرفض طلب التسوية فقط؛ يبقى الأصل والتزام اقتنائه مثبتين، ويمكن إعادة تقديم الدفع صراحةً بلا تكرار الأصل أو القيد.";
  }
  if (
    referenceNumber &&
    (referenceNumber.startsWith("SHIP-") ||
      referenceNumber.startsWith("ASSET-MAINT-"))
  ) {
    return "سبب الرفض إلزامي. يُرفض طلب الدفع فقط؛ يبقى المصروف وقيد استحقاقه مثبتين، ولا يُنشأ طلب بديل حتى إعادة تقديمه صراحةً.";
  }
  return "سبب الرفض إلزامي للسجل التَدقيقي — يَبقى السند في السجل بلا أي أَثَر مالي.";
}

export function VoucherRejectDialog({
  rejectTarget,
  rejectReason,
  setRejectReason,
  isPending,
  onClose,
  onSubmit,
}: VoucherRejectDialogProps) {
  return (
    <Dialog
      open={rejectTarget != null}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            رفض السند {rejectTarget?.voucherNumber ?? ""}
          </DialogTitle>
          <DialogDescription>
            {getRejectDescription(rejectTarget?.referenceNumber)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="voucher-reject-reason">سبب الرفض *</Label>
          <Textarea
            id="voucher-reject-reason"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="مَثلاً: المبلغ لا يطابق المستند المُرفَق"
            rows={3}
            maxLength={500}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isPending}
          >
            تراجع
          </Button>
          <Button
            variant="destructive"
            onClick={onSubmit}
            disabled={!rejectReason.trim() || isPending}
          >
            {isPending ? ACTION_LABELS.rejecting : "رفض السند"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { validAccrualReissueReason } from "./voucherUiPolicy";

export function isPurchaseSupplierPaymentReference(
  reference?: string | null,
): boolean {
  return (
    !!reference &&
    (reference.startsWith("PO-PAY-") || reference.startsWith("PO-USD-PAY-"))
  );
}

export interface ResubmitVoucherDialogProps {
  resubmitTarget: {
    id: number | string;
    voucherNumber?: string | null;
    referenceNumber?: string | null;
    resubmitAttempt?: number | null;
    attachmentUrl?: string | null;
  } | null;
  onClose: () => void;
  onSubmit: () => void;
  reissueReason: string;
  setReissueReason: (val: string) => void;
  resubmitNote: string;
  setResubmitNote: (val: string) => void;
  resubmitAttachmentImages: ImageItem[];
  setResubmitAttachmentImages: (images: ImageItem[]) => void;
  isPending: boolean;
}

export function ResubmitVoucherDialog({
  resubmitTarget,
  onClose,
  onSubmit,
  reissueReason,
  setReissueReason,
  resubmitNote,
  setResubmitNote,
  resubmitAttachmentImages,
  setResubmitAttachmentImages,
  isPending,
}: ResubmitVoucherDialogProps) {
  const isPoPayment = isPurchaseSupplierPaymentReference(
    resubmitTarget?.referenceNumber,
  );

  return (
    <Dialog
      open={resubmitTarget != null}
      onOpenChange={(open) => {
        if (!open && !isPending) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isPoPayment
              ? resubmitTarget?.referenceNumber?.startsWith("PO-USD-PAY-")
                ? "إعادة إصدار تسديد USD"
                : "إعادة إصدار دفعة المورد"
              : "إعادة إصدار طلب الدفع"}{" "}
            {resubmitTarget?.voucherNumber ?? ""}
          </DialogTitle>
          <DialogDescription>
            {isPoPayment ? (
              <>
                يبقى السند المرفوض محفوظاً. تُنشأ محاولة A
                {(resubmitTarget?.resubmitAttempt ?? 0) + 1} مرتبطة بالسند #
                {resubmitTarget?.id ?? "—"} وبأمر الشراء نفسه، بعد إعادة فحص
                رصيده الدفتري، بلا تغيير ذمة المورد أو أثر نقدي قبل اعتماد
                المالك.
              </>
            ) : (
              <>
                يبقى السند المرفوض محفوظاً. تُنشأ محاولة A
                {(resubmitTarget?.resubmitAttempt ?? 0) + 1} مرتبطة بالسند #
                {resubmitTarget?.id ?? "—"}، بلا تكرار للمصروف أو الأصل أو قيد
                الاعتراف وبلا أثر نقدي قبل اعتماد المالك.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="voucher-reissue-reason">سبب إعادة الإصدار *</Label>
          <Textarea
            id="voucher-reissue-reason"
            value={reissueReason}
            onChange={(event) => setReissueReason(event.target.value)}
            placeholder="مثلاً: أُرفقت فاتورة النقل المصححة"
            rows={3}
            minLength={5}
            maxLength={500}
            autoFocus
          />
          <div className="text-[11px] text-muted-foreground">
            السبب جزء ثابت من سلسلة التدقيق ولا يمكن استبداله بعد إنشاء
            المحاولة.
          </div>
        </div>
        <div className="space-y-1">
          <Label>المستند المصحح (اختياري)</Label>
          <ImageUploader
            value={resubmitAttachmentImages}
            onChange={setResubmitAttachmentImages}
            maxItems={1}
            maxSizeMB={2}
            singlePrimary={false}
            hint="اختر مستند المحاولة الجديدة. مرفق السند المرفوض لا يُنقل تلقائياً."
          />
          {resubmitTarget?.attachmentUrl && (
            <a
              href={resubmitTarget.attachmentUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs underline text-muted-foreground"
            >
              فتح مرفق المحاولة المرفوضة للمراجعة فقط
            </a>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="voucher-reissue-note">
            ملاحظة المحاولة (اختيارية)
          </Label>
          <Textarea
            id="voucher-reissue-note"
            value={resubmitNote}
            onChange={(event) => setResubmitNote(event.target.value)}
            placeholder="ملاحظة تشغيلية تضاف إلى وصف المحاولة الجديدة"
            rows={2}
            maxLength={500}
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
            onClick={onSubmit}
            disabled={!validAccrualReissueReason(reissueReason) || isPending}
          >
            {isPending ? "جارٍ إنشاء المحاولة…" : "إنشاء محاولة مرتبطة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

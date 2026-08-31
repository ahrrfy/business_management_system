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

export function PurchaseCancellationDialog({
  open,
  reference,
  description,
  reason,
  pending,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  reference: string;
  description: string;
  reason: string;
  pending: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>طلب إلغاء {reference}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="purchase-cancellation-reason">سبب الإلغاء</Label>
          <Textarea
            id="purchase-cancellation-reason"
            value={reason}
            maxLength={500}
            rows={4}
            placeholder="اكتب السبب التشغيلي أو الإداري المحدد للإلغاء"
            onChange={(event) => onReasonChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">مطلوب: 3–500 محرف، ويظهر للمراجع وفي سجل المستند.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>تراجع</Button>
          <Button variant="destructive" onClick={onSubmit} disabled={pending || reason.trim().length < 3}>
            {pending ? "جارٍ إرسال الطلب…" : "إرسال طلب الإلغاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

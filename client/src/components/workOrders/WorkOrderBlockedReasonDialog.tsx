import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_LABELS } from "@shared/actionLabels";

export function WorkOrderBlockedReasonDialog({
  target,
  onClose,
  onConfirm,
  pending,
}: {
  target: { id: number; orderNumber: string; title: string } | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (target) setReason(""); }, [target?.id]); // eslint-disable-line
  if (!target) return null;
  const trimmed = reason.trim();
  const tooLong = trimmed.length > 255;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تعطيل الأمر — سبب مطلوب</DialogTitle>
          <DialogDescription>
            الأمر «{target.title}» ({target.orderNumber}) — اكتب سبب التعطّل موجزاً.
            سيظهر في تلميح البطاقة وفي سجلّ أحداث الأمر.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-1">
          <Label htmlFor="wob-blocked-reason">سبب التعطّل</Label>
          <Textarea
            id="wob-blocked-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثال: بانتظار موافقة العميل على التصميم، أو نفاد لون خامّ، أو عطل الطابعة…"
            rows={3}
            maxLength={255}
            autoFocus
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{trimmed.length}/255</span>
            {tooLong && <span className="text-[var(--sem-neg)]">أقصاه ٢٥٥ حرفاً</span>}
          </div>
        </div>
        <DialogFooter>
          <button type="button" className="wob-btn" onClick={onClose} disabled={pending}>تراجع</button>
          <button
            type="button"
            className="wob-btn wob-btn-primary"
            disabled={pending || !trimmed || tooLong}
            onClick={() => onConfirm(trimmed)}
          >
            {pending ? ACTION_LABELS.saving : "وسْم كمعطَّل"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

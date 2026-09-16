import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACTION_LABELS } from "@shared/actionLabels";

export function ReconcileReasonDialog({
  open,
  onOpenChange,
  reasonKind,
  reasonText,
  onReasonTextChange,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reasonKind: "STOP" | "CLEAR_POLICY";
  reasonText: string;
  onReasonTextChange: (text: string) => void;
  isPending: boolean;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onOpenChange(false);
          onReasonTextChange("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {reasonKind === "STOP"
              ? "إيقاف الدفتر المزدوج إلى OFF؟"
              : "مسح مصادقة السياسة؟"}
          </DialogTitle>
          <DialogDescription>
            {reasonKind === "STOP"
              ? "ستتوقف كتابة القيود المزدوجة الجديدة، وتبقى اليوميات السابقة محفوظة ولن تُحذف. يُحفظ السبب في سجل التدقيق."
              : "تُمسح مصادقة المحاسب على سياسة الترحيل، ويُحفظ السبب في سجل التدقيق."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="reconcile-reason">
            {reasonKind === "STOP" ? "سبب الإيقاف" : "سبب المسح"}
          </label>
          <Textarea
            id="reconcile-reason"
            value={reasonText}
            onChange={(event) => onReasonTextChange(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder="اكتب سبباً واضحاً يفهمه من يراجع سجل التدقيق لاحقاً"
          />
          <p className="text-[11px] text-muted-foreground">
            10 أحرف على الأقل.
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onReasonTextChange("");
            }}
          >
            تراجع
          </Button>
          <SubmitButton
            type="button"
            variant="destructive"
            pending={isPending}
            pendingText={ACTION_LABELS.processing}
            disabled={reasonText.trim().length < 10}
            onClick={onSubmit}
          >
            {reasonKind === "STOP" ? "تأكيد الإيقاف إلى OFF" : "تأكيد المسح"}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

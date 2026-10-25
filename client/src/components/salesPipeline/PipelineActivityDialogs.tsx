import { useEffect, useState } from "react";
import {
  SALES_LEAD_STATUS_LABELS,
  SALES_OPPORTUNITY_STAGE_LABELS,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";
import type { PipelineOptions } from "./types";
import { AppSelect } from "@/components/ui/AppSelect";
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
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
export function PipelineTransitionDialog({
  open,
  onOpenChange,
  kind,
  branchId,
  optionsError = false,
  onRetryOptions,
  leadStatus,
  opportunityStage,
  options,
  customerId,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "LEAD" | "OPPORTUNITY";
  branchId: number | null;
  optionsError?: boolean;
  onRetryOptions?: () => void;
  leadStatus?: SalesLeadStatus;
  opportunityStage?: SalesOpportunityStage;
  options: PipelineOptions;
  customerId?: number | null;
  pending: boolean;
  onSubmit: (value: { reason: string; invoiceId: number | null }) => void;
}) {
  const [reason, setReason] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  useEffect(() => {
    if (open) {
      setReason("");
      setInvoiceId("");
    }
  }, [open, branchId, kind, leadStatus, opportunityStage, customerId]);
  const won = kind === "OPPORTUNITY" && opportunityStage === "WON";
  const optionsReady =
    !optionsError && branchId != null && options.selectedBranchId === branchId;
  const invoices = (optionsReady ? options.invoices : []).filter(
    (item) =>
      customerId == null ||
      item.customerId == null ||
      item.customerId === customerId,
  );
  const label =
    kind === "LEAD" && leadStatus
      ? SALES_LEAD_STATUS_LABELS[leadStatus]
      : opportunityStage
        ? SALES_OPPORTUNITY_STAGE_LABELS[opportunityStage]
        : "الحالة";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0">
        <DialogHeader>
          <DialogTitle>نقل إلى «{label}»</DialogTitle>
          <DialogDescription>
            يسجل السبب في خط الأحداث ولا يمكن محوه. تأكد من واقعية الحالة قبل
            الحفظ.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          {won && (
            <div>
              <Label htmlFor="transition-invoice">فاتورة الفوز</Label>
              <AppSelect
                id="transition-invoice"
                value={invoiceId}
                disabled={!optionsReady}
                onValueChange={setInvoiceId}
              >
                <option value="">اختر الفاتورة</option>
                {invoices.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.invoiceNumber} · {item.total}
                  </option>
                ))}
              </AppSelect>
              {!optionsReady ? (
                <div
                  className="mt-2 text-xs text-muted-foreground"
                  role={optionsError ? "alert" : "status"}
                >
                  {optionsError
                    ? "تعذر تحميل فواتير فرع الفرصة."
                    : "يلزم تحميل فواتير فرع الفرصة قبل تأكيد الفوز."}
                  {optionsError && onRetryOptions ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ms-2"
                      onClick={onRetryOptions}
                    >
                      إعادة المحاولة
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
          <div>
            <Label htmlFor="transition-reason">سبب الانتقال</Label>
            <Textarea
              id="transition-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            إلغاء
          </Button>
          <SubmitButton
            pending={pending}
            disabled={
              reason.trim().length < 3 ||
              (won &&
                (!optionsReady ||
                  !invoices.some((item) => String(item.id) === invoiceId)))
            }
            onClick={() =>
              onSubmit({ reason, invoiceId: Number(invoiceId) || null })
            }
          >
            تأكيد الانتقال
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PipelineHistoryDialog({
  open,
  onOpenChange,
  title,
  loading,
  error,
  onRetry,
  events,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  events: Array<{
    id: number;
    eventType: string;
    reason: string;
    actorName: string | null;
    occurredAt: Date | string;
  }>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0">
        <DialogHeader>
          <DialogTitle>سجل {title}</DialogTitle>
          <DialogDescription>
            خط زمني تراكمي لكل إنشاء وتعديل وانتقال.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            جارٍ تحميل السجل…
          </p>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-sm text-destructive">تعذّر تحميل السجل.</p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={onRetry}
            >
              إعادة المحاولة
            </Button>
          </div>
        ) : (
          <div className="min-w-0 max-h-[55vh] space-y-2 overflow-y-auto [overflow-wrap:anywhere]">
            {events.map((event) => (
              <div key={event.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b className="text-sm">{event.eventType}</b>
                  <span className="text-2xs text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString(
                      "ar-IQ-u-nu-latn",
                    )}
                  </span>
                </div>
                <p className="mt-1 text-xs">{event.reason}</p>
                <p className="mt-1 text-2xs text-muted-foreground">
                  بواسطة {event.actorName || "مستخدم"}
                </p>
              </div>
            ))}
            {!events.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                لا أحداث.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { Plus, Split, Trash2 } from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtAr } from "@/lib/money";
import { INBOUND_ENABLED_PAYMENT_METHODS } from "@shared/inboundPaymentPolicy";
import { paymentMethodCompact } from "@shared/terms";
import type { SplitTenderDraft } from "./useSplitTender";
import { remainingTenderPart, tenderAmount, type TenderMethod } from "./splitTender";

export function SplitTenderButton({
  draft,
  due,
  disabled = false,
  reason,
}: {
  draft: SplitTenderDraft;
  due: string;
  disabled?: boolean;
  reason?: string | null;
}) {
  const open = draft.editorOpen;
  const setOpen = draft.setEditorOpen;
  const total = draft.totals(due);
  return (
    <>
      <span title={reason ?? undefined}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            if (!draft.active) draft.enable(due);
            setOpen(true);
          }}
        >
          <Split aria-hidden className="size-3.5" />
          {draft.active
            ? `دفع مقسّم · ${fmtAr(draft.tendered)} د.ع`
            : "تقسيم الدفع"}
        </Button>
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-xl max-h-[90dvh] overflow-y-auto"
          dir="rtl"
          data-split-tender-editor=""
        >
          <DialogHeader>
            <DialogTitle>تقسيم الدفع</DialogTitle>
            <DialogDescription>
              وزّع المقبوض على طرق الدفع الفعلية. أكّد كل دفعة غير نقدية
              بمرجعها؛ النقد وحده يدخل الدرج. أجرة التوصيل المقبوضة منفصلة عن
              هذه الدفعات.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {draft.parts.map((part, index) => (
              <section
                key={part.id}
                className="rounded-md border p-3 space-y-2"
                aria-label={`الدفعة ${index + 1}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm">الدفعة {index + 1}</strong>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`حذف الدفعة ${index + 1}`}
                    disabled={
                      draft.pendingId != null || draft.parts.length <= 1
                    }
                    onClick={() => draft.remove(part.id)}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </div>
                {draft.proofAmount(part,index)!==tenderAmount(part.amount).toFixed(2)&&<p className="mb-2 text-xs">القبض الفعلي مع الأجور: <strong dir="ltr">{fmtAr(draft.proofAmount(part,index))}</strong> د.ع</p>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label>طريقة الدفع</Label>
                    <AppSelect
                      value={part.method}
                      disabled={draft.pendingId != null}
                      onValueChange={(value) =>
                        draft.update(part.id, { method: value as TenderMethod })
                      }
                    >
                      {INBOUND_ENABLED_PAYMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {paymentMethodCompact(method)}
                        </option>
                      ))}
                    </AppSelect>
                  </div>
                  <div className="space-y-1">
                    <Label>المبلغ</Label>
                    <MoneyInput
                      ariaLabel={`مبلغ الدفعة ${index + 1}`}
                      value={part.amount}
                      onChange={(amount) => draft.update(part.id, { amount })}
                      disabled={draft.pendingId != null}
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={draft.pendingId != null}
                  onClick={() =>
                    draft.update(part.id, {
                      amount: remainingTenderPart(draft.parts, due, part.id),
                    })
                  }
                >
                  تعبئة المتبقي
                </Button>
                {part.method !== "CASH" && (
                  <div className="space-y-2">
                    <Label htmlFor={`split-ref-${part.id}`}>
                      مرجع عملية الدفع
                    </Label>
                    <Input
                      id={`split-ref-${part.id}`}
                      dir="ltr"
                      value={part.reference}
                      maxLength={100}
                      disabled={draft.pendingId != null}
                      onChange={(event) =>
                        draft.update(part.id, { reference: event.target.value })
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        draft.pendingId != null ||
                        part.proof?.confirmed === true
                      }
                      onClick={() => void draft.confirm(part.id)}
                    >
                      {draft.pendingId === part.id
                        ? "جارٍ التحقق…"
                        : part.proof?.confirmed
                          ? "الدفعة مؤكدة"
                          : "تأكيد نجاح العملية لدى المزوّد"}
                    </Button>
                  </div>
                )}
              </section>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={draft.parts.length >= 10 || draft.pendingId != null}
            onClick={draft.add}
          >
            <Plus aria-hidden className="size-4" />
            إضافة دفعة
          </Button>
          <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
            <p>
              المستحق الآن: <b dir="ltr">{fmtAr(due)}</b> د.ع
            </p>
            <p>
              مجموع الدفعات: <b dir="ltr">{fmtAr(draft.tendered)}</b> د.ع
            </p>
            {total.change.gt(0) ? (
              <p>
                الفكة من النقد:{" "}
                <b dir="ltr">{fmtAr(total.change.toFixed(2))}</b> د.ع
              </p>
            ) : (
              <p>
                المتبقي: <b dir="ltr">{fmtAr(total.remaining.toFixed(2))}</b>{" "}
                د.ع
              </p>
            )}
          </div>
          {draft.error && (
            <p role="alert" className="text-sm text-destructive">
              {draft.error}
            </p>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={draft.pendingId != null}
              onClick={() => {
                draft.reset();
                setOpen(false);
              }}
            >
              العودة إلى دفعة واحدة
            </Button>
            <Button
              disabled={draft.pendingId != null}
              onClick={() => {
                if (draft.payments(due)) setOpen(false);
              }}
            >
              اعتماد التقسيم
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

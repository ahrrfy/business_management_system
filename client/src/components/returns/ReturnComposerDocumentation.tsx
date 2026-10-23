import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ReturnComposerModel } from "./useReturnComposer";
import { QUICK_REASONS } from "./returnComposerTypes";

type Props = Pick<
  ReturnComposerModel,
  | "restock"
  | "setRestock"
  | "reason"
  | "setReason"
  | "setError"
  | "qtyLocked"
  | "isLocked"
>;
export function ReturnComposerDocumentation({
  restock,
  setRestock,
  reason,
  setReason,
  setError,
  qtyLocked,
  isLocked,
}: Props) {
  return (
    <div className="lg:col-span-5 space-y-3">
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-sm font-bold">
            سبب الإرجاع والتوثيق
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {QUICK_REASONS.map((qr) => (
                <button
                  key={qr}
                  type="button"
                  disabled={isLocked || qtyLocked}
                  onClick={() => {
                    setReason(qr);
                    setError("");
                  }}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-xs transition-colors",
                    reason === qr
                      ? "bg-primary text-primary-foreground border-primary font-bold"
                      : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {qr}
                </button>
              ))}
            </div>
            <Input
              id="ret-reason"
              value={reason}
              maxLength={500}
              disabled={isLocked || qtyLocked}
              onChange={(event) => {
                setReason(event.target.value);
                setError("");
              }}
              placeholder="اختر سبباً من الأزرار أو اكتب هنا..."
              className="h-9 text-xs"
            />
          </div>

          {/* حالة البضاعة */}
          <div className="space-y-1">
            <Label className="text-xs font-semibold">
              حالة البضاعة العائدة
            </Label>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="حالة البضاعة العائدة"
            >
              <button
                type="button"
                role="radio"
                aria-checked={restock}
                disabled={isLocked}
                onClick={() => setRestock(true)}
                className={`rounded-lg border p-2.5 text-start text-xs font-bold transition-all ${restock ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted text-muted-foreground"}`}
              >
                سليمة — تعود للرفّ
                <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                  تُضاف للمخزون للبيع ثانية
                </div>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!restock}
                disabled={isLocked}
                onClick={() => setRestock(false)}
                className={`rounded-lg border p-2.5 text-start text-xs font-bold transition-all ${!restock ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]/60 text-stock-low" : "bg-card hover:bg-muted text-muted-foreground"}`}
              >
                تالفة — هدر وعزل
                <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                  خسارة ولا تُضاف للرفّ
                </div>
              </button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmtAr, D, positiveDiff, round2 } from "@/lib/money";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";
import type { DeliverTarget } from "./workOrderTypes";

const dlgInput = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function WorkOrderDeliverDialog({
  order,
  onClose,
  onConfirm,
  pending,
}: {
  order: DeliverTarget | null;
  onClose: () => void;
  onConfirm: (payment?: { amount: string; method: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; reference?: string }) => void;
  pending: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [methodV, setMethodV] = useState<"CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET">("CASH");
  const [reference, setReference] = useState("");
  useEffect(() => {
    if (order) {
      // تعبئة المتبقّي تلقائياً = سعر البيع − العربون المقبوض (لا طرح يدويّ من الموظّف).
      const dueInit = positiveDiff(order.salePrice, order.deposit ?? 0);
      setAmount(dueInit.gt(0) ? dueInit.toFixed(2) : "");
      setMethodV("CASH");
      setReference("");
    }
  }, [order?.id]); // eslint-disable-line
  if (!order) return null;
  const amtD = D(amount);
  const hasDep = D(order.deposit ?? 0).gt(0);
  const due = positiveDiff(order.salePrice, order.deposit ?? 0);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تسليم وإصدار فاتورة</DialogTitle>
          <DialogDescription>
            الأمر «{order.title}» ({order.orderNumber}) — سعر البيع {fmtAr(order.salePrice)} د.ع.
            سيُصدر فاتورة فوراً ويُحدَّث المخزون والذمم. هذا إجراء لا رجعة فيه.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmtAr(order.salePrice)} د.ع</span></div>
            {hasDep && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-[var(--sem-pos)]">−{fmtAr(order.deposit)} د.ع</span></div>}
            <div className="flex justify-between border-t pt-1 font-bold"><span>الرصيد المستحق</span><span dir="ltr" className="tabular-nums">{fmtAr(due.toFixed(2))} د.ع</span></div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">المبلغ المدفوع الآن (الافتراضي = الرصيد المستحق؛ أقل = آجل)</label>
            <MoneyInput value={amount} onChange={setAmount} className={dlgInput} placeholder={`0 – ${fmtAr(due.toFixed(2))}`} />
          </div>
          {methodV !== "CASH" && (
            <div className="space-y-1">
              <label className="text-sm font-medium">مرجع العملية <span className="text-destructive">*</span></label>
              <input className={dlgInput} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="رقم موافقة البطاقة أو رقم التحويل" />
              <p className="text-xs text-muted-foreground">لا تُحفظ دفعة إلكترونية بلا مرجع قابل للمطابقة.</p>
            </div>
          )}
          <div className="space-y-1">
            <label htmlFor="wo-deliver-method" className="text-sm font-medium">طريقة الدفع</label>
            {/* تعطيلُ الخيار محفوظ كما هو — سياسة القبض (isPosPaymentMethodEnabled) تبقى مُنفَّذة. */}
            <AppSelect id="wo-deliver-method" value={methodV} onValueChange={(value) => setMethodV(value as typeof methodV)}>
              <option value="CASH">نقدي</option>
              <option value="CARD" disabled={!isPosPaymentMethodEnabled("CARD")}>بطاقة</option>
              <option value="TRANSFER" disabled={!isPosPaymentMethodEnabled("TRANSFER")}>تحويل</option>
              <option value="WALLET" disabled={!isPosPaymentMethodEnabled("WALLET")}>محفظة</option>
            </AppSelect>
          </div>
        </div>
        <DialogFooter>
          <button className="wob-btn wob-btn-ghost" onClick={onClose} disabled={pending}>إلغاء</button>
          <button className="wob-btn wob-btn-primary" disabled={pending || !isPosPaymentMethodEnabled(methodV) || (amtD.gt(0) && methodV !== "CASH" && !reference.trim())}
            onClick={() => {
              if (!isPosPaymentMethodEnabled(methodV)) return;
              onConfirm(amtD.gt(0)
                ? { amount: round2(amtD).toFixed(2), method: methodV, reference: methodV === "CASH" ? undefined : reference.trim() }
                : undefined);
            }}>
            {pending ? "جارٍ…" : "تسليم وإصدار الفاتورة"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

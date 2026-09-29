import { ShieldCheck } from "lucide-react";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt, positiveDiff } from "@/lib/money";
import { cn } from "@/lib/utils";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

export const WO_PAYMENT_METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];

export type WoPaymentMethod = (typeof WO_PAYMENT_METHODS)[number]["v"];

interface WorkOrderDeliveryPaymentCardProps {
  salePrice: string | number;
  deposit?: string | number | null;
  remainingDue: Decimal;
  payAmount: string;
  setPayAmount: (val: string) => void;
  payMethod: WoPaymentMethod;
  setPayMethod: (val: WoPaymentMethod) => void;
  payReference: string;
  setPayReference: (val: string) => void;
  deliveryMgrApproval: { email: string; password: string } | null;
  onClearMgrApproval: () => void;
  onRequestMgrApproval: () => void;
}

export function WorkOrderDeliveryPaymentCard({
  salePrice,
  deposit,
  remainingDue,
  payAmount,
  setPayAmount,
  payMethod,
  setPayMethod,
  payReference,
  setPayReference,
  deliveryMgrApproval,
  onClearMgrApproval,
  onRequestMgrApproval,
}: WorkOrderDeliveryPaymentCardProps) {
  const payAmountD = D(payAmount || "0");
  const unpaidRemainder = positiveDiff(remainingDue.toFixed(2), payAmountD.toFixed(2));
  const hasUnpaidRemainder = unpaidRemainder.gt(0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">دفعة عند التسليم (اختياري)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">سعر البيع</span>
            <span dir="ltr" className="tabular-nums">{fmt(salePrice)} د.ع</span>
          </div>
          {D(deposit ?? 0).gt(0) && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">العربون المقبوض</span>
              <span dir="ltr" className="tabular-nums text-[var(--sem-pos)]">−{fmt(deposit)} د.ع</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-1 font-bold">
            <span>الرصيد المستحق</span>
            <span dir="ltr" className="tabular-nums">{fmt(remainingDue.toFixed(2))} د.ع</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="space-y-1">
            <Label>المبلغ المدفوع الآن (الافتراضي = المستحق)</Label>
            <MoneyInput value={payAmount} onChange={setPayAmount} placeholder="الرصيد المستحق" ariaLabel="مبلغ الدفعة" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wo-pay-method">طريقة الدفع</Label>
            <AppSelect id="wo-pay-method" value={payMethod} onValueChange={(value) => setPayMethod(value as WoPaymentMethod)}>
              {WO_PAYMENT_METHODS.map((m) => (
                <option key={m.v} value={m.v} disabled={!isPosPaymentMethodEnabled(m.v)}>
                  {m.label}
                </option>
              ))}
            </AppSelect>
          </div>
          {payMethod !== "CASH" && (
            <div className="space-y-1">
              <Label htmlFor="pay-ref">مرجع العملية {payAmountD.gt(0) && <span className="text-destructive">*</span>}</Label>
              <Input
                id="pay-ref"
                dir="ltr"
                value={payReference}
                onChange={(e) => setPayReference(e.target.value)}
                placeholder="رقم إشعار الجهاز/التحويل"
                className={cn(payReference.trim() === "" && payAmountD.gt(0) && "border-[var(--sem-warn)]")}
              />
              {payReference.trim() === "" && payAmountD.gt(0) && (
                <p className="text-[11px] text-[var(--sem-warn)]">
                  مطلوب لمطابقة دفعة {WO_PAYMENT_METHODS.find((m) => m.v === payMethod)?.label} مع كشف الحساب.
                </p>
              )}
            </div>
          )}
        </div>

        {hasUnpaidRemainder && (
          <div className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs space-y-2">
            <div className="flex items-center justify-between font-bold text-[var(--sem-warn)]">
              <span>متبقٍ غير مستحصل:</span>
              <span dir="ltr" className="tabular-nums font-mono text-sm">{fmt(unpaidRemainder.toFixed(2))} د.ع</span>
            </div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              وفقاً لسياسة الرقابة المالية، يُمنع تسليم الطلب بمتبقٍ غير مستحصل إلا بعد استيفاء المبلغ كاملاً أو الحصول على اعتماد المسؤول لتحويله إلى ذمة العميل.
            </p>
            {deliveryMgrApproval ? (
              <div className="flex items-center justify-between rounded bg-card/80 p-2 border border-border">
                <span className="flex items-center gap-1.5 text-[var(--sem-pos)] font-semibold text-xs">
                  <ShieldCheck aria-hidden className="size-4 shrink-0" />
                  تم اعتماد إضافة المتبقي لذمة العميل
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground"
                  onClick={onClearMgrApproval}
                >
                  إلغاء الاعتماد
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full text-xs font-semibold"
                onClick={onRequestMgrApproval}
              >
                طلب اعتماد المدير لإضافة المتبقي لذمة العميل
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

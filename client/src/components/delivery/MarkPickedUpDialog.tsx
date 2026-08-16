import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt, positiveDiff } from "@/lib/money";
import { cn } from "@/lib/utils";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";

const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];
type Method = (typeof METHODS)[number]["v"];

export interface PickupOrder {
  id: number;
  orderNumber: string;
  title: string;
  salePrice: string;
  deposit?: string | null;
}

export interface PickupPayment {
  amount: string;
  method: Method;
  reference?: string;
}

/**
 * حوار «استلام مباشر» (بلا توصيل) — اِستقبال (تكامل التوصيل، ٤/٨): يُستدعى من طابور استقبال أوامر
 * الشغل (ReceptionOrderQueue) لأوامر READY بلا `hasDelivery`. يُعيد إنتاج نموذج الدفع في
 * WorkOrderDetail.tsx (المبلغ/الطريقة/المرجع) داخل حوارٍ منبثق بدل صفحة كاملة.
 *
 * النافذة نفسها هي حوار التأكيد (نمط DispatchDialog المجاور) — لا نُكدّس `confirm()` فوق حوارٍ يدويّ
 * z-[100] (علّة تجمّد موثَّقة سابقاً في DeliveryHub: طبقة confirm() الأدنى z-50 تُحجَب خلف الحوار
 * اليدويّ فتُخيَّل الشاشة مجمَّدة). مراجعة عدائية (٤/٨): هذا المسار وWorkOrderDetail.tsx كلاهما
 * يستدعيان workOrders.deliver نفسها (لا رجعة — فاتورة تُصدَر) لكن ذاك يفرض كتابة «تسليم» للتأكيد
 * (confirm requireText) بينما هذا كان نقرة واحدة فقط — فجوة احتكاك حقيقية على طابورٍ مزدحم. بدل
 * تكديس confirm() (العلّة أعلاه)، التأكيد المكتوب حقلٌ داخل نفس الحوار.
 */
export function MarkPickedUpDialog({ order, pending, onClose, onConfirm }: {
  order: PickupOrder | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (payment?: PickupPayment) => void;
}) {
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<Method>("CASH");
  const [payReference, setPayReference] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (order) {
      setPayAmount("");
      setPayMethod("CASH");
      setPayReference("");
      setConfirmText("");
      setError("");
    }
  }, [order?.id]);

  if (!order) return null;
  const remainingDue = positiveDiff(order.salePrice, order.deposit ?? 0);
  const payAmountD = D(payAmount || "0");
  const payNow = payAmountD.gt(0);
  const confirmed = confirmText.trim() === "تسليم";

  const submit = () => {
    if (!confirmed) return;
    if (!isPosPaymentMethodEnabled(payMethod)) {
      setError(posPaymentRejectionMessage(payMethod));
      return;
    }
    if (payNow && payMethod !== "CASH" && !payReference.trim()) {
      setError("مرجع العملية مطلوب لدفعة غير نقدية.");
      return;
    }
    setError("");
    onConfirm(payNow ? { amount: payAmountD.toFixed(2), method: payMethod, reference: payMethod !== "CASH" ? payReference.trim() : undefined } : undefined);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-extrabold">تسليم «{order.title}» مباشرةً للعميل</h3>
        <p className="mb-4 text-xs text-muted-foreground">{order.orderNumber}</p>
        <div className="mb-3 space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmt(order.salePrice)} د.ع</span></div>
          {D(order.deposit ?? 0).gt(0) && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-emerald-600">−{fmt(order.deposit ?? "0")} د.ع</span></div>}
          <div className="flex justify-between border-t pt-1 font-bold"><span>المتبقّي</span><span dir="ltr" className="tabular-nums">{fmt(remainingDue.toFixed(2))} د.ع</span></div>
        </div>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>مبلغ الدفعة الآن</Label>
            <MoneyInput value={payAmount} onChange={setPayAmount} placeholder="الرصيد المستحق" ariaLabel="مبلغ الدفعة" className="h-11" />
          </div>
          <div className="space-y-1">
            <Label>طريقة الدفع</Label>
            <AppSelect value={payMethod} onValueChange={(v) => setPayMethod(v as Method)} className="h-11">
              {METHODS.map((m) => <option key={m.v} value={m.v} disabled={!isPosPaymentMethodEnabled(m.v)}>{m.label}</option>)}
            </AppSelect>
          </div>
        </div>
        {payMethod !== "CASH" && (
          <div className="mb-3 space-y-1">
            <Label htmlFor="pickup-pay-ref">مرجع العملية {payNow && <span className="text-destructive">*</span>}</Label>
            <Input
              id="pickup-pay-ref"
              dir="ltr"
              value={payReference}
              onChange={(e) => setPayReference(e.target.value)}
              placeholder="رقم إشعار الجهاز/التحويل"
              className={cn(payReference.trim() === "" && payNow && "border-[var(--sem-warn)]")}
            />
          </div>
        )}
        <p className="mb-3 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>سيُسلَّم الأمر وتُصدَر فاتورة {payNow ? `مع دفعة ${fmt(payAmountD.toFixed(2))} د.ع` : "آجلة بالكامل"}. لا رجعة.</span>
        </p>
        <div className="mb-4 space-y-1">
          <Label htmlFor="pickup-confirm-text">اكتب «تسليم» للتأكيد</Label>
          <Input
            id="pickup-confirm-text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="تسليم"
          />
        </div>
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
        <div className="flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>إلغاء</Button>
          <Button variant="destructive" className="flex-1" onClick={submit} disabled={pending || !confirmed}>{pending ? "جارٍ…" : "تسليم وإصدار فاتورة"}</Button>
        </div>
      </div>
    </div>
  );
}

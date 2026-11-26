import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt, positiveDiff } from "@/lib/money";
import { cn } from "@/lib/utils";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import type { ManagerApprovalInput } from "@shared/managerApproval";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { getDeviceCode } from "@/lib/offline/outbox";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

const METHODS: { v: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; label: string }[] = [
  { v: "CASH", label: "نقدي" },
  { v: "TRANSFER", label: "تحويل" },
  { v: "CARD", label: "بطاقة" },
  { v: "WALLET", label: "محفظة" },
];
type Method = (typeof METHODS)[number]["v"];

export interface PickupOrder {
  id: number;
  branchId?: number | null;
  orderNumber: string;
  title: string;
  salePrice: string;
  deposit?: string | null;
}

export interface PickupPayment {
  amount: string;
  method: Method;
  reference?: string;
  externalPaymentAttemptId?: number;
  externalPaymentDeviceId?: string;
}

export interface PickupDeliveryExtra {
  addToCustomerDebt?: boolean;
  managerApproval?: ManagerApprovalInput;
}

/**
 * حوار «استلام مباشر» (بلا توصيل) — اِستقبال (تكامل التوصيل، ٤/٨): يُستدعى من طابور استقبال أوامر
 * الشغل (ReceptionOrderQueue) لأوامر READY بلا `hasDelivery`. يُعيد إنتاج نموذج الدفع في
 * WorkOrderDetail.tsx (المبلغ/الطريقة/المرجع) داخل حوارٍ منبثق بدل صفحة كاملة.
 */
export function MarkPickedUpDialog({ order, pending, onClose, onConfirm }: {
  order: PickupOrder | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (payment?: PickupPayment, extra?: PickupDeliveryExtra) => void;
}) {
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<Method>("CASH");
  const [payReference, setPayReference] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState("");
  const [showManagerApproval, setShowManagerApproval] = useState(false);
  const [managerApproval, setManagerApproval] = useState<ManagerApprovalInput | null>(null);
  const [addToCustomerDebt, setAddToCustomerDebt] = useState(false);
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);
  const initiateExternal = trpc.reception.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.reception.confirmExternalPayment.useMutation();

  useEffect(() => {
    if (order) {
      const dueInit = positiveDiff(order.salePrice, order.deposit ?? 0);
      setPayAmount(dueInit.gt(0) ? dueInit.toFixed(2) : "");
      setPayMethod("CASH");
      setPayReference("");
      setConfirmText("");
      setError("");
      setShowManagerApproval(false);
      setManagerApproval(null);
      setAddToCustomerDebt(false);
      setExternalAttempt(null);
    }
  }, [order?.id]);

  if (!order) return null;
  const remainingDue = positiveDiff(order.salePrice, order.deposit ?? 0);
  const payAmountD = D(payAmount || "0");
  const payNow = payAmountD.gt(0);
  const confirmed = confirmText.trim() === "تسليم";
  const unpaidRemainder = positiveDiff(remainingDue.toFixed(2), payAmountD.toFixed(2));
  const hasUnpaidRemainder = unpaidRemainder.gt(0);
  const normalizedAmount = payNow ? payAmountD.toFixed(2) : "0.00";
  const effectiveBranchId = order.branchId ? Number(order.branchId) : null;
  const externalFingerprint = effectiveBranchId
    ? `SALES_COLLECTION|${effectiveBranchId}|${payMethod}|${normalizedAmount}|${payReference.trim()}`
    : "";
  const externalConfirmed =
    payMethod === "CASH" ||
    !effectiveBranchId ||
    (externalAttempt?.confirmed === true &&
      Boolean(externalFingerprint) &&
      externalAttempt.fingerprint === externalFingerprint);

  const confirmExternalPayment = async () => {
    const normalizedRef = payReference.trim();
    if (!normalizedRef || !payNow || payMethod === "CASH" || payMethod === "CHECK" || !effectiveBranchId) return;
    try {
      const prior = externalAttempt?.fingerprint === externalFingerprint ? externalAttempt : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const requestId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        const initiated = await initiateExternal.mutateAsync({
          branchId: effectiveBranchId,
          channel: "SALES_COLLECTION",
          method: payMethod,
          amount: normalizedAmount,
          reference: normalizedRef,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: false });
      }
      await confirmExternal.mutateAsync({
        branchId: effectiveBranchId,
        channel: "SALES_COLLECTION",
        attemptId,
        deviceId,
      });
      setExternalAttempt({ attemptId, requestId, deviceId, fingerprint: externalFingerprint, confirmed: true });
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${normalizedRef} وأصبح جاهزاً للاستهلاك.`);
    } catch (err) {
      notify.err(err, "تعذّر تأكيد الدفع الخارجي");
    }
  };

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
    if (payNow && payMethod !== "CASH" && !externalConfirmed) {
      setError("أكّد الدفع الخارجي أولاً قبل التسليم.");
      return;
    }
    if (hasUnpaidRemainder && (!addToCustomerDebt || !managerApproval)) {
      setError(`لا يمكن تسليم الطلب بمتبقٍ غير مستحصل (${fmt(unpaidRemainder.toFixed(2))} د.ع) دون اعتماد المسؤول لإضافته إلى ذمة العميل.`);
      return;
    }
    setError("");
    onConfirm(
      payNow
        ? {
            amount: payAmountD.toFixed(2),
            method: payMethod,
            reference: payMethod !== "CASH" ? payReference.trim() : undefined,
            ...(payMethod !== "CASH" && externalAttempt?.attemptId
              ? {
                  externalPaymentAttemptId: externalAttempt.attemptId,
                  externalPaymentDeviceId: externalAttempt.deviceId,
                }
              : {}),
          }
        : undefined,
      { addToCustomerDebt, managerApproval: managerApproval ?? undefined },
    );
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-lg font-extrabold">تسليم «{order.title}» مباشرةً للعميل</h3>
        <p className="mb-4 text-xs text-muted-foreground">{order.orderNumber}</p>
        <div className="mb-3 space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">سعر البيع</span><span dir="ltr" className="tabular-nums">{fmt(order.salePrice)} د.ع</span></div>
          {D(order.deposit ?? 0).gt(0) && <div className="flex justify-between"><span className="text-muted-foreground">العربون المقبوض</span><span dir="ltr" className="tabular-nums text-[var(--sem-pos)]">−{fmt(order.deposit ?? "0")} د.ع</span></div>}
          <div className="flex justify-between border-t pt-1 font-bold"><span>المتبقّي الكلي</span><span dir="ltr" className="tabular-nums">{fmt(remainingDue.toFixed(2))} د.ع</span></div>
        </div>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>مبلغ الدفعة الآن</Label>
            <MoneyInput value={payAmount} onChange={(v) => { setPayAmount(v); setExternalAttempt(null); }} placeholder="المبلغ المقبوض" ariaLabel="مبلغ الدفعة" className="h-11" />
          </div>
          <div className="space-y-1">
            <Label>طريقة الدفع</Label>
            <AppSelect value={payMethod} onValueChange={(v) => { setPayMethod(v as Method); setPayReference(""); setExternalAttempt(null); }} className="h-11">
              {METHODS.map((m) => <option key={m.v} value={m.v} disabled={!isPosPaymentMethodEnabled(m.v)}>{m.label}</option>)}
            </AppSelect>
          </div>
        </div>
        {payMethod !== "CASH" && payMethod !== "CHECK" && effectiveBranchId ? (
          <div className="mb-3">
            <PaymentReferenceField
              value={payReference}
              onChange={(v) => { setPayReference(v); setExternalAttempt(null); }}
              method={payMethod}
              confirmed={externalConfirmed}
              confirming={initiateExternal.isPending || confirmExternal.isPending}
              onConfirm={() => void confirmExternalPayment()}
              inputId="pickup-pay-ref"
              colors={{
                border: "var(--border)",
                muted: "var(--muted)",
                mutedFg: "var(--muted-foreground)",
                fg: "var(--foreground)",
                amber: "var(--sem-warn)",
                success: "var(--sem-pos)",
              }}
            />
          </div>
        ) : payMethod !== "CASH" ? (
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
        ) : null}

        {hasUnpaidRemainder && (
          <div className="mb-3 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs space-y-2">
            <div className="flex items-center justify-between font-bold text-[var(--sem-warn)]">
              <span>متبقٍ غير مستحصل:</span>
              <span dir="ltr" className="tabular-nums font-mono text-sm">{fmt(unpaidRemainder.toFixed(2))} د.ع</span>
            </div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              وفقاً لسياسة الرقابة المالية، يُمنع تسليم الطلب بمتبقٍ غير مستحصل إلا بعد استيفاء المبلغ كاملاً أو الحصول على اعتماد المسؤول لتحويله إلى ذمة العميل.
            </p>
            {managerApproval ? (
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
                  onClick={() => { setManagerApproval(null); setAddToCustomerDebt(false); }}
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
                onClick={() => setShowManagerApproval(true)}
              >
                طلب اعتماد المدير لإضافة المتبقي لذمة العميل
              </Button>
            )}
          </div>
        )}

        <p className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span>سيُسلَّم الأمر وتُصدَر فاتورة {payNow ? `مع دفعة ${fmt(payAmountD.toFixed(2))} د.ع` : "آجلة"}. لا يمكن التراجع بعد التنفيذ.</span>
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
          <Button
            variant="destructive"
            className="flex-1"
            onClick={submit}
            disabled={pending || !confirmed || (hasUnpaidRemainder && !managerApproval)}
          >
            {pending ? "جارٍ…" : "تسليم وإصدار فاتورة"}
          </Button>
        </div>

        {showManagerApproval && (
          <ManagerApprovalDialog
            zIndexClass="z-[110]"
            title="اعتماد مدير — إضافة متبقي طلب لذمة العميل"
            description={`تسليم الطلب مع بقاء ${fmt(unpaidRemainder.toFixed(2))} د.ع غير مستحصلة يتطلب موافقة المدير لتحويلها إلى ذمة العميل.`}
            onCancel={() => setShowManagerApproval(false)}
            onApprove={(approval) => {
              setManagerApproval(approval);
              setAddToCustomerDebt(true);
              setShowManagerApproval(false);
              setError("");
            }}
          />
        )}
      </div>
    </div>
  );
}

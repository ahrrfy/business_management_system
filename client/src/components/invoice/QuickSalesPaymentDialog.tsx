import { useEffect, useRef, useState } from "react";
import { HandCoins, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { D, fmt, moneyInput, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { paymentMethodCompact } from "@shared/terms";
import { getDeviceCode } from "@/lib/offline/outbox";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { invoiceStatusLabel, isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { invoiceRemaining } from "@shared/predicates/invoiceRemaining";

import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  type InboundEnabledPaymentMethod,
} from "@shared/inboundPaymentPolicy";

type Method = InboundEnabledPaymentMethod;
const METHODS: readonly Method[] = INBOUND_ENABLED_PAYMENT_METHODS;

export interface QuickSalesPaymentDialogProps {
  open: boolean;
  onClose: () => void;
  invoiceId: number;
  invoiceNumber: string;
  customerName?: string | null;
  remainingAmount: string;
  totalAmount?: string;
  paidAmount?: string;
  branchId: number;
  onSuccess?: () => void;
}

export function QuickSalesPaymentDialog({
  open,
  onClose,
  invoiceId,
  invoiceNumber,
  customerName,
  remainingAmount,
  totalAmount,
  paidAmount,
  branchId,
  onSuccess,
}: QuickSalesPaymentDialogProps) {
  const utils = trpc.useUtils();
  const invoiceQuery = trpc.sales.get.useQuery(
    { invoiceId: invoiceId ?? 0 },
    { enabled: open && invoiceId > 0 },
  );
  const inv = invoiceQuery.data;
  const total = inv ? D(inv.total) : D(totalAmount || "0");
  const paid = inv ? D(inv.paidAmount) : D(paidAmount || "0");
  const isInvoiceDead = isDeadInvoiceStatus(inv?.status);
  const liveRemaining = isInvoiceDead ? "0.00" : round2(invoiceRemaining(inv ?? {
    total: total.toString(), paidAmount: paid.toString(),
  })).toFixed(2);
  const effectiveRemaining = inv ? liveRemaining : remainingAmount;

  const [amount, setAmount] = useState(effectiveRemaining);
  const [method, setMethod] = useState<Method>("CASH");
  const [reference, setReference] = useState("");
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId?: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);

  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setAmount(effectiveRemaining);
      setMethod("CASH");
      setReference("");
      setClientRequestId(crypto.randomUUID());
      setExternalAttempt(null);
    }
    prevOpenRef.current = open;
  }, [open, effectiveRemaining]);

  const prevRemainingRef = useRef(effectiveRemaining);
  useEffect(() => {
    if (open && !externalAttempt) {
      if (amount === prevRemainingRef.current) {
        setAmount(effectiveRemaining);
      }
    }
    prevRemainingRef.current = effectiveRemaining;
  }, [open, effectiveRemaining, externalAttempt, amount]);

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  const parsedAmount = moneyInput(amount);
  const normalizedPayAmount = round2(parsedAmount).toFixed(2);
  const externalNeeded = method !== "CASH" && parsedAmount.gt(0);
  const externalFingerprint = `SALES_COLLECTION|${branchId}|${method}|${normalizedPayAmount}|${reference.trim()}`;
  const externalConfirmed =
    !externalNeeded ||
    (externalAttempt?.confirmed === true &&
      externalAttempt.fingerprint === externalFingerprint);

  const pay = trpc.sales.pay.useMutation({
    onSuccess: async (r) => {
      notify.ok("تم تسجيل الدفعة بنجاح", `الحالة الحالية: ${invoiceStatusLabel(r.status)}`);
      await Promise.all([
        utils.sales.get.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.sales.listSummary.invalidate(),
      ]);
      onSuccess?.();
      onClose();
    },
    onError: (e) => {
      notify.err("تعذّر تسجيل الدفعة", e.message);
    },
  });

  const isInvoiceRefreshing = invoiceQuery.isLoading || invoiceQuery.isFetching;
  const isBusy = pay.isPending || initiateExternal.isPending || confirmExternal.isPending;
  const hasInFlightAttempt = externalAttempt != null;
  const cannotClose = isBusy || (hasInFlightAttempt && !pay.isSuccess);

  async function confirmExternalPayment() {
    let currentLiveRemaining = D(liveRemaining);
    if (isInvoiceRefreshing || !inv) {
      notify.err("تحديث الفاتورة", "يرجى الانتظار حتى اكتمال تحميل أحدث بيانات الفاتورة.");
      return;
    }
    if (isInvoiceDead) {
      notify.err("فاتورة مقفلة", "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مرتجعة أو مستبدلة.");
      return;
    }
    try {
      const fresh = await utils.sales.get.fetch({ invoiceId });
      if (fresh) {
        if (isDeadInvoiceStatus(fresh.status)) {
          notify.err("فاتورة مقفلة", "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مرتجعة أو مستبدلة.");
          return;
        }
        currentLiveRemaining = round2(invoiceRemaining(fresh));
      }
    } catch {
      // الاعتماد على الحالة المحلية إذا تعذّر الاستعلام
    }
    if (currentLiveRemaining.lte(0)) {
      notify.err("الفاتورة مسددة", "تم سداد كامل رصيد الفاتورة بالفعل.");
      return;
    }
    if (parsedAmount.gt(currentLiveRemaining)) {
      notify.err("تجاوز الرصيد المحدث", `الرصيد المتبقي الفعلي هو ${fmt(currentLiveRemaining.toFixed(2))} د.ع.`);
      return;
    }
    const trimmedRef = reference.trim();
    if (!trimmedRef) {
      notify.err("مرجع العملية مطلوب", "أدخل رقم إشعار جهاز الدفع أو الحوالة أولاً.");
      return;
    }
    if (!parsedAmount.gt(0)) {
      notify.err("المبلغ مطلوب", "أدخل مبلغ الدفعة قبل تأكيد العملية الخارجية.");
      return;
    }
    try {
      const prior =
        externalAttempt?.fingerprint === externalFingerprint ? externalAttempt : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const reqId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        // تثبيت معرّف الطلب في حالة المكوّن قبل الإرسال لضمان عدم ضياعه عند أخطاء الشبكة
        setExternalAttempt({
          attemptId: null,
          requestId: reqId,
          deviceId,
          fingerprint: externalFingerprint,
          confirmed: false,
        });
        const initiated = await initiateExternal.mutateAsync({
          branchId: Number(branchId),
          channel: "SALES_COLLECTION",
          method: method as "CARD" | "TRANSFER" | "WALLET",
          amount: normalizedPayAmount,
          reference: trimmedRef,
          requestId: reqId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        setExternalAttempt({
          attemptId,
          requestId: reqId,
          deviceId,
          fingerprint: externalFingerprint,
          confirmed: false,
        });
      }
      await confirmExternal.mutateAsync({
        branchId: Number(branchId),
        channel: "SALES_COLLECTION",
        attemptId,
        deviceId,
      });
      setExternalAttempt({
        attemptId,
        requestId: reqId,
        deviceId,
        fingerprint: externalFingerprint,
        confirmed: true,
      });
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${trimmedRef} وجاري ترحيل الدفعة...`);
      // دمج التأكيد والاستهلاك في تدفق موحد يمنع تباعد الحالتين
      pay.mutate({
        invoiceId,
        amount: normalizedPayAmount,
        method,
        reference: trimmedRef,
        clientRequestId,
        externalPaymentAttemptId: attemptId,
        externalPaymentDeviceId: deviceId,
      });
    } catch (err) {
      notify.err(err instanceof Error ? err.message : "تعذّر تأكيد الدفع الخارجي");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isPosPaymentMethodEnabled(method)) {
      notify.err("طريقة دفع معطلة", posPaymentRejectionMessage(method));
      return;
    }
    let amt: ReturnType<typeof D>;
    try {
      amt = D(amount.trim());
    } catch {
      notify.err("مبلغ غير صالح", "أدخل مبلغاً عددياً صالحاً.");
      return;
    }
    if (!amt.gt(0)) {
      notify.err("مبلغ غير صالح", "يجب أن يكون مبلغ الدفعة أكبر من صفر.");
      return;
    }
    if (isInvoiceRefreshing || !inv) {
      notify.err("تحديث الفاتورة", "يرجى الانتظار حتى اكتمال تحميل أحدث بيانات الفاتورة.");
      return;
    }
    if (isInvoiceDead) {
      notify.err("فاتورة مقفلة", "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مرتجعة أو مستبدلة.");
      return;
    }
    if (amt.gt(D(effectiveRemaining))) {
      notify.err("تجاوز الرصيد", "مبلغ الدفعة أكبر من الرصيد المتبقي على الفاتورة.");
      return;
    }
    if (method !== "CASH") {
      if (!reference.trim()) {
        notify.err("مرجع مفقود", "مرجع عملية الدفع مطلوب للدفع الإلكتروني والمصرفي.");
        return;
      }
      if (!externalConfirmed) {
        await confirmExternalPayment();
        return;
      }
    }

    pay.mutate({
      invoiceId,
      amount: normalizedPayAmount,
      method,
      reference: reference.trim() || undefined,
      clientRequestId,
      externalPaymentAttemptId: externalAttempt?.attemptId ?? null,
      externalPaymentDeviceId: externalAttempt?.deviceId ?? null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !cannotClose) onClose(); }}>
      <DialogContent
        className="sm:max-w-md"
        dir="rtl"
        showCloseButton={!cannotClose}
        onEscapeKeyDown={(e) => { if (cannotClose) e.preventDefault(); }}
        onPointerDownOutside={(e) => { if (cannotClose) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <HandCoins aria-hidden className="size-5 text-primary" />
            <span>تسديد دفعة مبيعات — {invoiceNumber}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            تسجيل دفعة قبض سريعة على الفاتورة دون مغادرة الشاشة.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-2.5 text-xs">
            <div>
              <span className="text-muted-foreground block">العميل:</span>
              <span className="font-semibold">{inv?.customerName || customerName || "عميل نقدي"}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">الرصيد المتبقي:</span>
              <span className="font-bold text-money-negative tabular-nums flex items-center gap-1">
                {isInvoiceRefreshing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                <span>{fmt(effectiveRemaining)} د.ع</span>
              </span>
            </div>
            {totalAmount || inv ? (
              <div>
                <span className="text-muted-foreground block">إجمالي الفاتورة:</span>
                <span className="tabular-nums">{fmt(total.toString())} د.ع</span>
              </div>
            ) : null}
            {paidAmount || inv ? (
              <div>
                <span className="text-muted-foreground block">المدفوع سابقاً:</span>
                <span className="text-money-positive tabular-nums">{fmt(paid.toString())} د.ع</span>
              </div>
            ) : null}
          </div>

          {isInvoiceDead && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
            حالة الفاتورة: {invoiceStatusLabel(inv?.status)}. لا يمكن تسجيل دفعة على هذا المستند.
          </p>}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sales-pay-method" className="text-xs">طريقة القبض</Label>
              <AppSelect
                value={method}
                disabled={cannotClose || isInvoiceDead}
                onValueChange={(v) => {
                  if (cannotClose) return;
                  setMethod(v as Method);
                  setReference("");
                  setExternalAttempt(null);
                }}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {paymentMethodCompact(m)}
                  </option>
                ))}
              </AppSelect>
            </div>

            <div className="space-y-1">
              <Label htmlFor="sales-pay-amount" className="text-xs">المبلغ المقبوض</Label>
              <MoneyInput
                id="sales-pay-amount"
                value={amount}
                onChange={setAmount}
                disabled={cannotClose || isInvoiceDead}
                placeholder="0.00"
                ariaLabel="المبلغ المقبوض"
                className="font-mono text-sm"
              />
            </div>
          </div>

          {method !== "CASH" && !isInvoiceDead ? (
            <div className="rounded-md border bg-card p-2.5">
              <PaymentReferenceField
                value={reference}
                onChange={(val) => {
                  if (cannotClose) return;
                  setReference(val);
                  setExternalAttempt(null);
                }}
                method={method}
                confirmed={externalConfirmed}
                confirming={initiateExternal.isPending || confirmExternal.isPending || isInvoiceRefreshing}
                onConfirm={confirmExternalPayment}
                inputId="sales-quick-pay-reference"
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
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={cannotClose}
            >
              إلغاء
            </Button>
            <SubmitButton
              pending={pay.isPending}
              size="sm"
              disabled={
                !parsedAmount.gt(0) ||
                (method !== "CASH" && !externalConfirmed) ||
                isBusy ||
                isInvoiceRefreshing ||
                isInvoiceDead ||
                (inv != null && D(liveRemaining).lte(0))
              }
            >
              تسجيل وترحيل الدفعة
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

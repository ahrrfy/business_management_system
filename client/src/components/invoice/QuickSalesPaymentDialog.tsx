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
import { preopenDocumentWindow } from "@/lib/printing/print";
import { printInvoicePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { trpc } from "@/lib/trpc";
import { paymentMethodCompact } from "@shared/terms";
import { getDeviceCode } from "@/lib/offline/outbox";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { invoiceStatusLabel, isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { invoiceRemaining } from "@shared/predicates/invoiceRemaining";
import { financialIntentScopeKey, isDefinitiveIntentRejection, loadFinancialIntent, reserveFinancialIntent, resolveFinancialIntent, type FinancialIntent, type FinancialIntentScope } from "@/lib/persistedFinancialIntent";

import {
  INBOUND_ENABLED_PAYMENT_METHODS,
  type InboundEnabledPaymentMethod,
} from "@shared/inboundPaymentPolicy";

type Method = InboundEnabledPaymentMethod;
const METHODS: readonly Method[] = INBOUND_ENABLED_PAYMENT_METHODS;
type PaymentCommand = {
  invoiceId: number; amount: string; method: Method; reference?: string;
  clientRequestId: string; externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
};
type PaymentSnapshot = { command: PaymentCommand; receipt: Parameters<typeof printInvoicePaymentReceipt>[0] };

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
  const me = trpc.auth.me.useQuery(undefined, { enabled: open });
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
  const [clientRequestId, setClientRequestId] = useState<string>(() => crypto.randomUUID());
  const intentScope: FinancialIntentScope | null = me.data?.id && branchId > 0 && invoiceId > 0
    ? { companyId: me.data.companyId ?? null, userId: me.data.id, branchId, operation: "SALES_PAYMENT", target: `invoice:${invoiceId}` }
    : null;
  const scopeKey = intentScope ? financialIntentScopeKey(intentScope) : "";
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [pendingSlot, setPendingSlot] = useState<{ scopeKey: string; intent: FinancialIntent<PaymentSnapshot> } | null>(null);
  const pendingIntent = pendingSlot?.scopeKey === scopeKey ? pendingSlot.intent : null;
  const [loadedScope, setLoadedScope] = useState("");
  const [intentReadError, setIntentReadError] = useState("");
  const sendingRef = useRef(false);
  const activeIntentRef = useRef<{ scope: FinancialIntentScope; intent: FinancialIntent<PaymentSnapshot>; recovery: boolean } | null>(null);
  useEffect(() => {
    if (!open || !intentScope) return;
    let cancelled = false;
    setIntentReadError("");
    void loadFinancialIntent<PaymentSnapshot>(intentScope).then(saved => {
      if (cancelled) return;
      setPendingSlot(saved ? { scopeKey, intent: saved } : null);
      if (saved) {
        setAmount(saved.payload.command.amount);
        setMethod(saved.payload.command.method);
        setReference(saved.payload.command.reference ?? "");
        setClientRequestId(saved.id);
      }
      setLoadedScope(scopeKey);
    }).catch(() => {
      if (!cancelled) setIntentReadError("تعذّرت قراءة محاولة الدفع المحفوظة؛ أعد فتح الشاشة دون مسح التخزين المحلي.");
    });
    return () => { cancelled = true; };
  }, [open, scopeKey]);
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
    if (open && !externalAttempt && !pendingIntent) {
      if (amount === prevRemainingRef.current) {
        setAmount(effectiveRemaining);
      }
    }
    prevRemainingRef.current = effectiveRemaining;
  }, [open, effectiveRemaining, externalAttempt, amount, pendingIntent]);

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

  const payWinRef = useRef<Window | null>(null);
  function closePayWin() {
    try { payWinRef.current?.close(); } catch { /* noop */ }
    payWinRef.current = null;
  }
  function clearDisplayedIntent(scope: FinancialIntentScope, id: string) {
    const key = financialIntentScopeKey(scope);
    setPendingSlot(slot => slot?.scopeKey === key && slot.intent.id === id ? null : slot);
  }
  const pay = trpc.sales.pay.useMutation({
    onSuccess: async (r) => {
      const active = activeIntentRef.current;
      const win = payWinRef.current;
      payWinRef.current = null;
      if (!active) { sendingRef.current = false; return; }
      try {
        if (await resolveFinancialIntent(active.scope, active.intent.id)) clearDisplayedIntent(active.scope, active.intent.id);
      } catch {
        notify.err("تم تسجيل الدفعة", "تعذّر إغلاق سجل الاسترداد المحلي؛ احتفظ بالمحاولة الأصلية دون إنشاء دفعة بديلة.");
      }
      if (financialIntentScopeKey(active.scope) !== scopeRef.current) {
        try { win?.close(); } catch { /* noop */ }
        sendingRef.current = false;
        activeIntentRef.current = null;
        return;
      }
      notify.ok("تم تسجيل الدفعة بنجاح", `الحالة الحالية: ${invoiceStatusLabel(r.status)}`);
      void printInvoicePaymentReceipt(
        active.intent.payload.receipt,
        win ? { into: win } : undefined,
      ).catch(() => notify.err("الدفعة مسجلة", "تعذّرت طباعة الإيصال؛ أعد طباعته من الفاتورة دون دفع جديد."));
      const refreshed = await Promise.allSettled([
        utils.sales.get.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
        utils.sales.listSummary.invalidate(),
      ]);
      if (refreshed.some(result => result.status === "rejected")) notify.err("الدفعة مسجلة", "تعذّر تحديث بعض القوائم؛ حدّث الصفحة دون إعادة الدفع.");
      sendingRef.current = false;
      activeIntentRef.current = null;
      try { await onSuccess?.(); } catch { /* The payment has already succeeded. */ }
      onClose();
    },
    onError: async (e) => {
      closePayWin();
      const active = activeIntentRef.current;
      // A rejection of a recovery attempt cannot disprove the original commit.
      if (active && !active.recovery && isDefinitiveIntentRejection(e)) {
        try {
          if (await resolveFinancialIntent(active.scope, active.intent.id)) {
            clearDisplayedIntent(active.scope, active.intent.id);
            if (financialIntentScopeKey(active.scope) === scopeRef.current) setClientRequestId(crypto.randomUUID());
          }
        } catch { /* Preserve the unresolved envelope. */ }
      }
      sendingRef.current = false;
      activeIntentRef.current = null;
      notify.err("تعذّر تسجيل الدفعة", e.message);
    },
  });

  const isInvoiceRefreshing = invoiceQuery.isLoading || invoiceQuery.isFetching;
  const isBusy = pay.isPending || initiateExternal.isPending || confirmExternal.isPending;
  const hasInFlightAttempt = externalAttempt != null;
  const cannotClose = isBusy || (hasInFlightAttempt && !pay.isSuccess && !pendingIntent);

  async function submitPaymentCommand(command: PaymentCommand, recovery?: FinancialIntent<PaymentSnapshot>) {
    if (sendingRef.current || !intentScope || loadedScope !== scopeKey || intentReadError) return;
    sendingRef.current = true;
    const capturedScope = intentScope;
    try {
      const remaining = D(effectiveRemaining).minus(D(command.amount));
      const proposed: FinancialIntent<PaymentSnapshot> = recovery ?? {
        id: command.clientRequestId, createdAt: new Date().toISOString(),
        payload: { command, receipt: {
          invoiceNumber, customerName: inv?.customerName ?? customerName ?? null,
          customerPhone: (inv as { contactPhone?: string | null } | undefined)?.contactPhone ?? null,
          invoiceTotal: total.toFixed(2), paidBefore: paid.toFixed(2), amountPaid: command.amount,
          remainingAfter: (remaining.gt(0) ? remaining : D(0)).toFixed(2), paymentMethod: command.method,
          reference: command.reference ?? null, cashierName: null,
        } },
      };
      const saved = await reserveFinancialIntent(capturedScope, proposed);
      if (financialIntentScopeKey(capturedScope) !== scopeRef.current) throw new Error("تغيّرت هوية الجلسة؛ أعد فتح الشاشة بحساب صاحب المحاولة.");
      setPendingSlot({ scopeKey, intent: saved });
      if (saved.id !== proposed.id) {
        closePayWin();
        sendingRef.current = false;
        notify.err("توجد محاولة محفوظة", "استرد نتيجة المحاولة السابقة قبل إنشاء دفعة جديدة.");
        return;
      }
      activeIntentRef.current = { scope: capturedScope, intent: saved, recovery: !!recovery };
      pay.mutate(saved.payload.command);
    } catch {
      closePayWin();
      sendingRef.current = false;
      notify.err("لم تُرسل دفعة جديدة", "تعذّر حفظ هوية محاولة الدفع؛ تحقق من التخزين المحلي ثم أعد المحاولة.");
    }
  }

  async function confirmExternalPayment() {
    if (!payWinRef.current) payWinRef.current = preopenDocumentWindow();
    let currentLiveRemaining = D(liveRemaining);
    if (isInvoiceRefreshing || !inv) {
      closePayWin();
      notify.err("تحديث الفاتورة", "يرجى الانتظار حتى اكتمال تحميل أحدث بيانات الفاتورة.");
      return;
    }
    if (isInvoiceDead) {
      closePayWin();
      notify.err("فاتورة مقفلة", "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مرتجعة أو مستبدلة.");
      return;
    }
    const trimmedRef = reference.trim();
    if (!trimmedRef) {
      closePayWin();
      notify.err("مرجع العملية مطلوب", "أدخل رقم إشعار جهاز الدفع أو الحوالة أولاً.");
      return;
    }
    if (!parsedAmount.gt(0)) {
      closePayWin();
      notify.err("المبلغ مطلوب", "أدخل مبلغ الدفعة قبل تأكيد العملية الخارجية.");
      return;
    }
    try {
      const fresh = await utils.sales.get.fetch({ invoiceId });
      if (fresh) {
        if (isDeadInvoiceStatus(fresh.status)) {
          closePayWin();
          notify.err("فاتورة مقفلة", "لا يمكن تسجيل دفعة على فاتورة ملغاة أو مرتجعة أو مستبدلة.");
          return;
        }
        currentLiveRemaining = round2(invoiceRemaining(fresh));
      }
    } catch {
      // الاعتماد على الحالة المحلية إذا تعذّر الاستعلام
    }
    if (currentLiveRemaining.lte(0)) {
      closePayWin();
      notify.err("الفاتورة مسددة", "تم سداد كامل رصيد الفاتورة بالفعل.");
      return;
    }
    if (parsedAmount.gt(currentLiveRemaining)) {
      closePayWin();
      notify.err("تجاوز الرصيد المحدث", `الرصيد المتبقي الفعلي هو ${fmt(currentLiveRemaining.toFixed(2))} د.ع.`);
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
      if (!payWinRef.current) payWinRef.current = preopenDocumentWindow();
      await submitPaymentCommand({
        invoiceId,
        amount: normalizedPayAmount,
        method,
        reference: trimmedRef,
        clientRequestId,
        externalPaymentAttemptId: attemptId,
        externalPaymentDeviceId: deviceId,
      });
    } catch (err) {
      closePayWin();
      notify.err(err instanceof Error ? err.message : "تعذّر تأكيد الدفع الخارجي");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sendingRef.current || !intentScope || loadedScope !== scopeKey || intentReadError) return;
    if (pendingIntent) {
      payWinRef.current = preopenDocumentWindow();
      await submitPaymentCommand(pendingIntent.payload.command, pendingIntent);
      return;
    }
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
        payWinRef.current = preopenDocumentWindow();
        await confirmExternalPayment();
        return;
      }
    }

    payWinRef.current = preopenDocumentWindow();
    await submitPaymentCommand({
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
                disabled={cannotClose || isInvoiceDead || !!pendingIntent}
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
                disabled={cannotClose || isInvoiceDead || !!pendingIntent}
                placeholder="0.00"
                ariaLabel="المبلغ المقبوض"
                className="font-mono text-sm"
              />
            </div>
          </div>

          {method !== "CASH" && !isInvoiceDead && !pendingIntent ? (
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

          {intentReadError && <p role="alert" className="text-sm text-destructive">{intentReadError}</p>}
          {pendingIntent && <p role="status" className="text-sm text-muted-foreground">توجد محاولة دفع محفوظة. استرد نتيجتها بالمبلغ والمفتاح الأصليين قبل تسجيل دفعة أخرى.</p>}
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
                isBusy ||
                !intentScope ||
                loadedScope !== scopeKey ||
                !!intentReadError ||
                (!pendingIntent && (!parsedAmount.gt(0) || (method !== "CASH" && !externalConfirmed) || isInvoiceRefreshing || isInvoiceDead || (inv != null && D(liveRemaining).lte(0))))
              }
            >
              {pendingIntent ? "استرداد محاولة الدفعة السابقة" : "تسجيل وترحيل الدفعة"}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

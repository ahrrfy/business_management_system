import { useEffect, useState } from "react";
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
import { invoiceStatusLabel } from "@shared/invoiceStatus";

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
const METHODS: Method[] = ["CASH", "CARD", "TRANSFER", "WALLET"];

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
  const returned = inv ? D(inv.returnedTotal ?? "0") : D(0);
  const liveRemaining = round2(total.minus(paid).minus(returned)).toFixed(2);
  const effectiveRemaining = inv ? liveRemaining : remainingAmount;

  const [amount, setAmount] = useState(effectiveRemaining);
  const [method, setMethod] = useState<Method>("CASH");
  const [reference, setReference] = useState("");
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setAmount(effectiveRemaining);
      setMethod("CASH");
      setReference("");
      setClientRequestId(crypto.randomUUID());
      setExternalAttempt(null);
    }
  }, [open, effectiveRemaining]);

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

  const isBusy = pay.isPending || initiateExternal.isPending || confirmExternal.isPending;

  async function confirmExternalPayment() {
    if (invoiceQuery.isLoading || !inv) {
      notify.err("تحديث الفاتورة", "يرجى الانتظار حتى اكتمال تحميل أحدث بيانات الفاتورة.");
      return;
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED") {
      notify.err("فاتورة مقفلة", "لا يمكن سداد فاتورة ملغاة أو مرتجعة بالكامل.");
      return;
    }
    if (D(liveRemaining).lte(0)) {
      notify.err("الفاتورة مسددة", "تم سداد كامل رصيد الفاتورة بالفعل.");
      return;
    }
    if (parsedAmount.gt(D(liveRemaining))) {
      notify.err("تجاوز الرصيد المحدث", `الرصيد المتبقي الفعلي هو ${fmt(liveRemaining)} د.ع.`);
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
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${trimmedRef} وجاهز للاعتماد.`);
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
    if (invoiceQuery.isLoading) {
      notify.err("تحديث الفاتورة", "يرجى الانتظار حتى اكتمال تحميل أحدث بيانات الفاتورة.");
      return;
    }
    if (inv && (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED")) {
      notify.err("فاتورة مقفلة", "لا يمكن سداد فاتورة ملغاة أو مرتجعة بالكامل.");
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
        notify.err("تأكيد غير مكتمل", "يرجى الضغط على زر تأكيد العملية قبل الحفظ.");
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
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isBusy) onClose(); }}>
      <DialogContent
        className="max-w-md"
        dir="rtl"
        showCloseButton={!isBusy}
        onEscapeKeyDown={(e) => { if (isBusy) e.preventDefault(); }}
        onPointerDownOutside={(e) => { if (isBusy) e.preventDefault(); }}
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
                {invoiceQuery.isLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                <span>{fmt(effectiveRemaining)} د.ع</span>
              </span>
            </div>
            {totalAmount ? (
              <div>
                <span className="text-muted-foreground block">إجمالي الفاتورة:</span>
                <span className="tabular-nums">{fmt(totalAmount)} د.ع</span>
              </div>
            ) : null}
            {paidAmount ? (
              <div>
                <span className="text-muted-foreground block">المدفوع سابقاً:</span>
                <span className="text-money-positive tabular-nums">{fmt(paidAmount)} د.ع</span>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sales-pay-method" className="text-xs">طريقة القبض</Label>
              <AppSelect
                value={method}
                onValueChange={(v) => {
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
                placeholder="0.00"
                ariaLabel="المبلغ المقبوض"
                className="font-mono text-sm"
              />
            </div>
          </div>

          {method !== "CASH" ? (
            <div className="rounded-md border bg-card p-2.5">
              <PaymentReferenceField
                value={reference}
                onChange={(val) => {
                  setReference(val);
                  setExternalAttempt(null);
                }}
                method={method}
                confirmed={externalConfirmed}
                confirming={initiateExternal.isPending || confirmExternal.isPending}
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
              disabled={isBusy}
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
                invoiceQuery.isLoading ||
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

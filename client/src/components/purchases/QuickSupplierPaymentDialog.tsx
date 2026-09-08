import { useEffect, useMemo, useState } from "react";
import { HandCoins } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { LoadingState } from "@/components/PageState";
import { MoneyInput } from "@/components/form/MoneyInput";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { paymentMethodCompact } from "@shared/terms";

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
type PaymentEvidence =
  | "PAYMENT_ORDER"
  | "BANK_ADVICE"
  | "TRANSFER_RECEIPT"
  | "CASH_ACKNOWLEDGEMENT"
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "OTHER";

const METHODS: Method[] = ["CASH", "CARD", "TRANSFER", "WALLET"];

const EVIDENCE_LABELS: Record<PaymentEvidence, string> = {
  CASH_ACKNOWLEDGEMENT: "إشعار استلام نقدي",
  BANK_ADVICE: "إشعار مصرفي",
  TRANSFER_RECEIPT: "إيصال تحويل",
  PAYMENT_ORDER: "أمر دفع معتمد",
  DOCUMENT_IMAGE: "صورة مستند",
  PDF: "ملف PDF",
  OTHER: "مستند آخر",
};

export interface QuickSupplierPaymentDialogProps {
  open: boolean;
  onClose: () => void;
  purchaseOrderId: number;
  poNumber: string;
  supplierId: number;
  supplierName: string;
  branchId: number;
  currency: "IQD" | "USD";
  exchangeRate?: string | null;
  remainingAmount: string;
  onSuccess?: () => void;
}

export function QuickSupplierPaymentDialog({
  open,
  onClose,
  purchaseOrderId,
  poNumber,
  supplierId,
  supplierName,
  branchId,
  currency,
  exchangeRate,
  remainingAmount,
  onSuccess,
}: QuickSupplierPaymentDialogProps) {
  const utils = trpc.useUtils();
  const [method, setMethod] = useState<Method>("CASH");
  const [amount, setAmount] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [evidenceType, setEvidenceType] =
    useState<PaymentEvidence>("CASH_ACKNOWLEDGEMENT");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");

  // استعلام فواتير المورد المرحلة للبحث عن الفاتورة المرتبطة بهذا الأمر
  const paymentSourcesQuery = trpc.supplierPayments.paymentSources.useQuery(
    { branchId, supplierId, limit: 100 },
    { enabled: open && supplierId > 0 && branchId > 0 },
  );

  const matchedInvoice = useMemo(() => {
    const rows = paymentSourcesQuery.data?.rows ?? [];
    // مطابقة رقم الفاتورة أو رقم أمر الشراء
    const exact = rows.find(
      (r) =>
        r.invoiceNumber === poNumber ||
        r.externalInvoiceNumber === poNumber,
    );
    if (exact) return exact;
    // إن لم تطابق حرفياً، نأخذ الفاتورة التي تحمل نفس العملة للمورد وبها رصيد متبقٍ
    return rows.find(
      (r) =>
        r.currency === currency &&
        D(r.remainingAmount || 0).gt(0),
    );
  }, [paymentSourcesQuery.data?.rows, poNumber, currency]);

  useEffect(() => {
    if (open) {
      const maxPayable = matchedInvoice
        ? currency === "USD"
          ? matchedInvoice.remainingCurrencyAmount || remainingAmount
          : matchedInvoice.remainingAmount || remainingAmount
        : remainingAmount;
      setAmount(maxPayable || "0");
      setReason(`سداد فاتورة أمر الشراء ${poNumber}`);
      setEvidenceReference(`PAY-PO-${poNumber}`);
      setExternalReference("");
      setMethod("CASH");
      setEvidenceType("CASH_ACKNOWLEDGEMENT");
    }
  }, [open, matchedInvoice, poNumber, remainingAmount, currency]);

  const requestPaymentMut = trpc.supplierPayments.requestPayment.useMutation({
    onSuccess: async () => {
      notify.ok(`تم تسجيل طلب سداد المورد ${supplierName} بنجاح`);
      await Promise.all([
        utils.purchases.list.invalidate(),
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.supplierPayments.paymentSources.invalidate(),
      ]);
      onSuccess?.();
      onClose();
    },
    onError: (err) => {
      notify.err(err);
    },
  });

  const parsedAmount = D(amount || 0);
  const isAmountValid =
    parsedAmount.gt(0) &&
    (matchedInvoice
      ? parsedAmount.lte(
          D(
            currency === "USD"
              ? matchedInvoice.remainingCurrencyAmount
              : matchedInvoice.remainingAmount,
          ),
        )
      : true);

  const isExternalRefValid =
    method === "CASH" || externalReference.trim().length > 0;
  const isEvidenceRefValid = evidenceReference.trim().length > 0;
  const isReasonValid = reason.trim().length >= 3;
  const canSubmit =
    isAmountValid &&
    isExternalRefValid &&
    isEvidenceRefValid &&
    isReasonValid &&
    matchedInvoice != null &&
    !requestPaymentMut.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !matchedInvoice) return;

    const rate = exchangeRate ? String(exchangeRate) : null;
    const finalAmount = parsedAmount.toFixed(2);

    requestPaymentMut.mutate({
      supplierId,
      branchId,
      requestKey: `pay-po-${purchaseOrderId}-${crypto.randomUUID()}`,
      currency,
      exchangeRate: rate,
      amount: currency === "USD" && rate ? round2(parsedAmount.times(rate)).toFixed(2) : finalAmount,
      currencyAmount: finalAmount,
      paymentMethod: method,
      externalReference: externalReference.trim() || null,
      evidenceType,
      evidenceReference: evidenceReference.trim(),
      reason: reason.trim(),
      allocations: [
        {
          supplierInvoiceId: matchedInvoice.id,
          invoiceVersion: matchedInvoice.version,
          amount: currency === "USD" && rate ? round2(parsedAmount.times(rate)).toFixed(2) : finalAmount,
          currencyAmount: finalAmount,
        },
      ],
    });
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !val && onClose()}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <HandCoins aria-hidden className="size-5 text-primary" />
            <span>سداد فوري للمورد — {supplierName}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            تسجيل دفعة سداد مرتبطة بأمر الشراء {poNumber}.
          </DialogDescription>
        </DialogHeader>

        {paymentSourcesQuery.isLoading ? (
          <LoadingState message="جارٍ فحص فاتورة المورد المرحلة…" />
        ) : null}

        {!paymentSourcesQuery.isLoading && !matchedInvoice ? (
          <div className="rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-3 text-xs text-[var(--sem-warn)]">
            لم يتم العثور على فاتورة مورد مرحّلة لهذا الأمر بعد. تأكد من اعتماد
            واستلام أمر الشراء بالكامل أولاً لتسجيل سداد مالي عليه.
          </div>
        ) : null}

        {matchedInvoice ? (
          <form onSubmit={handleSubmit} className="space-y-3 py-1">
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-2.5 text-xs">
              <div>
                <span className="text-muted-foreground block">الفاتورة المعتمدة:</span>
                <span className="font-semibold">{matchedInvoice.invoiceNumber}</span>
              </div>
              <div>
                <span className="text-muted-foreground block">الرصيد المستحق:</span>
                <span className="font-bold text-money-negative tabular-nums">
                  {fmt(
                    currency === "USD"
                      ? matchedInvoice.remainingCurrencyAmount
                      : matchedInvoice.remainingAmount,
                  )}{" "}
                  {currency === "USD" ? "$" : "د.ع"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="pay-method" className="text-xs">طريقة السداد</Label>
                <AppSelect
                  value={method}
                  onValueChange={(v) => setMethod(v as Method)}
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {paymentMethodCompact(m)}
                    </option>
                  ))}
                </AppSelect>
              </div>

              <div className="space-y-1">
                <Label htmlFor="pay-amount" className="text-xs">المبلغ المدفوع</Label>
                <MoneyInput
                  id="pay-amount"
                  value={amount}
                  onChange={setAmount}
                  placeholder="0.00"
                  ariaLabel="المبلغ المدفوع"
                  className="font-mono text-sm"
                />
              </div>
            </div>

            {method !== "CASH" ? (
              <div className="space-y-1">
                <Label htmlFor="pay-ext-ref" className="text-xs">
                  مرجع الدفع الخارجي (رقم الحوالة / العملية)
                </Label>
                <Input
                  id="pay-ext-ref"
                  value={externalReference}
                  onChange={(e) => setExternalReference(e.target.value)}
                  placeholder="مثال: TRX-98234"
                  className="text-xs"
                />
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="pay-ev-type" className="text-xs">نوع المستند الثبوتي</Label>
                <AppSelect
                  value={evidenceType}
                  onValueChange={(v) => setEvidenceType(v as PaymentEvidence)}
                >
                  {Object.entries(EVIDENCE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </AppSelect>
              </div>

              <div className="space-y-1">
                <Label htmlFor="pay-ev-ref" className="text-xs">مرجع المستند / الوصل</Label>
                <Input
                  id="pay-ev-ref"
                  value={evidenceReference}
                  onChange={(e) => setEvidenceReference(e.target.value)}
                  placeholder="مثال: وصل رقم 1024"
                  className="text-xs"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="pay-reason" className="text-xs">البيان / الملاحظات</Label>
              <Textarea
                id="pay-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="سبب أو تفاصيل الدفعة"
                className="text-xs"
              />
            </div>

            <DialogFooter className="pt-2 gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={requestPaymentMut.isPending}
              >
                إلغاء
              </Button>
              <SubmitButton
                size="sm"
                pending={requestPaymentMut.isPending}
                disabled={!canSubmit}
              >
                تسجيل السداد
              </SubmitButton>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              إغلاق
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

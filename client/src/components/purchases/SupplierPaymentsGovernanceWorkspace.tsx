import { useMemo, useState } from "react";
import { HandCoins, RotateCcw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { MoneyInput } from "@/components/form/MoneyInput";
import {
  GovernanceApprovalQueue,
  type GovernanceQueueRow,
} from "./GovernanceApprovalQueue";
import { GovernanceRequestNotice } from "./GovernanceRequestNotice";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { D, fmt, sum } from "@/lib/money";
import { newGovernanceKey } from "./purchaseGovernanceUiPolicy";

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
type PaymentEvidence =
  | "PAYMENT_ORDER"
  | "BANK_ADVICE"
  | "TRANSFER_RECEIPT"
  | "CASH_ACKNOWLEDGEMENT"
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "OTHER";

export type SupplierPaymentSource = {
  supplierInvoiceId: number;
  invoiceNumber: string;
  invoiceVersion: number;
  supplierId: number;
  supplierLabel: string;
  currency: "IQD" | "USD";
  exchangeRate: string | null;
  remainingAmount: string;
  remainingCurrencyAmount: string;
};

export type SupplierRefundSource = {
  supplierPaymentId: number;
  paymentNumber: string;
  paymentVersion: number;
  supplierId: number;
  supplierLabel: string;
  currency: "IQD" | "USD";
  allocations: Array<{
    supplierPaymentAllocationId: number;
    invoiceNumber: string;
    refundableAmount: string;
    refundableCurrencyAmount: string;
  }>;
};

export function SupplierPaymentsGovernanceWorkspace({
  branchId,
  paymentSources,
  refundSources,
  pendingPayments,
  pendingRefunds,
  currentUserId,
  canDecide,
  decisionBlockedReason,
  loadingSources,
  sourcesError,
  onRetrySources,
  paymentSourcesHasMore,
  refundSourcesHasMore,
  loadingMoreSources,
  onLoadMorePaymentSources,
  onLoadMoreRefundSources,
  requestPending,
  decisionPending,
  onRequestPayment,
  onRequestRefund,
  onDecidePayment,
  onDecideRefund,
  pendingPaymentLoading,
  pendingRefundLoading,
  pendingPaymentError,
  pendingRefundError,
  onRetryPendingPayments,
  onRetryPendingRefunds,
}: {
  branchId: number;
  paymentSources: SupplierPaymentSource[];
  refundSources: SupplierRefundSource[];
  pendingPayments: GovernanceQueueRow[];
  pendingRefunds: GovernanceQueueRow[];
  currentUserId: number | null | undefined;
  canDecide: boolean;
  decisionBlockedReason: string;
  loadingSources: boolean;
  sourcesError?: unknown;
  onRetrySources: () => void;
  paymentSourcesHasMore: boolean;
  refundSourcesHasMore: boolean;
  loadingMoreSources: boolean;
  onLoadMorePaymentSources: () => void;
  onLoadMoreRefundSources: () => void;
  requestPending: boolean;
  decisionPending: boolean;
  onRequestPayment: (input: {
    supplierId: number;
    branchId: number;
    requestKey: string;
    currency: "IQD" | "USD";
    exchangeRate?: string | null;
    amount: string;
    currencyAmount: string;
    paymentMethod: Method;
    externalReference?: string | null;
    evidenceType: PaymentEvidence;
    evidenceReference: string;
    reason: string;
    allocations: Array<{
      supplierInvoiceId: number;
      invoiceVersion: number;
      amount: string;
      currencyAmount: string;
    }>;
  }) => Promise<unknown>;
  onRequestRefund: (input: {
    supplierPaymentId: number;
    expectedPaymentVersion: number;
    requestKey: string;
    refundMethod: Method;
    externalReference?: string | null;
    evidenceType:
      | "SUPPLIER_ACKNOWLEDGEMENT"
      | "BANK_ADVICE"
      | "TRANSFER_RECEIPT"
      | "CASH_RECEIPT"
      | "DOCUMENT_IMAGE"
      | "PDF"
      | "OTHER";
    evidenceReference: string;
    reason: string;
    allocations: Array<{
      supplierPaymentAllocationId: number;
      amount: string;
      currencyAmount: string;
    }>;
  }) => Promise<unknown>;
  onDecidePayment: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
  onDecideRefund: Parameters<typeof GovernanceApprovalQueue>[0]["onDecide"];
  pendingPaymentLoading: boolean;
  pendingRefundLoading: boolean;
  pendingPaymentError?: unknown;
  pendingRefundError?: unknown;
  onRetryPendingPayments: () => void;
  onRetryPendingRefunds: () => void;
}) {
  const [mode, setMode] = useState<"PAYMENT" | "REFUND" | null>(null);
  const [groupKey, setGroupKey] = useState("");
  const [refundId, setRefundId] = useState("");
  const [amounts, setAmounts] = useState<
    Record<number, { amount: string; currencyAmount: string }>
  >({});
  const [method, setMethod] = useState<Method>("TRANSFER");
  const [exchangeRate, setExchangeRate] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [evidenceType, setEvidenceType] =
    useState<PaymentEvidence>("BANK_ADVICE");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");

  const groups = useMemo(() => {
    const result = new Map<
      string,
      { supplierId: number; supplierLabel: string; currency: "IQD" | "USD" }
    >();
    for (const row of paymentSources) {
      const key = `${row.supplierId}:${row.currency}`;
      result.set(key, {
        supplierId: row.supplierId,
        supplierLabel: row.supplierLabel,
        currency: row.currency,
      });
    }
    return Array.from(result.entries());
  }, [paymentSources]);
  const selectedGroup = groups.find(([key]) => key === groupKey)?.[1];
  const groupInvoices = selectedGroup
    ? paymentSources.filter(
        (row) =>
          row.supplierId === selectedGroup.supplierId &&
          row.currency === selectedGroup.currency,
      )
    : [];
  const selectedRefund = refundSources.find(
    (row) => row.supplierPaymentId === Number(refundId),
  );
  const selectedEntries = Object.entries(amounts)
    .map(([id, values]) => ({ id: Number(id), ...values }))
    .filter(
      (row) => row.id > 0 && D(row.amount).gt(0) && D(row.currencyAmount).gt(0),
    );
  const totalAmount = sum(selectedEntries.map((row) => row.amount));
  const totalCurrencyAmount = sum(
    selectedEntries.map((row) => row.currencyAmount),
  );
  const valid =
    reason.trim().length >= 3 &&
    evidenceReference.trim().length > 0 &&
    selectedEntries.length > 0 &&
    (method === "CASH" || externalReference.trim().length > 0) &&
    (mode === "PAYMENT"
      ? selectedGroup != null &&
        (selectedGroup.currency === "IQD" || D(exchangeRate).gt(0))
      : selectedRefund != null);

  function reset() {
    setMode(null);
    setGroupKey("");
    setRefundId("");
    setAmounts({});
    setMethod("TRANSFER");
    setExchangeRate("");
    setExternalReference("");
    setEvidenceType("BANK_ADVICE");
    setEvidenceReference("");
    setReason("");
  }

  async function submitRequest() {
    if (!valid) return;
    if (mode === "PAYMENT" && selectedGroup) {
      const byId = new Map(
        groupInvoices.map((row) => [row.supplierInvoiceId, row]),
      );
      try {
        await onRequestPayment({
          supplierId: selectedGroup.supplierId,
          branchId,
          requestKey: newGovernanceKey(
            `supplier-payment-${selectedGroup.supplierId}`,
          ),
          currency: selectedGroup.currency,
          exchangeRate: selectedGroup.currency === "USD" ? exchangeRate : null,
          amount: totalAmount,
          currencyAmount: totalCurrencyAmount,
          paymentMethod: method,
          externalReference: externalReference.trim() || null,
          evidenceType,
          evidenceReference: evidenceReference.trim(),
          reason: reason.trim(),
          allocations: selectedEntries.map((entry) => ({
            supplierInvoiceId: entry.id,
            invoiceVersion: byId.get(entry.id)!.invoiceVersion,
            amount: entry.amount,
            currencyAmount: entry.currencyAmount,
          })),
        });
        reset();
      } catch {
        // يبقى الحوار مفتوحاً ويعرض مالك mutation الخطأ.
      }
      return;
    }
    if (mode === "REFUND" && selectedRefund) {
      try {
        await onRequestRefund({
          supplierPaymentId: selectedRefund.supplierPaymentId,
          expectedPaymentVersion: selectedRefund.paymentVersion,
          requestKey: newGovernanceKey(
            `supplier-payment-refund-${selectedRefund.supplierPaymentId}`,
          ),
          refundMethod: method,
          externalReference: externalReference.trim() || null,
          evidenceType:
            evidenceType === "PAYMENT_ORDER" ||
            evidenceType === "CASH_ACKNOWLEDGEMENT"
              ? "OTHER"
              : evidenceType,
          evidenceReference: evidenceReference.trim(),
          reason: reason.trim(),
          allocations: selectedEntries.map((entry) => ({
            supplierPaymentAllocationId: entry.id,
            amount: entry.amount,
            currencyAmount: entry.currencyAmount,
          })),
        });
        reset();
      } catch {
        // يبقى الحوار مفتوحاً ويعرض مالك mutation الخطأ.
      }
    }
  }

  const invoiceRows =
    mode === "PAYMENT" ? groupInvoices : (selectedRefund?.allocations ?? []);
  const formCurrency =
    mode === "PAYMENT" ? selectedGroup?.currency : selectedRefund?.currency;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="inline-flex items-center gap-2">
              <HandCoins aria-hidden className="size-4" />
              طلبات سداد المورد
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => setMode("PAYMENT")}
              >
                طلب سداد
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setMode("REFUND")}
              >
                طلب استرداد دفعة
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={loadingSources}
                onClick={onRetrySources}
              >
                <RotateCcw aria-hidden className="size-4" />
                {ACTION_LABELS.refresh}
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <GovernanceRequestNotice>
            السداد أو الاسترداد المعلّق لا يغيّر الذمة ولا يخرج أو يدخل نقداً.
            التنفيذ يبدأ فقط بعد اعتماد مستقل.
          </GovernanceRequestNotice>
          {sourcesError ? (
            <p role="alert" className="text-sm text-destructive">
              تعذّر تحميل الفواتير والدفعات المؤهلة. أعد المحاولة قبل إنشاء طلب.
            </p>
          ) : null}
          {!sourcesError && (paymentSourcesHasMore || refundSourcesHasMore) ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">
                توجد مصادر مؤهلة أقدم. حمّل بقية الصفحات قبل اختيار المورد أو الدفعة.
              </span>
              {paymentSourcesHasMore ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loadingMoreSources}
                  onClick={onLoadMorePaymentSources}
                >
                  تحميل فواتير أقدم
                </Button>
              ) : null}
              {refundSourcesHasMore ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loadingMoreSources}
                  onClick={onLoadMoreRefundSources}
                >
                  تحميل دفعات أقدم
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <GovernanceApprovalQueue
        title="طلبات السداد بانتظار اعتماد"
        scope="supplier-payment"
        rows={pendingPayments}
        currentUserId={currentUserId}
        loading={pendingPaymentLoading}
        error={pendingPaymentError}
        pending={decisionPending}
        reviewAllowed={canDecide}
        reviewBlockedReason={decisionBlockedReason}
        onRetry={onRetryPendingPayments}
        onDecide={onDecidePayment}
      />
      <GovernanceApprovalQueue
        title="طلبات استرداد الدفعات بانتظار اعتماد"
        scope="supplier-payment-refund"
        rows={pendingRefunds}
        currentUserId={currentUserId}
        loading={pendingRefundLoading}
        error={pendingRefundError}
        pending={decisionPending}
        reviewAllowed={canDecide}
        reviewBlockedReason={decisionBlockedReason}
        onRetry={onRetryPendingRefunds}
        onDecide={onDecideRefund}
      />

      <Dialog
        open={mode != null}
        onOpenChange={(open) => !open && !requestPending && reset()}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {mode === "PAYMENT"
                ? "طلب سداد فواتير مورد"
                : "طلب استرداد دفعة مورد"}
            </DialogTitle>
            <DialogDescription>
              خصص المبلغ على فواتير أو تخصيصات مؤهلة. مجموع البنود هو رأس الطلب
              ولا يُطبّق عند الإرسال.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {mode === "PAYMENT" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="supplier-payment-group">المورد والعملة</Label>
                  <AppSelect
                    id="supplier-payment-group"
                    value={groupKey}
                    onValueChange={(value) => {
                      setGroupKey(value);
                      setAmounts({});
                      const source = paymentSources.find(
                        (row) => `${row.supplierId}:${row.currency}` === value,
                      );
                      setExchangeRate(source?.exchangeRate ?? "");
                    }}
                    disabled={loadingSources || Boolean(sourcesError)}
                  >
                    <option value="">اختر مورداً وعملة</option>
                    {groups.map(([key, group]) => (
                      <option key={key} value={key}>
                        {group.supplierLabel} — {group.currency}
                      </option>
                    ))}
                  </AppSelect>
                </div>
                {selectedGroup?.currency === "USD" ? (
                  <div className="space-y-2">
                    <Label htmlFor="supplier-payment-rate">سعر الصرف</Label>
                    <MoneyInput
                      id="supplier-payment-rate"
                      value={exchangeRate}
                      onChange={setExchangeRate}
                      decimals={4}
                      ariaLabel="سعر الصرف"
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="supplier-payment-refund-source">الدفعة</Label>
                <AppSelect
                  id="supplier-payment-refund-source"
                  value={refundId}
                  onValueChange={(value) => {
                    setRefundId(value);
                    setAmounts({});
                  }}
                  disabled={loadingSources || Boolean(sourcesError)}
                >
                  <option value="">اختر دفعة مؤهلة</option>
                  {refundSources.map((row) => (
                    <option
                      key={row.supplierPaymentId}
                      value={row.supplierPaymentId}
                    >
                      {row.paymentNumber} — {row.supplierLabel}
                    </option>
                  ))}
                </AppSelect>
              </div>
            )}

            {invoiceRows.length ? (
              <div className="space-y-2">
                <Label>التخصيصات</Label>
                <div className="space-y-3 rounded-md border p-3">
                  {invoiceRows.map((row) => {
                    const id =
                      "supplierInvoiceId" in row
                        ? row.supplierInvoiceId
                        : row.supplierPaymentAllocationId;
                    const number = row.invoiceNumber;
                    const maxAmount =
                      "remainingAmount" in row
                        ? row.remainingAmount
                        : row.refundableAmount;
                    const maxCurrency =
                      "remainingCurrencyAmount" in row
                        ? row.remainingCurrencyAmount
                        : row.refundableCurrencyAmount;
                    return (
                      <div
                        key={id}
                        className="grid gap-2 rounded border p-2 sm:grid-cols-[1fr_11rem_11rem] sm:items-end"
                      >
                        <div className="text-sm">
                          <p className="font-medium" dir="ltr">
                            {number}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            متبقي: {fmt(maxAmount)} د.ع · {fmt(maxCurrency)}{" "}
                            بالعملة
                          </p>
                        </div>
                        <div>
                          <Label
                            htmlFor={`payment-iqd-${id}`}
                            className="text-xs"
                          >
                            المبلغ د.ع
                          </Label>
                          <MoneyInput
                            id={`payment-iqd-${id}`}
                            value={amounts[id]?.amount ?? ""}
                            onChange={(amount) =>
                              setAmounts((current) => ({
                                ...current,
                                [id]: {
                                  amount,
                                  currencyAmount:
                                    formCurrency === "IQD"
                                      ? amount
                                      : (current[id]?.currencyAmount ?? ""),
                                },
                              }))
                            }
                            ariaLabel={`مبلغ ${number} بالدينار`}
                          />
                        </div>
                        <div>
                          <Label
                            htmlFor={`payment-currency-${id}`}
                            className="text-xs"
                          >
                            مبلغ العملة
                          </Label>
                          <MoneyInput
                            id={`payment-currency-${id}`}
                            value={amounts[id]?.currencyAmount ?? ""}
                            onChange={(currencyAmount) =>
                              setAmounts((current) => ({
                                ...current,
                                [id]: {
                                  amount: current[id]?.amount ?? "",
                                  currencyAmount,
                                },
                              }))
                            }
                            disabled={formCurrency === "IQD"}
                            ariaLabel={`مبلغ ${number} بالعملة`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-sm font-semibold" dir="ltr">
                  الإجمالي: {fmt(totalAmount)} د.ع · {fmt(totalCurrencyAmount)}{" "}
                  بالعملة
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="supplier-payment-method">طريقة الحركة</Label>
                <AppSelect
                  id="supplier-payment-method"
                  value={method}
                  onValueChange={(value) => setMethod(value as Method)}
                >
                  <option value="CASH">نقدي</option>
                  <option value="CARD">بطاقة</option>
                  <option value="TRANSFER">تحويل</option>
                  <option value="WALLET">محفظة</option>
                </AppSelect>
              </div>
              {method !== "CASH" ? (
                <div className="space-y-2">
                  <Label htmlFor="supplier-payment-reference">
                    مرجع الحركة
                  </Label>
                  <Input
                    id="supplier-payment-reference"
                    value={externalReference}
                    maxLength={160}
                    onChange={(event) =>
                      setExternalReference(event.target.value)
                    }
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="supplier-payment-evidence-type">
                  نوع الدليل
                </Label>
                <AppSelect
                  id="supplier-payment-evidence-type"
                  value={evidenceType}
                  onValueChange={(value) =>
                    setEvidenceType(value as PaymentEvidence)
                  }
                >
                  <option value="PAYMENT_ORDER">أمر دفع</option>
                  <option value="BANK_ADVICE">إشعار مصرفي</option>
                  <option value="TRANSFER_RECEIPT">وصل تحويل</option>
                  <option value="CASH_ACKNOWLEDGEMENT">إقرار نقدي</option>
                  <option value="DOCUMENT_IMAGE">صورة مستند</option>
                  <option value="PDF">ملف PDF</option>
                  <option value="OTHER">دليل آخر</option>
                </AppSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="supplier-payment-evidence">مرجع الدليل</Label>
                <Input
                  id="supplier-payment-evidence"
                  value={evidenceReference}
                  maxLength={500}
                  onChange={(event) => setEvidenceReference(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="supplier-payment-reason">سبب الطلب</Label>
              <Textarea
                id="supplier-payment-reason"
                value={reason}
                rows={4}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={requestPending}
              onClick={reset}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              pending={requestPending}
              pendingText={ACTION_LABELS.sending}
              disabled={!valid}
              onClick={() => void submitRequest()}
            >
              إرسال للاعتماد
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

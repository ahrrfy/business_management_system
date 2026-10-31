import { useEffect, useMemo, useRef, useState } from "react";
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
import { trpc } from "@/lib/trpc";
import { canLifecycleOperation } from "@/lib/lifecycleOperationAccess";
import { shiftTypeLabel } from "@/lib/labels";
import { notify } from "@/lib/notify";
import { financialIntentScopeKey, isDefinitiveIntentRejection, loadFinancialIntent, reserveFinancialIntent, resolveFinancialIntent, type FinancialIntent, type FinancialIntentScope } from "@/lib/persistedFinancialIntent";

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
  purchaseOrderIds?: number[];
};

export type SupplierRefundSource = {
  supplierPaymentId: number;
  paymentNumber: string;
  paymentVersion: number;
  derivesInvoiceCurrency?: boolean;
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
  isOwner,
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
  isOwner?: boolean;
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
    cashSource?: {
      mode: "DRAWER" | "TREASURY";
      shiftId?: number | null;
    } | null;
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
    cashSource?: {
      mode: "DRAWER" | "TREASURY";
      shiftId?: number | null;
    } | null;
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
  const me = trpc.auth.me.useQuery();
  type SupplierCommand = { mode: "PAYMENT"; input: Parameters<typeof onRequestPayment>[0] } | { mode: "REFUND"; input: Parameters<typeof onRequestRefund>[0] };
  const intentScope: FinancialIntentScope | null = me.data?.id && branchId > 0
    ? { companyId: me.data.companyId ?? null, userId: me.data.id, branchId, operation: "SUPPLIER_SETTLEMENT", target: "workspace" } : null;
  const scopeKey = intentScope ? financialIntentScopeKey(intentScope) : "";
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const sendingRef = useRef(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [loadedScope, setLoadedScope] = useState("");
  const [intentReadError, setIntentReadError] = useState("");
  const [pendingSlot, setPendingSlot] = useState<{ scopeKey: string; intent: FinancialIntent<SupplierCommand> } | null>(null);
  const pendingIntent = pendingSlot?.scopeKey === scopeKey ? pendingSlot.intent : null;
  useEffect(() => {
    if (!intentScope) return;
    let cancelled = false;
    setIntentReadError("");
    void loadFinancialIntent<SupplierCommand>(intentScope).then(saved => {
      if (cancelled) return;
      setPendingSlot(saved ? { scopeKey, intent: saved } : null);
      setLoadedScope(scopeKey);
    }).catch(() => { if (!cancelled) setIntentReadError("تعذّرت قراءة محاولة المورد المحفوظة؛ أعد فتح الشاشة دون مسح التخزين المحلي."); });
    return () => { cancelled = true; };
  }, [scopeKey]);
  const canRequestPayment = canLifecycleOperation(me.data, "supplierPayments.requestPayment", true);
  const canRequestRefund = canLifecycleOperation(me.data, "supplierPayments.requestRefund", true);
  const [mode, setMode] = useState<"PAYMENT" | "REFUND" | null>(null);
  const [groupKey, setGroupKey] = useState("");
  const [refundId, setRefundId] = useState("");
  const [amounts, setAmounts] = useState<
    Record<number, { amount: string; currencyAmount: string }>
  >({});
  const [method, setMethod] = useState<Method>("TRANSFER");
  const [cashMode, setCashMode] = useState<"DRAWER" | "TREASURY">("DRAWER");
  const [cashShiftId, setCashShiftId] = useState("");
  const cashSourcesQuery = trpc.supplierPayments.cashSources.useQuery(
    { branchId },
    { enabled: branchId > 0 && mode != null && method === "CASH" },
  );
  const sourceRequests = trpc.supplierPayments.pendingPayments.useQuery(
    { branchId },
    { enabled: branchId > 0 },
  );
  const refundSourceRequests =
    trpc.supplierPayments.pendingRefunds.useInfiniteQuery(
      { branchId, limit: 100 },
      {
        enabled: branchId > 0,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
      },
    );
  useEffect(() => {
    const drawers = cashSourcesQuery.data?.drawers ?? [];
    if (!cashShiftId && drawers.length === 1)
      setCashShiftId(String(drawers[0].id));
  }, [cashSourcesQuery.data, cashShiftId]);
  const paymentQueueRows = pendingPayments.map((row) => {
    const request = sourceRequests.data?.find(
      (request) => Number(request.id) === row.id,
    );
    if (request?.paymentMethod !== "CASH") return row;
    const source = request.cashSource;
    return {
      ...row,
      details: [
        ...(row.details ?? []),
        {
          label: "مصدر النقد والدافع",
          value: source
            ? source.mode === "DRAWER"
              ? `درج ${source.shiftId} — المستخدم ${source.payerUserId}`
              : `خزينة الفرع ${branchId} — المستخدم ${source.payerUserId}`
            : "مصدر غير محدّد: ارفض الطلب وأعد تقديمه بمصدر صريح",
        },
      ],
    };
  });
  const refundQueueRows = pendingRefunds.map((row) => {
    const request = refundSourceRequests.data?.pages
      .flatMap((page) => page.rows)
      .find((request) => Number(request.id) === row.id);
    if (request?.refundMethod !== "CASH") return row;
    const source = request.cashSource;
    return {
      ...row,
      details: [
        ...(row.details ?? []),
        {
          label: "وجهة النقد والمستلم",
          value: source
            ? source.mode === "DRAWER"
              ? `درج ${source.shiftId} — المستخدم ${source.receiverUserId}`
              : `خزينة الفرع ${branchId} — المستخدم ${source.receiverUserId}`
            : "مصدر غير محدّد: ارفض الطلب وأعد تقديمه بمصدر صريح",
        },
      ],
    };
  });
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
  const derivesRefundCurrency =
    mode === "REFUND" && selectedRefund?.derivesInvoiceCurrency === true;
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
    (method !== "CASH" ||
      (cashMode === "TREASURY"
        ? cashSourcesQuery.data?.canUseTreasury === true
        : cashSourcesQuery.data?.drawers.some(
            (row) => String(row.id) === cashShiftId,
          ) === true)) &&
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
    setCashMode("DRAWER");
    setCashShiftId("");
    setExchangeRate("");
    setExternalReference("");
    setEvidenceType("BANK_ADVICE");
    setEvidenceReference("");
    setReason("");
  }

  async function submitRequest() {
    if (sendingRef.current || pendingIntent || !intentScope || loadedScope !== scopeKey || intentReadError) return;
    if (mode === "PAYMENT" ? !canRequestPayment : !canRequestRefund) return;
    if (!valid) return;
    if (
      method === "CASH" &&
      !(cashMode === "TREASURY"
        ? cashSourcesQuery.data?.canUseTreasury
        : cashSourcesQuery.data?.drawers.some(
            (row) => String(row.id) === cashShiftId,
          ))
    )
      return;
    if (mode === "PAYMENT" && selectedGroup) {
      const byId = new Map(
        groupInvoices.map((row) => [row.supplierInvoiceId, row]),
      );
      try {
        const sent = await sendSupplierCommand({ mode: "PAYMENT", input: {
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
          cashSource:
            method === "CASH"
              ? {
                  mode: cashMode,
                  shiftId: cashMode === "DRAWER" ? Number(cashShiftId) : null,
                }
              : null,
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
        } });
        if (sent) reset();
      } catch {
        // يبقى الحوار مفتوحاً ويعرض مالك mutation الخطأ.
      }
      return;
    }
    if (mode === "REFUND" && selectedRefund) {
      try {
        const sent = await sendSupplierCommand({ mode: "REFUND", input: {
          supplierPaymentId: selectedRefund.supplierPaymentId,
          expectedPaymentVersion: selectedRefund.paymentVersion,
          requestKey: newGovernanceKey(
            `supplier-payment-refund-${selectedRefund.supplierPaymentId}`,
          ),
          refundMethod: method,
          cashSource:
            method === "CASH"
              ? {
                  mode: cashMode,
                  shiftId: cashMode === "DRAWER" ? Number(cashShiftId) : null,
                }
              : null,
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
        } });
        if (sent) reset();
      } catch {
        // يبقى الحوار مفتوحاً ويعرض مالك mutation الخطأ.
      }
    }
  }

  async function sendSupplierCommand(proposal?: SupplierCommand, recovery?: FinancialIntent<SupplierCommand>): Promise<boolean> {
    if (sendingRef.current || !intentScope || loadedScope !== scopeKey || intentReadError) return false;
    const command = recovery?.payload ?? proposal;
    if (!command) return false;
    sendingRef.current = true; setRecoveryBusy(true);
    const capturedScope = intentScope;
    let saved: FinancialIntent<SupplierCommand> | null = null;
    let dispatched = false;
    let rejected = false;
    try {
      const proposed = recovery ?? { id: command.input.requestKey, createdAt: new Date().toISOString(), payload: command };
      saved = await reserveFinancialIntent(capturedScope, proposed);
      if (financialIntentScopeKey(capturedScope) !== scopeRef.current) throw new Error("تغيّرت هوية الجلسة.");
      setPendingSlot({ scopeKey, intent: saved });
      if (saved.id !== proposed.id) { notify.err("توجد محاولة محفوظة", "استرد نتيجة الطلب السابق قبل إنشاء طلب جديد."); return false; }
      dispatched = true;
      if (saved.payload.mode === "PAYMENT") await onRequestPayment(saved.payload.input);
      else await onRequestRefund(saved.payload.input);
      if (await resolveFinancialIntent(capturedScope, saved.id)) {
        if (financialIntentScopeKey(capturedScope) === scopeRef.current) setPendingSlot(null);
      }
      return financialIntentScopeKey(capturedScope) === scopeRef.current;
    } catch (error) {
      if (saved && dispatched && !recovery && isDefinitiveIntentRejection(error)) {
        try { if (await resolveFinancialIntent(capturedScope, saved.id)) { rejected = true; if (financialIntentScopeKey(capturedScope) === scopeRef.current) setPendingSlot(null); } } catch { /* Preserve unresolved intent. */ }
      }
      notify.err("تعذّر إكمال الطلب", rejected ? "رفض الخادم الطلب قبل تسجيله؛ راجع المدخلات ثم أعد المحاولة." : dispatched ? "احتفظنا بالمفتاح والحمولة؛ استخدم استرداد الطلب السابق دون إنشاء طلب بديل." : "تعذّر حفظ هوية الطلب؛ لم يُرسل طلب جديد.");
      return false;
    } finally { sendingRef.current = false; setRecoveryBusy(false); }
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
                disabled={!canRequestPayment || !!pendingIntent || recoveryBusy || loadedScope !== scopeKey || !!intentReadError}
              >
                طلب سداد
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setMode("REFUND")}
                disabled={!canRequestRefund || !!pendingIntent || recoveryBusy || loadedScope !== scopeKey || !!intentReadError}
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
          {intentReadError && <p role="alert" className="text-sm text-destructive">{intentReadError}</p>}
          {pendingIntent && <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
            <p>توجد محاولة {pendingIntent.payload.mode === "PAYMENT" ? "سداد" : "استرداد دفعة"} محفوظة. استرد نتيجتها بالمفتاح والتخصيصات الأصلية.</p>
            <Button type="button" disabled={requestPending || recoveryBusy} onClick={() => { void sendSupplierCommand(undefined, pendingIntent).then(done => { if (done) reset(); }); }}>استرداد طلب المورد السابق</Button>
          </div>}
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
                توجد مصادر مؤهلة أقدم. حمّل بقية الصفحات قبل اختيار المورد أو
                الدفعة.
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
        rows={paymentQueueRows}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={pendingPaymentLoading}
        error={pendingPaymentError}
        pending={decisionPending}
        reviewAllowed={canLifecycleOperation(me.data, "supplierPayments.decidePayment", canDecide)}
        reviewBlockedReason={decisionBlockedReason}
        onRetry={onRetryPendingPayments}
        onDecide={onDecidePayment}
      />
      <GovernanceApprovalQueue
        title="طلبات استرداد الدفعات بانتظار اعتماد"
        scope="supplier-payment-refund"
        rows={refundQueueRows}
        currentUserId={currentUserId}
        isOwner={isOwner}
        loading={pendingRefundLoading}
        error={pendingRefundError}
        pending={decisionPending}
        reviewAllowed={canLifecycleOperation(me.data, "supplierPayments.decideRefund", canDecide)}
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
          <fieldset disabled={!!pendingIntent || recoveryBusy || requestPending} className="space-y-4">
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
                                    (formCurrency === "IQD" || derivesRefundCurrency)
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
                          {derivesRefundCurrency ? (
                            <p className="py-2 text-sm text-muted-foreground">
                              تُحسب تلقائياً من تخصيص الدفع الأصلي
                            </p>
                          ) : (
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
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-sm font-semibold" dir="ltr">
                  الإجمالي: {fmt(totalAmount)} د.ع
                  {!derivesRefundCurrency && (
                    <> · {fmt(totalCurrencyAmount)} بالعملة</>
                  )}
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
              {method === "CASH" ? (
                <div className="space-y-2">
                  <Label htmlFor="supplier-payment-cash-source">
                    {mode === "PAYMENT" ? "مصدر النقد" : "وجهة استلام النقد"}
                  </Label>
                  <AppSelect
                    id="supplier-payment-cash-source"
                    value={cashMode}
                    onValueChange={(value) =>
                      setCashMode(value as "DRAWER" | "TREASURY")
                    }
                  >
                    <option value="DRAWER">درجي المفتوح</option>
                    {cashSourcesQuery.data?.canUseTreasury ? (
                      <option value="TREASURY">خزينة الفرع</option>
                    ) : null}
                  </AppSelect>
                  {cashMode === "DRAWER" ? (
                    <AppSelect
                      aria-label={
                        mode === "PAYMENT" ? "درج الدافع" : "درج المستلم"
                      }
                      value={cashShiftId}
                      onValueChange={setCashShiftId}
                    >
                      <option value="">اختر درجك المفتوح</option>
                      {(cashSourcesQuery.data?.drawers ?? []).map((row) => (
                        <option key={row.id} value={row.id}>
                          {shiftTypeLabel(row.shiftType)} — درج {row.id}
                        </option>
                      ))}
                    </AppSelect>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {mode === "PAYMENT"
                      ? "يُحفظ المصدر مع الطلب ويُصرف منه عند الاعتماد."
                      : "تُحفظ وجهة الاستلام مع الطلب ويُضاف إليها النقد عند الاعتماد."}{" "}
                    إغلاق الدرج يتطلب طلباً جديداً.
                  </p>
                  {cashSourcesQuery.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {cashSourcesQuery.error.message}
                    </p>
                  ) : null}
                  {!cashSourcesQuery.isLoading &&
                  cashMode === "DRAWER" &&
                  !cashSourcesQuery.data?.drawers.length ? (
                    <p role="alert" className="text-sm">
                      لا يوجد درج مفتوح لك في هذا الفرع. افتح وردية أو اختر
                      الخزينة إن كانت لديك صلاحيتها.
                    </p>
                  ) : null}
                </div>
              ) : null}
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
          </fieldset>
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
              disabled={!valid || !!pendingIntent || recoveryBusy || loadedScope !== scopeKey || !!intentReadError}
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

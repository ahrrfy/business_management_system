import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState, LoadingState } from "@/components/PageState";
import { RefundRailPicker, type RefundRailPickerState } from "@/components/ui/RefundRailPicker";
import { D, fmtAr } from "@/lib/money";
import { newClientRequestId } from "@/lib/countQueue";
import { notify } from "@/lib/notify";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const REVERSE_REASON_PRESETS = [
  "رفض الزبون الاستلام",
  "تراجع الزبون",
  "عيب في التنفيذ",
  "خطأ في الطلب",
] as const;

type ReverseControlInput = Extract<
  RouterInputs["workOrders"]["requestControl"],
  { requestType: "REVERSE_DELIVERY" }
>;
type ReversePreflight = NonNullable<
  RouterOutputs["workOrders"]["controlPreflight"]["reverseDelivery"]
>;
type EligibleReversePreflight = Extract<ReversePreflight, { eligible: true }>;
type ReverseRefundSourceInput = ReverseControlInput["payload"]["refundSources"][number];

export interface PendingReverseDeliveryAttempt {
  input: ReverseControlInput;
}

export function isRequestableReverseRefundSource(
  source: EligibleReversePreflight["refundSources"][number],
): source is EligibleReversePreflight["refundSources"][number] & ReverseRefundSourceInput {
  return source.collectedMethod !== "EXCHANGE";
}

export function buildReverseDeliveryControlAttempt(args: {
  workOrderId: number;
  reason: string;
  reopen: boolean;
  refundShiftId: number | null;
  requestKey: string;
  preflight: EligibleReversePreflight;
}): PendingReverseDeliveryAttempt {
  if (!args.preflight.refundSources.every(isRequestableReverseRefundSource)) {
    throw new Error("تتضمن خطة الرد طريقة قبض لا يقبلها عقد طلب العكس");
  }
  const refundSources: ReverseRefundSourceInput[] = args.preflight.refundSources.map((source) => ({
    sourceReceiptId: source.sourceReceiptId,
    amount: source.amount,
    collectedMethod: source.collectedMethod,
    refundMethod: source.refundMethod,
    counterRole: source.counterRole,
  }));
  return {
    input: {
      requestType: "REVERSE_DELIVERY",
      requestKey: args.requestKey,
      workOrderId: args.workOrderId,
      baseVersion: args.preflight.version,
      reason: args.reason.trim(),
      payload: {
        expectedVersion: args.preflight.version,
        reopen: args.reopen,
        refundShiftId: args.refundShiftId,
        refundSources,
      },
    },
  };
}

export function reverseDeliveryAttemptStorageKey(workOrderId: number): string {
  return `work-order-reverse-delivery-attempt:${workOrderId}`;
}

function isStoredAttempt(value: unknown, workOrderId: number): value is PendingReverseDeliveryAttempt {
  if (!value || typeof value !== "object") return false;
  const input = (value as { input?: Partial<ReverseControlInput> }).input;
  return input?.requestType === "REVERSE_DELIVERY"
    && input.workOrderId === workOrderId
    && typeof input.requestKey === "string"
    && typeof input.reason === "string"
    && typeof input.baseVersion === "number"
    && !!input.payload
    && Array.isArray(input.payload.refundSources);
}

function consignmentReadyForReverse(preflight: EligibleReversePreflight): boolean {
  const consignment = preflight.consignment;
  if (!consignment) return true;
  return consignment.status === "DELIVERED"
    && consignment.parcelStatus === "DELIVERED"
    && (consignment.moneyStatus === "SETTLED" || consignment.moneyStatus === "NOT_APPLICABLE");
}

export default function ReverseDeliveryRequestDialog({
  workOrderId,
  orderNumber,
  title,
  buttonLabel = "مرتجع / عكس تسليم",
  size = "default",
  defaultOpen = false,
  hideTrigger = false,
  onOpenChange,
  onRequested,
}: {
  workOrderId: number;
  orderNumber?: string | null;
  title?: string | null;
  buttonLabel?: string;
  size?: "sm" | "default";
  defaultOpen?: boolean;
  hideTrigger?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequested?: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(defaultOpen);
  const [reason, setReason] = useState<string>(REVERSE_REASON_PRESETS[0]);
  const [reopen, setReopen] = useState(false);
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);
  const [rail, setRail] = useState<RefundRailPickerState | null>(null);
  const [attempt, setAttempt] = useState<PendingReverseDeliveryAttempt | null>(null);
  const [submitError, setSubmitError] = useState("");
  const attemptRef = useRef<PendingReverseDeliveryAttempt | null>(null);
  const preflightQuery = trpc.workOrders.controlPreflight.useQuery(
    { workOrderId },
    { enabled: open && Number.isInteger(workOrderId) && workOrderId > 0 },
  );
  const preflight = preflightQuery.data?.reverseDelivery ?? null;

  const rememberAttempt = (next: PendingReverseDeliveryAttempt) => {
    attemptRef.current = next;
    setAttempt(next);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(reverseDeliveryAttemptStorageKey(workOrderId), JSON.stringify(next));
    }
  };
  const forgetAttempt = () => {
    attemptRef.current = null;
    setAttempt(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(reverseDeliveryAttemptStorageKey(workOrderId));
    }
  };
  const recoverAttempt = (): PendingReverseDeliveryAttempt | null => {
    if (attemptRef.current) return attemptRef.current;
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(reverseDeliveryAttemptStorageKey(workOrderId));
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredAttempt(parsed, workOrderId)) return null;
      attemptRef.current = parsed;
      return parsed;
    } catch {
      return null;
    }
  };

  const updateOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const request = trpc.workOrders.requestControl.useMutation({
    onSuccess: async (result) => {
      const message = result.status === "APPROVED"
        ? "تم اعتماد الطلب مسبقاً وتحديث بياناته."
        : result.status === "REJECTED"
          ? "تم رفض هذا الطلب مسبقاً."
          : result.status === "STALE"
            ? "تغيّرت بيانات الطلب؛ حدّث الصفحة وحاول مجدداً."
            : result.replayed
              ? "طلب المرتجع مسجّل مسبقاً وبانتظار موافقة المدير."
              : "أُرسل طلب المرتجع وعكس التسليم لموافقة المدير.";
      forgetAttempt();
      setSubmitError("");
      updateOpen(false);
      setReason(REVERSE_REASON_PRESETS[0]);
      setReopen(false);
      setRefundShiftId(null);
      notify.ok("أُرسل الطلب", message);
      onRequested?.(message);
      await Promise.all([
        utils.workOrders.pendingControlRequests.invalidate(),
        utils.workOrders.controlPreflight.invalidate({ workOrderId }),
        utils.workOrders.get.invalidate({ workOrderId }),
        utils.workOrders.list.invalidate(),
        utils.workOrders.eventTimeline.invalidate({ workOrderId }),
        utils.sales.get.invalidate(),
        utils.sales.list.invalidate(),
      ]);
    },
    onError: (error) => {
      setSubmitError(`${error.message} — يمكنك إعادة المحاولة بأمان.`);
    },
  });

  useEffect(() => {
    if (!open) return;
    const recovered = recoverAttempt();
    if (!recovered) {
      setReason((prev) => (prev.trim().length >= 3 ? prev : REVERSE_REASON_PRESETS[0]));
      return;
    }
    setAttempt(recovered);
    setReason(recovered.input.reason);
    setReopen(recovered.input.payload.reopen);
    setRefundShiftId(recovered.input.payload.refundShiftId ?? null);
  }, [open, workOrderId]);

  const eligiblePreflight = preflight?.eligible ? preflight : null;
  const cashRefundRequired = eligiblePreflight?.refundSources.some((source) => source.refundMethod === "CASH") ?? false;
  const plannedRefundTotal = useMemo(
    () => eligiblePreflight?.refundSources.reduce((sum, source) => sum.plus(D(source.amount)), D(0)).toFixed(2) ?? "0.00",
    [eligiblePreflight],
  );
  const liveConsignment = eligiblePreflight ? !consignmentReadyForReverse(eligiblePreflight) : false;
  const unsupportedRefundSource = eligiblePreflight?.refundSources.some((source) => !isRequestableReverseRefundSource(source)) ?? false;
  const railReady = rail != null && !rail.loading && rail.error == null && rail.preflight != null;
  const pickedRail = railReady ? rail.selection?.rail ?? null : null;
  const shiftRequiredButMissing = cashRefundRequired
    && (!railReady || rail.blockReason != null || pickedRail == null || (pickedRail === "DRAWER" && refundShiftId == null));
  const cashShiftUnavailable = cashRefundRequired && railReady
    && rail.preflight!.drawers.length === 0 && !rail.preflight!.rails.TREASURY.available;

  const submitFreshAttempt = () => {
    if (!eligiblePreflight || reason.trim().length < 3 || liveConsignment || unsupportedRefundSource || shiftRequiredButMissing || cashShiftUnavailable) return;
    const next = buildReverseDeliveryControlAttempt({
      workOrderId,
      reason,
      reopen,
      refundShiftId: cashRefundRequired ? refundShiftId : null,
      requestKey: newClientRequestId(),
      preflight: eligiblePreflight,
    });
    rememberAttempt(next);
    setSubmitError("");
    request.mutate(next.input);
  };

  const retryExactAttempt = () => {
    const exact = attemptRef.current ?? attempt;
    if (!exact) return;
    setSubmitError("");
    request.mutate(exact.input);
  };

  const discardAndRefresh = () => {
    forgetAttempt();
    setSubmitError("");
    void preflightQuery.refetch();
  };

  const handleOpenChange = (next: boolean) => {
    if (request.isPending) return;
    updateOpen(next);
    if (next) setSubmitError("");
  };

  return (
    <>
      {!hideTrigger && (
        <Button variant="destructive" size={size} onClick={() => updateOpen(true)}>
          <RotateCcw aria-hidden className="me-1 size-4" />
          {buttonLabel}
        </Button>
      )}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw aria-hidden className="size-4" />
              مرتجع / عكس تسليم الطلب
            </DialogTitle>
            <DialogDescription>
              {[title ? `«${title}»` : null, orderNumber ? `الطلب ${orderNumber}` : null].filter(Boolean).join(" — ")}
            </DialogDescription>
          </DialogHeader>

          {preflightQuery.isLoading || preflightQuery.isFetching ? (
            <LoadingState message={ACTION_LABELS.verifying} className="py-8" />
          ) : preflightQuery.isError ? (
            <ErrorState
              message="تعذّر التحقق من حالة الأمر ومصادر القبض والورديات؛ أُوقف الطلب حتى نجاح التحقق."
              onRetry={() => void preflightQuery.refetch()}
              className="py-8"
            />
          ) : !eligiblePreflight ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {preflight && !preflight.eligible
                ? preflight.ineligibleReason
                : "هذا الطلب ليس في حالة «مُسلَّم» قابلة للإرجاع."}
            </div>
          ) : (
            <div className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">المقبوض الصافي</span>
                  <span dir="ltr" className="font-bold tabular-nums">{fmtAr(eligiblePreflight.netPaid)} د.ع</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">يُردّ عند الاعتماد</span>
                  <span dir="ltr" className="font-bold tabular-nums text-destructive">{fmtAr(plannedRefundTotal)} د.ع</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-bold">مصادر الاسترداد المطابقة للمقبوضات</Label>
                {eligiblePreflight.refundSources.length === 0 ? (
                  <p className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
                    لا يوجد مبلغ مقبوض يُردّ للزبون.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {eligiblePreflight.refundSources.map((source) => (
                      <div
                        key={`${source.sourceReceiptId}:${source.counterRole}:${source.refundMethod}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                      >
                        <span>
                          {paymentMethodLabel(source.collectedMethod)} ← ردّ {paymentMethodLabel(source.refundMethod)}
                        </span>
                        <span dir="ltr" className="font-bold tabular-nums">{fmtAr(source.amount)} د.ع</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {cashRefundRequired && (
                <div className="space-y-2 rounded-md border p-3">
                  <Label className="text-xs font-bold">وردية الاسترداد النقدي</Label>
                  <RefundRailPicker
                    context={{ sourceDocType: "WORKORDER_REVERSE_DELIVERY", sourceDocId: workOrderId }}
                    mode="embedded"
                    onStateChange={(next) => {
                      setRail(next);
                      setRefundShiftId(next.selection?.refundShiftId ?? null);
                    }}
                    initialSelection={attempt?.input.payload.refundShiftId != null ? { rail: "DRAWER", refundShiftId: attempt.input.payload.refundShiftId } : null}
                    drawerLabel="درج الاسترداد النقدي"
                    drawerHint="يُصرف النقد من درج الاستقبال المختار عند موافقة المدير."
                    submitting={attempt != null || request.isPending}
                  />
                  {cashShiftUnavailable ? (
                    <p role="alert" className="text-xs font-bold text-destructive">
                      لا توجد وردية استقبال مفتوحة؛ افتح ورديةً أولاً.
                    </p>
                  ) : pickedRail === "TREASURY" ? (
                    <p className="text-xs text-muted-foreground">
                      يُصرف المبلغ من خزينة الفرع عند اعتماد المدير.
                    </p>
                  ) : railReady && rail.blockReason ? (
                    <p className="text-xs font-bold text-[var(--sem-warn)]">{rail.blockReason}</p>
                  ) : null}
                </div>
              )}

              {eligiblePreflight.consignment && liveConsignment && (
                <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]">
                  الإرسالية {eligiblePreflight.consignment.number} ما زالت نشطة؛ أكمل إرجاع الطرد مع المندوب أولاً.
                </div>
              )}

              {unsupportedRefundSource && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                  طريقة قبض قديمة غير مدعومة في هذا المسار؛ راجع المدير.
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor={`reverse-reason-${workOrderId}`} className="text-xs font-bold">سبب المرتجع</Label>
                <div className="flex flex-wrap gap-1.5">
                  {REVERSE_REASON_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      disabled={attempt != null || request.isPending}
                      onClick={() => setReason(preset)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                        reason.trim() === preset
                          ? "border-destructive bg-destructive text-destructive-foreground"
                          : "border-border bg-muted/40 text-foreground hover:bg-muted",
                      )}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <Textarea
                  id={`reverse-reason-${workOrderId}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={attempt != null || request.isPending}
                  maxLength={500}
                  rows={2}
                  placeholder="اختر سبباً أو اكتب ملاحظة مختصرة"
                />
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id={`reverse-reopen-${workOrderId}`}
                  checked={reopen}
                  onCheckedChange={(checked) => setReopen(checked === true)}
                  disabled={attempt != null || request.isPending}
                />
                <Label htmlFor={`reverse-reopen-${workOrderId}`} className="cursor-pointer text-xs font-normal leading-5">
                  إعادة الطلب إلى «جاهز للتسليم» بعد الموافقة (بدلاً من إلغائه نهائياً)
                </Label>
              </div>

              <p className="rounded-md bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
                يُرسل الطلب لموافقة المدير أولاً؛ لا تصبح حالة الأمر «جاهز» أو «ملغى» قبل اعتماد مراجع مستقل.
              </p>

              {submitError && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={request.isPending}>
                {ACTION_LABELS.close}
              </Button>
              {attempt && (
                <Button variant="outline" onClick={discardAndRefresh} disabled={request.isPending}>
                  تحديث
                </Button>
              )}
            </div>
            <Button
              variant="destructive"
              disabled={
                request.isPending
                || (!attempt && (
                  !eligiblePreflight
                  || reason.trim().length < 3
                  || liveConsignment
                  || unsupportedRefundSource
                  || shiftRequiredButMissing
                  || cashShiftUnavailable
                ))
              }
              onClick={attempt ? retryExactAttempt : submitFreshAttempt}
            >
              {request.isPending ? (
                <><Loader2 aria-hidden className="me-1 size-4 animate-spin" /> {ACTION_LABELS.sending}</>
              ) : attempt ? "إعادة الإرسال" : "تأكيد طلب المرتجع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

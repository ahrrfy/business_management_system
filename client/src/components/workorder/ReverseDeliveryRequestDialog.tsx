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
  buttonLabel = "طلب عكس التسليم",
  size = "default",
  onRequested,
}: {
  workOrderId: number;
  orderNumber?: string | null;
  title?: string | null;
  buttonLabel?: string;
  size?: "sm" | "default";
  onRequested?: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reopen, setReopen] = useState(false);
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);
  /** حالةُ منتقي الروافد الموحَّد — الدرجُ وسببُ الحجب من الخادم لا من قائمةٍ محلّيّة. */
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

  const request = trpc.workOrders.requestControl.useMutation({
    onSuccess: async (result) => {
      const message = result.status === "APPROVED"
        ? "استعاد النظام طلب عكس معتمداً سابقاً؛ حُدّثت التفاصيل من السجل الفعلي بدلاً من افتراض نتيجة جديدة."
        : result.status === "REJECTED"
          ? "استعاد النظام طلب عكس مرفوضاً سابقاً؛ لم ينفذ أي ردّ أو تغيير حالة بهذه المحاولة."
          : result.status === "STALE"
            ? "استعاد النظام طلب عكس متقادماً؛ لم ينفذ أي ردّ أو تغيير حالة بهذه المحاولة."
            : result.replayed
              ? "تحقق النظام من طلب عكس التسليم السابق؛ ما زال بانتظار مراجع مستقل، ولم تتغير حالة الأمر."
              : "أُرسل طلب عكس التسليم بلا ردّ مال أو تغيير حالة؛ ينتظر اعتماد مراجع مستقل.";
      forgetAttempt();
      setSubmitError("");
      setOpen(false);
      setReason("");
      setReopen(false);
      setRefundShiftId(null);
      notify.ok("طلب العكس قيد المراجعة", message);
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
      setSubmitError(`${error.message} — لم نفترض نجاح الطلب. أعد إرسال الحمولة المحفوظة نفسها للتحقق الآمن.`);
    },
  });

  useEffect(() => {
    if (!open) return;
    const recovered = recoverAttempt();
    if (!recovered) return;
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
  /**
   * الدرجُ من المنتقي الموحَّد: يُحجَب الإرسال بسبب المنتقي المقروء (لا درجَ · تعدّدٌ بلا اختيار ·
   * درجٌ أُغلق) — لا بعدِّ الورديات محلّياً. والمحاولةُ المحفوظة تُبذَر في المنتقي فيُحترَم درجُها.
   */
  const railReady = rail != null && !rail.loading && rail.error == null && rail.preflight != null;
  const pickedRail = railReady ? rail.selection?.rail ?? null : null;
  // الدرجُ يلزمه رقمٌ؛ والخزينةُ (المفتاح الناقص، ق١٠) اختيارٌ صريح بلا درج يُنفَّذ عند الاعتماد.
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
    setOpen(next);
    if (next) setSubmitError("");
  };

  return (
    <>
      <Button variant="destructive" size={size} onClick={() => setOpen(true)}>
        <RotateCcw aria-hidden className="me-1 size-4" />
        {buttonLabel}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw aria-hidden className="size-4" />
              طلب عكس تسليم أمر الشغل
            </DialogTitle>
            <DialogDescription>
              {[title ? `«${title}»` : null, orderNumber ? `الأمر ${orderNumber}` : null].filter(Boolean).join(" — ")}
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
                : "الأمر ليس في حالة «مُسلَّم» ذات فاتورة حيّة، لذلك لا يمكن فتح طلب عكس تسليم."}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">نسخة الأمر التي ستُراجع</span>
                  <span dir="ltr" className="font-mono font-bold">v{eligiblePreflight.version}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">صافي المقبوض بعد الردود المنفذة</span>
                  <span dir="ltr" className="font-bold tabular-nums">{fmtAr(eligiblePreflight.netPaid)} د.ع</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">ردود معلّقة سبق طلبها</span>
                  <span dir="ltr" className="tabular-nums">{fmtAr(eligiblePreflight.priorPendingOut)} د.ع</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">المبلغ الجديد المطلوب ردّه عند الاعتماد</span>
                  <span dir="ltr" className="font-bold tabular-nums">{fmtAr(plannedRefundTotal)} د.ع</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-bold">مصادر الاسترداد المطابقة للمقبوضات</Label>
                {eligiblePreflight.refundSources.length === 0 ? (
                  <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    لا يوجد مبلغ مقبوض جديد يحتاج إلى رد؛ يبقى عكس الذمة والقيد مشروطاً باعتماد المراجع.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {eligiblePreflight.refundSources.map((source) => (
                      <div
                        key={`${source.sourceReceiptId}:${source.counterRole}:${source.refundMethod}`}
                        className="grid gap-1 rounded-md border p-3 text-xs sm:grid-cols-[1fr_auto]"
                      >
                        <div>
                          <p className="font-semibold">سند القبض #{source.sourceReceiptId}</p>
                          <p className="text-muted-foreground">
                            {paymentMethodLabel(source.collectedMethod)} ← الرد عبر {paymentMethodLabel(source.refundMethod)}
                          </p>
                          <p className="text-muted-foreground">
                            الحساب المقابل: {source.counterRole === "OTHER_LIABILITY" ? "أمانة العميل" : "ذمة العميل"}
                          </p>
                        </div>
                        <span dir="ltr" className="self-center font-bold tabular-nums">{fmtAr(source.amount)} د.ع</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {cashRefundRequired && (
                <div className="space-y-2 rounded-md border p-3">
                  <Label>وردية الاسترداد النقدي</Label>
                  <p className="text-xs text-muted-foreground">
                    يخرج الرد النقدي من درج استقبال مفتوح في فرع الأمر، ويظهر في مطابقة اليوم.
                  </p>
                  {/*
                    المنتقي الموحَّد (ق١٠): الأدراجُ وكفايتُها من الخادم. بلا وردية استقبال مفتوحة تُعرَض
                    **الخزينة** رافداً (المفتاح الناقص — `WORK_ORDER_REVERSE_DELIVERY_COMPENSATION`): الطلبُ
                    يُرسَل بلا درج، والمعتمِدُ يصرف من الخزينة بصفته؛ وإن فُتحت وردية استقبال قبل الاعتماد
                    خرج النقد من درجها. والبطاقةُ تُعلَن غيرَ متاحة بسببها لا تُخفى.
                  */}
                  <RefundRailPicker
                    context={{ sourceDocType: "WORKORDER_REVERSE_DELIVERY", sourceDocId: workOrderId }}
                    mode="embedded"
                    onStateChange={(next) => {
                      setRail(next);
                      setRefundShiftId(next.selection?.refundShiftId ?? null);
                    }}
                    initialSelection={attempt?.input.payload.refundShiftId != null ? { rail: "DRAWER", refundShiftId: attempt.input.payload.refundShiftId } : null}
                    drawerLabel="درج الاسترداد النقدي"
                    drawerHint="النقد يخرج فوراً من درج الاستقبال المختار عند اعتماد الطلب."
                    submitting={attempt != null || request.isPending}
                  />
                  {cashShiftUnavailable ? (
                    <p role="alert" className="text-xs font-bold text-destructive">
                      لا توجد وردية استقبال مفتوحة ولا خزينةٌ متاحة؛ افتح ورديةً قبل إرسال الطلب.
                    </p>
                  ) : pickedRail === "TREASURY" ? (
                    <p className="text-xs text-muted-foreground">
                      لا وردية استقبال مفتوحة — يُصرَف الردّ من خزينة الفرع عند اعتماد الطلب بصفة المعتمِد.
                    </p>
                  ) : railReady && rail.blockReason ? (
                    <p className="text-xs font-bold text-[var(--sem-warn)]">{rail.blockReason}</p>
                  ) : null}
                </div>
              )}

              {eligiblePreflight.consignment && (
                <div className={liveConsignment
                  ? "rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs text-[var(--sem-warn)]"
                  : "rounded-md border p-3 text-xs text-muted-foreground"}
                >
                  الإرسالية {eligiblePreflight.consignment.number}: {eligiblePreflight.consignment.parcelStatus} / {eligiblePreflight.consignment.moneyStatus}.
                  {liveConsignment && " أكمل رجوع الطرد وتسوية عهدة المندوب أولاً؛ لا يُرسل طلب عكس على إرسالية حيّة."}
                </div>
              )}

              {unsupportedRefundSource && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                  تتضمن مصادر القبض طريقة مبادلة قديمة لا يقبلها عقد طلب العكس؛ أُوقف الإرسال كي لا يُنشأ طلب غير قابل للاعتماد.
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor={`reverse-reason-${workOrderId}`}>سبب العكس</Label>
                <Textarea
                  id={`reverse-reason-${workOrderId}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={attempt != null || request.isPending}
                  maxLength={500}
                  rows={3}
                  placeholder="مثال: رفض العميل العمل بعد التسليم وثبتت إعادته"
                />
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id={`reverse-reopen-${workOrderId}`}
                  checked={reopen}
                  onCheckedChange={(checked) => setReopen(checked === true)}
                  disabled={attempt != null || request.isPending}
                />
                <Label htmlFor={`reverse-reopen-${workOrderId}`} className="cursor-pointer font-normal leading-5">
                  بعد الاعتماد أعِد الأمر إلى «جاهز للتسليم» لإعادة تسليمه، بدل إغلاقه ملغىً.
                </Label>
              </div>

              <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                الإرسال ينشئ طلب مراجعة فقط: لا يخرج نقد، ولا تنعكس الفاتورة، ولا تصبح حالة الأمر «جاهز» أو «ملغى» قبل اعتماد مراجع مستقل.
              </p>

              {attempt && (
                <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-xs text-[var(--sem-warn)]">
                  توجد محاولة محفوظة بالمفتاح <span dir="ltr" className="font-mono">{attempt.input.requestKey}</span>.
                  زر إعادة الإرسال يعيد الحمولة نفسها حرفياً ولا يولّد مفتاحاً جديداً.
                </div>
              )}
              {submitError && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
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
                  إلغاء المحاولة وتحديث المعاينة
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
              ) : attempt ? "إعادة إرسال المحاولة نفسها" : "إرسال طلب العكس للمراجعة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { deliverySourceView } from "@shared/deliverySource";
import { DeliverySourceLink } from "./DeliverySourceLink";
import React, { useCallback, useId, useMemo, useRef, useState } from "react";
import { CircleX, ScanBarcode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { SHORTFALL_REASONS, SHORTFALL_REASON_LABEL_AR, type ShortfallReason } from "@shared/shortfallReason";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import {
  resolveCompanyStatementBarcode,
  statementQueueRemaining,
  shipmentStatementCandidates,
  parseStatementAmount,
  statementDifference,
  statementClaimSnapshot,
  type StatementDecision,
  type StatementResponsibility,
  type CompanyStatementQueueCandidate,
} from "./companyStatementQueue";

export interface CompanyStatementScanQueueProps {
  candidates: readonly CompanyStatementQueueCandidate[];
  queuedIds: readonly number[];
  collectedById: Readonly<Record<number, string>>;
  claimSnapshots?: Readonly<Record<number, string>>;
  decisionsById?: Readonly<Record<number, StatementDecision>>;
  disabled?: boolean;
  removeDisabled?: boolean;
  onQueue: (candidate: CompanyStatementQueueCandidate, defaultCollected: string) => void;
  onRemove: (consignmentId: number) => void;
  onCollectedChange: (consignmentId: number, value: string) => void;
  onDecisionChange?: (consignmentId: number, decision: StatementDecision) => void;
}

export function CompanyStatementScanQueue({
  candidates,
  queuedIds,
  collectedById,
  claimSnapshots,
  decisionsById = {},
  disabled = false,
  removeDisabled = disabled,
  onQueue,
  onRemove,
  onCollectedChange,
  onDecisionChange,
}: CompanyStatementScanQueueProps) {
  const [barcode, setBarcode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scannerInputId = useId();
  const queuedSet = useMemo(() => new Set(queuedIds), [queuedIds]);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);
  const queued = queuedIds.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate ? [candidate] : [];
  });

  const focusScanner = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const acceptedIdsRef = useRef(new Set<number>());
  // Props are authoritative after a render; the ref also prevents a burst from adding twice
  // before the parent selection update renders.
  acceptedIdsRef.current = new Set(queuedSet);
  const scan = (raw: string) => {
    if (disabled) return;
    const result = resolveCompanyStatementBarcode(candidates, raw, acceptedIdsRef.current);
    if (result.kind === "EMPTY") return;
    if (result.kind === "NOT_FOUND") {
      notify.err("البوليصة غير موجودة لهذه الشركة", `الرقم ${result.trackingRef} لا يطابق إرسالية مفتوحة للشركة المختارة.`);
    } else if (result.kind === "AMBIGUOUS") {
      notify.err("رقم البوليصة مكرر", `وجد النظام ${result.matches} إرساليات بالرقم ${result.trackingRef}. صحّح أرقام التتبع قبل التحصيل.`);
    } else if (result.kind === "DUPLICATE") {
      notify.warn("البوليصة موجودة في طابور الكشف", result.candidate.invoiceNumber ?? result.candidate.consignmentNumber);
    } else {
      const shipment = shipmentStatementCandidates(candidates, result.candidate.id);
      for (const candidate of shipment) {
        if (acceptedIdsRef.current.has(candidate.id)) continue;
        acceptedIdsRef.current.add(candidate.id);
        onQueue(candidate, statementQueueRemaining(candidate).toFixed(2));
      }
      playReadyBeep();
      const recordedCounts = shipment.flatMap((candidate) =>
        candidate.shipmentInvoiceCount == null ? [] : [candidate.shipmentInvoiceCount],
      );
      const recordedCount = Math.max(...recordedCounts, 0);
      const needsMembershipCheck = recordedCount > shipment.length ||
        (result.candidate.shipmentLeaderConsignmentId != null && recordedCounts.length === 0);
      if (needsMembershipCheck) {
        notify.warn("تحقق من فواتير الشحنة", recordedCount > 0
          ? `المسجل ${recordedCount} فواتير، والمتاح في القائمة ${shipment.length}. سيتحقق النظام من الأعضاء قبل التوريد.`
          : "تعذر معرفة عدد فواتير الشحنة من القائمة. سيتحقق النظام من الأعضاء قبل التوريد.");
      } else {
        notify.ok(shipment.length > 1 ? `أُضيفت فواتير الشحنة (${shipment.length}) إلى الكشف` : "أُضيفت الإرسالية إلى طابور الكشف", result.candidate.consignmentNumber);
      }
    }
    setBarcode("");
    focusScanner();
  };

  return (
    <div className="space-y-3 rounded-xl border-2 border-dashed border-primary/45 bg-background/80 p-3">
      <label htmlFor={scannerInputId} className="flex items-center gap-2 text-sm font-extrabold text-primary">
        <ScanBarcode aria-hidden className="size-4" />
        طابور كشف الشركة بالباركود
      </label>
      <div className="flex gap-2">
        <UnifiedSearchInput
          id={scannerInputId}
          ref={inputRef}
          value={barcode}
          onChange={setBarcode}
          onScan={scan}
          onSubmit={scan}
          debounceMs={0}
          disabled={disabled}
          placeholder={disabled ? "أدخل رقم الكشف أولاً" : "امسح باركود البوليصة المطبوع في كشف الشركة"}
          dir="ltr"
          barcode={true}
          size="default"
          className="h-11 flex-1"
          inputClassName="text-center font-mono text-base font-bold placeholder:font-sans placeholder:text-sm placeholder:font-normal"
        />
        <Button type="button" onClick={() => scan(barcode)} disabled={disabled || !barcode.trim()} className="h-11">
          مسح وإضافة
        </Button>
      </div>

      {queued.length === 0 ? (
        <p className="rounded-lg border bg-muted/30 p-3 text-center text-xs text-muted-foreground">
          الطابور فارغ — امسح باركود كل سطر في كشف الشركة بالتتابع.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-muted-foreground">
            <span>فواتير الكشف الممسوحة</span>
            <span className="tabular-nums">{queued.length}</span>
          </div>
          {queued.map((candidate, index) => {
            const expected = statementQueueRemaining(candidate);
            const value = collectedById[candidate.id] ?? "";
            const amount = parseStatementAmount(value);
            const difference = statementDifference(candidate, value);
            const decision = decisionsById[candidate.id] ?? {};
            const stale = claimSnapshots != null && claimSnapshots[candidate.id] !== statementClaimSnapshot(candidate);
            return (
              <div key={candidate.id} className="grid items-center gap-2 rounded-lg border bg-card p-2.5 sm:grid-cols-[2rem_1fr_10rem_2rem]">
                <span className="text-center text-xs font-black tabular-nums">{index + 1}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-black"><DeliverySourceLink source={candidate} /></span>
                    <span className="font-mono text-primary" dir="ltr">{candidate.shipmentTrackingRef ?? candidate.externalTrackingRef}</span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {candidate.customerName ?? candidate.recipientName ?? "عميل نقدي"}
                    {(candidate.customerPhone ?? candidate.recipientPhone) && ` · ${candidate.customerPhone ?? candidate.recipientPhone}`}
                    {(candidate.address ?? candidate.deliveryAddress) && ` · ${candidate.address ?? candidate.deliveryAddress}`}
                    {` · ${candidate.consignmentNumber}`}
                  </p>
                </div>
                <div className="text-end text-xs">
                  <span className="block text-muted-foreground">المطلوب {fmt(expected.toFixed(2))} د.ع</span>
                  <MoneyInput ariaLabel={`مبلغ الكشف: ${deliverySourceView(candidate).reference}`} value={value}
                    disabled={disabled} onChange={(next) => onCollectedChange(candidate.id, next)} className="h-9" />
                </div>
                <Button type="button" size="icon" variant="ghost" disabled={removeDisabled}
                  onClick={() => {
                    for (const member of shipmentStatementCandidates(candidates, candidate.id)) {
                      acceptedIdsRef.current.delete(member.id);
                      onRemove(member.id);
                    }
                  }} aria-label="إزالة من طابور الكشف">
                  <CircleX aria-hidden className="size-4 text-destructive" />
                </Button>
                {stale && <p role="alert" className="text-xs font-bold text-destructive sm:col-span-4">تغيرت بيانات الفاتورة بعد التحديد؛ أزل الشحنة وأعد تحديدها وراجع المبلغ.</p>}
                {amount && amount.gt(expected) && <p role="alert" className="text-xs text-destructive sm:col-span-4">مبلغ الكشف يتجاوز المتبقي على الفاتورة.</p>}
                {amount && amount.isZero() && (expected.gt(0) || candidate.parcelStatus !== "DELIVERED") && (
                  <label className="flex gap-2 text-xs sm:col-span-4">
                    <input type="checkbox" checked={decision.zeroDeliveryConfirmed === true} disabled={disabled}
                      onChange={(event) => onDecisionChange?.(candidate.id, { ...decision, zeroDeliveryConfirmed: event.target.checked })} />
                    أؤكد أن مبلغ هذه الفاتورة في الكشف صفر ولن يورّد عنها نقد في هذه الدفعة
                    {candidate.parcelStatus !== "DELIVERED" ? "، وأؤكد تسليمها للعميل." : "."}
                  </label>
                )}
                {amount && amount.lt(expected) && (
                  <div className="space-y-2 rounded border p-2 text-xs sm:col-span-4">
                    {!difference ? <p role="alert" className="text-destructive">تعذر التحقق من النقد المثبت لهذه الفاتورة؛ حدّث البيانات وراجعها قبل المتابعة.</p> : <>
                      {difference.custody.gt(0) && <p>نقد مقبوض مثبت باقٍ بعهدة جهة التوصيل: <strong>{fmt(difference.custody.toFixed(2))} د.ع</strong></p>}
                      {difference.unproven.gt(0) && <p>فرق غير مثبت قبضه: <strong>{fmt(difference.unproven.toFixed(2))} د.ع</strong></p>}
                      <label htmlFor={`${scannerInputId}-responsibility-${candidate.id}`} className="block font-bold">مسؤولية الفرق {difference.unproven.gt(0) ? "غير المثبت" : "المثبت"}</label>
                      <AppSelect id={`${scannerInputId}-responsibility-${candidate.id}`} value={decision.shortfallResponsibility ?? ""} disabled={disabled}
                        onValueChange={(next) => onDecisionChange?.(candidate.id, { ...decision, shortfallResponsibility: (next || undefined) as StatementResponsibility | undefined, shortfallReason: undefined })}>
                        <option value="">اختر المسؤولية</option>
                        {difference.unproven.gt(0) ? <>
                          <option value="CUSTOMER">الفرق غير المثبت على العميل</option>
                          <option value="DELIVERY_PARTY">الفرق غير المثبت على جهة التوصيل</option>
                        </> : <option value="COURIER_CUSTODY">النقد المثبت باقٍ بعهدة جهة التوصيل</option>}
                      </AppSelect>
                      {decision.shortfallResponsibility === "DELIVERY_PARTY" && <>
                        <label htmlFor={`${scannerInputId}-reason-${candidate.id}`} className="block font-bold">سبب تحميل الجهة الفرق</label>
                        <AppSelect id={`${scannerInputId}-reason-${candidate.id}`} value={decision.shortfallReason ?? ""} disabled={disabled}
                          onValueChange={(next) => onDecisionChange?.(candidate.id, { ...decision, shortfallReason: (next || undefined) as ShortfallReason | undefined })}>
                          <option value="">اختر سبب العجز</option>
                          {SHORTFALL_REASONS.map((reason) => <option key={reason} value={reason}>{SHORTFALL_REASON_LABEL_AR[reason]}</option>)}
                        </AppSelect>
                      </>}
                    </>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

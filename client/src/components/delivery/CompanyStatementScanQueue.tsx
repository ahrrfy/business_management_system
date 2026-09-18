import React, { useCallback, useId, useMemo, useRef, useState } from "react";
import { CircleX, ScanBarcode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import {
  resolveCompanyStatementBarcode,
  statementQueueRemaining,
  type CompanyStatementQueueCandidate,
} from "./companyStatementQueue";

export interface CompanyStatementScanQueueProps {
  candidates: readonly CompanyStatementQueueCandidate[];
  queuedIds: readonly number[];
  collectedById: Readonly<Record<number, string>>;
  disabled?: boolean;
  onQueue: (candidate: CompanyStatementQueueCandidate, defaultCollected: string) => void;
  onRemove: (consignmentId: number) => void;
  onCollectedChange: (consignmentId: number, value: string) => void;
}

export function CompanyStatementScanQueue({
  candidates,
  queuedIds,
  collectedById,
  disabled = false,
  onQueue,
  onRemove,
  onCollectedChange,
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

  const scan = () => {
    const result = resolveCompanyStatementBarcode(candidates, barcode, queuedSet);
    if (result.kind === "EMPTY") return;
    if (result.kind === "NOT_FOUND") {
      notify.err("البوليصة غير موجودة لهذه الشركة", `الرقم ${result.trackingRef} لا يطابق إرسالية مفتوحة للشركة المختارة.`);
    } else if (result.kind === "AMBIGUOUS") {
      notify.err("رقم البوليصة مكرر", `وجد النظام ${result.matches} إرساليات بالرقم ${result.trackingRef}. صحّح أرقام التتبع قبل التحصيل.`);
    } else if (result.kind === "DUPLICATE") {
      notify.warn("البوليصة موجودة في طابور الكشف", result.candidate.invoiceNumber ?? result.candidate.consignmentNumber);
    } else {
      const remaining = statementQueueRemaining(result.candidate).toFixed(2);
      onQueue(result.candidate, remaining);
      playReadyBeep();
      notify.ok("أُضيفت الفاتورة إلى طابور الكشف", `${result.candidate.invoiceNumber ?? result.candidate.consignmentNumber} — ${fmt(remaining)} د.ع`);
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
        <Input
          id={scannerInputId}
          ref={inputRef}
          value={barcode}
          onChange={(event) => setBarcode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              scan();
            }
          }}
          disabled={disabled}
          placeholder={disabled ? "أدخل رقم الكشف أولاً" : "امسح باركود البوليصة المطبوع في كشف الشركة (Enter)"}
          dir="ltr"
          className="h-11 flex-1 text-center font-mono text-base font-bold"
        />
        <Button type="button" onClick={scan} disabled={disabled || !barcode.trim()} className="h-11">
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
            return (
              <div key={candidate.id} className="grid items-center gap-2 rounded-lg border bg-card p-2.5 sm:grid-cols-[2rem_1fr_8rem_8rem_2rem]">
                <span className="text-center text-xs font-black tabular-nums">{index + 1}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-black">{candidate.invoiceNumber ?? `فاتورة #${candidate.invoiceId}`}</span>
                    <span className="font-mono text-primary" dir="ltr">{candidate.externalTrackingRef}</span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {candidate.customerName ?? candidate.recipientName ?? "عميل نقدي"} · {candidate.consignmentNumber}
                  </p>
                </div>
                <div className="text-end text-xs">
                  <span className="block text-muted-foreground">المتوقع</span>
                  <strong className="tabular-nums" dir="ltr">{fmt(expected.toFixed(2))}</strong>
                </div>
                <MoneyInput
                  value={collectedById[candidate.id] ?? expected.toFixed(2)}
                  onChange={(value) => onCollectedChange(candidate.id, value)}
                  ariaLabel={`مبلغ الكشف للفاتورة ${candidate.invoiceNumber ?? candidate.invoiceId}`}
                  className="h-8 text-end font-mono text-xs"
                />
                <Button type="button" size="icon" variant="ghost" onClick={() => onRemove(candidate.id)} aria-label="إزالة من طابور الكشف">
                  <CircleX aria-hidden className="size-4 text-destructive" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

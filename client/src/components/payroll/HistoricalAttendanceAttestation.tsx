import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

interface Props {
  period: string;
  enabled: boolean;
}

type Selection = {
  period: string;
  employeeId: number;
  employeeName: string;
  sourceAuditId: number;
  sourceHash: string;
};

function formatChangeDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "تاريخ غير متاح";
  return new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Owner review of a specific conflict; recording it never generates payroll. */
export function HistoricalAttendanceAttestation({ period, enabled }: Props) {
  const queryEnabled = enabled && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const candidatesQuery = trpc.payroll.historicalAttendanceCandidates.useQuery(
    { period },
    { enabled: queryEnabled },
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [evidenceText, setEvidenceText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const currentView = useRef({ period, enabled });
  currentView.current = { period, enabled };
  const currentSelection = useRef(selection);
  currentSelection.current = selection;

  useEffect(() => {
    setSelection(null);
    setEvidenceText("");
    setConfirmed(false);
  }, [period, enabled]);

  const attestation = trpc.payroll.attestHistoricalAttendanceExemption.useMutation({
    onSuccess: async (_result, variables) => {
      notify.ok(`سُجّل إقرار شهر ${variables.period}. راجع البيانات قبل توليد المسير.`);
      if (currentView.current.enabled && currentView.current.period === variables.period) {
        const selected = currentSelection.current;
        if (selected?.period === variables.period && selected.employeeId === variables.employeeId && selected.employeeName === variables.expectedEmployeeName && selected.sourceAuditId === variables.sourceAuditId && selected.sourceHash === variables.sourceHash) {
          setSelection(null);
          setEvidenceText("");
          setConfirmed(false);
        }
        await candidatesQuery.refetch();
      }
    },
  });

  if (!queryEnabled) return null;
  if (candidatesQuery.isLoading) {
    return <p role="status" className="text-xs text-muted-foreground">جارٍ فحص أساس الأجر التاريخي…</p>;
  }
  if (candidatesQuery.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-2.5 text-xs text-destructive">
        <span>تعذّر فحص الإعفاءات التاريخية لهذا الشهر.</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void candidatesQuery.refetch()}>
          إعادة المحاولة
        </Button>
      </div>
    );
  }

  // Never reuse a selection when the month, employee identity or source changes.
  const candidates = (candidatesQuery.data ?? []).filter((candidate) => candidate.period === period);
  const attestable = candidates.filter((candidate) => candidate.kind === "attestable");
  const selected = attestable.find((candidate) =>
    selection?.period === period &&
    candidate.employeeId === selection.employeeId &&
    candidate.employeeName === selection.employeeName &&
    candidate.sourceAuditId === selection.sourceAuditId &&
    candidate.sourceHash === selection.sourceHash,
  );
  if (candidates.length === 0) return null;

  const evidence = evidenceText.trim();
  const canRecord = Boolean(
    selected && confirmed && evidence.length >= 10 && evidence.length <= 300 &&
    !attestation.isPending && !candidatesQuery.isFetching,
  );
  const selectCandidate = (candidate: Selection) => {
    setSelection(candidate);
    setEvidenceText("");
    setConfirmed(false);
    attestation.reset();
  };

  return (
    <section aria-label="مراجعة الإعفاءات التاريخية" className="space-y-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs" dir="rtl">
      <p className="font-semibold">مراجعة الإعفاء من الحضور لشهر <bdi dir="ltr">{period}</bdi></p>
      <p>قد تحتاج بعض سجلات الإعفاء التاريخية إلى مراجعة قبل إعداد المسير.</p>
      <ul className="max-h-40 space-y-2 overflow-y-auto">
        {candidates.map((candidate) => (
          <li key={`${candidate.kind}-${candidate.employeeId}`} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background p-2">
            <div className="min-w-0">
              <div className="break-words font-semibold">{candidate.employeeName}</div>
              {candidate.kind === "manual_review" ? (
                <div className="space-y-1 text-muted-foreground">
                  <p>{candidate.reason}</p>
                  <p>راجع ملف الموظف وسجل الأجر.</p>
                </div>
              ) : (
                <div className="text-muted-foreground">
                  <p>السجل اللاحق: من غير معفى إلى معفى.</p>
                  <p>تاريخ تغيير الإعفاء: {formatChangeDate(candidate.sourceChangedAt)}</p>
                </div>
              )}
            </div>
            {candidate.kind === "attestable" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`مراجعة إقرار ${candidate.employeeName}`}
                disabled={attestation.isPending || candidatesQuery.isFetching}
                onClick={() => selectCandidate({
                  period,
                  employeeId: candidate.employeeId,
                  employeeName: candidate.employeeName,
                  sourceAuditId: candidate.sourceAuditId,
                  sourceHash: candidate.sourceHash,
                })}
              >
                مراجعة
              </Button>
            )}
          </li>
        ))}
      </ul>
      {selected && (
        <div className="space-y-2 rounded border bg-background p-2.5">
          <p>إقرار خاص بالموظف <b>{selected.employeeName}</b> عن شهر <bdi dir="ltr" className="font-bold">{period}</bdi>.</p>
          <div className="space-y-1">
            <Label htmlFor="historical-attendance-evidence">مصدر الدليل الذي راجعته (10 إلى 300 حرف)</Label>
            <Textarea
              id="historical-attendance-evidence"
              value={evidenceText}
              maxLength={300}
              placeholder="اذكر المستند أو السجل الذي راجعته"
              disabled={attestation.isPending}
              onChange={(event) => setEvidenceText(event.target.value)}
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="historical-attendance-confirm" checked={confirmed} disabled={attestation.isPending} onCheckedChange={(value) => setConfirmed(value === true)} />
            <Label htmlFor="historical-attendance-confirm" className="leading-relaxed font-normal">
              أؤكد بعد مراجعة الدليل أن الموظف كان معفى من الحضور وبأجر شهري ثابت طوال هذا الشهر، رغم اختلاف السجل اللاحق.
            </Label>
          </div>
          {attestation.isError && (
            <p role="alert" className="text-destructive">{attestation.error?.message ?? "تعذّر تسجيل الإقرار. أعد المحاولة."}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canRecord}
              onClick={() => {
                if (!selected || !canRecord) return;
                attestation.mutate({ period, employeeId: selected.employeeId,
                  expectedEmployeeName: selected.employeeName,
                  sourceAuditId: selected.sourceAuditId, sourceHash: selected.sourceHash,
                  evidenceText: evidence, confirmFixedExemption: true });
              }}
            >
              {attestation.isPending ? "جارٍ تسجيل الإقرار…" : "تسجيل الإقرار"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={attestation.isPending} onClick={() => setSelection(null)}>إلغاء المراجعة</Button>
          </div>
        </div>
      )}
    </section>
  );
}

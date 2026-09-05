/**
 * التسوية اليوميّة بتأكيدٍ واحد (م١ PR-C): المعاينة محسوبةٌ سلفاً من الخادم (المتوقَّع · الأجرة ·
 * الاستقطاعات · الصافي · الأسطر · المرتجعات المُعلَنة)، وسؤالٌ واحد «المعدود فعلاً» مُملأٌ بالصافي:
 * طابق ⇒ «إقفال» · نقص ⇒ سبب العجز إلزاميّ (من `shared/shortfallReason`، يُقيَّد ذمّةً فوريّة على
 * الجهة خادمياً) · زاد ⇒ يُرسَل كما هو ورسالة الخادم تُعرض كما هي. النتيجة مُهيكَلة (BALANCED/SHORT
 * + رقم السند/الإيصال). المنطق النقيّ في `dailySettlement.ts`.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Scale, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ErrorState } from "@/components/PageState";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { DELIVERY_TERMS } from "@shared/deliveryTerminology";
import { SHORTFALL_REASON_DESCRIPTION_AR, type ShortfallReason } from "@shared/shortfallReason";
import {
  SHORTFALL_OPTIONS,
  buildSettleDailyPayload,
  canSettle,
  previewTotals,
  settleResultSummary,
  settlementVerdict,
  type SettleDailyPayload,
  type SettleDailyResult,
  type SettlementPreview,
} from "./dailySettlement";

export interface DailySettlementDialogProps {
  party: { id: number; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: SettlementPreview | undefined;
  previewLoading: boolean;
  previewError: string | null;
  onRetryPreview: () => void;
  shiftType: "RETAIL" | "RECEPTION";
  /** يُنفّذ `delivery.settleDaily`؛ يرمي عند الرفض (الزيادة مثلاً) فتُعرض رسالة الخادم كما هي. */
  onSettle: (payload: SettleDailyPayload) => Promise<SettleDailyResult>;
}

export function DailySettlementDialog({ party, open, onOpenChange, preview, previewLoading, previewError, onRetryPreview, shiftType, onSettle }: DailySettlementDialogProps) {
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState<ShortfallReason | null>(null);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<SettleDailyResult | null>(null);
  // مفتاح idempotency ثابتٌ لكلّ فتحةِ نافذة ⇒ النقر المزدوج/إعادة الشبكة لا تُكرّر التسوية.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setCounted("");
    setReason(null);
    setServerError(null);
    setResult(null);
    setPending(false);
    setClientRequestId(crypto.randomUUID());
  }, [open, party?.id]);

  // المعدود يُملأ بالصافي المحسوب سلفاً أوّل ما تصل المعاينة — الكاشير يعدّل لا يبتدئ.
  useEffect(() => {
    if (open && preview && counted === "") setCounted(preview.net);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preview?.net]);

  const verdict = preview ? settlementVerdict(preview, counted) : null;
  const totals = preview ? previewTotals(preview) : null;
  const settleEnabled = !!preview && !!verdict && canSettle(verdict, reason) && !pending && !result;

  const submit = async () => {
    if (!preview || !verdict) return;
    const payload = buildSettleDailyPayload(preview, verdict, reason, shiftType, clientRequestId);
    if (!payload) return;
    setPending(true);
    setServerError(null);
    try {
      setResult(await onSettle(payload));
    } catch (error: unknown) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  const summary = result ? settleResultSummary(result) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2"><Scale aria-hidden className="size-5" /> سوِّ اليوم — {party?.name}</DialogTitle>
          <DialogDescription>
            الصافي محسوبٌ سلفاً من الطرود المُسلَّمة ونقد المندوب والأجرة. أدخل ما عُدَّ فعلاً وأقفل بتأكيدٍ واحد.
          </DialogDescription>
        </DialogHeader>

        {previewError ? (
          <ErrorState message={previewError} onRetry={onRetryPreview} />
        ) : previewLoading || !preview || !verdict || !totals ? (
          <p className="text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>
        ) : summary ? (
          <div className="space-y-2 rounded-lg border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] p-3" role="status">
            <p className="inline-flex items-center gap-2 text-sm font-black text-[var(--sem-pos)]"><CheckCircle2 aria-hidden className="size-4" /> {summary.title}</p>
            <ul className="list-disc space-y-1 ps-5 text-xs">{summary.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          </div>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border bg-muted/40 p-3 text-xs">
              <dt className="text-muted-foreground">المتوقَّع (نقد الطرود المُسلَّمة)</dt><dd className="text-end font-bold tabular-nums" dir="ltr">{fmt(preview.expectedCash)} د.ع</dd>
              <dt className="text-muted-foreground">{DELIVERY_TERMS.feesOwedToCourier.compact} (تُخصم)</dt><dd className="text-end font-bold tabular-nums" dir="ltr">− {fmt(preview.feeDue)} د.ع</dd>
              <dt className="text-muted-foreground">استقطاعات</dt><dd className="text-end font-bold tabular-nums" dir="ltr">− {fmt(preview.deductions)} د.ع</dd>
              <dt className="font-black">الصافي المتوقَّع في يدك</dt><dd className="text-end text-base font-black tabular-nums text-primary" dir="ltr">{fmt(preview.net)} د.ع</dd>
            </dl>

            <div className="text-[11px] text-muted-foreground">
              {totals.lines} طرد · COD {fmt(totals.codTotal)} · مُحصَّل {fmt(totals.collectedTotal)} · متبقٍّ على الزبائن {fmt(totals.remainingTotal)}
              {preview.returnsAwaitingReceipt > 0 && (
                <span className="ms-2 inline-flex items-center gap-1 rounded bg-[var(--sem-warn-bg)] px-1.5 py-0.5 font-bold text-[var(--sem-warn)]" title={DELIVERY_TERMS.returned.tooltip}>
                  <TriangleAlert aria-hidden className="size-3" /> {preview.returnsAwaitingReceipt} مرتجع مُعلَن بانتظار الاستلام — لا يدخل الصافي
                </span>
              )}
            </div>

            {preview.lines.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                    <tr><th className="p-1.5 text-start">الطرد</th><th className="p-1.5 text-start">الزبون</th><th className="p-1.5 text-end">COD</th><th className="p-1.5 text-end" title="ما قبضه المندوب من الزبون">محصل</th></tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={l.consignmentId} className="border-t">
                        <td className="p-1.5 font-bold tabular-nums" dir="ltr">{l.consignmentNumber}</td>
                        <td className="p-1.5">{l.customerName || l.invoiceNumber}</td>
                        <td className="p-1.5 text-end tabular-nums" dir="ltr">{fmt(l.codAmount)}</td>
                        <td className="p-1.5 text-end tabular-nums" dir="ltr">{fmt(l.collectedAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div>
              <Label htmlFor="daily-settlement-counted" className="mb-1 block text-xs font-bold">المعدود فعلاً (د.ع)</Label>
              <MoneyInput id="daily-settlement-counted" value={counted} onChange={setCounted} ariaLabel="النقد المعدود فعلاً" className="h-11 text-end text-lg font-black tabular-nums" />
              <p className={cn("mt-1 text-xs font-bold", verdict.kind === "BALANCED" ? "text-[var(--sem-pos)]" : verdict.kind === "SHORT" ? "text-[var(--sem-neg)]" : verdict.kind === "OVER" ? "text-[var(--sem-warn)]" : "text-muted-foreground")}>
                {verdict.kind === "BALANCED" && "مطابق تماماً — إقفالٌ بتأكيدٍ واحد."}
                {verdict.kind === "SHORT" && <>عجز <span dir="ltr">{fmt(verdict.diff)}</span> د.ع — يُقيَّد ذمّةً فوريّة على الجهة بسببٍ مصنَّف.</>}
                {verdict.kind === "OVER" && <>زيادة <span dir="ltr">{fmt(verdict.diff)}</span> د.ع — تُرسَل كما هي والخادم يقرّر.</>}
                {verdict.kind === "EMPTY" && "أدخل ما عُدَّ فعلاً."}
                {verdict.kind === "INVALID" && "المبلغ ليس رقماً صالحاً."}
              </p>
            </div>

            {verdict.kind === "SHORT" && (
              <div>
                <Label htmlFor="daily-settlement-reason" className="mb-1 block text-xs font-bold">سبب العجز (إلزاميّ)</Label>
                <AppSelect id="daily-settlement-reason" value={reason ?? ""} onValueChange={(v) => setReason((v || null) as ShortfallReason | null)} aria-label="سبب العجز" className="h-10 text-sm">
                  <option value="">اختر السبب</option>
                  {SHORTFALL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </AppSelect>
                {reason && <p className="mt-1 text-[11px] text-muted-foreground">{SHORTFALL_REASON_DESCRIPTION_AR[reason]}</p>}
              </div>
            )}

            {serverError && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs font-bold text-destructive">{serverError}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-start">
          {summary ? (
            <Button onClick={() => onOpenChange(false)}>إغلاق</Button>
          ) : (
            <>
              <Button disabled={!settleEnabled} onClick={() => void submit()}>
                {pending ? ACTION_LABELS.saving : verdict?.kind === "SHORT" ? "إقفال بعجزٍ مُصنَّف" : "إقفال"}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>إلغاء</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

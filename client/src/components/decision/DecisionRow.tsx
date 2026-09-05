/**
 * صفُّ القرار — يعرض **ما يُقرَّر عليه** ويحسمه **في مكانه** (م٧ ق٢: «الفعل في مكانه»).
 *
 * العقد: `DecisionRowModel` من `shared/decisionRegistry.ts`. الصفّ لا يعرف مصدر الطلب ولا
 * خدمته — يعرض الطرف والمبلغ والأصناف والسبب والعمر والـSLA، ويرسل الحسم إلى `decisions.decide`
 * الذي يوجّهه إلى دالّة الحسم الأصلية. النتيجةُ مُهيكَلة: `STALE` تُعرض تحذيراً لا نجاحاً.
 *
 * الرفضُ بسببٍ إلزاميّ حيث تشترطه الخدمة، ثمّ حوارُ `confirm` (لا `window.confirm`).
 */
import { useId, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, Info, XCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { APPROVAL_TRIGGER_LABEL_AR } from "@shared/approvalPolicy";
import {
  DECISION_ACTION_LABEL_AR,
  DECISION_OUTCOME_LABEL_AR,
  decisionSpec,
  type DecisionAction,
  type DecisionDecideResult,
  type DecisionRowModel,
} from "@shared/decisionRegistry";

export interface DecisionRowProps {
  row: DecisionRowModel;
  /** يُستدعى بعد كلّ حسمٍ (نجاحاً أو STALE) كي يُعيد الصندوق التحميل. */
  onDecided?: (result: DecisionDecideResult) => void;
}

function newClientRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** عمرٌ مقروء: أقلّ من ساعة بالدقائق، وأقلّ من يومين بالساعات، وإلّا بالأيام. */
export function ageLabel(ageHours: number): string {
  if (ageHours < 1) return `منذ ${Math.max(1, Math.round(ageHours * 60))} د`;
  if (ageHours < 48) return `منذ ${Math.round(ageHours)} س`;
  return `منذ ${Math.round(ageHours / 24)} يوم`;
}

const OUTCOME_TONE: Record<DecisionDecideResult["outcome"], { cls: string; Icon: typeof CheckCircle2 }> = {
  EXECUTED: { cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]", Icon: CheckCircle2 },
  REQUESTED: { cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]", Icon: Info },
  STALE: { cls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]", Icon: AlertTriangle },
  REJECTED: { cls: "bg-muted text-muted-foreground", Icon: XCircle },
  WITHDRAWN: { cls: "bg-muted text-muted-foreground", Icon: XCircle },
};

export function DecisionRow({ row, onDecided }: DecisionRowProps) {
  const spec = decisionSpec(row.kind);
  const formId = useId();
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"IDLE" | "REJECT" | "APPROVE">("IDLE");
  const [result, setResult] = useState<DecisionDecideResult | null>(null);

  const decide = trpc.decisions.decide.useMutation({
    onSuccess: (res) => {
      setResult(res);
      setMode("IDLE");
      // ⭐ لا «نجاح» على STALE: الحالة تُعرض تحذيراً داخل الصفّ، والتوست يقول الحقيقة.
      if (res.outcome === "STALE") notify.warn(res.message);
      else if (res.outcome === "REQUESTED") notify.info(res.message);
      else notify.ok(res.message);
      onDecided?.(res);
    },
    onError: (e) => notify.err(e),
  });

  const canApprove = row.allowedActions.includes("APPROVE") && !row.approveBlockedReason;
  const canReject = row.allowedActions.includes("REJECT") && row.rejectReason !== "NOT_SUPPORTED";
  const canWithdraw = row.allowedActions.includes("WITHDRAW");
  const confirmationsOk = row.confirmations.every((c) => confirmations[c.key] === true);
  const referenceOk = !row.requiredReference || reference.trim().length >= row.requiredReference.minLength;
  const approveReasonOk = row.approveReason !== "REQUIRED" || reason.trim().length >= row.reasonMinLength;
  const rejectReasonOk = row.rejectReason !== "REQUIRED" || reason.trim().length >= row.reasonMinLength;

  const amountText = useMemo(() => (row.amount ? `${fmtAr(row.amount)} ${row.currency === "USD" ? "$" : "د.ع"}` : null), [row.amount, row.currency]);

  async function submit(action: DecisionAction) {
    const label = DECISION_ACTION_LABEL_AR[action];
    const ok = await confirm({
      variant: action === "APPROVE" ? "warning" : "danger",
      title: `${label}: ${row.title}`,
      description: (
        <div className="space-y-1 text-xs">
          {row.party && <div>الطرف: {row.party}</div>}
          {amountText && <div dir="ltr" className="font-bold tabular-nums">{amountText}</div>}
          {reason.trim() && <div>السبب: {reason.trim()}</div>}
          {action === "APPROVE" && row.trigger && <div className="text-[var(--sem-warn)]">لحظة الخطر: {APPROVAL_TRIGGER_LABEL_AR[row.trigger]}</div>}
        </div>
      ),
      confirmText: label,
    });
    if (!ok) return;
    decide.mutate({
      kind: row.kind,
      id: row.id,
      action,
      clientRequestId: newClientRequestId(),
      reason: reason.trim() || undefined,
      expectedVersion: row.expectedVersion ?? undefined,
      confirmations: row.confirmations.length ? confirmations : undefined,
      reference: reference.trim() || undefined,
    });
  }

  const slaBadge = row.sla ? (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold ${
        row.sla.breached ? "bg-[var(--sem-danger-bg)] text-[var(--sem-danger)]" : "bg-muted text-muted-foreground"
      }`}
      title={`سقف القرار ${row.sla.hours} ساعة`}
    >
      <Clock aria-hidden className="size-3" />
      {row.sla.breached ? `متأخر ${Math.round(Math.abs(row.sla.remainingHours))} س` : `يتبقى ${Math.round(row.sla.remainingHours)} س`}
    </span>
  ) : null;

  const outcomeTone = result ? OUTCOME_TONE[result.outcome] : null;

  return (
    <Card data-decision-kind={row.kind} data-decision-id={row.id}>
      <CardContent className="space-y-3 py-4">
        {/* ─── الرأس: النوع · العنوان · العمر · SLA ─── */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-bold text-muted-foreground">{spec?.title ?? row.kind}</span>
              {row.trigger && (
                <span className="rounded bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-2xs font-bold text-[var(--sem-warn)]">
                  {APPROVAL_TRIGGER_LABEL_AR[row.trigger]}
                </span>
              )}
              {slaBadge}
            </div>
            <p className="text-sm font-extrabold">{row.title}</p>
            <p className="text-2xs text-muted-foreground">
              {row.party ? `الطرف: ${row.party}` : "بلا طرف"}
              {row.branchName ? ` · ${row.branchName}` : ""}
              {row.requestedByName ? ` · طلبه ${row.requestedByName}` : ""}
              {` · ${ageLabel(row.ageHours)} (${fmtDateTime(row.requestedAt)})`}
            </p>
          </div>
          {amountText && (
            <p className="text-base font-extrabold tabular-nums" dir="ltr">
              {amountText}
            </p>
          )}
        </div>

        {/* ─── ما يُقرَّر عليه ─── */}
        {row.summaryItems.length > 0 && (
          <ul className="divide-y rounded-md border text-xs">
            {row.summaryItems.map((it, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
                <span className="min-w-0 flex-1 truncate" title={it.label}>{it.label}</span>
                {it.qty != null && it.qty !== "" && (
                  <span className="tabular-nums text-muted-foreground" dir="ltr">
                    {typeof it.qty === "number" ? fmtAr(it.qty) : it.qty}{it.unit ? ` ${it.unit}` : ""}
                  </span>
                )}
                {it.unitPrice != null && it.unitPrice !== "" && (
                  <span className="font-bold tabular-nums" dir="ltr">{fmtAr(it.unitPrice)}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {row.reason && (
          <p className="rounded-md bg-muted/50 p-2 text-2xs leading-relaxed">
            <span className="font-bold">السبب: </span>
            {row.reason}
          </p>
        )}

        {/* ─── النتيجة المُهيكَلة ─── */}
        {result && outcomeTone && (
          <div className={`flex items-start gap-2 rounded-md p-2 text-xs ${outcomeTone.cls}`} role="status">
            <outcomeTone.Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-extrabold">{DECISION_OUTCOME_LABEL_AR[result.outcome]}</p>
              <p className="mt-0.5 leading-relaxed">{result.message}</p>
            </div>
          </div>
        )}

        {/* ─── مدخلات الحسم ─── */}
        {!result && (
          <div className="space-y-2">
            {row.approveBlockedReason && (
              <p className="flex items-start gap-1 text-2xs text-[var(--sem-warn)]">
                <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {row.approveBlockedReason}
              </p>
            )}
            {row.confirmations.map((c) => (
              <label key={c.key} className="flex items-start gap-2 text-xs">
                <Checkbox
                  checked={confirmations[c.key] === true}
                  onCheckedChange={(v) => setConfirmations((s) => ({ ...s, [c.key]: v === true }))}
                  aria-label={c.label}
                />
                <span>{c.label}</span>
              </label>
            ))}
            {row.requiredReference && (
              <div className="space-y-1">
                <label htmlFor={`${formId}-ref`} className="text-2xs font-bold">{row.requiredReference.label}</label>
                <Input id={`${formId}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} className="h-9 text-xs" dir="ltr" maxLength={100} />
              </div>
            )}
            {(mode !== "IDLE" || row.approveReason === "REQUIRED") && (
              <div className="space-y-1">
                <label htmlFor={`${formId}-reason`} className="text-2xs font-bold">
                  {mode === "REJECT" ? "سبب الرفض" : "ملاحظة القرار"}
                  {(mode === "REJECT" ? row.rejectReason === "REQUIRED" : row.approveReason === "REQUIRED") ? ` (إلزامي، ${row.reasonMinLength} محارف فأكثر)` : " (اختياري)"}
                </label>
                <Textarea id={`${formId}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="text-xs" maxLength={1000} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canApprove && mode !== "REJECT" && (
                <Button
                  size="sm"
                  disabled={decide.isPending || !confirmationsOk || !referenceOk || !approveReasonOk}
                  onClick={() => submit("APPROVE")}
                >
                  {decide.isPending ? ACTION_LABELS.approving : DECISION_ACTION_LABEL_AR.APPROVE}
                </Button>
              )}
              {canReject && mode !== "REJECT" && (
                <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => setMode("REJECT")}>
                  {DECISION_ACTION_LABEL_AR.REJECT}
                </Button>
              )}
              {mode === "REJECT" && (
                <>
                  <Button size="sm" variant="destructive" disabled={decide.isPending || !rejectReasonOk} onClick={() => submit("REJECT")}>
                    {decide.isPending ? ACTION_LABELS.rejecting : "تأكيد الرفض"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => setMode("IDLE")}>
                    {ACTION_LABELS.cancel}
                  </Button>
                </>
              )}
              {canWithdraw && (
                <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => submit("WITHDRAW")}>
                  {DECISION_ACTION_LABEL_AR.WITHDRAW}
                </Button>
              )}
              <Button size="sm" variant="link" asChild className="ms-auto">
                <Link href={row.href}>
                  <ExternalLink aria-hidden className="size-3.5 me-1" /> افتح المستند
                </Link>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

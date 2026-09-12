import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmt } from "@/lib/money";
import { EXCHANGE_CONTROL_SCOPE_DISCLOSURE } from "@/lib/doubleEntryRoleLabels";
import {
  AlertTriangle,
  Check,
  CircleCheck,
  Power,
  ShieldCheck,
} from "lucide-react";
import { GateMetric } from "./GateMetric";
import { OperationalMismatchesCard } from "./OperationalMismatchesCard";
import { OpeningPreparationCard } from "./OpeningPreparationCard";
import { PolicyApprovalCard } from "./PolicyApprovalCard";
import { MonthlyReconciliationTable } from "./MonthlyReconciliationTable";
import type { DoubleEntryData, ActivationData, OpeningPreparation } from "./types";

export function DoubleEntryStatus({
  reconciliation,
  activation,
  openingPreparation,
  openingPreparationError,
  preparingOpening,
  openingAllocationAmounts,
  onOpeningAllocationAmountChange,
  busy,
  policyReference,
  policyAccountantName,
  onPolicyReferenceChange,
  onPolicyAccountantNameChange,
  onApprovePolicy,
  onClearPolicy,
  onPrepareShadow,
  onPrepareAllocatedShadow,
  onStartShadow,
  onActivate,
  onStop,
}: {
  reconciliation: DoubleEntryData;
  activation: ActivationData;
  openingPreparation: OpeningPreparation | null;
  openingPreparationError: string | null;
  preparingOpening: boolean;
  openingAllocationAmounts: Record<string, string>;
  onOpeningAllocationAmountChange: (key: string, value: string) => void;
  busy: boolean;
  policyReference: string;
  policyAccountantName: string;
  onPolicyReferenceChange: (value: string) => void;
  onPolicyAccountantNameChange: (value: string) => void;
  onApprovePolicy: () => void;
  onClearPolicy: () => void;
  onPrepareShadow: () => void;
  onPrepareAllocatedShadow: () => void;
  onStartShadow: () => void;
  onActivate: () => void;
  onStop: () => void;
}) {
  const modeLabel =
    activation.mode === "ACTIVE"
      ? "ACTIVE (معتمد)"
      : activation.mode === "SHADOW"
        ? "SHADOW (ظل)"
        : "OFF (متوقف)";
  const modeClass =
    activation.mode === "ACTIVE"
      ? "badge-status-active"
      : activation.mode === "SHADOW"
        ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
        : "bg-muted text-muted-foreground";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4" />
            حالة الدفتر المزدوج وبوابة ACTIVE
          </span>
          <span className={`rounded-full px-3 py-1 text-xs ${modeClass}`}>
            الوضع: {modeLabel}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <GateMetric
            label="مدة الظل"
            value={`${activation.shadowDays}/${activation.requiredShadowDays} يوم`}
            ok={activation.shadowDays >= activation.requiredShadowDays}
          />
          <GateMetric
            label="خرائط القيود"
            value={`${activation.mappedTypes}/${activation.requiredMappedTypes}`}
            ok={
              activation.mappedTypes === activation.requiredMappedTypes &&
              activation.unmappedEntryTypes.length === 0
            }
          />
          <GateMetric
            label="فجوات نافذة الظل"
            value={String(
              activation.gapCount +
                activation.missingCount +
                activation.extraCount +
                activation.scopeMismatchCount +
                activation.unreconstructableCount +
                activation.sourceMismatchCount,
            )}
            ok={
              activation.gapCount +
                activation.missingCount +
                activation.extraCount +
                activation.scopeMismatchCount +
                activation.unreconstructableCount ===
              0
            }
          />
          <GateMetric
            label="انحراف نافذة الظل"
            value={fmt(activation.drift)}
            ok={
              activation.drift === "0.00" &&
              activation.journalImbalance === "0.00" &&
              activation.imbalancedJournalCount === 0
            }
          />
          <GateMetric
            label="سلامة لقطة الافتتاح"
            value={
              activation.openingVerification
                ? `${activation.openingVerification.entryCount} قيد / ${activation.openingVerification.lineCount} سطر`
                : "غير متاحة"
            }
            ok={activation.openingVerification?.hashMatches === true}
          />
          <GateMetric
            label="المطابقة التشغيلية"
            value={
              activation.operationalReconciliation
                ? `${activation.operationalReconciliation.driftCount} فرق / ${fmt(activation.operationalReconciliation.totalAbsoluteDifference)}`
                : "غير متاحة"
            }
            ok={activation.operationalReconciliation?.ok === true}
          />
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          {EXCHANGE_CONTROL_SCOPE_DISCLOSURE}
        </div>

        {activation.operationalReconciliation && (
          <OperationalMismatchesCard
            reconciliation={activation.operationalReconciliation}
          />
        )}

        {activation.cycleId && (
          <div className="text-xs text-muted-foreground">
            معرّف الدورة:{" "}
            <span className="font-mono" dir="ltr">
              {activation.cycleId}
            </span>
          </div>
        )}

        {activation.mode === "ACTIVE" && activation.blockers.length === 0 ? (
          <div className="badge-status-active flex items-center gap-2 rounded-md p-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-4" />
            تم اعتماد ACTIVE بعد اجتياز البوابة. يستمر التقرير في عرض أي فجوات
            أو انحرافات لاحقة.
          </div>
        ) : activation.blockers.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="inline-flex items-center gap-2 font-semibold">
              <AlertTriangle aria-hidden className="size-4 text-destructive" />
              {activation.mode === "ACTIVE"
                ? "مشكلات صحة الدفتر الفعّال"
                : "موانع التفعيل"}
            </div>
            {activation.blockers.map((item) => (
              <div key={item.key} className="flex items-start gap-2 text-sm">
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div>
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="badge-status-active flex items-center gap-2 rounded-md p-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-4" />
            اجتازت البوابة كل الشروط: {activation.requiredShadowDays} يوماً، صفر
            فجوات، انحراف صفر، و{activation.requiredMappedTypes}/
            {activation.requiredMappedTypes} خريطة.
          </div>
        )}

        <PolicyApprovalCard
          activation={activation}
          busy={busy}
          policyReference={policyReference}
          policyAccountantName={policyAccountantName}
          onPolicyReferenceChange={onPolicyReferenceChange}
          onPolicyAccountantNameChange={onPolicyAccountantNameChange}
          onApprovePolicy={onApprovePolicy}
          onClearPolicy={onClearPolicy}
        />

        {activation.mode === "OFF" && (
          <OpeningPreparationCard
            openingPreparation={openingPreparation}
            openingPreparationError={openingPreparationError}
            preparingOpening={preparingOpening}
            openingAllocationAmounts={openingAllocationAmounts}
            onOpeningAllocationAmountChange={onOpeningAllocationAmountChange}
            busy={busy}
            onPrepareShadow={onPrepareShadow}
            onPrepareAllocatedShadow={onPrepareAllocatedShadow}
            onStartShadow={onStartShadow}
          />
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {activation.mode === "OFF" && (
            <span className="text-xs text-muted-foreground">
              يبدأ وضع الظل من زر تأكيد لقطة القطع أعلاه.
            </span>
          )}
          {activation.mode === "SHADOW" && (
            <>
              <Button
                disabled={busy || !activation.ok}
                onClick={onActivate}
                title={
                  !activation.ok
                    ? activation.blockers.map((item) => item.label).join("، ")
                    : undefined
                }
              >
                <ShieldCheck aria-hidden className="size-4" />
                اعتماد ACTIVE عبر البوابة
              </Button>
              <Button variant="destructive" disabled={busy} onClick={onStop}>
                <Power aria-hidden className="size-4" />
                إيقاف إلى OFF
              </Button>
            </>
          )}
          {activation.mode === "ACTIVE" && (
            <>
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <Check aria-hidden className="size-4" />
                الدفتر المزدوج مُعتمد.
              </span>
              <Button variant="destructive" disabled={busy} onClick={onStop}>
                <Power aria-hidden className="size-4" />
                إيقاف إلى OFF
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            التحكم محصور بمالك النظام/المدير العام، وكل انتقال يُكتب في سجل
            التدقيق داخل المعاملة نفسها.
          </span>
        </div>

        <MonthlyReconciliationTable reconciliation={reconciliation} />
      </CardContent>
    </Card>
  );
}

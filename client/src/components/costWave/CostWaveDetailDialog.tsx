import { useEffect, useState } from "react";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  COST_WAVE_MAX_REASON_LENGTH,
  COST_WAVE_MIN_REASON_LENGTH,
  COST_WAVE_PURPOSE_LABELS,
  COST_WAVE_RULE_LABELS,
  COST_WAVE_STATUS_LABELS,
  type CostWaveStatus,
} from "@shared/costWave";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table/DataTable";
import {
  COST_WAVE_APPROVAL_COLUMNS,
  COST_WAVE_EVENT_COLUMNS,
  COST_WAVE_ITEM_COLUMNS,
  COST_WAVE_SKIPPED_COLUMNS,
} from "@/components/costWave/costWaveColumns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { trpc } from "@/lib/trpc";

const STATUS_VARIANT: Record<
  CostWaveStatus,
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING_APPROVAL: "warning",
  APPLIED: "success",
  REJECTED: "danger",
  CONFLICTED: "neutral",
};


export function CostWaveDetailDialog({
  waveId,
  onClose,
  onChanged,
}: {
  waveId: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const detail = trpc.inventory.costWave.useQuery(
    { id: waveId ?? 0 },
    { enabled: waveId != null },
  );
  const [rejectionReason, setRejectionReason] = useState("");

  useEffect(() => {
    setRejectionReason("");
  }, [waveId]);

  function closeDialog() {
    setRejectionReason("");
    onClose();
  }

  async function refresh() {
    await Promise.all([
      utils.inventory.costWave.invalidate(),
      utils.inventory.costWaves.invalidate(),
    ]);
    onChanged();
  }

  const approve = trpc.inventory.approveCostWave.useMutation({
    onSuccess: async (result) => {
      await refresh();
      toast.success(
        result.status === "APPLIED"
          ? "طُبّقت الموجة بعد اكتمال الاعتمادين"
          : result.status === "CONFLICTED"
            ? "أوقفت الموجة بسبب تعارض محفوظ في سجل المراحل"
            : "سُجّل الاعتماد الأول؛ ما زال يلزم اعتماد ثانٍ مستقل",
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const reject = trpc.inventory.rejectCostWave.useMutation({
    onSuccess: async () => {
      setRejectionReason("");
      await refresh();
      toast.success("حُفظ الرفض وسببه دون أي أثر على التكلفة");
    },
    onError: (error) => toast.error(error.message),
  });

  const itemColumns = COST_WAVE_ITEM_COLUMNS;

  const approvalColumns = COST_WAVE_APPROVAL_COLUMNS;

  const eventColumns = COST_WAVE_EVENT_COLUMNS;
  const skippedColumns = COST_WAVE_SKIPPED_COLUMNS;

  const data = detail.data;
  const alreadyDecided = data?.approvals.some(
    (row) => Number(row.approverId) === Number(me.data?.id),
  );
  const canDecide =
    data?.wave.status === "PENDING_APPROVAL" &&
    Number(data.wave.createdBy) !== Number(me.data?.id) &&
    !alreadyDecided;

  async function approveNow() {
    if (!data) return;
    const finalApproval = data.wave.approvalCount === 1;
    const ok = await confirm({
      variant: finalApproval ? "danger" : "warning",
      title: finalApproval
        ? "الاعتماد الثاني سيطبّق الموجة"
        : "تسجيل الاعتماد الأول",
      description: finalApproval
        ? `سيُعاد فحص ${data.wave.itemCount} صنفاً ثم تغيير التكلفة وترحيل أثر ${formatIqd(data.wave.expectedValueDelta)} داخل معاملة واحدة. أي تعارض يوقف الكل.`
        : "سيُحفظ اسمك وتاريخ القرار وبصمة اللقطة، ولن تتغير التكلفة قبل اعتماد شخص آخر.",
      confirmText: finalApproval ? "اعتماد وتطبيق" : "تسجيل الاعتماد",
    });
    if (ok) approve.mutate({ id: data.wave.id });
  }

  return (
    <Dialog open={waveId != null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="sm:max-w-7xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <FileCheck2 aria-hidden className="size-5" />
            {data
              ? `${data.wave.name} (#${data.wave.id})`
              : ACTION_LABELS.loading}
            {data && (
              <Badge
                variant={STATUS_VARIANT[data.wave.status as CostWaveStatus]}
              >
                {COST_WAVE_STATUS_LABELS[data.wave.status as CostWaveStatus]}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            تفاصيل ثابتة للأصناف والفاعل والتاريخ والاعتمادات واللقطة في كل
            مرحلة.
          </DialogDescription>
        </DialogHeader>

        {detail.isError && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md border border-[var(--sem-danger)]/40 bg-[var(--sem-danger-bg)] p-3 text-sm text-[var(--sem-danger)]"
          >
            {detail.error.message}
          </div>
        )}
        {data && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Summary
                label="أنشأها"
                value={
                  data.wave.createdByName || `مستخدم #${data.wave.createdBy}`
                }
                sub={fmtDateTime(data.wave.createdAt)}
              />
              <Summary
                label="الغرض"
                value={COST_WAVE_PURPOSE_LABELS[data.wave.purpose]}
                sub={data.wave.reason}
              />
              <Summary
                label="القاعدة"
                value={COST_WAVE_RULE_LABELS[data.wave.ruleType]}
                sub={data.wave.changeValue}
              />
              <Summary
                label="الأصناف / الكمية"
                value={`${data.wave.itemCount} / ${data.wave.expectedQuantity}`}
                sub={`المستبعد: ${data.wave.skippedCount}`}
              />
              <Summary
                label="فرق قيمة المخزون"
                value={formatIqd(data.wave.expectedValueDelta)}
                sub={`${data.wave.approvalCount} من ${data.wave.requiredApprovals} اعتماد`}
              />
            </div>

            {(data.wave.conflictReason || data.wave.rejectionReason) && (
              <div className="flex gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm">
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
                />
                <span>
                  {data.wave.conflictReason || data.wave.rejectionReason}
                </span>
              </div>
            )}

            <section className="space-y-2">
              <h3 className="font-bold">تفاصيل تغييرات الأصناف</h3>
              <DataTable
                columns={itemColumns}
                data={data.items}
                searchable
                searchPlaceholder="ابحث بالمنتج أو الفئة أو SKU"
                bounded={false}
                viewKey="cost-wave-detail-items"
              />
            </section>

            {data.skipped.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-bold">الأصناف المستبعدة وأسبابها</h3>
                <DataTable
                  columns={skippedColumns}
                  data={data.skipped}
                  searchable
                  bounded={false}
                  viewKey="cost-wave-detail-skipped"
                />
              </section>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 font-bold">
                  <ShieldCheck aria-hidden className="size-4" /> قرارات الاعتماد
                </h3>
                <DataTable
                  columns={approvalColumns}
                  data={data.approvals}
                  searchable={false}
                  bounded={false}
                  emptyText="لم يُسجّل أي قرار بعد"
                  viewKey="cost-wave-detail-approvals"
                />
              </section>
              <section className="space-y-2">
                <h3 className="font-bold">لقطة كل مرحلة</h3>
                <DataTable
                  columns={eventColumns}
                  data={data.events}
                  searchable={false}
                  bounded={false}
                  viewKey="cost-wave-detail-events"
                />
              </section>
            </div>

            {canDecide && (
              <div className="grid gap-3 rounded-md border p-3 md:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <label htmlFor="cost-wave-rejection-reason" className="text-sm font-medium">
                    سبب الرفض
                  </label>
                  <Textarea
                    id="cost-wave-rejection-reason"
                    value={rejectionReason}
                    onChange={(event) => setRejectionReason(event.target.value)}
                    placeholder={`اكتب ${COST_WAVE_MIN_REASON_LENGTH} محارف على الأقل — لا يلزم عند الاعتماد`}
                    maxLength={COST_WAVE_MAX_REASON_LENGTH}
                  />
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Button
                    onClick={approveNow}
                    disabled={approve.isPending || reject.isPending}
                  >
                    <CheckCircle2 aria-hidden />
                    {approve.isPending
                      ? ACTION_LABELS.processing
                      : data.wave.approvalCount === 1
                        ? "الاعتماد الثاني والتطبيق"
                        : "الاعتماد الأول"}
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={
                      rejectionReason.trim().length <
                        COST_WAVE_MIN_REASON_LENGTH ||
                      approve.isPending ||
                      reject.isPending
                    }
                    onClick={() =>
                      reject.mutate({
                        id: data.wave.id,
                        reason: rejectionReason.trim(),
                      })
                    }
                  >
                    <XCircle aria-hidden />{" "}
                    {reject.isPending
                      ? ACTION_LABELS.processing
                      : ACTION_LABELS.reject}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {ACTION_LABELS.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Summary({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-bold">{value}</div>
      {sub && (
        <div
          className="mt-1 line-clamp-2 text-xs text-muted-foreground"
          title={sub}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

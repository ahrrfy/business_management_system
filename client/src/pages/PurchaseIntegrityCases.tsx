import { useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import {
  PurchaseIntegrityWorkspace,
  type PurchaseIntegrityRow,
} from "@/components/purchases/PurchaseIntegrityWorkspace";
import { AppSelect } from "@/components/ui/AppSelect";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

export default function PurchaseIntegrityCases() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const [pickedBranchId, setPickedBranchId] = useState("");
  const [cutoffDate, setCutoffDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  useEffect(() => {
    if (me.data?.branchId != null) setPickedBranchId(String(me.data.branchId));
  }, [me.data?.branchId]);
  const branchId =
    me.data?.branchId != null
      ? Number(me.data.branchId)
      : pickedBranchId
        ? Number(pickedBranchId)
        : null;
  const queryBranchId = branchId === null ? 0 : branchId;
  const enabled = queryBranchId > 0;
  const casesQuery = trpc.purchaseIntegrity.list.useQuery(
    { branchId: queryBranchId, limit: 200 },
    { enabled },
  );
  const blockersQuery = trpc.purchaseIntegrity.monthCloseBlockers.useQuery(
    { branchId: queryBranchId, cutoffDate },
    { enabled },
  );
  const rows = useMemo<PurchaseIntegrityRow[]>(
    () =>
      (casesQuery.data ?? []).map((row) => ({
        id: Number(row.id),
        caseNumber: row.caseNumber,
        code: row.code,
        severity: row.severity,
        status: row.status,
        title: row.title,
        description: row.description,
        detectedAmount: row.detectedAmount,
        detectedAt: row.detectedAt,
        resolutionRequestedBy:
          row.resolutionRequestedBy == null
            ? null
            : Number(row.resolutionRequestedBy),
      })),
    [casesQuery.data],
  );

  async function invalidateAll() {
    await Promise.all([
      utils.purchaseIntegrity.list.invalidate(),
      utils.purchaseIntegrity.resolutionSources.invalidate(),
      utils.purchaseIntegrity.monthCloseBlockers.invalidate(),
    ]);
  }
  const openCase = trpc.purchaseIntegrity.open.useMutation({
    onSuccess: async () => {
      notify.info(
        "تم فتح قضية النزاهة",
        "لا تغيّر القضية قيوداً أو مخزوناً تلقائياً",
      );
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });
  const requestResolution =
    trpc.purchaseIntegrity.requestResolution.useMutation({
      onSuccess: async () => {
        notify.info("تم إرسال حل القضية للاعتماد", "القضية لم تُقفل بعد");
        await invalidateAll();
      },
      onError: (error) => notify.err(error),
    });
  const decideResolution = trpc.purchaseIntegrity.decideResolution.useMutation({
    onSuccess: async (result) => {
      if (result.status === "RESOLVED" || result.status === "DISMISSED")
        notify.ok(
          result.status === "RESOLVED"
            ? "تم اعتماد الحل وإقفال القضية"
            : "تم استبعاد القضية بقرار موثّق",
        );
      else notify.info("تم رفض الحل وإعادة القضية إلى المراجعة");
      await invalidateAll();
    },
    onError: (error) => notify.err(error),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="نزاهة المشتريات وإقفال الفترة"
        description="قضايا عدم المطابقة، الأدلة، مسار الحل المستقل، وموانع الإقفال المالي."
        icon={<ShieldAlert aria-hidden className="size-6" />}
        backHref="/purchases"
        backLabel="المشتريات"
        actions={
          me.data?.branchId == null ? (
            <AppSelect
              value={pickedBranchId}
              onValueChange={setPickedBranchId}
              className="w-52"
              aria-label="الفرع"
            >
              <option value="">اختر الفرع</option>
              {(branches.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </AppSelect>
          ) : undefined
        }
      />
      {me.isLoading ? (
        <LoadingState />
      ) : branchId == null ? (
        <div
          role="status"
          className="rounded-md border p-8 text-center text-sm text-muted-foreground"
        >
          اختر فرعاً لعرض قضايا النزاهة وموانع الإقفال.
        </div>
      ) : (
        <PurchaseIntegrityWorkspace
          branchId={branchId}
          rows={rows}
          blockers={blockersQuery.data ?? []}
          cutoffDate={cutoffDate}
          currentUserId={me.data?.id}
          loading={casesQuery.isLoading || blockersQuery.isLoading}
          error={casesQuery.error ?? blockersQuery.error}
          pending={
            openCase.isPending ||
            requestResolution.isPending ||
            decideResolution.isPending
          }
          onRetry={() =>
            void Promise.all([casesQuery.refetch(), blockersQuery.refetch()])
          }
          onCutoffDateChange={setCutoffDate}
          onOpenCase={(input) => openCase.mutateAsync(input)}
          onRequestResolution={(input) => requestResolution.mutateAsync(input)}
          onDecideResolution={(input) => decideResolution.mutateAsync(input)}
        />
      )}
    </div>
  );
}

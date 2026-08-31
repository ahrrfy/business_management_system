import { useEffect, useMemo, useState } from "react";
import {
  CASH_VARIANCE_EVIDENCE_MAX_BYTES,
  CASH_VARIANCE_EVIDENCE_MIME_TYPES,
  CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH,
  CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH,
  CASH_VARIANCE_REASON_CODES_BY_SOURCE,
  CASH_VARIANCE_REASON_LABELS,
  type CashVarianceReasonCode,
} from "@shared/cashVariance";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { newClientRequestId } from "@/lib/countQueue";
import { D, formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { selectCls } from "@/lib/ui/formStyles";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_LABELS } from "@shared/actionLabels";

type VarianceCase = RouterOutputs["treasury"]["cashVariance"]["list"]["rows"][number];
type SourceType = "CUSTODY" | "DAILY_TREASURY";

const STATUS_LABEL = {
  PROPOSED: "بانتظار الاعتماد",
  APPROVED: "معتمدة",
  REJECTED: "مرفوضة",
} as const;

function statusVariant(status: VarianceCase["status"]) {
  if (status === "APPROVED") return "success" as const;
  if (status === "REJECTED") return "danger" as const;
  return "warning" as const;
}

export default function CashVarianceResolutionPanel() {
  const [filterBranchId, setFilterBranchId] = useState(0);
  const [status, setStatus] = useState<"ALL" | VarianceCase["status"]>("PROPOSED");
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [sourceType, setSourceType] = useState<SourceType>("CUSTODY");
  const [sourceId, setSourceId] = useState("");
  const [reasonCode, setReasonCode] = useState<CashVarianceReasonCode>("CUSTODY_LOSS");
  const [reason, setReason] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [evidenceDocumentId, setEvidenceDocumentId] = useState<number | null>(null);
  const [evidenceFileName, setEvidenceFileName] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const branchesQ = trpc.branches.list.useQuery();
  const meQ = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  useEffect(() => {
    if (filterBranchId || meQ.data?.branchId == null) return;
    setFilterBranchId(Number(meQ.data.branchId));
  }, [filterBranchId, meQ.data?.branchId]);

  const allowedReasons = CASH_VARIANCE_REASON_CODES_BY_SOURCE[sourceType];
  useEffect(() => {
    if (!allowedReasons.includes(reasonCode as never)) {
      setReasonCode(allowedReasons[0]);
    }
  }, [allowedReasons, reasonCode]);

  const listQ = trpc.treasury.cashVariance.list.useInfiniteQuery(
    { branchId: filterBranchId, status: status === "ALL" ? undefined : status, limit: 50 },
    {
      enabled: filterBranchId > 0,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const varianceCases = useMemo(
    () => listQ.data?.pages.flatMap((page) => page.rows) ?? [],
    [listQ.data],
  );
  const varianceTotal = listQ.data?.pages[0]?.total ?? 0;
  const detailQ = trpc.treasury.cashVariance.get.useQuery(
    { caseId: selectedCaseId ?? 0 },
    { enabled: selectedCaseId != null },
  );

  const refresh = async () => {
    await Promise.all([
      utils.treasury.cashVariance.list.invalidate(),
      utils.treasury.cashVariance.get.invalidate(),
      utils.treasury.dailyCashReconciliation.invalidate(),
    ]);
  };
  const proposeM = trpc.treasury.cashVariance.propose.useMutation({
    onSuccess: async (result) => {
      notify.ok("حُفظ اقتراح فرق النقد", "بانتظار اعتماد مراجع مستقل.");
      setSelectedCaseId(result.caseId);
      setSourceId("");
      setReason("");
      setEvidenceReference("");
      setEvidenceDocumentId(null);
      setEvidenceFileName("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const registerEvidenceM = trpc.treasury.cashVariance.registerEvidence.useMutation({
    onSuccess: (result) => {
      setEvidenceDocumentId(result.evidenceDocumentId);
      notify.ok("حُفظ دليل فرق النقد ببصمة ثابتة");
    },
    onError: (error) => {
      setEvidenceDocumentId(null);
      setEvidenceFileName("");
      notify.err(error);
    },
  });
  const approveM = trpc.treasury.cashVariance.approve.useMutation({
    onSuccess: async () => {
      notify.ok("اعتُمد فرق النقد", "ثُبّت النقد الفعلي ورُحّل القيد المتوازن.");
      setDecisionNote("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });
  const rejectM = trpc.treasury.cashVariance.reject.useMutation({
    onSuccess: async () => {
      notify.ok("رُفض اقتراح فرق النقد");
      setDecisionNote("");
      await refresh();
    },
    onError: (error) => notify.err(error),
  });

  const selected = detailQ.data;
  const deciding = approveM.isPending || rejectM.isPending;
  const selectedVariance = selected ? D(selected.variance) : D(0);
  const selectedImpact = !selected
    ? "—"
    : selectedVariance.isPositive()
      ? "التزام معلّق بالزيادة — لا يُسجّل إيراداً"
      : selected.sourceType === "CUSTODY"
        ? "ذمة على مسؤول العهدة المشتق من العقد"
        : "مصروف خسائر خزينة معتمد بلا إسناد لموظف";

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">تسوية فروقات النقد</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          يسجل المنشئ السبب والدليل، ثم يعتمد مراجع مستقل. عجز العهدة فقط يصبح ذمةً على مسؤولها المشتق من العقد؛ عجز الخزينة اليومية خسارة معتمدة، والزيادة التزام معلّق.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">اقتراح حالة</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>المصدر</span>
            <select className={selectCls} value={sourceType} onChange={(event) => {
              setSourceType(event.target.value as SourceType);
            }}>
              <option value="CUSTODY">عهدة CH/CD</option>
              <option value="DAILY_TREASURY">مطابقة خزينة يومية</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>{sourceType === "CUSTODY" ? "رقم سند العهدة الوارد" : "رقم المطابقة اليومية"}</span>
            <Input inputMode="numeric" value={sourceId} onChange={(event) => setSourceId(event.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span>سبب الفرق</span>
            <select className={selectCls} value={reasonCode} onChange={(event) => setReasonCode(event.target.value as CashVarianceReasonCode)}>
              {allowedReasons.map((value) => <option key={value} value={value}>{CASH_VARIANCE_REASON_LABELS[value]}</option>)}
            </select>
          </label>
          {sourceType === "CUSTODY" ? (
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              في العجز فقط يُشتق مسؤول العهدة من مالك الوردية أو مُسلِّم العهدة، ولا يعيّن موظفاً من هذه الشاشة.
            </div>
          ) : (
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              المطابقة اليومية لا تعيّن موظفاً لغياب سجل حيازة حاكم؛ العجز المعتمد يرحّل إلى حساب الخسائر.
            </div>
          )}
          <label className="space-y-1 text-sm">
            <span>وصف الدليل</span>
            <Input value={evidenceReference} maxLength={CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="وصف المحضر أو المستند المرفق" />
          </label>
          <label className="space-y-1 text-sm">
            <span>ملف الدليل الموثق (حتى 5MB)</span>
            <Input
              type="file"
              accept={CASH_VARIANCE_EVIDENCE_MIME_TYPES.join(",")}
              disabled={registerEvidenceM.isPending || filterBranchId <= 0}
              onChange={(event) => {
                const file = event.target.files?.[0];
                setEvidenceDocumentId(null);
                setEvidenceFileName(file?.name ?? "");
                if (!file) return;
                if (file.size <= 0 || file.size > CASH_VARIANCE_EVIDENCE_MAX_BYTES || !CASH_VARIANCE_EVIDENCE_MIME_TYPES.includes(file.type as never)) {
                  notify.err("الملف غير صالح؛ المسموح PDF أو PNG أو JPEG أو WEBP وبحد 5MB");
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => registerEvidenceM.mutate({
                  branchId: filterBranchId,
                  fileName: file.name,
                  dataUrl: String(reader.result),
                  clientRequestId: newClientRequestId(),
                });
                reader.onerror = () => notify.err("تعذر قراءة ملف الدليل");
                reader.readAsDataURL(file);
              }}
            />
            {evidenceDocumentId != null && <span className="text-xs text-emerald-700">موثق: {evidenceFileName} — #{evidenceDocumentId}</span>}
          </label>
          <label className="space-y-1 text-sm md:col-span-3">
            <span>التفسير التشغيلي</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
          </label>
          <div className="md:col-span-3">
            <Button
              disabled={
                proposeM.isPending ||
                registerEvidenceM.isPending ||
                evidenceDocumentId == null ||
                Number(sourceId) <= 0 ||
                reason.trim().length < 10 ||
                evidenceReference.trim().length < CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH ||
                evidenceReference.trim().length > CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH
              }
              onClick={() => {
                const common = {
                  sourceId: Number(sourceId),
                  evidenceDocumentId: evidenceDocumentId!,
                  reason,
                  evidenceReference,
                  clientRequestId: newClientRequestId(),
                };
                if (sourceType === "CUSTODY") {
                  proposeM.mutate({ sourceType: "CUSTODY", reasonCode, ...common });
                } else {
                  if (reasonCode === "CUSTODY_LOSS") {
                    notify.err("عجز العهدة يتطلب مصدر عهدة موثّقاً");
                    return;
                  }
                  proposeM.mutate({ sourceType: "DAILY_TREASURY", reasonCode, ...common });
                }
              }}
            >{proposeM.isPending ? "جارٍ الحفظ…" : "حفظ الاقتراح"}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">سجل الحالات</CardTitle>
          <div className="flex flex-wrap gap-2">
            <select className={selectCls} aria-label="فرع سجل فروقات النقد" value={filterBranchId || ""} onChange={(event) => setFilterBranchId(Number(event.target.value))}>
              <option value="" disabled>اختر فرع السجل</option>
              {(branchesQ.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
            <select className={selectCls} aria-label="حالة فرق النقد" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              <option value="PROPOSED">بانتظار الاعتماد</option>
              <option value="APPROVED">معتمدة</option>
              <option value="REJECTED">مرفوضة</option>
              <option value="ALL">الكل</option>
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {listQ.isLoading ? <LoadingState message="جارٍ تحميل حالات فروقات النقد…" /> : listQ.error ? (
            <ErrorState message={listQ.error.message} onRetry={() => void listQ.refetch()} />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60"><tr>
                  <th className="p-2 text-right">الحالة</th><th className="p-2 text-right">المصدر</th>
                  <th className="p-2 text-right">المتوقع</th><th className="p-2 text-right">الفعلي</th>
                  <th className="p-2 text-right">الفرق</th><th className="p-2 text-right">الإجراء</th>
                </tr></thead>
                <tbody>
                  {varianceCases.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-2"><Badge variant={statusVariant(row.status)}>{STATUS_LABEL[row.status]}</Badge></td>
                      <td className="p-2">{row.sourceType === "CUSTODY" ? "عهدة" : "مطابقة يومية"} — {row.sourceReference}</td>
                      <td className="p-2 tabular-nums">{formatIqd(row.expectedAmount)}</td>
                      <td className="p-2 tabular-nums">{formatIqd(row.actualAmount)}</td>
                      <td className="p-2 tabular-nums">{formatIqd(row.variance)}</td>
                      <td className="p-2"><Button size="sm" variant="outline" onClick={() => setSelectedCaseId(Number(row.id))}>عرض</Button></td>
                    </tr>
                  ))}
                  {!varianceCases.length && <TableEmptyRow colSpan={6} message="لا توجد حالات ضمن المرشح الحالي." />}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
                <span>إجمالي الحالات: {varianceTotal} — المحمّل: {varianceCases.length}</span>
                {listQ.hasNextPage ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={listQ.isFetchingNextPage}
                    onClick={() => void listQ.fetchNextPage()}
                  >
                    {listQ.isFetchingNextPage ? ACTION_LABELS.loading : "تحميل المزيد"}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedCaseId != null && (
        <Card>
          <CardHeader><CardTitle className="text-base">تفاصيل الحالة #{selectedCaseId}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {detailQ.isLoading ? <LoadingState /> : detailQ.error ? <ErrorState message={detailQ.error.message} onRetry={() => void detailQ.refetch()} /> : selected ? (
              <>
                <dl className="grid gap-2 text-sm md:grid-cols-3">
                  <div><dt className="text-muted-foreground">الحالة</dt><dd><Badge variant={statusVariant(selected.status)}>{STATUS_LABEL[selected.status]}</Badge></dd></div>
                  <div><dt className="text-muted-foreground">السبب</dt><dd>{CASH_VARIANCE_REASON_LABELS[selected.reasonCode]}</dd></div>
                  <div><dt className="text-muted-foreground">الدليل</dt><dd className="break-all">{selected.evidenceReference}</dd></div>
                  <div><dt className="text-muted-foreground">المتوقع</dt><dd className="font-bold tabular-nums">{formatIqd(selected.expectedAmount)}</dd></div>
                  <div><dt className="text-muted-foreground">الفعلي</dt><dd className="font-bold tabular-nums">{formatIqd(selected.actualAmount)}</dd></div>
                  <div><dt className="text-muted-foreground">الفرق</dt><dd className="font-bold tabular-nums">{formatIqd(selected.variance)}</dd></div>
                  <div><dt className="text-muted-foreground">المسؤول</dt><dd>{selected.responsibleNameSnapshot || "لا يوجد مسؤول شخصي مثبت"}</dd></div>
                  <div className="md:col-span-2"><dt className="text-muted-foreground">الأثر المحاسبي</dt><dd>{selectedImpact}</dd></div>
                  <div className="md:col-span-3"><dt className="text-muted-foreground">التفسير</dt><dd>{selected.reason}</dd></div>
                </dl>
                {selected.status === "PROPOSED" && (
                  <div className="space-y-2 border-t pt-3">
                    {selected.decisionPolicy.canDecide ? (
                      <>
                        <Textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} rows={2} placeholder="ملاحظة المراجع؛ إلزامية عند الرفض" />
                        <div className="flex gap-2">
                          <Button disabled={deciding} onClick={async () => {
                            const accepted = await confirm({
                              variant: "danger",
                              title: `اعتماد فرق النقد #${selectedCaseId}`,
                              description: `سيُثبّت الفعلي ${formatIqd(selected.actualAmount)} مقابل المتوقع ${formatIqd(selected.expectedAmount)}، ويُرحّل فرقاً قدره ${formatIqd(selected.variance)}. ${selectedImpact}. متابعة؟`,
                              confirmText: "اعتماد وترحيل القيد",
                            });
                            if (!accepted) return;
                            approveM.mutate({ caseId: selectedCaseId, expectedVersion: selected.version, clientRequestId: newClientRequestId(), note: decisionNote || null });
                          }}>اعتماد وترحيل</Button>
                          <Button variant="destructive" disabled={deciding || decisionNote.trim().length < 10} onClick={() => rejectM.mutate({ caseId: selectedCaseId, expectedVersion: selected.version, clientRequestId: newClientRequestId(), reason: decisionNote })}>رفض الاقتراح</Button>
                        </div>
                      </>
                    ) : (
                      <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-bold text-destructive">
                        {selected.decisionPolicy.blockedReason}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">قرار فصل المهام صادر من الخادم ويُعاد التحقق منه داخل المعاملة عند الاعتماد.</p>
                  </div>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

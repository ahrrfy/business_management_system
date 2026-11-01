import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { iqd } from "@/lib/hr/ui";
import { D } from "@/lib/money";
import { payrollStatusLabel } from "@/lib/payrollAccrual";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { AlertTriangle, CheckCircle, Plus, XCircle } from "lucide-react";

const PENALTY_TYPE_LABELS: Record<string, string> = {
  ATTENTION: "لفت نظر",
  WARNING: "إنذار أولي / نهائي",
  SALARY_DEDUCTION: "استقطاع من الراتب",
  SUSPENSION: "إيقاف مؤقت عن العمل",
  DISMISSAL: "فصل انضباطي",
};

type PayrollAllocation = { runId: number; period: string; runStatus: string; amount: string };
const payrollAllocations = (row: unknown): PayrollAllocation[] | null | undefined =>
  (row as { payrollAllocations?: PayrollAllocation[] | null }).payrollAllocations;
const historicalAttestation = (row: unknown): { status: "NEEDS_RECONCILIATION"; period: string } | null | undefined =>
  (row as { historicalAttestation?: { status: "NEEDS_RECONCILIATION"; period: string } | null }).historicalAttestation;

export function EmployeePenaltiesTab({
  employeeId,
  branchId,
  currentUserId,
}: {
  employeeId: number;
  branchId?: number;
  currentUserId?: number;
}) {
  const { can } = useCatalogPeopleOperationAccess();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isOwner = me.data?.isOwner === true;
  const canViewPenalties = can("hrEnterprise.penalties.list");
  const q = trpc.hrEnterprise.penalties.list.useQuery({ employeeId }, { enabled: canViewPenalties });
  const [open, setOpen] = useState(false);

  const [penaltyType, setPenaltyType] = useState<string>("SALARY_DEDUCTION");
  const [decisionNumber, setDecisionNumber] = useState("");
  const [decisionDate, setDecisionDate] = useState(new Date().toISOString().slice(0, 10));
  const [deductionDays, setDeductionDays] = useState("1");
  const [deductionAmount, setDeductionAmount] = useState("0");
  const [reason, setReason] = useState("");
  const [historicalTarget, setHistoricalTarget] = useState<{ id: number; decisionNumber: string } | null>(null);
  const [historicalRequestKey, setHistoricalRequestKey] = useState("");
  const [reportedPayout, setReportedPayout] = useState("");
  const [evidenceStatement, setEvidenceStatement] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [confirmedSourceHash, setConfirmedSourceHash] = useState<string | null>(null);
  const historicalPreview = trpc.payroll.historicalPenaltyPreview.useQuery(
    { penaltyId: historicalTarget?.id ?? 0 },
    { enabled: isOwner && historicalTarget != null },
  );
  const historicalMutation = trpc.payroll.attestHistoricalPenalty.useMutation({
    onSuccess: async (result) => {
      notify.ok(result.mode === "REPLAY_VERIFIED" ? "الإقرار مسجّل سابقاً وينتظر المطابقة" : "سُجّل الإقرار وينتظر المطابقة؛ لم يُعدّل المسير أو السند");
      setHistoricalTarget(null);
      await utils.hrEnterprise.penalties.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });
  const preview = historicalPreview.data?.snapshot.penaltyId === historicalTarget?.id ? historicalPreview.data : null;
  const validPayout = /^\d+(\.\d{1,2})?$/.test(reportedPayout);
  const payoutDifference = preview && validPayout ? D(preview.snapshot.recordedPayout).minus(D(reportedPayout)) : null;
  const payoutMatches = !!preview && payoutDifference != null && payoutDifference.eq(D(preview.snapshot.penaltyAmount));
  const canRecordHistorical = isOwner && !!preview && preview.existingAuditId == null && preview.snapshot.cashBucket === "TREASURY" &&
    validPayout && payoutMatches && evidenceStatement.trim().length >= 10 && evidenceReference.trim().length >= 5 && confirmedSourceHash === preview.sourceHash && !historicalMutation.isPending;

  const openHistorical = (id: number, number: string) => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      notify.err("تعذّر تجهيز طلب الإقرار. أعد فتح النظام من اتصال آمن ثم حاول مجدداً.");
      return;
    }
    setReportedPayout("");
    setEvidenceStatement("");
    setEvidenceReference("");
    setConfirmedSourceHash(null);
    setHistoricalRequestKey(globalThis.crypto.randomUUID());
    setHistoricalTarget({ id, decisionNumber: number });
  };

  const recordHistorical = () => {
    if (!canRecordHistorical || !preview || !historicalTarget) return;
    historicalMutation.mutate({
      penaltyId: historicalTarget.id,
      itemId: preview.snapshot.itemId,
      sourceHash: preview.sourceHash,
      requestKey: historicalRequestKey,
      reportedActualPayout: reportedPayout,
      reportedCashSource: "TREASURY",
      evidenceStatement: evidenceStatement.trim(),
      evidenceReference: evidenceReference.trim(),
    });
  };

  const createMut = trpc.hrEnterprise.penalties.create.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل القرار الانضباطي كمسودة بنجاح");
      setOpen(false);
      setDecisionNumber("");
      setReason("");
      await utils.hrEnterprise.penalties.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const approveMut = trpc.hrEnterprise.penalties.approve.useMutation({
    onSuccess: async () => {
      notify.ok("تم اعتماد القرار الانضباطي");
      await utils.hrEnterprise.penalties.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const cancelMut = trpc.hrEnterprise.penalties.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("تم إلغاء العقوبة بنجاح");
      await utils.hrEnterprise.penalties.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!decisionNumber.trim() || !reason.trim()) {
      notify.err("يرجى ملء رقم القرار وسبب العقوبة بالتفصيل");
      return;
    }
    const days = Number(deductionDays) || 0;
    if (penaltyType === "SALARY_DEDUCTION" && days > 3) {
      notify.err("الحد الأقصى لأيام الاستقطاع في النظام هو 3 أيام");
      return;
    }
    createMut.mutate({
      employeeId,
      penaltyType: penaltyType as any,
      decisionNumber: decisionNumber.trim(),
      decisionDate,
      reason: reason.trim(),
      deductionDays: days,
      deductionAmount: deductionAmount || undefined,
    });
  };

  const getStatusBadge = (status: string, payrollRunId: number | null) => {
    switch (status) {
      case "DRAFT":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-pending">مسودة</span>;
      case "APPROVED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">معتمدة</span>;
      case "APPLIED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-active">{payrollRunId == null ? "ارتباط المسير غير موثّق" : "مرتبطة بمسير — راجع حالته"}</span>;
      case "CANCELLED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-cancelled">ملغاة</span>;
      default:
        return <span>{status}</span>;
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            العقوبات والقرارات الانضباطية
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            سجل القرارات الانضباطية وربط استقطاعاتها بمسير الرواتب.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5" disabled={!can("hrEnterprise.penalties.create")}>
          <Plus className="h-4 w-4" />
          إصدار عقوبة انضباطية
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {!canViewPenalties ? (
          <div className="p-6 text-center text-sm text-muted-foreground">لا تملك صلاحية عرض القرارات الانضباطية.</div>
        ) : q.isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">جاري تحميل العقوبات...</div>
        ) : q.isError || !q.data ? (
          <div className="p-6 text-center text-sm text-destructive" role="alert">تعذّر تحميل القرارات الانضباطية. أعد المحاولة.</div>
        ) : q.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            سجل الموظف نظيف، لا توجد عقوبات أو إنذارات مسجلة.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>نوع العقوبة</TableHead>
                <TableHead>رقم القرار</TableHead>
                <TableHead>تاريخ القرار</TableHead>
                <TableHead>أيام الاستقطاع</TableHead>
                <TableHead>المبلغ المحدد بالقرار</TableHead>
                <TableHead>المبلغ المثبّت في المسير</TableHead>
                <TableHead>السبب</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead className="w-32">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium text-xs">
                    {PENALTY_TYPE_LABELS[p.penaltyType] ?? p.penaltyType}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start font-mono text-xs">
                    {p.decisionNumber}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(p.decisionDate)}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs">
                    {Number(p.deductionDays) > 0 ? `${p.deductionDays} يوم` : "—"}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs tabular-nums">
                    {p.penaltyType === "SALARY_DEDUCTION" ? iqd(p.deductionAmount) : "—"}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {payrollAllocations(p)?.length ? payrollAllocations(p)!.map((allocation) => (
                      <div key={`${allocation.runId}-${allocation.period}`}>
                        <span dir="ltr">{iqd(allocation.amount)}</span>
                        <span className="block text-muted-foreground">مسير {allocation.period} #{allocation.runId} — {payrollStatusLabel(allocation.runStatus)}</span>
                      </div>
                    )) : "لا يوجد تخصيص موثّق"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {p.reason}
                  </TableCell>
                  <TableCell>
                    {getStatusBadge(p.status, p.payrollRunId)}
                    {p.payrollRunId != null && <span className="block text-xs text-muted-foreground">مسير #{p.payrollRunId}</span>}
                    {historicalAttestation(p)?.status === "NEEDS_RECONCILIATION" && (
                      <span className="block mt-1 text-xs text-muted-foreground">إقرار بحسم يدوي لشهر {historicalAttestation(p)!.period} يحتاج مطابقة السند والخزينة؛ لم يُسجّل خصماً في المسير.</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.status === "DRAFT" && historicalAttestation(p)?.status === "NEEDS_RECONCILIATION" && (
                      <span className="text-xs text-muted-foreground">لا تتاح الإجراءات قبل المطابقة</span>
                    )}
                    {p.status === "DRAFT" && !historicalAttestation(p) && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-primary hover:bg-primary/10 gap-1"
                          disabled={!can("hrEnterprise.penalties.approve") || (approveMut.isPending || p.createdById === currentUserId)}
                          title={p.createdById === currentUserId ? "فصل المهام: لا يمكنك اعتماد قرار أنشأته بنفسك" : "اعتماد القرار"}
                          onClick={async () => {
                            const ok = await confirm({
                              variant: "warning",
                              title: "اعتماد القرار الانضباطي",
                              description: `اعتماد القرار رقم ${p.decisionNumber}؟`,
                              confirmText: "اعتماد",
                            });
                            if (ok) approveMut.mutate({ id: p.id });
                          }}
                        >
                          <CheckCircle className="h-3 w-3" />
                          اعتماد
                        </Button>
                        {isOwner && p.penaltyType === "SALARY_DEDUCTION" && D(p.deductionAmount).gt(0) && !historicalAttestation(p) && (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openHistorical(p.id, p.decisionNumber)}>
                            إقرار حسم تاريخي
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                          disabled={!can("hrEnterprise.penalties.cancel") || (cancelMut.isPending)}
                          onClick={async () => {
                            const ok = await confirm({
                              variant: "danger",
                              title: "إلغاء القرار الانضباطي",
                              description: `إلغاء القرار رقم ${p.decisionNumber} نهائياً؟`,
                              confirmText: "إلغاء القرار",
                            });
                            if (ok) cancelMut.mutate({ id: p.id, reason: "إلغاء بطلب الإدارة" });
                          }}
                        >
                          <XCircle className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={historicalTarget != null} onOpenChange={(open) => { if (!open && !historicalMutation.isPending) setHistoricalTarget(null); }}>
        <DialogContent className="sm:max-w-xl" dir="rtl">
          <DialogHeader><DialogTitle>إقرار حسم تاريخي — قرار {historicalTarget?.decisionNumber}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">إقرار يحتاج مطابقة السند والخزينة؛ لا يُغيّر السند أو المسير ولا يُنشئ صرفاً.</p>
          <p className="text-xs text-muted-foreground">سبب المراجعة: مطابقة الحسم اليدوي المراد إثباته مع سند الراتب والخزينة.</p>
          {historicalPreview.isLoading ? (
            <p className="text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>
          ) : historicalPreview.isError ? (
            <p className="text-sm text-destructive" role="alert">{historicalPreview.error?.message || "تعذّر تحميل مصدر الإقرار. راجع قرار العقوبة ومسير الشهر."}</p>
          ) : !preview ? (
            <p className="text-sm text-muted-foreground">تعذّر مطابقة مصدر الإقرار.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="rounded border p-3 space-y-1 text-xs">
                <div>الموظف: <strong>{preview.snapshot.employeeName}</strong></div>
                <div>المسير: <span dir="ltr">{preview.snapshot.period}</span> · السند #{preview.snapshot.receiptId}</div>
                <div>مبلغ القرار: <span dir="ltr">{iqd(preview.snapshot.penaltyAmount)}</span></div>
                <div>مبلغ الصرف المسجّل في السند: <span dir="ltr">{iqd(preview.snapshot.recordedPayout)}</span></div>
                <div>مصدر السند: {preview.snapshot.cashBucket === "TREASURY" ? "الخزينة" : "مصدر آخر — لا يقبل هذا الإقرار"}</div>
              </div>
              {preview.existingAuditId != null ? (
                <p className="text-xs text-muted-foreground">يوجد إقرار سابق لهذا القرار، وهو بانتظار المطابقة.</p>
              ) : (
                <>
                  <div className="space-y-1"><Label htmlFor="historical-actual-payout">المبلغ المصروف فعلياً كما تقرّ به (د.ع)</Label><MoneyInput id="historical-actual-payout" value={reportedPayout} onChange={(value) => { setReportedPayout(value); setConfirmedSourceHash(null); }} /></div>
                  {payoutDifference != null && <p className="text-xs">الفرق بين السند والمبلغ المقرّ: <span dir="ltr">{iqd(payoutDifference.toFixed(2))}</span>{!payoutMatches && " — لا يطابق مبلغ القرار."}</p>}
                  <div className="space-y-1"><Label htmlFor="historical-statement">نص إقرارك بالواقعة</Label><Textarea id="historical-statement" value={evidenceStatement} onChange={(e) => { setEvidenceStatement(e.target.value); setConfirmedSourceHash(null); }} maxLength={500} placeholder="اكتب ما تؤكده من واقع السجلات" /></div>
                  <div className="space-y-1"><Label htmlFor="historical-reference">مرجع المراجعة</Label><Input id="historical-reference" value={evidenceReference} onChange={(e) => { setEvidenceReference(e.target.value); setConfirmedSourceHash(null); }} maxLength={300} placeholder="مرجع أو وصف دليل المراجعة" /></div>
                  <div className="flex items-start gap-2"><Checkbox id="historical-confirm" checked={confirmedSourceHash === preview.sourceHash} onCheckedChange={(checked) => setConfirmedSourceHash(checked === true ? preview.sourceHash : null)} /><Label htmlFor="historical-confirm" className="leading-relaxed">أقر بوقوع الحسم اليدوي فعلاً وبصحة مبلغ الصرف والمصدر والنص والمرجع وفق ما راجعته.</Label></div>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={historicalMutation.isPending} onClick={() => setHistoricalTarget(null)}>إغلاق</Button>
            {preview?.existingAuditId == null && <Button type="button" disabled={!canRecordHistorical} onClick={recordHistorical}>تسجيل الإقرار للمطابقة</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>إصدار قرار انضباطي / عقوبة</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="penalty-type">نوع القرار</Label>
                <AppSelect id="penalty-type" value={penaltyType} onValueChange={setPenaltyType}>
                  <option value="SALARY_DEDUCTION">استقطاع من الراتب (حد النظام 3 أيام)</option>
                  <option value="ATTENTION">لفت نظر خطي</option>
                  <option value="WARNING">إنذار رسمي أولي / نهائي</option>
                  <option value="SUSPENSION">إيقاف مؤقت عن العمل</option>
                  <option value="DISMISSAL">فصل انضباطي مسبب</option>
                </AppSelect>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="penalty-no">رقم القرار الإداري</Label>
                  <Input
                    id="penalty-no"
                    placeholder="مثال: DEC-2026-104"
                    value={decisionNumber}
                    onChange={(e) => setDecisionNumber(e.target.value)}
                    dir="ltr"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="penalty-date">تاريخ القرار</Label>
                  <Input
                    id="penalty-date"
                    type="date"
                    value={decisionDate}
                    onChange={(e) => setDecisionDate(e.target.value)}
                    required
                  />
                </div>
              </div>

              {penaltyType === "SALARY_DEDUCTION" && (
                <div className="grid grid-cols-2 gap-3 p-2.5 rounded-md bg-muted border border-border">
                  <div className="space-y-1.5">
                    <Label htmlFor="deduction-days">
                      أيام الاستقطاع (1 إلى 3 أيام)
                    </Label>
                    <Input
                      id="deduction-days"
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="3"
                      value={deductionDays}
                      onChange={(e) => setDeductionDays(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="deduction-amt">مبلغ مقطوع بديل (د.ع)</Label>
                    <MoneyInput
                      id="deduction-amt"
                      placeholder="0"
                      value={deductionAmount}
                      onChange={setDeductionAmount}
                      decimals={0}
                    />
                  </div>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    يحدد النظام سقف أيام الاستقطاع لهذا القرار بثلاثة أيام.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="penalty-reason">السبب والمخالفة المرتكبة بالتفصيل</Label>
                <Textarea
                  id="penalty-reason"
                  placeholder="وصف المخالفة الانضباطية أو التقصير المثبت بالتحقيق الداخلي"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  required
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={!can("hrEnterprise.penalties.create") || (createMut.isPending)}>
                {createMut.isPending ? "جاري الحفظ..." : "إصدار القرار"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

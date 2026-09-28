import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CheckCircle, Plus, XCircle } from "lucide-react";

const PENALTY_TYPE_LABELS: Record<string, string> = {
  ATTENTION: "لفت نظر",
  WARNING: "إنذار أولي / نهائي",
  SALARY_DEDUCTION: "استقطاع من الراتب",
  SUSPENSION: "إيقاف مؤقت عن العمل",
  DISMISSAL: "فصل انضباطي",
};

export function EmployeePenaltiesTab({
  employeeId,
  branchId,
  currentUserId,
}: {
  employeeId: number;
  branchId?: number;
  currentUserId?: number;
}) {
  const utils = trpc.useUtils();
  const q = trpc.hrEnterprise.penalties.list.useQuery({ employeeId });
  const [open, setOpen] = useState(false);

  const [penaltyType, setPenaltyType] = useState<string>("SALARY_DEDUCTION");
  const [decisionNumber, setDecisionNumber] = useState("");
  const [decisionDate, setDecisionDate] = useState(new Date().toISOString().slice(0, 10));
  const [deductionDays, setDeductionDays] = useState("1");
  const [deductionAmount, setDeductionAmount] = useState("0");
  const [reason, setReason] = useState("");

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
      notify.ok("تم اعتماد العقوبة، وسيتم استقطاعها تلقائياً في مسيّر الرواتب القادم");
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
      notify.err("الحد الأقصى للاستقطاع الانضباطي هو 3 أيام بموجب المادة 139 من قانون العمل العراقي");
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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "DRAFT":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-pending">مسودة</span>;
      case "APPROVED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">معتمدة — بانتظار مسير الرواتب</span>;
      case "APPLIED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-active">تم الاستقطاع من الراتب</span>;
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
            حوكمة الإجراءات التأديبية بموجب قانون العمل العراقي رقم 37 لسنة 2015 (المواد 138-142)، مع ربط الاستقطاع آلياً بالرواتب.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          إصدار عقوبة انضباطية
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {q.isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">جاري تحميل العقوبات...</div>
        ) : !q.data || q.data.length === 0 ? (
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
                <TableHead>المبلغ المستقطع</TableHead>
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
                    {Number(p.deductionAmount) > 0 ? iqd(p.deductionAmount) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {p.reason}
                  </TableCell>
                  <TableCell>{getStatusBadge(p.status)}</TableCell>
                  <TableCell>
                    {p.status === "DRAFT" && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-primary hover:bg-primary/10 gap-1"
                          disabled={approveMut.isPending || p.createdById === currentUserId}
                          title={p.createdById === currentUserId ? "فصل المهام: لا يمكنك اعتماد قرار أنشأته بنفسك" : "اعتماد القرار"}
                          onClick={async () => {
                            const ok = await confirm({
                              variant: "warning",
                              title: "اعتماد القرار الانضباطي",
                              description: `اعتماد القرار رقم ${p.decisionNumber}؟ سيتم إدراج الاستقطاع آلياً في مسير الرواتب القادم.`,
                              confirmText: "اعتماد",
                            });
                            if (ok) approveMut.mutate({ id: p.id });
                          }}
                        >
                          <CheckCircle className="h-3 w-3" />
                          اعتماد
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                          disabled={cancelMut.isPending}
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>إصدار قرار انضباطي / عقوبة</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="space-y-1.5">
                <Label htmlFor="penalty-type">نوع العقوبة القانونية</Label>
                <AppSelect id="penalty-type" value={penaltyType} onValueChange={setPenaltyType}>
                  <option value="SALARY_DEDUCTION">استقطاع من الراتب (حد أقصى 3 أيام شهرياً)</option>
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
                    المادة 139 من قانون العمل: لا يجوز أن يتجاوز حسم الأجر كعقوبة تأديبية أجر 3 أيام في الشهر الواحد.
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
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "جاري الحفظ..." : "إصدار القرار"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

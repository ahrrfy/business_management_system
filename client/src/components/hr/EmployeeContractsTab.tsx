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
import { fmtDate } from "@/lib/date";
import { iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Briefcase, Plus } from "lucide-react";

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  FIXED_TERM: "محدد المدة",
  INDEFINITE: "غير محدد المدة",
  PROBATION: "فترة تجربة",
  SEASONAL: "عمل موسمي",
};

export function EmployeeContractsTab({ employeeId }: { employeeId: number }) {
  const utils = trpc.useUtils();
  const q = trpc.hrEnterprise.contracts.list.useQuery({ employeeId });
  const [open, setOpen] = useState(false);

  const [contractType, setContractType] = useState<string>("FIXED_TERM");
  const [contractNumber, setContractNumber] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const [probationEndDate, setProbationEndDate] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [basicSalary, setBasicSalary] = useState("");
  const [allowances, setAllowances] = useState("0");
  const [terms, setTerms] = useState("");

  const createMut = trpc.hrEnterprise.contracts.create.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل العقد بنجاح");
      setOpen(false);
      setContractNumber("");
      setTerms("");
      await utils.hrEnterprise.contracts.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const approveMut = trpc.hrEnterprise.contracts.approve.useMutation({
    onSuccess: async () => {
      notify.ok("تم تفعيل واعتماد العقد بنجاح");
      await utils.hrEnterprise.contracts.list.invalidate({ employeeId });
    },
    onError: (err) => notify.err(err),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!startDate) {
      notify.err("يرجى تحديد تاريخ بداية العقد");
      return;
    }
    createMut.mutate({
      employeeId,
      contractType: contractType as any,
      contractNumber: contractNumber.trim() || undefined,
      startDate,
      endDate: endDate || undefined,
      probationEndDate: probationEndDate || undefined,
      jobTitle: jobTitle.trim() || undefined,
      basicSalary: basicSalary || undefined,
      allowances: allowances || undefined,
      terms: terms.trim() || undefined,
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-active">ساري</span>;
      case "DRAFT":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-pending">مسودة</span>;
      case "RENEWED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">مجدد</span>;
      case "TERMINATED":
      case "EXPIRED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium badge-status-cancelled">منتهي</span>;
      default:
        return <span>{status}</span>;
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-primary" />
            عقود العمل وفترات التجربة
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            حوكمة عقود العمل وتتبع فترات التجربة القانونية (الحد الأقصى 3 أشهر بموجب المادة 33 من قانون العمل العراقي).
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          تسجيل عقد جديد
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {q.isLoading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">جاري تحميل العقود...</div>
        ) : !q.data || q.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            لا توجد عقود مسجلة لهذا الموظف حتى الآن.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>نوع العقد</TableHead>
                <TableHead>رقم العقد</TableHead>
                <TableHead>تاريخ البداية</TableHead>
                <TableHead>تاريخ الانتهاء</TableHead>
                <TableHead>نهاية التجربة</TableHead>
                <TableHead>الراتب الأساسي</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead className="w-24">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium text-xs">
                    {CONTRACT_TYPE_LABELS[c.contractType] ?? c.contractType}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start font-mono text-xs">
                    {c.contractNumber || "—"}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(c.startDate)}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(c.endDate)}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs">
                    {fmtDate(c.probationEndDate)}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start text-xs tabular-nums">
                    {c.basicSalary ? iqd(c.basicSalary) : "—"}
                  </TableCell>
                  <TableCell>{getStatusBadge(c.status)}</TableCell>
                  <TableCell>
                    {c.status === "DRAFT" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={approveMut.isPending}
                        onClick={() => approveMut.mutate({ id: c.id })}
                      >
                        تفعيل
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>تسجيل عقد عمل جديد</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="contract-type">نوع العقد</Label>
                  <AppSelect id="contract-type" value={contractType} onValueChange={setContractType}>
                    <option value="FIXED_TERM">محدد المدة</option>
                    <option value="INDEFINITE">غير محدد المدة (دائمي)</option>
                    <option value="PROBATION">عقد تجربة أولي</option>
                    <option value="SEASONAL">موسمي / مؤقت</option>
                  </AppSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contract-no">رقم العقد</Label>
                  <Input
                    id="contract-no"
                    placeholder="مثال: CNT-2026-001"
                    value={contractNumber}
                    onChange={(e) => setContractNumber(e.target.value)}
                    dir="ltr"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="contract-start">تاريخ بداية العقد</Label>
                  <Input
                    id="contract-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contract-end">تاريخ الانتهاء</Label>
                  <Input
                    id="contract-end"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contract-probation">
                  تاريخ نهاية فترة التجربة (أقصاها 3 أشهر بموجب المادة 33)
                </Label>
                <Input
                  id="contract-probation"
                  type="date"
                  value={probationEndDate}
                  onChange={(e) => setProbationEndDate(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="contract-salary">الراتب الأساسي الشهري (د.ع)</Label>
                  <MoneyInput
                    id="contract-salary"
                    placeholder="900,000"
                    value={basicSalary}
                    onChange={setBasicSalary}
                    decimals={0}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contract-allowances">البدلات الشهرية (د.ع)</Label>
                  <MoneyInput
                    id="contract-allowances"
                    placeholder="150,000"
                    value={allowances}
                    onChange={setAllowances}
                    decimals={0}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="contract-terms">الشروط والأحكام الخاصة</Label>
                <Textarea
                  id="contract-terms"
                  placeholder="أي بنود أو شروط إضافية ملحقة بالعقد"
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                إلغاء
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "جاري الحفظ..." : "تسجيل العقد"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

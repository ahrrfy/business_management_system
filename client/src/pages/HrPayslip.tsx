import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { printPayslip } from "@/lib/printing/printPayslip";
import { iqd } from "@/lib/hr/ui";
import { fmtDate } from "@/lib/date";
import { AlertCircle, CheckCircle2, Clock, FileText, Printer } from "lucide-react";

export default function HrPayslip() {
  const { runId } = useParams<{ runId: string }>();
  const idNum = Number(runId);

  const q = trpc.payroll.myPayslip.useQuery(
    { runId: idNum },
    { enabled: Number.isInteger(idNum) && idNum > 0 },
  );

  if (q.isLoading) {
    return (
      <div className="container max-w-4xl py-8 space-y-4">
        <div className="p-8 text-center text-sm text-muted-foreground animate-pulse">
          جاري تحميل قسيمة الراتب...
        </div>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="container max-w-4xl py-8 space-y-4">
        <Card className="border-destructive/30">
          <CardContent className="p-6 text-center space-y-3">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
            <h2 className="text-base font-semibold">تعذّر عرض قسيمة الراتب</h2>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {q.error?.message || "لا توجد قسيمة راتب مطابقة لهذا المعرّف أو ليس لديك صلاحية للاطلاع عليها."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { employee, item } = q.data;
  const statusLabel =
    item.runStatus === "paid" ? "مدفوع" : item.runStatus === "approved" ? "معتمد" : "مسودّة";

  const handlePrint = () => {
    printPayslip({
      runId: item.runId,
      period: item.period,
      statusLabel,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      employeeId: employee.id,
      position: employee.position,
      department: employee.department,
      revisionNo: item.revisionNo,
      accrualDate: item.accrualDate,
      paidAt: item.paidAt ? (typeof item.paidAt === "string" ? item.paidAt : new Date(item.paidAt).toISOString().slice(0, 10)) : null,
      legalPolicyHash: item.legalPolicyHash,
      approvalSnapshotHash: item.approvalSnapshotHash,
      itemSnapshotHash: item.snapshotHash,
      payTypeLabel: item.payType === "hourly" ? "بالساعة" : "شهري",
      hours: item.hours,
      gross: item.gross,
      overtime: item.overtime,
      commission: item.commission,
      deductions: item.deductions,
      advanceDeduction: item.advanceDeduction,
      socialSecurityEmployee: item.socialSecurityEmployee,
      incomeTax: item.incomeTax,
      socialSecurityEmployer: item.socialSecurityEmployer,
      endOfServiceAccrual: item.endOfServiceAccrual,
      net: item.net,
      note: item.note,
    });
  };

  return (
    <div className="container max-w-4xl py-6 space-y-6">
      <PageHeader
        title={
          <div className="flex items-center gap-2">
            <span>قسيمة الراتب الإلكترونية</span>
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                item.runStatus === "paid"
                  ? "badge-status-active"
                  : item.runStatus === "approved"
                  ? "bg-primary/10 text-primary"
                  : "badge-status-pending"
              }`}
            >
              {item.runStatus === "paid" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <Clock className="h-3 w-3" />
              )}
              {statusLabel}
            </span>
          </div>
        }
        icon={<FileText className="h-5 w-5 text-primary" />}
        description={`كشف استحقاق واقتطاعات الأجر الشهري للفترة ${item.period}`}
        backHref="/hr"
        backLabel="رجوع للموارد البشرية"
        actions={
          <Button onClick={handlePrint} className="gap-2">
            <Printer className="h-4 w-4" />
            طباعة كشف الراتب
          </Button>
        }
      />

      {/* بيانات الموظف والمسير */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            بيانات المستحق
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <span className="text-muted-foreground block mb-0.5">اسم الموظف</span>
            <span className="font-semibold text-sm">
              {employee.firstName} {employee.lastName}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block mb-0.5">المنصب / القسم</span>
            <span className="font-medium">
              {employee.position || "—"} / {employee.department || "—"}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block mb-0.5">طريقة الاحتساب</span>
            <span className="font-medium">
              {item.payType === "hourly" ? "بالساعة" : "راتب شهري"}
              {item.hours && Number(item.hours) > 0 ? ` (${item.hours} ساعة)` : ""}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground block mb-0.5">تاريخ الاستحقاق</span>
            <span className="font-medium" dir="ltr">
              {item.accrualDate ? fmtDate(item.accrualDate) : item.period}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* تفاصيل الاستحقاقات والاستقطاعات */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* الاستحقاقات */}
        <Card>
          <CardHeader className="pb-2 border-b bg-muted/20">
            <CardTitle className="text-sm font-semibold text-money-positive">
              الاستحقاقات (الإيرادات)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-2.5 text-xs">
            <div className="flex justify-between py-1 border-b border-dashed">
              <span className="text-muted-foreground">الراتب الأساسي / أجر الحضور</span>
              <span className="font-medium" dir="ltr">{iqd(item.gross)}</span>
            </div>
            {Number(item.allowances || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">البدلات الثابتة</span>
                <span className="font-medium" dir="ltr">{iqd(item.allowances!)}</span>
              </div>
            )}
            {Number(item.overtime || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">الأجر الإضافي</span>
                <span className="font-medium text-money-positive" dir="ltr">+{iqd(item.overtime)}</span>
              </div>
            )}
            {Number(item.commission || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">العمولات والمكافآت</span>
                <span className="font-medium text-money-positive" dir="ltr">+{iqd(item.commission)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* الاستقطاعات */}
        <Card>
          <CardHeader className="pb-2 border-b bg-muted/20">
            <CardTitle className="text-sm font-semibold text-money-negative">
              الاستقطاعات والخصومات
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-2.5 text-xs">
            {Number(item.advanceDeduction || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">استقطاع السلف</span>
                <span className="font-medium text-money-negative" dir="ltr">-{iqd(item.advanceDeduction!)}</span>
              </div>
            )}
            {Number(item.deductions || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">الجزاءات والخصومات الأخرى</span>
                <span className="font-medium text-money-negative" dir="ltr">-{iqd(item.deductions)}</span>
              </div>
            )}
            {Number(item.socialSecurityEmployee || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">الضمان الاجتماعي (حصة الموظف 5%)</span>
                <span className="font-medium text-money-negative" dir="ltr">-{iqd(item.socialSecurityEmployee!)}</span>
              </div>
            )}
            {Number(item.incomeTax || 0) > 0 && (
              <div className="flex justify-between py-1 border-b border-dashed">
                <span className="text-muted-foreground">ضريبة الدخل المستقطعة</span>
                <span className="font-medium text-money-negative" dir="ltr">-{iqd(item.incomeTax!)}</span>
              </div>
            )}
            {Number(item.advanceDeduction || 0) === 0 &&
              Number(item.deductions || 0) === 0 &&
              Number(item.socialSecurityEmployee || 0) === 0 &&
              Number(item.incomeTax || 0) === 0 && (
                <div className="py-4 text-center text-muted-foreground">لا توجد استقطاعات على هذا الراتب</div>
              )}
          </CardContent>
        </Card>
      </div>

      {/* شريط صافي الراتب النهائي */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <span className="text-xs text-muted-foreground block mb-1">صافي الراتب المستحق للصرف</span>
            <div className="text-2xl sm:text-3xl font-bold tracking-tight text-primary tabular-nums" dir="ltr">
              {iqd(item.net)}
            </div>
          </div>
          {item.paidAt && (
            <div className="text-xs text-muted-foreground text-start sm:text-end">
              <span>تم الصرف الفعلي بتاريخ: </span>
              <span className="font-medium" dir="ltr">{fmtDate(item.paidAt)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* الملاحظات التوضيحية */}
      {item.note && (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground">
            <span className="font-semibold block mb-1 text-foreground">ملاحظات الاحتساب:</span>
            <p className="whitespace-pre-wrap">{item.note}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

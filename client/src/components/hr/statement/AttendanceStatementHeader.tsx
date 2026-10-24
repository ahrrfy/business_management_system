import { recentAttendanceMonths as recentMonths } from "@shared/hr";
import { ATTENDANCE_STATE_LABELS as STATE_LABEL } from "@shared/hr";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { iqd } from "@/lib/hr/ui";
import { printAttendanceStatement } from "@/lib/printing/printAttendanceStatement";
import { formatDurationArabic } from "@shared/attendanceHours";
import {
  CalendarDays,
  FileSpreadsheet,
  Printer,
  RefreshCw,
  Send,
} from "lucide-react";
import type { EmployeeStatementModel } from "./useEmployeeStatement";
const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function AttendanceStatementHeader({
  model,
}: {
  model: EmployeeStatementModel;
}) {
  const {
    can,
    period,
    setPeriod,
    setFix,
    correct,
    recompute,
    totalDue,
    snap,
    dueLabel,
    shareText,
    wa,
    employeeId,
    manualRecomputeRef,
  } = model;
  const d = model.d!;
  return (
    <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
      <CardTitle className="text-base flex items-center gap-2">
        <CalendarDays aria-hidden className="size-4" />
        كشف الحضور والدوام التفصيلي
      </CardTitle>
      <div className="flex items-center gap-2 flex-wrap">
        <AppSelect
          className={selectCls}
          value={period}
          onValueChange={(value) => {
            setFix(null);
            setPeriod(value);
          }}
          disabled={correct.isPending || recompute.isPending}
          aria-label="الشهر"
        >
          {recentMonths().map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </AppSelect>
        {!snap && can("attendance.recomputeRates") && (
          <Button
            variant="outline"
            size="sm"
            disabled={recompute.isPending}
            onClick={() => {
              manualRecomputeRef.current = true;
              recompute.mutate({ period, employeeId });
            }}
            title="مزامنة البصمات الخام وإعادة احتساب الساعات والفترات والأجور تلقائياً مع الحفاظ على التعديلات اليدوية"
          >
            <RefreshCw
              aria-hidden
              className={`size-3.5 ${recompute.isPending ? "animate-spin" : ""}`}
            />
            {recompute.isPending
              ? "جارٍ المزامنة والاحتساب…"
              : "مزامنة البصمات وإعادة الاحتساب"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            printAttendanceStatement(
              {
                employeeName: d.employee.name,
                employeeId: d.employee.id,
                position: d.employee.position,
                department: d.employee.department,
                branchName: d.employee.branchName,
                period: d.period,
                from: d.from,
                to: d.to,
                totals: d.totals,
                amountDue: d.amountDue,
                dueBasis: d.dueBasis,
                payrollSnapshot: snap,
              },
              d.days as never,
            )
          }
        >
          <Printer aria-hidden className="size-3.5" /> طباعة الكشف
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            exportRows(d.days as any[], {
              filename: `كشف حضور ${d.employee.name} ${d.period}`,
              title: `كشف حضور ودوام — ${d.employee.name}`,
              meta: [
                { label: "الشهر", value: d.period },
                { label: "الفترة", value: `${d.from} ← ${d.to}` },
                {
                  label: "ساعات الدوام المطلوبة",
                  value: d.totals.scheduledHours,
                },
                {
                  label: "الساعات المدفوعة المستحقّة",
                  value: d.totals.payableHours,
                },
                // المستحقّ بأساسه — وإلّا قُرئ مجموعُ عمود «أجر اليوم» (صفرٌ للمُعفى) راتباً.
                { label: dueLabel, value: iqd(String(totalDue)) },
              ],
              columns: [
                { key: "date", header: "التاريخ" },
                { key: "dayName", header: "اليوم" },
                {
                  key: "checkIn",
                  header: "وقت الدخول",
                  map: (r: any) => r.checkIn ?? "",
                },
                {
                  key: "checkOut",
                  header: "وقت الانصراف",
                  map: (r: any) => r.checkOut ?? "",
                },
                {
                  key: "sessions",
                  header: "فترات الدوام / الاستراحة",
                  map: (r: any) =>
                    r.sessions && r.sessions.length > 1
                      ? `${r.sessions.map((s: any) => `${s.checkIn}←${s.checkOut ?? "؟"}`).join(" ، ")}${r.breakMinutes > 0 ? ` (استراحة/زمنية ${formatDurationArabic(r.breakMinutes)})` : ""}`
                      : r.breakMinutes > 0
                        ? `استراحة/زمنية ${formatDurationArabic(r.breakMinutes)}`
                        : "",
                },
                { key: "scheduledHours", header: "المطلوب" },
                { key: "countedHours", header: "صافي العمل" },
                { key: "overtimeHours", header: "إضافي" },
                { key: "rate", header: "سعر الساعة", money: true },
                { key: "amount", header: "أجر الدوام", money: true },
                { key: "overtimeAmount", header: "أجر الإضافي", money: true },
                { key: "totalAmount", header: "إجمالي اليوم", money: true },
                {
                  key: "state",
                  header: "الحالة",
                  map: (r: any) => STATE_LABEL[r.state] ?? r.state,
                },
                {
                  key: "needsReview",
                  header: "يحتاج مراجعة",
                  map: (r: any) => (r.needsReview ? "نعم" : ""),
                },
              ],
              totalsRow: {
                amount: Number(d.totals.basePay),
                overtimeHours: Number(d.totals.overtimeHours),
                overtimeAmount: Number(d.totals.overtimePay),
                totalAmount: totalDue,
              },
            })
          }
        >
          <FileSpreadsheet aria-hidden className="size-3.5" /> تصدير Excel
        </Button>
        {wa && (
          <Button variant="outline" size="sm" asChild>
            <a
              href={`${wa}?text=${encodeURIComponent(shareText)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Send aria-hidden className="size-3.5" /> مشاركة واتساب
            </a>
          </Button>
        )}
      </div>
    </CardHeader>
  );
}

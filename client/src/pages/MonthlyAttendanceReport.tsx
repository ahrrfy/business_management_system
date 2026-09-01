/* ============================================================================
 * تقرير الحضور الشهريّ لكل الموظفين (client/src/pages/MonthlyAttendanceReport.tsx)
 *
 * صفٌّ لكل موظف بالمجاميع — الصورة الشاملة قبل توليد المسيّر. يُبنى بنواة المسيّر
 * نفسها فلا ينحرف عن الكشف الفرديّ ولا عن ما يُدفع فعلاً.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { PageHeader } from "@/components/PageHeader";


import { exportRows } from "@/lib/export";
import { iqd } from "@/lib/hr/ui";
import { printMonthlyAttendance } from "@/lib/printing/printMonthlyAttendance";
import { trpc } from "@/lib/trpc";
import { CalendarDays, FileSpreadsheet, Printer, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const MONTH_NAMES = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];
function monthLabel(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}

/** رقم بمنزلتين وفواصل — تنسيقٌ موحّد لكل أعمدة الساعات. */
const h2 = (v: string | number) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function MonthlyAttendanceReport() {
  const [period, setPeriod] = useState(thisMonth());
  // فلتر الفرع — للمرتفعين العابرين للفروع فقط (الخادم يدعمه أصلاً؛ hr/READ لا يحمل عزل
  // فروعٍ لأيّ دور، فهذا تضييقٌ اختياريّ لا صلاحيةٌ جديدة، نظير AttendanceReport.tsx).
  const [branchId, setBranchId] = useState<number | "">("");
  const me = trpc.auth.me.useQuery();
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isElevated });
  // بحث محلّي (اسم/قسم/وظيفة) — الشهر كلّه محمَّلٌ أصلاً دفعة واحدة (كل الموظفين)، فلا حاجة
  // لبحثٍ خادميّ؛ يُصفّي الجدول فقط، والمجاميع أعلاه/بالتذييل تبقى مجموع الشهر كاملاً (لا تكذب).
  const [search, setSearch] = useState("");

  const q = trpc.attendance.monthlyReport.useQuery({ period, branchId: isElevated && branchId ? branchId : undefined });
  const d = q.data;
  const filteredRows = useMemo(() => {
    const t = search.trim();
    if (!t) return d?.rows ?? [];
    const norm = (s: string) => s.toLowerCase();
    const nt = norm(t);
    return (d?.rows ?? []).filter((r) =>
      norm(r.employeeName).includes(nt) || norm(r.department ?? "").includes(nt) || norm(r.position ?? "").includes(nt),
    );
  }, [d?.rows, search]);
  /**
   * أعمدة الحضور الشهريّ + ذيل المجاميع.
   * ⚠️ «المجموع (N موظفاً)» كان خليّةً مدموجة بـ`colSpan={3}`؛ الذيل هنا لكل عمود،
   * فالتسمية على العمود الأوّل والعمودان بعدها بلا ذيل — نفس المحاذاة بلا دمج.
   */
  const attendanceColumns = useMemo<ColumnDef<(typeof filteredRows)[number], unknown>[]>(() => [
    {
      id: "employee", header: "الموظف",
      accessorFn: (r) => r.employeeName,
      cell: ({ row }) => (
        <div>
          <Link href={`/hr/employees/${row.original.employeeId}`} className="font-medium hover:underline">{row.original.employeeName}</Link>
          {row.original.position && <div className="text-[11px] text-muted-foreground">{row.original.position}</div>}
        </div>
      ),
      footer: () => (d ? `المجموع (${d.totals.employees} موظفاً)` : null),
      meta: { kind: "text", wrap: true },
    },
    {
      id: "department", header: "القسم",
      accessorFn: (r) => r.department ?? "—",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.department ?? "—"}</span>,
      meta: { kind: "text" },
    },
    { id: "scheduledHours", header: "مقرَّر", accessorFn: (r) => Number(r.scheduledHours), cell: ({ row }) => h2(row.original.scheduledHours), meta: { kind: "number" } },
    {
      id: "payableHours", header: "مستحقّ",
      accessorFn: (r) => Number(r.payableHours),
      cell: ({ row }) => <span className="font-medium">{h2(row.original.payableHours)}</span>,
      footer: () => (d ? h2(d.totals.payableHours) : null),
      meta: { kind: "number" },
    },
    {
      id: "absentDays", header: "غياب",
      accessorFn: (r) => Number(r.absentDays),
      cell: ({ row }) => row.original.absentDays || "—",
      footer: () => (d ? (d.totals.absentDays || "—") : null),
      meta: { kind: "number" },
    },
    {
      id: "overtimeHours", header: "إضافيّ",
      accessorFn: (r) => Number(r.overtimeHours),
      cell: ({ row }) => Number(row.original.overtimeHours) > 0 ? h2(row.original.overtimeHours) : "—",
      footer: () => (d ? h2(d.totals.overtimeHours) : null),
      meta: { kind: "number" },
    },
    {
      id: "restWorkedHours", header: "يوم راحة",
      accessorFn: (r) => Number(r.restWorkedHours),
      cell: ({ row }) => Number(row.original.restWorkedHours) > 0 ? h2(row.original.restWorkedHours) : "—",
      footer: () => (d ? h2(d.totals.restWorkedHours) : null),
      meta: { kind: "number" },
    },
    { id: "hourlyRate", header: "سعر الساعة", accessorFn: (r) => Number(r.hourlyRate), cell: ({ row }) => iqd(row.original.hourlyRate), meta: { kind: "money" } },
    {
      id: "totalDue", header: "المستحقّ",
      accessorFn: (r) => Number(r.totalDue),
      cell: ({ row }) => (
        <div className="font-bold">
          {iqd(row.original.totalDue)}
          {/* الشهر المصروف (ق٣): الرقم من لقطة المسيّر — لا يتغيّر بترقيةٍ أو تصحيحٍ لاحق. */}
          {row.original.frozen ? (
            <div className="text-[10px] font-normal text-primary">من المسيّر (مجمَّد)</div>
          ) : (
            row.original.dueBasis !== "attendance" && (
              <div className="text-[10px] font-normal text-muted-foreground">
                {row.original.dueBasis === "exempt" ? "راتب ثابت (معفى)" : row.original.dueBasis === "hourly" ? "بالساعة" : "راتب ثابت"}
              </div>
            )
          )}
        </div>
      ),
      footer: () => (d ? <span className="font-bold">{iqd(d.totals.totalDue)}</span> : null),
      meta: { kind: "money" },
    },
    {
      id: "reviewDays", header: "تصحيح",
      accessorFn: (r) => Number(r.reviewDays),
      cell: ({ row }) => row.original.reviewDays > 0
        ? <span className="font-medium text-[var(--sem-warn)]">{row.original.reviewDays}</span>
        : "—",
      footer: () => (d ? (d.totals.reviewDays || "—") : null),
      meta: { kind: "number" },
    },
  ], [d]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="تقرير الحضور الشهريّ"
        description="صفٌّ لكل موظف — الساعات المقرَّرة والمستحقّة والغياب والإضافيّ والمستحقّ. يُحسب بنواة مسيّر الرواتب نفسها."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/attendance"><CalendarDays className="size-4" /> سجلّ الحضور</Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-3 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {/* منتقي شهرٍ بأسهم — بلا سقف ١٢ شهراً القديم (كان قائمة منسدلة لآخر ١٢ شهراً فقط،
                والخادم لا يفرض هذا الحدّ إطلاقاً). max=الشهر الجاري يمنع فتح شهرٍ مستقبليّ فارغ. */}
            <MonthPicker value={period} onChange={setPeriod} max={thisMonth()} ariaLabel="الشهر" />
            {isElevated && (
              <AppSelect
                aria-label="الفرع"
                className="h-9 w-40"
                value={branchId === "" ? "" : String(branchId)}
                onValueChange={(v) => setBranchId(v ? Number(v) : "")}
              >
                <option value="">كل الفروع</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </AppSelect>
            )}
            <Input
              className="h-9 w-56"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالاسم أو القسم أو الوظيفة…"
              aria-label="بحث في الجدول"
            />
            {d && (
              <span className="text-xs text-muted-foreground">
                {search.trim() ? `${filteredRows.length} من ${d.rows.length}` : `${d.totals.employees} موظفاً`}
                {d.totals.exempt > 0 ? ` · ${d.totals.exempt} معفى من الحضور` : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={!d || d.rows.length === 0}
              onClick={() => d && printMonthlyAttendance({ period: d.period, rows: d.rows as never, totals: d.totals })}
            >
              <Printer aria-hidden className="size-3.5" /> طباعة
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!d || d.rows.length === 0}
              onClick={() => d && exportRows(d.rows as any[], {
                filename: `تقرير الحضور الشهريّ ${d.period}`,
                title: `تقرير الحضور الشهريّ — ${monthLabel(d.period)}`,
                meta: [
                  { label: "الموظفون", value: String(d.totals.employees) },
                  { label: "ساعات مستحقّة", value: d.totals.payableHours },
                  { label: "العمل الإضافي", value: d.totals.overtimeHours },
                  { label: "أيام غياب", value: String(d.totals.absentDays) },
                ],
                columns: [
                  { key: "employeeName", header: "الموظف" },
                  { key: "position", header: "الوظيفة", map: (r: any) => r.position ?? "" },
                  { key: "department", header: "القسم", map: (r: any) => r.department ?? "" },
                  { key: "branchName", header: "الفرع", map: (r: any) => r.branchName ?? "" },
                  { key: "scheduledHours", header: "ساعات مقرَّرة" },
                  { key: "payableHours", header: "ساعات مستحقّة" },
                  { key: "unpaidHours", header: "ساعات غير مستحقّة" },
                  { key: "absentDays", header: "أيام غياب" },
                  { key: "unpaidLeaveDays", header: "إجازة بلا راتب" },
                  { key: "overtimeHours", header: "العمل الإضافي (ساعة)" },
                  { key: "restWorkedHours", header: "عمل يوم راحة (ساعة)" },
                  { key: "hourlyRate", header: "سعر الساعة", money: true },
                  { key: "basePay", header: "الأجر الأساس", money: true },
                  { key: "overtimePay", header: "أجر الإضافيّ", money: true },
                  { key: "totalDue", header: "المستحقّ", money: true },
                  // مصدرُ الرقم يرافقه في الملف: جدولٌ يخلط أرقاماً مجمَّدة بأخرى حيّة بلا
                  // تمييز يُقرأ كأنه صفٌّ واحد، وفرقُ شهرٍ مصروفٍ عن مسيّره يُقرأ خطأً.
                  {
                    key: "dueSource",
                    header: "مصدر الرقم",
                    map: (r: any) =>
                      r.frozen
                        ? "لقطة المسيّر (مجمَّد)"
                        : r.dueBasis === "exempt"
                          ? "راتب ثابت (معفى)"
                          : r.dueBasis === "hourly"
                            ? "أجرٌ بالساعة"
                            : r.dueBasis === "fixedSalary"
                              ? "راتب ثابت"
                              : "احتساب الحضور",
                  },
                  { key: "reviewDays", header: "أيام يحتاج تصحيح" },
                ],
                totalsRow: { totalDue: Number(d.totals.totalDue), overtimeHours: Number(d.totals.overtimeHours), absentDays: d.totals.absentDays },
              })}
            >
              <FileSpreadsheet aria-hidden className="size-3.5" /> تصدير Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {d && d.totals.withoutSchedule > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
          <span>
            <span className="font-medium text-[var(--sem-warn)]">{d.totals.withoutSchedule} موظفاً بلا جدول دوامٍ خاصّ</span> —
            يُحسبون على الجدول الاحتياطيّ. افتح بطاقة كلٍّ منهم واضبط ساعات أيامه وأسعارها.
          </span>
        </div>
      )}
      {d && d.totals.reviewDays > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
          <span>
            <span className="font-medium text-[var(--sem-warn)]">{d.totals.reviewDays} يوماً يحتاج تصحيح</span> عبر الموظفين —
            صحّحها من كشف كل موظف قبل اعتماد المسيّر.
          </span>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={attendanceColumns}
            data={filteredRows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText={search.trim() && (d?.rows.length ?? 0) > 0 ? "لا نتائج مطابقة للبحث." : "لا موظفين في هذا الشهر."}
          />
        </CardContent>
      </Card>
    </div>
  );
}

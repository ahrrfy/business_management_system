import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDate } from "@/lib/date";
import { EmpAvatar } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { LEAVE_STATUSES, LEAVE_TYPES, leaveStatusLabel } from "@shared/hr";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { selectClsSm } from "@/lib/ui/formStyles";


const STATUS_CLS: Record<string, string> = {
  approved: "badge-status-active",
  pending: "badge-status-pending",
  rejected: "badge-stock-out",
};

function LeaveStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}>
      {leaveStatusLabel(status)}
    </span>
  );
}

/** فرق الأيام شاملاً الطرفين (من ٨ إلى ٨ = يوم واحد). */
function daysBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  const a = new Date(from + "T00:00:00");
  const b = new Date(to + "T00:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

const today = () => new Date().toISOString().slice(0, 10);

const PAGE_SIZE = 25;

export default function Leaves() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  // فلاتر القائمة (منفصلة عن نموذج الطلب الجديد أدناه — تتشارك الاسم لولا هذا الفصل).
  const [empFilter, setEmpFilter] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [offset, setOffset] = useState(0);

  // نموذج الطلب الجديد
  const [employeeId, setEmployeeId] = useState("");
  const [leaveType, setLeaveType] = useState<string>(LEAVE_TYPES[0].key);
  const [fromDate, setFromDate] = useState(today());
  const [toDate, setToDate] = useState(today());
  const [reason, setReason] = useState("");

  const days = useMemo(() => daysBetween(fromDate, toDate), [fromDate, toDate]);

  const input = useMemo(
    () => ({
      status: (status || undefined) as never,
      type: (type || undefined) as never,
      employeeId: empFilter ? Number(empFilter) : undefined,
      from: filterFrom || undefined,
      to: filterTo || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [status, type, empFilter, filterFrom, filterTo, offset],
  );
  const list = trpc.leaves.list.useQuery(input);
  const balances = trpc.leaves.balances.useQuery();
  const empOpts = trpc.employees.formOptions.useQuery();

  // أي تغيير فلترٍ يعيد الترقيم إلى الصفحة الأولى — وإلا قد يفتح على صفحة خارج نطاق النتائج الجديدة.
  useEffect(() => setOffset(0), [status, type, empFilter, filterFrom, filterTo]);

  const rows = list.data?.rows ?? [];
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? rows.filter((l) => [l.employeeName, l.leaveType, l.reason, leaveStatusLabel(l.status)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : rows;
  }, [rows, query]);
  type LeaveRow = (typeof visibleRows)[number];
  type BalanceRow = NonNullable<(typeof balances)["data"]>[number];

  /** أعمدة أرصدة الإجازات — جدولٌ مُضمَّن في بطاقةٍ تحمل عنوانه وعدَّه. */
  const balanceColumns: ColumnDef<BalanceRow, unknown>[] = [
    {
      id: "name",
      header: "الموظف",
      accessorFn: (b) => b.name,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <EmpAvatar name={row.original.name} color={row.original.colorTag} photoUrl={row.original.photoUrl} sizePx={28} />
          <span className="font-medium">{row.original.name}</span>
        </div>
      ),
    },
    {
      id: "department",
      header: "القسم",
      accessorFn: (b) => b.department ?? "—",
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.department ?? "—"}</span>,
    },
    {
      id: "annual",
      header: "سنوية",
      accessorFn: (b) => b.annualLeaveBalance,
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => row.original.annualLeaveBalance,
    },
    {
      id: "sick",
      header: "مرضية",
      accessorFn: (b) => b.sickLeaveBalance,
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => row.original.sickLeaveBalance,
    },
  ];

  // مؤشّرات: قيد الموافقة، موافق عليها، أيام إجازة هذا الشهر — تُحسب خادمياً على كامل المجموعة
  // المفلترة (لا على الصفحة المعروضة وحدها) كي تبقى صحيحة عبر كل الصفحات.
  const kpiPending = list.data?.counts.pending ?? 0;
  const kpiApproved = list.data?.counts.approved ?? 0;
  const kpiMonthDays = list.data?.counts.monthDays ?? 0;

  const refresh = async () => {
    await Promise.all([utils.leaves.list.invalidate(), utils.leaves.balances.invalidate()]);
  };

  const create = trpc.leaves.create.useMutation({
    onSuccess: async () => {
      notify.ok("تم تقديم طلب الإجازة");
      setOpen(false);
      setEmployeeId("");
      setLeaveType(LEAVE_TYPES[0].key);
      setFromDate(today());
      setToDate(today());
      setReason("");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const decide = trpc.leaves.decide.useMutation({
    onSuccess: async (_d, vars) => {
      notify.ok(vars.decision === "approved" ? "تمت الموافقة على الإجازة" : "تم رفض الطلب");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const cancel = trpc.leaves.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغيت الإجازة واستُرِدّ الرصيد");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const submit = () => {
    if (!employeeId) { notify.warn("اختر الموظف"); return; }
    if (days <= 0) { notify.warn("نطاق التواريخ غير صالح"); return; }
    create.mutate({
      employeeId: Number(employeeId),
      leaveType: leaveType as never,
      fromDate,
      toDate,
      days,
      reason: reason.trim() || undefined,
    });
  };
  /**
   * أعمدة طلبات الإجازة — منقولة حرفياً.
   * ⚠️ «الموظف» هنا **موضوع** السجلّ لا فاعله (صاحب الإجازة)، فلا يُسمّى «نفّذها»:
   * الفاعل هو من وافق/رفض وهو غير معروضٍ في هذا الجدول (راجع حارس check:row-attribution).
   */
  const leaveColumns = useMemo<ColumnDef<LeaveRow, unknown>[]>(() => [
    {
      id: "employee", header: "الموظف",
      accessorFn: (l) => l.employeeName || "—",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <EmpAvatar name={row.original.employeeName} color={row.original.colorTag} photoUrl={row.original.photoUrl} sizePx={28} />
          <span className="font-medium">{row.original.employeeName || "—"}</span>
        </div>
      ),
      meta: { kind: "text", wrap: true },
    },
    {
      id: "leaveType", header: "النوع",
      accessorFn: (l) => l.leaveType,
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.leaveType}
          {!row.original.paid && <span className="text-muted-foreground"> · غير مدفوعة</span>}
        </span>
      ),
      meta: { kind: "text" },
    },
    { id: "fromDate", header: "من", accessorFn: (l) => String(l.fromDate ?? ""), cell: ({ row }) => fmtDate(row.original.fromDate), meta: { kind: "date" } },
    { id: "toDate", header: "إلى", accessorFn: (l) => String(l.toDate ?? ""), cell: ({ row }) => fmtDate(row.original.toDate), meta: { kind: "date" } },
    { id: "days", header: "الأيام", accessorFn: (l) => Number(l.days ?? 0), meta: { kind: "number" } },
    {
      id: "reason", header: "السبب",
      accessorFn: (l) => l.reason ?? "—",
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.reason ?? "—"}</span>,
      meta: { kind: "text", wrap: true },
    },
    {
      id: "status", header: "الحالة",
      accessorFn: (l) => l.status,
      cell: ({ row }) => <LeaveStatusBadge status={row.original.status} />,
      meta: { kind: "status" },
    },
    {
      id: "actions", header: "إجراء",
      cell: ({ row }) => {
        const l = row.original;
        return (
          <RowActions
            mode="inline"
            actions={[
              {
                key: "approve", kind: "approve", label: "موافقة",
                hidden: l.status !== "pending", disabled: decide.isPending,
                disabledReason: "توجد عملية قرار قيد التنفيذ",
                onSelect: () => void (async () => {
                  if (!(await confirm({ variant: "info", title: "الموافقة على الإجازة", description: `الموافقة على إجازة «${l.employeeName || "الموظف"}» (${l.days} يوم) وخصم رصيدها؟`, confirmText: "موافقة" }))) return;
                  decide.mutate({ id: l.id, decision: "approved" });
                })(),
                gate: { module: "hr", level: "FULL" },
              },
              {
                key: "reject", kind: "reverse", label: "رفض", variant: "destructive",
                hidden: l.status !== "pending", disabled: decide.isPending,
                disabledReason: "توجد عملية قرار قيد التنفيذ",
                onSelect: () => void (async () => {
                  if (!(await confirm({ variant: "warning", title: "رفض الطلب", description: `رفض طلب إجازة «${l.employeeName || "الموظف"}» (${l.days} يوم)؟`, confirmText: "رفض" }))) return;
                  decide.mutate({ id: l.id, decision: "rejected" });
                })(),
                gate: { module: "hr", level: "FULL" },
              },
              {
                key: "cancel", kind: "reverse", label: "إلغاء الإجازة", variant: "destructive",
                hidden: l.status !== "approved", disabled: cancel.isPending,
                disabledReason: "توجد عملية إلغاء قيد التنفيذ",
                onSelect: () => void (async () => {
                  if (!(await confirm({ variant: "danger", title: "إلغاء الإجازة", description: `إلغاء إجازة «${l.employeeName || "الموظف"}» (${l.days} يوم) واسترداد الأيام؟ يؤثّر على السجلّات.`, confirmText: "إلغاء الإجازة" }))) return;
                  cancel.mutate({ id: l.id });
                })(),
                gate: { module: "hr", level: "FULL" },
              },
            ]}
          />
        );
      },
      meta: { kind: "actions" },
    },
  ], [decide.isPending, cancel.isPending]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الإجازات"
        description="طلبات الإجازات وأرصدتها — سنوية، مرضية، أمومة، بدون راتب."
        actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" /> طلب إجازة جديد</Button>}
      />

      {/* المؤشّرات */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">طلبات قيد الموافقة</div><div className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">{kpiPending}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">موافق عليها</div><div className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">{kpiApproved}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">أيام إجازة هذا الشهر</div><div className="text-2xl font-bold mt-1 tabular-nums" dir="ltr">{kpiMonthDays}</div></CardContent></Card>
      </div>

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">الطلبات</TabsTrigger>
          <TabsTrigger value="balances">الأرصدة</TabsTrigger>
        </TabsList>

        {/* الطلبات */}
        <TabsContent value="requests">
          <Card>
            <CardHeader>
              <ListToolbar
                title="طلبات الإجازة"
                count={list.data?.total ?? visibleRows.length}
                loading={list.isLoading}
                search={{ value: query, onChange: setQuery, placeholder: "الموظف، النوع، السبب أو الحالة… (ضمن الصفحة الحالية)" }}
                activeFilterCount={(status ? 1 : 0) + (type ? 1 : 0) + (empFilter ? 1 : 0) + (filterFrom ? 1 : 0) + (filterTo ? 1 : 0)}
                onResetFilters={() => { setQuery(""); setStatus(""); setType(""); setEmpFilter(""); setFilterFrom(""); setFilterTo(""); }}
                onRefresh={() => void refresh()}
                refreshing={list.isFetching || balances.isFetching}
                onPrint={() => window.print()}
                exportSpec={{
                  filename: "طلبات-الإجازات",
                  rows: visibleRows,
                  formats: ["xlsx", "csv"],
                  columns: [
                    { key: "employeeName", header: "الموظف" }, { key: "leaveType", header: "النوع" },
                    { key: "fromDate", header: "من" }, { key: "toDate", header: "إلى" },
                    { key: "days", header: "الأيام" }, { key: "reason", header: "السبب" },
                    { key: "status", header: "الحالة", map: (l) => leaveStatusLabel(l.status) },
                  ],
                  // البحث النصّي محلّيٌّ (ضمن الصفحة المحمَّلة فقط) — تعذّر تعميمه خادمياً على كل
                  // الصفحات بلا مسّ leaveService.ts (خارج ملكية هذه الشريحة)؛ فحين يكون فارغاً
                  // نُصدِّر كل الصفحات المطابقة لبقية الفلاتر عبر fetchAllPaged.
                  fetchAll: query.trim()
                    ? undefined
                    : () =>
                        fetchAllPaged(
                          (off, lim) =>
                            utils.leaves.list
                              .fetch({ ...input, offset: off, limit: lim })
                              .then((r) => ({ rows: r.rows, total: r.total })),
                          { pageSize: 200 },
                        ),
                }}
                filters={<div className="flex items-end gap-2 flex-wrap">
                  <FilterField label="النوع">
                    <AppSelect className="h-9" value={type} onValueChange={(next) => setType(next)} aria-label="النوع">
                      <option value="">كل الأنواع</option>
                      {LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.key}</option>)}
                    </AppSelect>
                  </FilterField>
                  <FilterField label="الحالة">
                    <AppSelect className="h-9" value={status} onValueChange={(next) => setStatus(next)} aria-label="الحالة">
                      <option value="">كل الحالات</option>
                      {LEAVE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </AppSelect>
                  </FilterField>
                  <FilterField label="الموظف">
                    <AppSelect className="h-9" value={empFilter} onValueChange={(next) => setEmpFilter(next)} aria-label="الموظف">
                      <option value="">كل الموظفين</option>
                      {(empOpts.data?.managers ?? []).map((m) => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                    </AppSelect>
                  </FilterField>
                  <FilterField label="من تاريخ">
                    <Input type="date" dir="ltr" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} className="h-8 w-36" aria-label="من تاريخ" />
                  </FilterField>
                  <FilterField label="إلى تاريخ">
                    <Input type="date" dir="ltr" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} className="h-8 w-36" aria-label="إلى تاريخ" />
                  </FilterField>
                </div>}
              />
            </CardHeader>
            <CardContent className="p-0">
              <DataTable
                columns={leaveColumns}
                data={visibleRows}
                loading={list.isLoading}
                searchable={false}
                errorState={{ isError: list.isError, message: "تعذّر تحميل الطلبات.", onRetry: () => void list.refetch() }}
                emptyText="لا طلبات مطابقة. غيّر الفلاتر أو أضف طلباً جديداً."
                /*
                 * الترقيم خادميّ (offset/limit) ⇒ يجب إعلامُ DataTable.
                 * بدونه يظنّ الصفحةَ الحاضرة كاملَ البيانات فيُفعّل فرزاً يرتّب ٢٥ صفّاً فقط،
                 * فتُنتج الصفحةُ التالية شريحةً مفروزةً مستقلّة لا فرزاً شاملاً (Codex P2).
                 * ومع serverPagination بلا serverSorting يُعطّل DataTable الفرزَ من نفسه.
                 */
                serverPagination={{
                  page: Math.floor(offset / PAGE_SIZE),
                  onPageChange: (p) => setOffset(p * PAGE_SIZE),
                  pageSize: PAGE_SIZE,
                  total: list.data?.total,
                }}
              />
              {/* الترقيم يُصيّره DataTable نفسه عبر serverPagination — شريطٌ واحد لا اثنان. */}
            </CardContent>
          </Card>
        </TabsContent>

        {/* الأرصدة */}
        <TabsContent value="balances">
          <Card>
            <CardHeader><CardTitle className="text-base">أرصدة الإجازات <span className="text-muted-foreground font-normal">({balances.data?.length ?? 0})</span></CardTitle></CardHeader>
            <CardContent className="p-0">
              {/* مُضمَّن: البطاقة تحمل العنوان والعدّ ⇒ بلا شريط حالةٍ ولا بحثٍ ولا ترقيم. */}
              <DataTable<BalanceRow>
                embedded
                searchable={false}
                pageSize={Infinity}
                columns={balanceColumns}
                data={balances.data ?? []}
                loading={balances.isLoading}
                errorState={{ isError: balances.isError, message: "تعذّر تحميل الأرصدة.", onRetry: () => void balances.refetch() }}
                emptyText="لا موظفين على رأس العمل."
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* نافذة طلب إجازة جديد */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>طلب إجازة جديد</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="lv-emp">الموظف</Label>
              <AppSelect id="lv-emp" className={selectClsSm + " w-full h-9"} value={employeeId} onValueChange={(next) => setEmployeeId(next)}>
                <option value="">— اختر الموظف —</option>
                {(empOpts.data?.managers ?? []).map((m) => (
                  <option key={m.id} value={String(m.id)}>{m.name}{m.position ? ` — ${m.position}` : ""}</option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lv-type">نوع الإجازة</Label>
              <AppSelect id="lv-type" className={selectClsSm + " w-full h-9"} value={leaveType} onValueChange={(next) => setLeaveType(next)}>
                {LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.key}{t.paid ? "" : " (غير مدفوعة)"}</option>)}
              </AppSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="lv-from">من تاريخ</Label>
                <Input id="lv-from" type="date" dir="ltr" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="lv-to">إلى تاريخ</Label>
                <Input id="lv-to" type="date" dir="ltr" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              عدد الأيام: <span className="font-bold text-foreground tabular-nums" dir="ltr">{days}</span>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lv-reason">السبب (اختياري)</Label>
              <Textarea id="lv-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سفر عائلي، وعكة صحية…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button disabled={create.isPending || !employeeId || days <= 0} onClick={submit}>
              {create.isPending ? "جارٍ…" : "تقديم الطلب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

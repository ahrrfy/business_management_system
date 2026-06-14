import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmpAvatar } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { LEAVE_STATUSES, LEAVE_TYPES, leaveStatusLabel } from "@shared/hr";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_CLS: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
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
const thisMonthPrefix = () => new Date().toISOString().slice(0, 7); // YYYY-MM

export default function Leaves() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState(false);

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
    }),
    [status, type],
  );
  const list = trpc.leaves.list.useQuery(input);
  const balances = trpc.leaves.balances.useQuery();
  const empOpts = trpc.employees.formOptions.useQuery();

  const rows = list.data ?? [];

  // مؤشّرات: قيد الموافقة، موافق عليها، أيام إجازة هذا الشهر (تتقاطع مع الشهر الحالي).
  const monthPrefix = thisMonthPrefix();
  const kpiPending = rows.filter((l) => l.status === "pending").length;
  const kpiApproved = rows.filter((l) => l.status === "approved").length;
  const kpiMonthDays = rows
    .filter((l) => l.status === "approved" && (l.fromDate.startsWith(monthPrefix) || l.toDate.startsWith(monthPrefix)))
    .reduce((s, l) => s + (l.days ?? 0), 0);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">الإجازات</h1>
          <p className="text-sm text-muted-foreground">طلبات الإجازات وأرصدتها — سنوية، مرضية، أمومة، بدون راتب.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> طلب إجازة جديد</Button>
      </div>

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
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <CardTitle className="text-base">طلبات الإجازة <span className="text-muted-foreground font-normal">({rows.length})</span></CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <select className={selectCls} value={type} onChange={(e) => setType(e.target.value)} aria-label="النوع">
                    <option value="">كل الأنواع</option>
                    {LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.key}</option>)}
                  </select>
                  <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
                    <option value="">كل الحالات</option>
                    {LEAVE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-right">
                      <th className="p-2">الموظف</th>
                      <th className="p-2">النوع</th>
                      <th className="p-2">من</th>
                      <th className="p-2">إلى</th>
                      <th className="p-2 text-center">الأيام</th>
                      <th className="p-2">السبب</th>
                      <th className="p-2 text-center">الحالة</th>
                      <th className="p-2 text-center">إجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id} className="border-t hover:bg-accent/40">
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <EmpAvatar name={l.employeeName} color={l.colorTag} photoUrl={l.photoUrl} sizePx={28} />
                            <span className="font-medium">{l.employeeName || "—"}</span>
                          </div>
                        </td>
                        <td className="p-2 text-xs">{l.leaveType}{!l.paid && <span className="text-muted-foreground"> · غير مدفوعة</span>}</td>
                        <td className="p-2 text-xs tabular-nums" dir="ltr">{l.fromDate}</td>
                        <td className="p-2 text-xs tabular-nums" dir="ltr">{l.toDate}</td>
                        <td className="p-2 text-center tabular-nums" dir="ltr">{l.days}</td>
                        <td className="p-2 text-xs text-muted-foreground max-w-[200px] truncate">{l.reason ?? "—"}</td>
                        <td className="p-2 text-center"><LeaveStatusBadge status={l.status} /></td>
                        <td className="p-2 text-center">
                          {l.status === "pending" ? (
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                className="text-xs font-medium text-emerald-600 hover:underline disabled:opacity-50"
                                disabled={decide.isPending}
                                onClick={() => decide.mutate({ id: l.id, decision: "approved" })}
                              >موافقة</button>
                              <span className="text-border">·</span>
                              <button
                                className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
                                disabled={decide.isPending}
                                onClick={() => decide.mutate({ id: l.id, decision: "rejected" })}
                              >رفض</button>
                            </div>
                          ) : l.status === "approved" ? (
                            <button
                              className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
                              disabled={cancel.isPending}
                              onClick={() => { if (confirm("إلغاء الإجازة الموافق عليها واسترداد رصيدها؟")) cancel.mutate({ id: l.id }); }}
                            >إلغاء الإجازة</button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {list.isError && (
                      <tr><td colSpan={8} className="p-6 text-center text-rose-600">تعذّر تحميل الطلبات. <button className="underline" onClick={() => list.refetch()}>إعادة المحاولة</button></td></tr>
                    )}
                    {!list.isLoading && !list.isError && rows.length === 0 && (
                      <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا طلبات مطابقة. غيّر الفلاتر أو أضف طلباً جديداً.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* الأرصدة */}
        <TabsContent value="balances">
          <Card>
            <CardHeader><CardTitle className="text-base">أرصدة الإجازات <span className="text-muted-foreground font-normal">({balances.data?.length ?? 0})</span></CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-right">
                      <th className="p-2">الموظف</th>
                      <th className="p-2">القسم</th>
                      <th className="p-2 text-center">سنوية</th>
                      <th className="p-2 text-center">مرضية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(balances.data ?? []).map((b) => (
                      <tr key={b.id} className="border-t hover:bg-accent/40">
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <EmpAvatar name={b.name} color={b.colorTag} photoUrl={b.photoUrl} sizePx={28} />
                            <span className="font-medium">{b.name}</span>
                          </div>
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">{b.department ?? "—"}</td>
                        <td className="p-2 text-center tabular-nums" dir="ltr">{b.annualLeaveBalance}</td>
                        <td className="p-2 text-center tabular-nums" dir="ltr">{b.sickLeaveBalance}</td>
                      </tr>
                    ))}
                    {balances.isError && (
                      <tr><td colSpan={4} className="p-6 text-center text-rose-600">تعذّر تحميل الأرصدة. <button className="underline" onClick={() => balances.refetch()}>إعادة المحاولة</button></td></tr>
                    )}
                    {!balances.isLoading && !balances.isError && (balances.data?.length ?? 0) === 0 && (
                      <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">لا موظفين على رأس العمل.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
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
              <select id="lv-emp" className={selectCls + " w-full h-9"} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">— اختر الموظف —</option>
                {(empOpts.data?.managers ?? []).map((m) => (
                  <option key={m.id} value={String(m.id)}>{m.name}{m.position ? ` — ${m.position}` : ""}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lv-type">نوع الإجازة</Label>
              <select id="lv-type" className={selectCls + " w-full h-9"} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                {LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.key}{t.paid ? "" : " (غير مدفوعة)"}</option>)}
              </select>
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

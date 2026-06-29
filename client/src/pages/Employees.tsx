import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ListToolbar } from "@/components/list";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { EmpAvatar, EmploymentStatusBadge } from "@/lib/hr/ui";
import { CopyInline } from "@/components/CopyButton";
import { EMPLOYMENT_STATUSES, HR_DEPARTMENTS, employmentStatusLabel, fullEmployeeName, payTypeLabel } from "@shared/hr";
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// حسم النوع صراحةً (employees.list يُعيد {rows,total}) لتفادي فشل استدلال T في fetchAllPaged.
type Row = RouterOutputs["employees"]["list"]["rows"][number];

export default function Employees() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [department, setDepartment] = useState("");
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const limit = 50;

  const opts = trpc.employees.formOptions.useQuery();
  // مدخلات الفلترة فقط (بلا limit/offset) — تُعاد استعمالها في التصدير الشامل.
  const filterInput = useMemo(
    () => ({
      q: q.trim() || undefined,
      department: department || undefined,
      branchId: branchId ? Number(branchId) : undefined,
      status: (status || undefined) as never,
      includeInactive,
    }),
    [q, department, branchId, status, includeInactive],
  );
  const input = useMemo(
    () => ({ ...filterInput, limit, offset: page * limit }),
    [filterInput, page],
  );
  const list = trpc.employees.list.useQuery(input);

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">الموظفون</h1>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{ value: q, onChange: (v) => { setQ(v); setPage(0); }, placeholder: "بحث (اسم/هاتف/هوية/مسمى)" }}
            filters={
              <>
                <select className={selectCls} value={department} onChange={(e) => { setDepartment(e.target.value); setPage(0); }} aria-label="القسم">
                  <option value="">كل الأقسام</option>
                  {HR_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <select className={selectCls} value={branchId} onChange={(e) => { setBranchId(e.target.value); setPage(0); }} aria-label="الفرع">
                  <option value="">كل الفروع</option>
                  {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                </select>
                <select className={selectCls} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} aria-label="الحالة">
                  <option value="">كل الحالات</option>
                  {EMPLOYMENT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input type="checkbox" className="size-4" checked={includeInactive} onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }} />
                  <span className="text-muted-foreground">يشمل المعطّلين</span>
                </label>
              </>
            }
            exportSpec={{
              filename: "الموظفون",
              rows,
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, limit) =>
                    utils.employees.list
                      .fetch({ ...filterInput, limit, offset })
                      .then((r) => ({ rows: r.rows as Row[], total: r.total })),
                  { pageSize: 200 },
                ),
              columns: [
                { key: "fullName", header: "الاسم", map: (r) => r.fullName || fullEmployeeName(r) },
                { key: "position", header: "المسمى الوظيفي", map: (r) => r.position ?? "" },
                { key: "department", header: "القسم", map: (r) => r.department ?? "" },
                { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
                { key: "payType", header: "نوع الأجر", map: (r) => payTypeLabel(r.payType) },
                { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
                { key: "hireDate", header: "تاريخ المباشرة", map: (r) => (r.hireDate ? String(r.hireDate) : "") },
                { key: "employmentStatus", header: "الحالة", map: (r) => employmentStatusLabel(r.employmentStatus) },
              ],
            }}
            add={{ href: "/hr/employees/new", label: "موظف جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">الموظف</th>
                  <th className="p-2 text-start">القسم</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start">نوع الأجر</th>
                  <th className="p-2 text-start">الهاتف</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-start"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className={`border-t hover:bg-accent/50 cursor-pointer transition ${e.isActive ? "" : "opacity-60"}`} onClick={() => navigate(`/hr/employees/${e.id}`)}>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <EmpAvatar name={e.fullName} color={e.colorTag} photoUrl={e.photoUrl} sizePx={32} />
                        <div>
                          <div className="font-medium">{e.fullName}</div>
                          {e.position && <div className="text-xs text-muted-foreground">{e.position}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="p-2 text-xs">{e.department ?? "—"}</td>
                    <td className="p-2 text-xs">{e.branchName ?? "—"}</td>
                    <td className="p-2 text-xs">{payTypeLabel(e.payType)}</td>
                    <td className="p-2" onClick={(ev) => ev.stopPropagation()}><CopyInline value={e.phone} /></td>
                    <td className="p-2 text-center"><EmploymentStatusBadge status={e.employmentStatus} /></td>
                    <td className="p-2 text-muted-foreground"><ChevronLeft className="size-4" /></td>
                  </tr>
                ))}
                {!list.isLoading && rows.length === 0 && (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا موظفين مطابقين. غيّر الفلاتر أو أضف موظفاً جديداً.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
          <div className="text-muted-foreground">صفحة {page + 1} من {pages}</div>
          <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>التالي →</Button>
        </div>
      )}
    </div>
  );
}

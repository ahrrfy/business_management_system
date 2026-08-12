import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { FilterField, ListToolbar } from "@/components/list";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { EmpAvatar, EmploymentStatusBadge } from "@/lib/hr/ui";
import { CopyInline } from "@/components/CopyButton";
import { EMPLOYMENT_STATUSES, HR_DEPARTMENTS, employmentStatusLabel, fullEmployeeName, payTypeLabel } from "@shared/hr";
import { ChevronLeft, Fingerprint } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// حسم النوع صراحةً (employees.list يُعيد {rows,total}) لتفادي فشل استدلال T في fetchAllPaged.
type Row = RouterOutputs["employees"]["list"]["rows"][number];

export default function Employees() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  // فلاتر محفوظة في querystring (تعيش مع فتح بطاقة موظف والرجوع، وتُشارَك رابطاً).
  const [f, setF, resetF] = useUrlFilters({
    q: "", department: "", branchId: "", status: "", includeInactive: "",
  });
  const [page, setPage] = useState(0);
  const limit = 50;

  const opts = trpc.employees.formOptions.useQuery();
  /**
   * «منتهي الخدمة» موظفٌ isActive=false (setEmploymentStatus يطفئه دائماً) — والقائمة الافتراضية
   * تستثني غير النشطين. فلترةُ هذه الحالة بلا تفعيل includeInactive تُعيد صفراً كاذباً دائماً
   * (لا «لا يوجد منتهو خدمة» بل «القائمة لا تسمح لهم بالظهور أصلاً»).
   */
  function setStatus(v: string) {
    setF({ status: v, includeInactive: v === "terminated" ? "1" : f.includeInactive });
    setPage(0);
  }
  const includeInactive = f.includeInactive === "1";
  // مدخلات الفلترة فقط (بلا limit/offset) — تُعاد استعمالها في التصدير الشامل.
  const filterInput = useMemo(
    () => ({
      q: f.q.trim() || undefined,
      department: f.department || undefined,
      branchId: f.branchId ? Number(f.branchId) : undefined,
      status: (f.status || undefined) as never,
      includeInactive,
    }),
    [f.q, f.department, f.branchId, f.status, includeInactive],
  );
  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [f.department, f.branchId, f.status, includeInactive ? "1" : ""].filter(Boolean).length;
  useEffect(() => { setPage(0); }, [f.department, f.branchId, f.status, f.includeInactive]);
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
            search={{ value: f.q, onChange: (v) => { setF({ q: v }); setPage(0); }, placeholder: "بحث (اسم/هاتف/هوية/مسمى)" }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            filters={
              <>
                {/* FilterField يُظهر التسمية بصرياً — aria-label وحده لا يُرى (نمط PR #559/#566). */}
                <FilterField label="القسم">
                  <select className={selectCls} value={f.department} onChange={(e) => { setF({ department: e.target.value }); }} aria-label="القسم">
                    <option value="">كل الأقسام</option>
                    {HR_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </FilterField>
                <FilterField label="الفرع">
                  <select className={selectCls} value={f.branchId} onChange={(e) => { setF({ branchId: e.target.value }); }} aria-label="الفرع">
                    <option value="">كل الفروع</option>
                    {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                  </select>
                </FilterField>
                <FilterField label="الحالة">
                  <select className={selectCls} value={f.status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
                    <option value="">كل الحالات</option>
                    {EMPLOYMENT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </FilterField>
                <label className="flex items-center gap-2 h-8 text-sm self-end">
                  <input type="checkbox" className="size-4" checked={includeInactive} onChange={(e) => setF({ includeInactive: e.target.checked ? "1" : "" })} />
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
                { key: "deviceLinked", header: "مربوط بجهاز الحضور", map: (r) => (r.attendanceExempt ? "معفى" : r.deviceLinked ? "نعم" : "لا") },
              ],
            }}
            add={{ href: "/hr/employees/new", label: "موظف جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
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
                          <div className="font-medium flex items-center gap-1.5">
                            {e.fullName}
                            {/* بلا ربطٍ بجهاز الحضور لا تصل بصماته لسجل الحضور أصلاً — يُكتشف يوم الراتب بصفر ساعات. */}
                            {e.employmentStatus === "active" && !e.deviceLinked && !e.attendanceExempt && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] text-[var(--sem-warn)] font-normal"
                                title="لم يُربط برقم على جهاز الحضور — بصماته لن تُحتسب في الحضور ولا في الراتب"
                              >
                                <Fingerprint aria-hidden className="size-3" />
                                غير مربوط
                              </span>
                            )}
                          </div>
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
          </ScrollTableShell>
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

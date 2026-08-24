import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { FilterField, ListToolbar } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { EmpAvatar, EmploymentStatusBadge } from "@/lib/hr/ui";
import { CopyInline } from "@/components/CopyButton";
import { EMPLOYMENT_STATUSES, HR_DEPARTMENTS, employmentStatusLabel, fullEmployeeName, payTypeLabel } from "@shared/hr";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
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
  // مرآة بوّابة الخادم: `employees.create` = `hrWrite` (hr:FULL) — server/routers/employeeRouter.ts:154.
  // إخفاء زرّ «موظف جديد» على من لا يستطيع الحفظ (بدل رابطٍ يفتح ثمّ يُرفض عند submit).
  const me = trpc.auth.me.useQuery();
  const canCreate = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? null) as PermissionMap | null,
    "hr",
    "FULL",
    ["manager"],
  );
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
  // Codex P2 على PR #751 (نفس الفخّ هنا): تخفيضٌ في نتائج القائمة (تعطيلٌ يخرج صفوفاً، بحثٌ
  // يُقلّصها) دون تصفير `page` كان يُنتج «251–100 من 100» ويُظهر «مسح الفلاتر» مع `total > 0`.
  // نُصحّح إلى آخر صفحةٍ صالحة لا 0 (يحفظ نيّة كون المستخدم في نهاية القائمة). داخل useEffect
  // لأنّ `page` هنا `useState` (لا URL) — إعادة الضبط في التقديم (render) تُطلق تحذير React.
  useEffect(() => {
    if (list.data && page >= pages) setPage(Math.max(0, pages - 1));
  }, [list.data, page, pages]);
  const displayPage = Math.min(page, Math.max(0, pages - 1));

  return (
    <div className="space-y-4">
      <PageHeader
        title="الموظفون"
        description="قائمة الموظفين — الأقسام والفروع، نوع الأجر، ربط جهاز الحضور، والحالة الوظيفية."
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: f.q,
              onChange: (v) => { setF({ q: v }); setPage(0); },
              placeholder: "بحث (اسم/هاتف/هوية/مسمى)",
              autoFocus: true,
            }}
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
            add={canCreate ? { href: "/hr/employees/new", label: "موظف جديد" } : undefined}
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
                  <TableEmptyRow
                    colSpan={7}
                    message={
                      f.q || activeFilterCount > 0 ? (
                        <div className="space-y-2">
                          <div>لا موظفين مطابقين للفلاتر الحالية.</div>
                          <Button variant="outline" size="sm" onClick={() => { resetF(); setPage(0); }}>
                            مسح الفلاتر
                          </Button>
                        </div>
                      ) : canCreate ? (
                        "لا موظفين بعد. أضف أوّل موظف بزرّ «موظف جديد» أعلاه."
                      ) : (
                        "لا موظفين بعد."
                      )
                    }
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="text-muted-foreground">
            {pages > 1 ? (
              <>يعرض {(displayPage * limit + 1).toLocaleString("ar-IQ-u-nu-latn")}–
                {Math.min((displayPage + 1) * limit, total).toLocaleString("ar-IQ-u-nu-latn")} من
                {" "}
                {total.toLocaleString("ar-IQ-u-nu-latn")} موظف</>
            ) : (
              <>الإجمالي: {total.toLocaleString("ar-IQ-u-nu-latn")} موظف</>
            )}
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={displayPage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← السابق</Button>
              <div className="text-muted-foreground">صفحة {displayPage + 1} من {pages}</div>
              <Button variant="outline" size="sm" disabled={displayPage >= pages - 1} onClick={() => setPage((p) => p + 1)}>التالي →</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

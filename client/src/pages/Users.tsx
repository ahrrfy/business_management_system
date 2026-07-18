import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

export const ROLE_OPTIONS = [
  { value: "admin",          label: "مدير النظام" },
  { value: "manager",        label: "مدير فرع" },
  { value: "accountant",     label: "محاسب" },
  { value: "cashier",        label: "كاشير" },
  { value: "warehouse",      label: "أمين مخزن" },
  { value: "purchasing",     label: "مسؤول مشتريات" },
  { value: "print_operator", label: "فني مطبعة" },
  { value: "sales_rep",      label: "مندوب مبيعات" },
  { value: "auditor",        label: "مدقّق" },
  { value: "courier",        label: "مندوب توصيل" },
  { value: "user",           label: "مستخدم عام" },
] as const;

export const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLE_OPTIONS.map((o) => [o.value, o.label]),
);

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** ملصق لوني للدور */
function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin:          "bg-red-100 text-red-700",
    manager:        "bg-purple-100 text-purple-700",
    accountant:     "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
    cashier:        "bg-emerald-100 text-emerald-700",
    warehouse:      "bg-amber-100 text-amber-700",
    purchasing:     "bg-orange-100 text-orange-700",
    print_operator: "bg-cyan-100 text-cyan-700",
    sales_rep:      "bg-teal-100 text-teal-700",
    auditor:        "bg-muted text-foreground",
    courier:        "bg-lime-100 text-lime-700",
    user:           "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[role] ?? "bg-muted text-muted-foreground"}`}>
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

export default function Users() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const limit = 50;

  const input = useMemo(
    () => ({
      q: q.trim() || undefined,
      role: role || undefined,
      includeInactive,
      limit,
      offset: page * limit,
    }),
    [q, role, includeInactive, page],
  );

  const list = trpc.users.list.useQuery(input);
  const branches = trpc.branches.list.useQuery();
  const branchName = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of branches.data ?? []) m.set(Number(b.id), b.name);
    return m;
  }, [branches.data]);

  const setActive = trpc.users.setActive.useMutation({
    onSuccess: () => utils.users.list.invalidate(),
    onError: (e) => setErr(e.message),
  });
  const [err, setErr] = useState("");

  const total = list.data?.total ?? 0;
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(total / limit));

  async function toggle(id: number, isActive: boolean, name: string, email: string) {
    setErr("");
    if (isActive) {
      if (!(await confirm({
        variant: "danger",
        title: "تعطيل المستخدم",
        description: `لن يستطيع «${name || email}» الدخول وتُبطَل جلساته فوراً. هل تتابع؟`,
        confirmText: "تعطيل",
      }))) return;
    }
    setActive.mutate({ userId: id, isActive: !isActive });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="المستخدمون"
        description="إدارة مستخدمي النظام وأدوارهم وفروعهم: إضافة، تعديل، تعطيل/تفعيل، وإعادة تعيين كلمة المرور."
      />

      {err && <p className="text-sm text-destructive">{err}</p>}

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => { setQ(v); setPage(0); },
              placeholder: "بحث (اسم/بريد/هاتف)",
            }}
            filters={
              <>
                <select
                  className={selectCls}
                  value={role}
                  onChange={(e) => { setRole(e.target.value); setPage(0); }}
                  aria-label="الدور"
                >
                  <option value="">كل الأدوار</option>
                  {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input type="checkbox" className="size-4" checked={includeInactive}
                    onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }} />
                  <span className="text-muted-foreground">عرض المعطّلين</span>
                </label>
              </>
            }
            add={{ href: "/users/new", label: "مستخدم جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">الاسم</th>
                <th className="p-2">معرّف الدخول</th>
                <th className="p-2">الدور</th>
                <th className="p-2">الفرع</th>
                <th className="p-2">آخر دخول</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const id = Number(u.id);
                const isActive = !!u.isActive;
                const mustChange = !!(u as any).mustChangePassword;
                return (
                  <tr key={id} className={`border-t ${isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">
                      {u.name ?? "—"}
                      {mustChange && <span className="me-1 inline-flex text-amber-600" title="إلزام تغيير كلمة المرور"><AlertTriangle aria-hidden className="size-3.5" /></span>}
                    </td>
                    <td className="p-2 font-mono text-xs" dir="ltr">
                      {(u as { username?: string | null }).username
                        ? <div>{(u as { username?: string | null }).username}</div>
                        : null}
                      {u.email ? <div className="text-muted-foreground">{u.email}</div> : null}
                      {!(u as { username?: string | null }).username && !u.email ? "—" : null}
                    </td>
                    <td className="p-2"><RoleBadge role={u.role} /></td>
                    <td className="p-2 text-xs">{u.branchId ? (branchName.get(Number(u.branchId)) ?? `#${Number(u.branchId)}`) : "—"}</td>
                    <td className="p-2 text-xs" dir="ltr">{fmtDate(u.lastSignedIn)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", href: `/users/${id}/edit` },
                          { key: "reset", label: "إعادة تعيين كلمة المرور", href: `/users/${id}/edit` },
                          {
                            key: "toggle",
                            label: isActive ? "تعطيل" : "تفعيل",
                            variant: isActive ? "destructive" : "default",
                            disabled: setActive.isPending,
                            onSelect: () => void toggle(id, isActive, u.name ?? "", u.email ?? ""),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {list.isError && (
                <tr><td colSpan={7} className="p-0"><ErrorState message="تعذّر تحميل المستخدمين." onRetry={() => list.refetch()} /></td></tr>
              )}
              {!list.isLoading && !list.isError && rows.length === 0 && (
                <TableEmptyRow colSpan={7} message="لا مستخدمين مطابقين." />
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

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ListToolbar, RowActions } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";

export const ROLE_OPTIONS = [
  { value: "admin", label: "مدير النظام" },
  { value: "manager", label: "مدير" },
  { value: "cashier", label: "كاشير" },
  { value: "warehouse", label: "مخزن" },
  { value: "user", label: "مستخدم" },
] as const;
export const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLE_OPTIONS.map((o) => [o.value, o.label]),
);

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("ar-IQ-u-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export default function Users() {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [role, setRole] = useState<"" | (typeof ROLE_OPTIONS)[number]["value"]>("");
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
      <h1 className="text-2xl font-bold">المستخدمون</h1>
      <p className="text-sm text-muted-foreground">
        إدارة مستخدمي النظام وأدوارهم وفروعهم: إضافة، تعديل، تعطيل/تفعيل، وإعادة تعيين كلمة المرور.
      </p>

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
                  onChange={(e) => { setRole(e.target.value as any); setPage(0); }}
                  aria-label="الدور"
                >
                  <option value="">كل الأدوار</option>
                  {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input type="checkbox" className="size-4" checked={includeInactive} onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }} />
                  <span className="text-muted-foreground">عرض المعطّلين</span>
                </label>
              </>
            }
            add={{ href: "/users/new", label: "مستخدم جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الاسم</th>
                <th className="p-2">البريد</th>
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
                return (
                  <tr key={id} className={`border-t ${isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{u.name ?? "—"}</td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{u.email ?? "—"}</td>
                    <td className="p-2 text-xs">{ROLE_LABEL[u.role] ?? u.role}</td>
                    <td className="p-2 text-xs">{u.branchId ? (branchName.get(Number(u.branchId)) ?? `#${Number(u.branchId)}`) : "—"}</td>
                    <td className="p-2 text-xs" dir="ltr">{fmtDate(u.lastSignedIn)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                        {isActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٣ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً (إسقاط inline مقصود) */}
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", href: `/users/${id}/edit` },
                          // إعادة التعيين تتم من شاشة التعديل نفسها (قسم كلمة المرور فيها)
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
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا مستخدمين مطابقين. أضف مستخدماً جديداً أو غيّر الفلاتر.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ← السابق
          </Button>
          <div className="text-muted-foreground">صفحة {page + 1} من {pages}</div>
          <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            التالي →
          </Button>
        </div>
      )}
    </div>
  );
}

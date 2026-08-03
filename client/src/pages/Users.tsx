import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ListToolbar, RowActions } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, TableEmptyRow, TableSkeleton } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { ROLE_LABEL, ROLE_OPTIONS } from "@/lib/roles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { POS_STATION_LABEL, type PosStation } from "@shared/permissions";

type Row = RouterOutputs["users"]["list"]["rows"][number];

/** شارة «القسم الفعليّ» — ما سيفتحه الحساب فعلاً في نقطة البيع (طبقة الشفافية ش١، محسوب خادمياً). */
function StationBadge({ station }: { station?: PosStation | "MULTI" | "NONE" }) {
  if (!station || station === "NONE") return <span className="text-muted-foreground text-xs">—</span>;
  const cls: Record<string, string> = {
    RETAIL: "bg-emerald-100 text-emerald-700",
    PRINT_SERVICES: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
    RECEPTION: "bg-violet-100 text-violet-700",
    MULTI: "bg-muted text-foreground",
  };
  const label = station === "MULTI" ? "متعدّد الأقسام" : POS_STATION_LABEL[station];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls[station]}`}>{label}</span>;
}

/** نصّ التصدير للقسم الفعليّ — نفس منطق StationBadge بلا تنسيق. */
function stationExportLabel(station?: PosStation | "MULTI" | "NONE"): string {
  if (!station || station === "NONE") return "—";
  return station === "MULTI" ? "متعدّد الأقسام" : POS_STATION_LABEL[station];
}

/** ملصق لوني للدور — الدور المخصّص يُعرض بتسميته الحقيقية (لا فئته الأساس) مع تمييز بصري.
 *  فجوة صدق الدور (٢٤/٧): «كاشير طباعة» كان يظهر «كاشير» فيبدو سلوك النظام غير منطقي.
 *  hasOverride: تخصيص فردي (permissionsOverride) بلا دور مخصّص ⇒ لاحقة «مُخصَّص» — الشكوى نفسها
 *  تتكرر حرفياً لو حُصر الحساب بالمصفوفة اليدوية بدل دور مخصّص وظلّت شارته «كاشير» مجرّدة. */
export function RoleBadge({ role, customRoleLabel, hasOverride, isOwner }: { role: string; customRoleLabel?: string | null; hasOverride?: boolean; isOwner?: boolean }) {
  if (isOwner) {
    return (
      <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-200 text-amber-900">
        مالك النظام
      </span>
    );
  }
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
  if (customRoleLabel) {
    return (
      <span
        className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700"
        title={`دور مخصّص — الفئة الأساس: ${ROLE_LABEL[role] ?? role}`}
      >
        {customRoleLabel}
      </span>
    );
  }
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[role] ?? "bg-muted text-muted-foreground"}`}
      title={hasOverride ? "صلاحيات معدَّلة يدوياً عن قالب الدور" : undefined}
    >
      {ROLE_LABEL[role] ?? role}
      {hasOverride ? <span className="opacity-70"> · مُخصَّص</span> : null}
    </span>
  );
}

export default function Users() {
  const utils = trpc.useUtils();

  // فلاتر الشاشة محفوظة في الرابط (useUrlFilters) — تعيش مع فتح التفاصيل والرجوع، وقابلة
  // للمشاركة. كل القيم نصوص (اتفاقية الهوك)؛ نشتقّ الأنواع الفعلية أدناه. customRoleId هنا أيضاً
  // (كان يُقرأ من useSearch مستقلاً) — توحيدٌ يتيح لزرّ «مسح الفلاتر» تفريغه مع البقية.
  const [f, setF, resetF] = useUrlFilters({
    q: "", role: "", branchId: "", inactive: "", customRoleId: "", page: "0",
  });
  const q = f.q;
  const role = f.role;
  const branchId = f.branchId;
  const includeInactive = f.inactive === "1";
  const customRoleId = useMemo(() => {
    const n = f.customRoleId ? Number(f.customRoleId) : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }, [f.customRoleId]);
  const page = Number(f.page) || 0;
  const limit = 50;
  function setPage(updater: number | ((p: number) => number)) {
    const next = typeof updater === "function" ? updater(page) : updater;
    setF({ page: String(Math.max(0, next)) });
  }

  // مدخلات الفلترة المشتركة (بلا limit/offset) — للقائمة وللتصدير الشامل، فلا يخالف المُصدَّر ما
  // على الشاشة.
  const filterInput = useMemo(
    () => ({
      q: q.trim() || undefined,
      role: role || undefined,
      customRoleId,
      branchId: branchId ? Number(branchId) : undefined,
      includeInactive,
    }),
    [q, role, customRoleId, branchId, includeInactive],
  );

  const list = trpc.users.list.useQuery({ ...filterInput, limit, offset: page * limit });
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
  const activeFilterCount = [role, branchId, includeInactive ? "1" : "", customRoleId ? "1" : ""].filter(Boolean).length;

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
      {customRoleId != null && (
        <p className="text-xs text-muted-foreground">
          القائمة مفلترة بمستخدمي دورٍ مخصّص محدّد —{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => { setF({ customRoleId: "" }); setPage(0); }}
          >
            إزالة الفلتر
          </button>
        </p>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => { setF({ q: v }); setPage(0); },
              placeholder: "بحث (اسم/بريد/هاتف)",
            }}
            filters={
              <>
                <AppSelect
                  size="sm"
                  value={role || "ALL"}
                  onValueChange={(v) => { setF({ role: v === "ALL" ? "" : v }); setPage(0); }}
                  aria-label="الدور"
                  className="h-8 w-auto min-w-32"
                >
                  <option value="ALL">كل الأدوار</option>
                  {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </AppSelect>
                <AppSelect
                  size="sm"
                  value={branchId || "ALL"}
                  onValueChange={(v) => { setF({ branchId: v === "ALL" ? "" : v }); setPage(0); }}
                  aria-label="الفرع"
                  className="h-8 w-auto min-w-32"
                >
                  <option value="ALL">كل الفروع</option>
                  {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                </AppSelect>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input type="checkbox" className="size-4" checked={includeInactive}
                    onChange={(e) => { setF({ inactive: e.target.checked ? "1" : "" }); setPage(0); }} />
                  <span className="text-muted-foreground">عرض المعطّلين</span>
                </label>
              </>
            }
            activeFilterCount={activeFilterCount}
            onResetFilters={() => resetF()}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "المستخدمون",
              rows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "name", header: "الاسم" },
                { key: "username", header: "معرّف الدخول", map: (u: Row) => (u as { username?: string | null }).username || u.email || "" },
                { key: "role", header: "الدور", map: (u: Row) => u.customRoleLabel ?? ROLE_LABEL[u.role] ?? u.role },
                { key: "effectiveStation", header: "القسم الفعليّ", map: (u: Row) => stationExportLabel((u as { effectiveStation?: PosStation | "MULTI" | "NONE" }).effectiveStation) },
                { key: "branchId", header: "الفرع", map: (u: Row) => u.branchId ? (branchName.get(Number(u.branchId)) ?? `#${Number(u.branchId)}`) : "" },
                { key: "lastSignedIn", header: "آخر دخول", map: (u: Row) => fmtDate(u.lastSignedIn) },
                { key: "isActive", header: "الحالة", map: (u: Row) => (u.isActive ? "مفعّل" : "معطّل") },
              ],
              // تصدير كل النتائج المطابقة للفلاتر (لا الصفحة المعروضة فقط) — نفس filterInput حتماً.
              // (ListToolbar يتكفّل بمؤشّر «جارٍ التحضير…» داخلياً — لا حاجة لحالة محلية هنا.)
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, lim) =>
                    utils.users.list.fetch({ ...filterInput, limit: lim, offset }).then((r) => ({ rows: r.rows as Row[], total: r.total })),
                  { pageSize: 500 },
                ),
            }}
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
                <th className="p-2">القسم الفعليّ</th>
                <th className="p-2">الفرع</th>
                <th className="p-2">آخر دخول</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && <TableSkeleton rows={8} cols={8} />}
              {!list.isLoading && rows.map((u) => {
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
                    <td className="p-2">
                      <RoleBadge
                        role={u.role}
                        customRoleLabel={u.customRoleLabel}
                        hasOverride={Object.keys((u.permissionsOverride as Record<string, string> | null) ?? {}).length > 0}
                        isOwner={!!(u as any).isOwner}
                      />
                    </td>
                    <td className="p-2"><StationBadge station={(u as { effectiveStation?: PosStation | "MULTI" | "NONE" }).effectiveStation} /></td>
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
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل",
                            href: `/users/${id}/edit`,
                            gate: { adminOnly: true },
                          },
                          {
                            key: "reset",
                            kind: "edit",
                            label: "إعادة تعيين كلمة المرور",
                            href: `/users/${id}/edit`,
                            gate: { adminOnly: true },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: isActive ? "تعطيل" : "تفعيل",
                            variant: isActive ? "destructive" : "default",
                            disabled: setActive.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            onSelect: () => void toggle(id, isActive, u.name ?? "", u.email ?? ""),
                            gate: { adminOnly: true },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {list.isError && (
                <tr><td colSpan={8} className="p-0"><ErrorState message="تعذّر تحميل المستخدمين." onRetry={() => list.refetch()} /></td></tr>
              )}
              {!list.isLoading && !list.isError && rows.length === 0 && (
                <TableEmptyRow colSpan={8} message="لا مستخدمين مطابقين." />
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

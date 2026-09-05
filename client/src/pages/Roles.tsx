import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions } from "@/components/list/RowActions";
import { ListToolbar } from "@/components/list/ListToolbar";
import { FilterField } from "@/components/list/FilterField";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { ROLES } from "@/lib/permissionsModel";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { Link } from "wouter";
import { useMemo } from "react";

const roleLabel = (key: string) => ROLES.find((r) => r.key === key)?.label ?? key;

/** صفُّ الدور المخصّص — مشتقٌّ من عقد `roles.list` فلا ينجرف عن الخادم. */
type CustomRoleRow = RouterOutputs["roles"]["list"]["custom"][number];

export default function Roles() {
  const utils = trpc.useUtils();
  const list = trpc.roles.list.useQuery({ includeInactive: true });
  const setActive = trpc.roles.setActive.useMutation({ onSuccess: () => utils.roles.list.invalidate() });
  const remove = trpc.roles.remove.useMutation({ onSuccess: () => utils.roles.list.invalidate() });

  const builtin = list.data?.builtin ?? [];
  const custom = list.data?.custom ?? [];
  const counts = list.data?.counts ?? {};

  // فلاتر الشاشة محفوظة في الرابط (useUrlFilters) — نمط Users.tsx نفسه. status: ""=الكل،
  // "active"=نشط، "inactive"=معطَّل. قائمة الأدوار المخصّصة تُجلب دائماً كاملةً (includeInactive)
  // فالفلترة محلية بحتة (لا استعلام إضافي).
  const [f, setF, resetF] = useUrlFilters({ q: "", status: "" });
  const query = f.q;
  const status = f.status;
  const visibleCustom = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return custom.filter((r) => {
      if (status === "active" && !r.isActive) return false;
      if (status === "inactive" && r.isActive) return false;
      if (!q) return true;
      return [r.label, r.description, roleLabel(r.baseRole)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q));
    });
  }, [custom, query, status]);
  const activeFilterCount = status ? 1 : 0;

  async function doDelete(id: number, label: string, count: number) {
    if (count > 0) return;
    if (!(await confirm({ variant: "danger", title: "حذف الدور", description: `حذف الدور «${label}» نهائياً؟`, confirmText: "حذف" }))) return;
    remove.mutate({ id });
  }

  // طباعة A4 بهوية المستند بدل window.print() (كان يطبع الشاشة بشريط الأدوات وقوائم الإجراءات).
  // الصفوف هي المعروضة نفسها (visibleCustom بعد البحث والفلتر) بلا استعلامٍ جديد، وبطاقة
  // «الأدوار المبنية» تبقى في المستند (كانت تُطبَع مع الصفحة) بوصفها مرجعاً لا جدولاً ثانياً.
  function printRoles() {
    printReportDoc({
      title: "الأدوار المخصّصة",
      headerExtra: [
        { label: "عدد الأدوار", value: visibleCustom.length.toLocaleString("ar-IQ-u-nu-latn") },
        { label: "الحالة", value: status === "active" ? "نشط" : status === "inactive" ? "معطَّل" : "الكل" },
        { label: "البحث", value: query.trim() || "بلا بحث" },
      ],
      columns: [
        { key: "label", label: "الاسم" },
        { key: "baseRole", label: "الفئة الأساسية" },
        { key: "users", label: "مستخدمون", align: "center" },
        { key: "status", label: "الحالة", align: "center" },
      ],
      rows: visibleCustom.map((r) => ({
        // الوصف يظهر سطراً ثانياً تحت الاسم في خليّة الشاشة — يبقى ملازماً له على الورق.
        label: `${r.label}${r.description ? ` — ${r.description}` : ""}`,
        baseRole: `${roleLabel(r.baseRole)}${r.canSeeCost ? " · يرى التكلفة" : ""}`,
        users: String(counts[Number(r.id)] ?? 0),
        status: r.isActive ? "مفعّل" : "معطّل",
      })),
      meta: builtin.length
        ? [
            {
              title: "الأدوار المبنية في النظام (للقراءة)",
              fields: builtin.map((r) => ({
                label: `${r.label}${r.canSeeCost ? " · يرى التكلفة" : ""}`,
                value: r.description ?? "—",
              })),
            },
          ]
        : undefined,
      emptyText: "لا أدوار مطابقة للبحث أو الفلتر.",
    });
  }

  // الأعمدة داخل المكوّن: تعتمد على `counts` وعلى حالة الطفرتين (تعطيل الإجراء أثناء التنفيذ).
  const columns = useMemo<ColumnDef<CustomRoleRow, unknown>[]>(
    () => [
      {
        id: "label",
        header: "الاسم",
        accessorFn: (r) => r.label,
        meta: { width: "wide" },
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.label}</div>
            {row.original.description ? <div className="text-[11px] text-muted-foreground">{row.original.description}</div> : null}
          </div>
        ),
      },
      {
        id: "baseRole",
        header: "الفئة الأساسية",
        accessorFn: (r) => roleLabel(r.baseRole) + (r.canSeeCost ? " · يرى التكلفة" : ""),
        cell: ({ row }) => (
          <span className="text-xs">
            {roleLabel(row.original.baseRole)}
            {row.original.canSeeCost ? " · يرى التكلفة" : ""}
          </span>
        ),
      },
      {
        id: "users",
        header: "مستخدمون",
        accessorFn: (r) => counts[Number(r.id)] ?? 0,
        meta: { kind: "number", align: "center" },
        cell: ({ row }) => {
          const id = Number(row.original.id);
          const count = counts[id] ?? 0;
          return count > 0 ? (
            <Link
              href={"/users?customRoleId=" + id}
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
              title="عرض المستخدمين المُسنَد لهم هذا الدور"
            >
              {count}
            </Link>
          ) : (
            count
          );
        },
      },
      {
        id: "status",
        header: "الحالة",
        // التسمية المعروضة لا العلَم الخامّ: «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
        accessorFn: (r) => (r.isActive ? "مفعّل" : "معطّل"),
        meta: { kind: "status" },
        cell: ({ row }) => {
          const active = !!row.original.isActive;
          return (
            <span className={"inline-block rounded-full px-2 py-0.5 text-xs " + (active ? "badge-status-active" : "badge-stock-out")}>
              {active ? "مفعّل" : "معطّل"}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "إجراء",
        meta: { kind: "actions" },
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          const id = Number(r.id);
          const count = counts[id] ?? 0;
          const active = !!r.isActive;
          return (
            <RowActions
              mode="menu"
              actions={[
                { key: "edit", kind: "edit", label: "تعديل", href: "/roles/" + id + "/edit", gate: { adminOnly: true } },
                {
                  key: "toggle",
                  kind: "approve",
                  label: active ? "تعطيل" : "تفعيل",
                  gate: { adminOnly: true },
                  disabled: setActive.isPending,
                  disabledReason: "جارٍ تحديث الدور",
                  onSelect: async () => {
                    if (!(await confirm({ variant: "warning", title: active ? "تعطيل الدور" : "تفعيل الدور", description: active ? "الأدوار المعطَّلة لا يمكن إسنادها لمستخدمين جدد. متابعة؟" : "تفعيل هذا الدور لإتاحته للإسناد. متابعة؟", confirmText: active ? "تعطيل" : "تفعيل" }))) return;
                    setActive.mutate({ id, isActive: !active });
                  },
                },
                {
                  key: "delete",
                  kind: "delete",
                  label: "حذف",
                  variant: "destructive",
                  gate: { adminOnly: true },
                  disabled: count > 0 || remove.isPending,
                  disabledReason: count > 0 ? "مُسنَد لمستخدمين — غيّر أدوارهم أولاً" : "جارٍ حذف الدور",
                  onSelect: () => void doDelete(id, r.label, count),
                },
              ]}
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts, setActive.isPending, remove.isPending],
  );

  return (
    <div className="space-y-4 max-w-5xl">
      <PageHeader
        title="الأدوار والصلاحيات"
        description="أدوار النظام المبنية + أدوار مخصّصة تصنعها بنفسك بصلاحيات محفوظة."
        actions={<Link href="/roles/new"><Button>+ إضافة دور مخصّص</Button></Link>}
      />

      {/* الأدوار المخصّصة */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="الأدوار المخصّصة"
            count={visibleCustom.length}
            loading={list.isLoading}
            search={{ value: query, onChange: (v) => setF({ q: v }), placeholder: "اسم الدور أو الفئة الأساسية…" }}
            filters={
              <FilterField label="الحالة">
                <AppSelect
                  size="sm"
                  value={status || "ALL"}
                  onValueChange={(v) => setF({ status: v === "ALL" ? "" : v })}
                  aria-label="الحالة"
                  className="h-8 w-auto min-w-28"
                >
                  <option value="ALL">الكل</option>
                  <option value="active">نشط</option>
                  <option value="inactive">معطَّل</option>
                </AppSelect>
              </FilterField>
            }
            activeFilterCount={activeFilterCount}
            onResetFilters={() => resetF()}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={printRoles}
            exportSpec={{
              filename: "الأدوار-المخصصة",
              rows: visibleCustom,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "label", header: "الدور" },
                { key: "baseRole", header: "الفئة الأساسية", map: (r) => roleLabel(r.baseRole) },
                { key: "description", header: "الوصف" },
                { key: "isActive", header: "الحالة", map: (r) => r.isActive ? "مفعّل" : "معطّل" },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CustomRoleRow>
            columns={columns}
            data={visibleCustom}
            /* البحث في ListToolbar أعلاه (يغذّي visibleCustom) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            /* بلا ترقيم: القائمة بياناتٌ مرجعية محدودة، والحاويةُ المحبوسة تُمرِّرها بترويسةٍ
               لاصقة. (الطباعة لم تعُد تقرأ DOM بعد التحوّل إلى `printReportDoc` — تبني
               المستند من `visibleCustom` كاملةً ⇒ لا اقتطاع صامت أياً كان الترقيم. يبقى
               `Infinity` قراراً عرضياً قائماً بذاته، ولم يُمَسّ.) */
            pageSize={Infinity}
            externalFiltersActive={query.trim() !== "" || status !== ""}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            getRowClassName={(r) => (r.isActive ? undefined : "opacity-60")}
            emptyText="لا أدوار مخصّصة بعد — أضِف دوراً جديداً بصلاحيات حسب حاجتك."
            emptyFilteredState="لا أدوار مطابقة للبحث أو الفلتر."
          />
        </CardContent>
      </Card>

      {/* الأدوار المبنية (للقراءة) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">الأدوار المبنية في النظام</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">قوالب ثابتة آمنة. لتخصيص أحدها: أضِف دوراً مخصّصاً واختره فئةً أساسية، فتبدأ خريطة صلاحياته من قالبه ثم عدّلها.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {builtin.map((r) => (
              <div key={r.key} className="rounded-md border p-3">
                <div className="font-medium text-sm">{r.label}{r.canSeeCost ? <span className="text-[10px] text-[var(--sem-pos)] mr-1">· يرى التكلفة</span> : null}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{r.description}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

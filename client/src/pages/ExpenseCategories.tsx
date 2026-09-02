// إدارة فئات المصروفات المُدارة — مدير/محاسب مخوّل بوحدة المصروفات.
//
// العقد المعروض للمستخدم صراحةً على الشاشة: **الفئة تُصنِّف، والدلو يُحاسِب.** الدلو الثمانيّ
// هو ما يقرأه الدفتر والتقارير والإقفال، والفئة طبقةٌ تشغيلية فوقه يديرها المالك بحرّية.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Edit3, Info, Plus, RotateCcw, Wrench } from "lucide-react";
import { ListToolbar, RowActions } from "@/components/list";
import {
  EXPENSE_BUCKETS,
  EXPENSE_BUCKET_LABEL,
  expenseBucketLabel,
  type ExpenseBucket,
} from "@shared/expenseCategories";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";

type Row = RouterOutputs["expenses"]["categories"]["list"][number];

export default function ExpenseCategories() {
  const utils = trpc.useUtils();
  const list = trpc.expenses.categories.list.useQuery({
    includeInactive: true,
  });
  const unclassified = trpc.expenses.categories.unclassifiedCount.useQuery();
  const me = trpc.auth.me.useQuery();
  const canManage =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "expenses",
      "FULL",
      ["manager", "accountant"],
    );

  const [query, setQuery] = useState("");
  const rows = list.data ?? [];
  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    if (!q) return rows;
    return rows.filter((r) =>
      [r.name, r.description, expenseBucketLabel(r.bucket)].some((v) =>
        String(v ?? "")
          .toLocaleLowerCase("ar")
          .includes(q),
      ),
    );
  }, [rows, query]);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [name, setName] = useState("");
  const [bucket, setBucket] = useState<ExpenseBucket>("OTHER");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState<number>(500);

  function resetForm() {
    setShowForm(false);
    setEditing(null);
    setName("");
    setBucket("OTHER");
    setDescription("");
    setSortOrder(500);
  }

  const create = trpc.expenses.categories.create.useMutation({
    onSuccess: async () => {
      await utils.expenses.categories.list.invalidate();
      resetForm();
      notify.ok("أُضيفت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const update = trpc.expenses.categories.update.useMutation({
    onSuccess: async () => {
      await utils.expenses.categories.list.invalidate();
      resetForm();
      notify.ok("حُدّثت الفئة");
    },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.expenses.categories.setActive.useMutation({
    onSuccess: async () => {
      await utils.expenses.categories.list.invalidate();
      notify.ok("تَمّ التحديث");
    },
    onError: (e) => notify.err(e),
  });
  const restoreDefaults = trpc.expenses.categories.restoreDefaults.useMutation({
    onSuccess: async (res) => {
      await utils.expenses.categories.list.invalidate();
      if (!res.inserted.length && !res.defaultsRepaired.length) {
        notify.ok(`الفئات الافتراضية مكتملة أصلاً (${res.total} فئة)`);
        return;
      }
      notify.ok(
        `استُعيدت الفئات: +${res.inserted.length} جديدة، ${res.defaultsRepaired.length} دلواً رُمِّمت احتياطيته`,
      );
    },
    onError: (e) => notify.err(e),
  });
  const backfill = trpc.expenses.categories.backfill.useMutation({
    onSuccess: async (res) => {
      await Promise.all([
        utils.expenses.categories.unclassifiedCount.invalidate(),
        utils.expenses.categories.list.invalidate(),
      ]);
      notify.ok(
        res.updated
          ? `صُنّف ${res.updated} مصروفاً بفئة دلوه الاحتياطية`
          : "لا مصروفات بلا فئة",
      );
    },
    onError: (e) => notify.err(e),
  });

  function startEdit(r: Row) {
    setEditing(r);
    setName(r.name);
    setBucket(r.bucket);
    setDescription(r.description ?? "");
    setSortOrder(r.sortOrder);
    setShowForm(true);
  }

  function submitForm() {
    const trimmed = name.trim();
    if (!trimmed) {
      notify.err("الاسم مطلوب");
      return;
    }
    if (editing) {
      update.mutate({
        id: editing.id,
        name: trimmed,
        bucket,
        description: description.trim() || null,
        sortOrder,
      });
    } else {
      create.mutate({
        name: trimmed,
        bucket,
        description: description.trim() || null,
        sortOrder,
      });
    }
  }

  async function toggleActive(r: Row) {
    const ok = await confirm({
      variant: r.isActive ? "warning" : "info",
      title: r.isActive ? "تعطيل الفئة" : "تفعيل الفئة",
      description: r.isActive
        ? `ستختفي فئة «${r.name}» من منتقي المصروف الجديد، وتحتفظ المصروفات القديمة بتصنيفها.`
        : `ستعود فئة «${r.name}» للظهور في منتقي المصروف.`,
      confirmText: r.isActive ? "تعطيل" : "تفعيل",
    });
    if (!ok) return;
    setActive.mutate({ id: r.id, isActive: !r.isActive });
  }

  async function confirmRestore() {
    const ok = await confirm({
      variant: "info",
      title: "استعادة الفئات الافتراضية",
      description:
        "ستُضاف فئات المصروفات الافتراضية الناقصة، وتُرمَّم فئة كل دلو الاحتياطية إن كانت مفقودة أو معطّلة. لا يُعدَّل اسمٌ ولا دلوٌ قائم، ولا تُفعَّل فئة عاديّة عطّلتها الإدارة.",
      confirmText: "استعادة",
    });
    if (ok) restoreDefaults.mutate();
  }

  const pendingCount = unclassified.data ?? 0;

  // طباعة A4 بهوية المستند بدل window.print() (كان يطبع الشاشة كما تُرى: بطاقة التنويه
  // والنموذج المفتوح وشريط الأدوات). نفس صفوف الجدول المعروضة وأعمدته — بلا استعلامٍ جديد.
  function printCategories() {
    printReportDoc({
      title: "فئات المصروفات",
      headerExtra: [
        { label: "عدد الفئات", value: visibleRows.length.toLocaleString("ar-IQ-u-nu-latn") },
        { label: "البحث", value: query.trim() || "بلا بحث" },
      ],
      note: "الدلو المحاسبي هو ما يقرأه دفتر الأستاذ والتقارير؛ الفئة طبقة تشغيلية فوقه لا تغيّر الحساب الذي يهبط فيه المصروف.",
      columns: [
        { key: "id", label: "#", align: "center" },
        { key: "name", label: "الاسم" },
        { key: "bucket", label: "الدلو المحاسبي" },
        { key: "description", label: "الوصف" },
        { key: "usedExpenseCount", label: "مصروفات", align: "center" },
        { key: "sortOrder", label: "ترتيب", align: "center" },
        { key: "isActive", label: "نشطة", align: "center" },
      ],
      rows: visibleRows.map((r) => ({
        id: String(r.id),
        // شارة «احتياطية الدلو» تظهر على الشاشة بجانب الاسم — نُبقيها نصّاً كي لا تضيع على الورق.
        name: `${r.name}${r.isBucketDefault ? " (احتياطية الدلو)" : ""}`,
        bucket: expenseBucketLabel(r.bucket),
        description: r.description ?? "—",
        usedExpenseCount: r.usedExpenseCount.toLocaleString("ar-IQ-u-nu-latn"),
        sortOrder: String(r.sortOrder),
        isActive: r.isActive ? "نشطة" : "معطّلة",
      })),
      emptyText: "لا فئات مطابقة.",
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="فئات المصروفات"
        description="تصنيف تشغيلي دقيق للمصروفات فوق الدلو المحاسبي — الفئة تُصنِّف والدلو يُحاسِب."
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={restoreDefaults.isPending}
                onClick={() => void confirmRestore()}
              >
                <RotateCcw aria-hidden className="size-4 ms-1" />
                {restoreDefaults.isPending
                  ? "جارٍ الاستعادة…"
                  : "استعادة الافتراضية"}
              </Button>
              <Button
                onClick={() => {
                  resetForm();
                  setShowForm(true);
                }}
                className="bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)]"
              >
                <Plus aria-hidden className="size-4 ms-1" /> فئة جديدة
              </Button>
            </div>
          ) : undefined
        }
      />

      <Card className="border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)]">
        <CardContent className="p-3 text-sm text-[var(--sem-info)] flex items-start gap-2">
          <Info aria-hidden className="size-4 mt-0.5 shrink-0" />
          <span>
            الدلو المحاسبي هو ما يقرأه دفتر الأستاذ والتقارير وجاهزية إقفال
            الشهر، وهو ثابت بثمانية بنود. الفئة طبقة تشغيلية فوقه: تُغيّر
            التصنيف الذي تراه في تقاريرك بلا أي تغيير في الحساب الذي يهبط فيه
            المصروف. لذلك لا يتغيّر دلو فئة ارتبطت بمصروفات.
          </span>
        </CardContent>
      </Card>

      {!canManage && (
        <Card>
          <CardContent className="p-3 text-sm text-muted-foreground">
            عرض فقط — الإدارة متاحة للمدير أو المحاسب المخوّل بوحدة المصروفات.
          </CardContent>
        </Card>
      )}

      {canManage && pendingCount > 0 && (
        <Card className="border-[var(--sem-warn)]/40">
          <CardContent className="p-3 text-sm flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Wrench aria-hidden className="size-4" />
              {pendingCount} مصروفاً بلا فئة مُدارة (سجلّات سبقت التصنيف).
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={backfill.isPending}
              onClick={() => backfill.mutate()}
            >
              {backfill.isPending ? "جارٍ التصنيف…" : "أسنِدها لفئة دلوها"}
            </Button>
          </CardContent>
        </Card>
      )}

      {showForm && canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editing ? "تعديل فئة" : "فئة جديدة"}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="exp-cat-name">الاسم *</Label>
              <Input
                id="exp-cat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً: وقود المولّدة"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-cat-bucket">الدلو المحاسبي *</Label>
              <AppSelect
                id="exp-cat-bucket"
                value={bucket}
                onValueChange={(v) => setBucket(v as ExpenseBucket)}
                disabled={
                  !!editing &&
                  (editing.isBucketDefault || editing.usedExpenseCount > 0)
                }
              >
                {EXPENSE_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {EXPENSE_BUCKET_LABEL[b]}
                  </option>
                ))}
              </AppSelect>
              {editing &&
                (editing.isBucketDefault || editing.usedExpenseCount > 0) && (
                  <p className="text-[11px] text-muted-foreground">
                    {editing.isBucketDefault
                      ? "الفئة الاحتياطية لدلوها — لا يُنقل دلوها."
                      : `مرتبطة بـ${editing.usedExpenseCount} مصروفاً؛ نقل الدلو يُعيد تصنيف تاريخ مُرحَّل. أنشئ فئة جديدة بالدلو الصحيح.`}
                  </p>
                )}
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="exp-cat-desc">الوصف (اختياري)</Label>
              <Input
                id="exp-cat-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="شرح مختصر يميّز الفئة عن غيرها"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-cat-sort">ترتيب العرض</Label>
              <Input
                id="exp-cat-sort"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <Button
                onClick={submitForm}
                disabled={create.isPending || update.isPending}
                className="bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)]"
              >
                {editing ? "حفظ التعديل" : "حفظ الفئة"}
              </Button>
              <Button variant="outline" onClick={resetForm}>
                إلغاء
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="فئات المصروفات"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "اسم الفئة أو الدلو أو الوصف…",
            }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={printCategories}
            exportSpec={{
              filename: "فئات-المصروفات",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "id", header: "#" },
                { key: "name", header: "الاسم" },
                {
                  key: "bucket",
                  header: "الدلو المحاسبي",
                  map: (r) => expenseBucketLabel(r.bucket),
                },
                { key: "description", header: "الوصف" },
                { key: "usedExpenseCount", header: "عدد المصروفات" },
                { key: "sortOrder", header: "الترتيب" },
                {
                  key: "isActive",
                  header: "الحالة",
                  map: (r) => (r.isActive ? "نشطة" : "معطّلة"),
                },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<Row>
            data={visibleRows}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            /* البحث في ListToolbar أعلاه (يغذّي visibleRows) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={query.trim() !== ""}
            getRowClassName={(r) => (r.isActive ? undefined : "opacity-60")}
            emptyState={canManage ? "لا فئات بعد — استعد الافتراضية أو أضِف أوّل فئة أعلاه." : "لا فئات حتى الآن."}
            emptyFilteredState={
              <div className="space-y-2">
                <div>لا فئات مطابقة للبحث «{query}».</div>
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  مسح البحث
                </Button>
              </div>
            }
            columns={[
              {
                id: "id",
                header: "#",
                accessorFn: (r) => r.id,
                meta: { kind: "number", align: "center", width: "id" },
                cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.id}</span>,
              },
              {
                id: "name",
                header: "الاسم",
                accessorFn: (r) => r.name,
                meta: { width: "wide" },
                cell: ({ row }) => (
                  <span className="font-medium">
                    {row.original.name}
                    {row.original.isBucketDefault && (
                      // Codex P2 (٢٤/٨): `Popover` بدل `Tooltip` — يفتح باللمس (Tap) على الأجهزة
                      // اللمسية، وبالنقر والمفتاح (Enter/Space) على الحاسوب. Radix Tooltip يفشل
                      // على اللمس لأنّ pointer-down يُخفي التركيز فيتعذّر ظهوره بتاباً واحد.
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label="ما معنى «احتياطية الدلو»؟"
                            className="ms-1 inline-block cursor-help rounded-full bg-[var(--sem-info-bg)] px-2 py-0.5 text-[10px] text-[var(--sem-info)] outline-none focus-visible:ring-1 focus-visible:ring-ring hover:opacity-80"
                          >
                            احتياطية الدلو
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="top" className="max-w-xs text-xs">
                          الفئة الاحتياطية لهذا الدلو — يُصنَّف بها أيّ مصروفٍ لم يُختَر له فئةٌ صراحةً. لا يُنقل دلوها ولا تُعطَّل يدوياً (يُعالجها زرّ «استعادة الافتراضية» إن اختلّت).
                        </PopoverContent>
                      </Popover>
                    )}
                  </span>
                ),
              },
              {
                id: "bucket",
                header: "الدلو المحاسبي",
                // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
                accessorFn: (r) => expenseBucketLabel(r.bucket),
                cell: ({ row }) => <span className="text-xs">{expenseBucketLabel(row.original.bucket)}</span>,
              },
              {
                id: "description",
                header: "الوصف",
                accessorFn: (r) => r.description ?? "—",
                meta: { width: "wide", wrap: true },
                cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.description ?? "—"}</span>,
              },
              {
                id: "usedExpenseCount",
                header: "مصروفات",
                accessorFn: (r) => r.usedExpenseCount,
                meta: { kind: "number", align: "center" },
                cell: ({ row }) => <span className="text-xs">{row.original.usedExpenseCount}</span>,
              },
              {
                id: "sortOrder",
                header: "ترتيب",
                accessorFn: (r) => r.sortOrder,
                meta: { kind: "number", align: "center" },
                cell: ({ row }) => <span className="text-xs">{row.original.sortOrder}</span>,
              },
              {
                id: "isActive",
                header: "نشطة",
                accessorFn: (r) => (r.isActive ? "نشطة" : "معطّلة"),
                meta: { kind: "status" },
                cell: ({ row }) => (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label={row.original.isActive ? "شرح: الفئة نشطة" : "شرح: الفئة معطّلة"}
                        className={`inline-block cursor-help rounded-full px-2 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring hover:opacity-80 ${row.original.isActive ? "badge-status-active" : "bg-muted text-muted-foreground"}`}
                      >
                        {row.original.isActive ? "نشطة" : "معطّلة"}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="top" className="max-w-xs text-xs">
                      {row.original.isActive
                        ? "الفئة تظهر في منتقي المصروف الجديد."
                        : "الفئة مخفيّة عن منتقي المصروف الجديد — المصروفات القديمة المُصنَّفة بها تحتفظ بتصنيفها بلا مسّ."}
                    </PopoverContent>
                  </Popover>
                ),
              },
              // عمود الإجراء يبقى محكوماً بالصلاحية كما كان — لا يُصيَّر أصلاً لغير المخوَّل.
              ...(canManage
                ? ([
                    {
                      id: "actions",
                      header: "إجراء",
                      enableSorting: false,
                      meta: { kind: "actions" },
                      cell: ({ row }) => (
                        <RowActions
                          mode="menu"
                          actions={[
                            {
                              key: "edit",
                              kind: "edit",
                              label: "تعديل",
                              icon: Edit3,
                              onSelect: () => startEdit(row.original),
                              gate: {
                                roles: ["manager", "accountant"],
                                module: "expenses",
                                level: "FULL",
                              },
                            },
                            {
                              key: "toggle",
                              kind: "approve",
                              label: row.original.isActive ? "تعطيل" : "تفعيل",
                              hidden: row.original.isBucketDefault,
                              variant: row.original.isActive ? "destructive" : "default",
                              onSelect: () => void toggleActive(row.original),
                              gate: {
                                roles: ["manager", "accountant"],
                                module: "expenses",
                                level: "FULL",
                              },
                            },
                          ]}
                        />
                      ),
                    },
                  ] as ColumnDef<Row, unknown>[])
                : []),
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

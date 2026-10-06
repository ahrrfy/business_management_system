import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { FilterField } from "@/components/list/FilterField";
import { ListToolbar } from "@/components/list/ListToolbar";
import { PageHeader } from "@/components/PageHeader";


import { RowActions } from "@/components/list/RowActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fmtDateTime } from "@/lib/date";
import { type ExportColumn } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmt, fmtInt, formatQuantity } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Plus, Package, ChefHat, Boxes, Layers, FileText } from "lucide-react";

const dateCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Row = RouterOutputs["production"]["list"]["rows"][number];

const PAGE = 50;

const statusLabel = (s: string) => (s === "CANCELLED" ? "ملغى" : "مُرحَّل");

export default function Production() {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });

  // الفلاتر في الـURL — تعيش مع فتح التفاصيل والرجوع وتُشارَك رابطاً.
  const [f, setF, resetF] = useUrlFilters({ q: "", status: "", branch: "", from: "", to: "" });
  const [page, setPage] = useState(0);
  const debouncedQ = useDebouncedValue(f.q, 250);

  // أي تغيير فلتر يعيد للصفحة الأولى (وإلا offset قديم على نتائج جديدة).
  function patchFilters(patch: Partial<{ q: string; status: string; branch: string; from: string; to: string }>) {
    setF(patch);
    setPage(0);
  }

  const filterInput = {
    status: (f.status || undefined) as "CONFIRMED" | "CANCELLED" | undefined,
    branchId: f.branch ? Number(f.branch) : undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    q: debouncedQ.trim() || undefined,
  };

  const list = trpc.production.list.useQuery(
    { ...filterInput, limit: PAGE, offset: page * PAGE },
    { enabled: me.data != null, placeholderData: keepPreviousData },
  );

  const rows: Row[] = list.data?.rows ?? [];
  const hasMore = list.data?.hasMore ?? false;
  const activeFilterCount = [f.status, f.branch, f.from, f.to].filter(Boolean).length;

  const exportColumns: ExportColumn<Row>[] = [
    { key: "docNumber", header: "رقم المستند" },
    {
      key: "productName",
      header: "المنتج الناتج",
      map: (r: any) => {
        if (r.primaryProductName) {
          const variant = r.primaryVariantName ? ` (${r.primaryVariantName})` : "";
          const more = (r.outputCount ?? r.outputs?.length ?? 0) > 1 ? ` (+${(r.outputCount ?? r.outputs?.length) - 1} أصناف)` : "";
          return `${r.primaryProductName}${variant}${more}`;
        }
        return r.outputs?.map((o: any) => `${o.productName}${o.variantName ? ` (${o.variantName})` : ""}`).join(" + ") || "";
      },
    },
    { key: "recipeName", header: "الوصفة", map: (r: any) => r.recipeName ?? "إنتاج يدوي" },
    {
      key: "bundleInfo",
      header: "البكج / المجموعة",
      map: (r: any) =>
        r.bundleInfo?.bundleName
          ? `بكج: ${r.bundleInfo.bundleName}`
          : r.bundleInfo?.isBundlePart
          ? "مكوّن بكج"
          : r.multiRecipeInfo?.isMultiRecipe
          ? "إنتاج مجمّع"
          : "",
    },
    { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
    { key: "outputQty", header: "كمية المخرجات", map: (r) => r.outputQty },
    { key: "materialsCost", header: "تكلفة المواد", map: (r) => r.materialsCost },
    { key: "laborCost", header: "العمالة", map: (r) => r.laborCost },
    { key: "totalCost", header: "الكلفة الكلية", map: (r) => r.totalCost },
    { key: "status", header: "الحالة", map: (r) => statusLabel(r.status) },
    { key: "createdAt", header: "التاريخ", map: (r) => fmtDateTime(r.createdAt) },
  ];

  /** يجلب كل الصفحات المطابقة للفلاتر (لا الصفحة المعروضة) — للتصدير والطباعة الكاملين. */
  function fetchAll(): Promise<Row[]> {
    return fetchAllPaged<Row>(
      (offset, limit) =>
        utils.production.list.fetch({ ...filterInput, limit, offset }).then((r) => ({ rows: r.rows })),
      { pageSize: 500 },
    );
  }

  async function printAll() {
    const all = await fetchAll();
    const branchLabel = f.branch
      ? (branches.data ?? []).find((b) => Number(b.id) === Number(f.branch))?.name ?? `فرع #${f.branch}`
      : "الكل";
    const ok = printReportDoc({
      title: "مستندات الإنتاج والتحويل",
      headerExtra: [
        { label: "الفرع", value: branchLabel },
        ...(f.from || f.to ? [{ label: "الفترة", value: `${f.from || "…"} — ${f.to || "…"}` }] : []),
        ...(f.status ? [{ label: "الحالة", value: statusLabel(f.status) }] : []),
      ],
      columns: [
        { key: "docNumber", label: "رقم المستند" },
        { key: "productRecipe", label: "المنتج / الوصفة" },
        { key: "branchName", label: "الفرع" },
        { key: "outputQty", label: "كمية المخرجات", align: "center" },
        { key: "totalCost", label: "الكلفة الكلية", align: "left" },
        { key: "status", label: "الحالة", align: "center" },
        { key: "createdAt", label: "التاريخ" },
      ],
      rows: all.map((r: any) => {
        const prod = r.primaryProductName
          ? `${r.primaryProductName}${r.primaryVariantName ? ` (${r.primaryVariantName})` : ""}${(r.outputCount ?? r.outputs?.length ?? 0) > 1 ? ` (+${(r.outputCount ?? r.outputs?.length) - 1})` : ""}`
          : (r.outputs?.[0]?.productName ?? "—");
        const recipe = r.recipeName ? ` (${r.recipeName})` : "";
        const bundle = r.bundleInfo?.bundleName ? ` [بكج: ${r.bundleInfo.bundleName}]` : "";
        return {
          docNumber: String(r.docNumber ?? ""),
          productRecipe: `${prod}${recipe}${bundle}`,
          branchName: String(r.branchName ?? ""),
          outputQty: formatQuantity(r.outputQty),
          totalCost: fmt(r.totalCost),
          status: statusLabel(r.status),
          createdAt: fmtDateTime(r.createdAt),
        };
      }),
      emptyText: "لا مستندات إنتاج في هذا النطاق.",
    });
    if (!ok) notify.err("اسمح بالنوافذ المنبثقة لإتمام الطباعة");
  }
  /** أعمدة مستندات الإنتاج. */
  const productionColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { id: "docNumber", header: "رقم المستند", accessorFn: (r) => r.docNumber, meta: { kind: "code" } },
    {
      id: "productAndRecipe",
      header: "المنتج / الوصفة",
      accessorFn: (r: any) => r.primaryProductName ?? r.recipeName ?? "",
      meta: { kind: "text" },
      cell: ({ row }) => {
        const r = row.original as any;
        const outputs = r.outputs ?? [];
        const mainProdName = r.primaryProductName || (outputs.length > 0 ? outputs[0]?.productName : null);
        const mainVariant = r.primaryVariantName;
        const mainSku = r.primarySku;
        const moreCount = (r.outputCount ?? outputs.length) - 1;

        return (
          <div className="flex flex-col gap-1 py-1 min-w-[200px] max-w-[340px]">
            {/* سطر المنتج الناتج */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Package aria-hidden className="size-3.5 text-primary shrink-0" />
              {mainProdName ? (
                <span className="font-semibold text-sm text-foreground leading-tight truncate" title={mainProdName}>
                  {mainProdName}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground italic">غير محدد</span>
              )}

              {mainVariant && (
                <span className="text-xs text-muted-foreground">({mainVariant})</span>
              )}

              {mainSku && (
                <span className="text-[10px] font-mono bg-muted/60 text-muted-foreground px-1 rounded border border-border/40">
                  {mainSku}
                </span>
              )}

              {moreCount > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-secondary text-secondary-foreground"
                  title={outputs
                    .map((o: any) =>
                      `${o.productName}${o.variantName ? ` (${o.variantName})` : ""}: ${formatQuantity(o.quantity)}${o.unitName ? ` ${o.unitName}` : ""}`
                    )
                    .filter(Boolean)
                    .join(" | ")}
                >
                  <Boxes aria-hidden className="size-3" />
                  +{moreCount}
                </span>
              )}
            </div>

            {/* سطر الوصفة والبكج إن وُجدا */}
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              {r.recipeName ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground" title={`وصفة: ${r.recipeName}`}>
                  <ChefHat aria-hidden className="size-3 text-muted-foreground/70 shrink-0" />
                  <span className="truncate max-w-[150px]">{r.recipeName}</span>
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground/70 italic">إنتاج يدوي</span>
              )}

              {/* وسام البكج */}
              {r.bundleInfo?.isBundlePart && (
                <span
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--stock-low)]/10 text-[var(--stock-low)] border border-[var(--stock-low)]/30"
                  title={r.bundleInfo.groupRef ? `مرجع الحزمة: ${r.bundleInfo.groupRef}` : undefined}
                >
                  <Boxes aria-hidden className="size-3 shrink-0" />
                  {r.bundleInfo.bundleName ? `بكج: ${r.bundleInfo.bundleName}` : "مكوّن بكج"}
                </span>
              )}

              {/* وسام الإنتاج المتعدد */}
              {r.multiRecipeInfo?.isMultiRecipe && (
                <span
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--status-pending)]/10 text-[var(--status-pending)] border border-[var(--status-pending)]/30"
                  title={r.multiRecipeInfo.groupRef ? `مرجع الدفعة: ${r.multiRecipeInfo.groupRef}` : undefined}
                >
                  <Layers aria-hidden className="size-3 shrink-0" />
                  إنتاج مجمّع
                </span>
              )}

              {/* وسام أمر الشغل إن وجد */}
              {r.linkedWorkOrderId && (
                <span
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-primary/10 text-primary border border-primary/25"
                >
                  <FileText aria-hidden className="size-3 shrink-0" />
                  أمر شغل #{r.linkedWorkOrderId}
                </span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "branchName", header: "الفرع",
      accessorFn: (r) => r.branchName,
      cell: ({ row }) => <span className="text-xs">{row.original.branchName}</span>,
      meta: { kind: "text" },
    },
    {
      id: "outputQty", header: "كمية المخرجات",
      accessorFn: (r) => Number(r.outputQty),
      cell: ({ row }) => formatQuantity(row.original.outputQty),
      meta: { kind: "number" },
    },
    {
      id: "totalCost", header: "الكلفة الكلية",
      accessorFn: (r) => Number(r.totalCost),
      cell: ({ row }) => fmt(row.original.totalCost),
      meta: { kind: "money" },
    },
    {
      id: "status", header: "الحالة",
      accessorFn: (r) => statusLabel(r.status),
      cell: ({ row }) => (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${row.original.status === "CANCELLED" ? "badge-status-cancelled" : "badge-status-active"}`}>
          {statusLabel(row.original.status)}
        </span>
      ),
      meta: { kind: "status" },
    },
    {
      id: "createdAt", header: "التاريخ",
      accessorFn: (r) => String(r.createdAt ?? ""),
      cell: ({ row }) => <span className="whitespace-nowrap text-xs">{fmtDateTime(row.original.createdAt)}</span>,
      meta: { kind: "datetime" },
    },
    {
      id: "actions", header: "إجراء",
      cell: ({ row }) => (
        <RowActions
          mode="inline"
          actions={[
            {
              key: "view", kind: "view", label: "فتح",
              href: `/production/${Number(row.original.id)}`,
              gate: { roles: ["manager"], module: "inventory", level: "FULL" },
            },
          ]}
        />
      ),
      meta: { kind: "actions" },
    },
  ], []);

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="الإنتاج والتحويل"
        description="تحويل المخزون إلى منتجات (ملازم/كتب/أكياس). يُخصم المدخل ويُنتَج المخرَج بكلفته الحقيقية."
        actions={
          <Link href="/production/new">
            <Button>
              <Plus aria-hidden className="size-4 me-1" /> مستند إنتاج جديد
            </Button>
          </Link>
        }
      />

      <Card>
        <CardContent className="space-y-3 p-4">
          <ListToolbar<Row>
            title="المستندات"
            count={rows.length}
            loading={list.isLoading}
            search={{
              value: f.q,
              onChange: (v) => patchFilters({ q: v }),
              placeholder: "رقم المستند، اسم المنتج، الوصفة أو البكج…",
              ariaLabel: "بحث في مستندات الإنتاج",
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={() => {
              resetF();
              setPage(0);
            }}
            onRefresh={() => list.refetch()}
            refreshing={list.isFetching}
            exportSpec={{ filename: "مستندات-الإنتاج", rows, columns: exportColumns, fetchAll }}
            onPrint={() => void printAll()}
            printDisabled={rows.length === 0}
            filters={
              <div className="flex flex-wrap items-end gap-2">
                <FilterField label="الحالة" className="w-36">
                  <AppSelect size="sm" value={f.status} onValueChange={(v) => patchFilters({ status: v })} placeholder="— الكل —">
                    <option value="">— الكل —</option>
                    <option value="CONFIRMED">مُرحَّل</option>
                    <option value="CANCELLED">ملغى</option>
                  </AppSelect>
                </FilterField>
                {canPickBranch && (
                  <FilterField label="الفرع" className="w-40">
                    <AppSelect size="sm" value={f.branch} onValueChange={(v) => patchFilters({ branch: v })} placeholder="— كل الفروع —">
                      <option value="">— كل الفروع —</option>
                      {(branches.data ?? []).map((b) => (
                        <option key={Number(b.id)} value={String(b.id)}>
                          {b.name}
                        </option>
                      ))}
                    </AppSelect>
                  </FilterField>
                )}
                <FilterField label="من">
                  <Input type="date" className={dateCls} value={f.from} onChange={(e) => patchFilters({ from: e.target.value })} />
                </FilterField>
                <FilterField label="إلى">
                  <Input type="date" className={dateCls} value={f.to} onChange={(e) => patchFilters({ to: e.target.value })} />
                </FilterField>
              </div>
            }
          />

          <DataTable
            columns={productionColumns}
            data={rows}
            loading={list.isLoading}
            searchable={false}
            emptyText={activeFilterCount > 0 || f.q ? "لا مستندات مطابقة للفلاتر." : "لا مستندات إنتاج بعد."}
            /* ترقيمٌ خادميّ (limit/offset) ⇒ يُعطّل DataTable الفرزَ فلا يرتّب صفحةً واحدة ويبدو شاملاً. */
            serverPagination={{ page, onPageChange: setPage, pageSize: PAGE, hasMore, isFetching: list.isFetching }}
          />

          {/* الترقيم يُصيّره DataTable عبر serverPagination — شريطٌ واحد لا اثنان. */}
        </CardContent>
      </Card>
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list/FilterField";
import { ListToolbar } from "@/components/list/ListToolbar";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow, TableSkeleton } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list/RowActions";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fmtDateTime } from "@/lib/date";
import { type ExportColumn } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmt, fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { Plus } from "lucide-react";

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
        { key: "branchName", label: "الفرع" },
        { key: "outputQty", label: "كمية المخرجات", align: "center" },
        { key: "totalCost", label: "الكلفة الكلية", align: "left" },
        { key: "status", label: "الحالة", align: "center" },
        { key: "createdAt", label: "التاريخ" },
      ],
      rows: all.map((r) => ({
        docNumber: String(r.docNumber ?? ""),
        branchName: String(r.branchName ?? ""),
        outputQty: fmtInt(r.outputQty),
        totalCost: fmt(r.totalCost),
        status: statusLabel(r.status),
        createdAt: fmtDateTime(r.createdAt),
      })),
      emptyText: "لا مستندات إنتاج في هذا النطاق.",
    });
    if (!ok) notify.err("اسمح بالنوافذ المنبثقة لإتمام الطباعة");
  }

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
              placeholder: "رقم المستند أو اسم المنتج الناتج…",
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
                  <input type="date" className={dateCls} value={f.from} onChange={(e) => patchFilters({ from: e.target.value })} />
                </FilterField>
                <FilterField label="إلى">
                  <input type="date" className={dateCls} value={f.to} onChange={(e) => patchFilters({ to: e.target.value })} />
                </FilterField>
              </div>
            }
          />

          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">رقم المستند</th>
                  <th className="p-2">الفرع</th>
                  <th className="p-2 text-center">كمية المخرجات</th>
                  <th className="p-2 text-right">الكلفة الكلية</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && <TableSkeleton rows={6} cols={7} />}
                {!list.isLoading &&
                  rows.map((r) => (
                    <tr key={Number(r.id)} className="border-t">
                      <td className="p-2 font-mono" dir="ltr">
                        {r.docNumber}
                      </td>
                      <td className="p-2 text-xs">{r.branchName}</td>
                      <td className="p-2 text-center tabular-nums" dir="ltr">
                        {fmtInt(r.outputQty)}
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {fmt(r.totalCost)}
                      </td>
                      <td className="p-2 text-center">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.status === "CANCELLED" ? "badge-status-cancelled" : "badge-status-active"}`}
                        >
                          {statusLabel(r.status)}
                        </span>
                      </td>
                      <td className="p-2 text-xs whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                      <td className="p-2 text-center">
                        <RowActions
                          mode="inline"
                          actions={[
                            {
                              key: "view",
                              kind: "view",
                              label: "فتح",
                              href: `/production/${Number(r.id)}`,
                              gate: { roles: ["manager"], module: "inventory", level: "FULL" },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow
                    colSpan={7}
                    message={activeFilterCount > 0 || f.q ? "لا مستندات مطابقة للفلاتر." : "لا مستندات إنتاج بعد."}
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>

          {/* ترقيم صفحات فعلي بدل اقتطاع 300 الصامت السابق. */}
          {(page > 0 || hasMore) && (
            <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
              <span>الصفحة {(page + 1).toLocaleString("ar-IQ-u-nu-latn")}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0 || list.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  السابق
                </Button>
                <Button variant="outline" size="sm" disabled={!hasMore || list.isFetching} onClick={() => setPage((p) => p + 1)}>
                  التالي
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

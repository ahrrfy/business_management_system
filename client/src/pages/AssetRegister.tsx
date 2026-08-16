import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { FilterField, ListToolbar } from "@/components/list";
import { trpc } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { AssetStatusBadge, CategoryIcon, iqd } from "@/lib/assets/ui";
import { assetSettlementPresentation } from "@/lib/assetAccrualStatus";
import { ASSET_CATEGORIES, ASSET_STATUSES, assetCategoryLabel, assetStatusLabel } from "@shared/assets";
import { ChevronLeft } from "lucide-react";
import { useMemo } from "react";
import { useLocation } from "wouter";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function initials(name?: string | null): string {
  if (!name) return "؟";
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
}

export default function AssetRegister() {
  const [, navigate] = useLocation();
  const [f, setF, resetF] = useUrlFilters({ q: "", category: "", branchId: "", status: "", includeDisposed: "" });

  const opts = trpc.assets.formOptions.useQuery();
  const list = trpc.assets.list.useQuery({
    category: (f.category || undefined) as never,
    branchId: f.branchId ? Number(f.branchId) : undefined,
    status: (f.status || undefined) as never,
    includeDisposed: f.includeDisposed === "1",
  });

  const rows = useMemo(() => {
    const all = list.data ?? [];
    const needle = f.q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((a) =>
      [a.code, a.name, a.serial, a.custodianName, a.location].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [list.data, f.q]);

  const activeFilterCount = [f.category, f.branchId, f.status, f.includeDisposed].filter(Boolean).length;
  const filtersActive = activeFilterCount > 0 || f.q.trim() !== "";

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">سجلّ الأصول</h1>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={rows.length}
            loading={list.isLoading}
            search={{ value: f.q, onChange: (v) => setF({ q: v }), placeholder: "بحث (اسم/رمز/تسلسلي/عهدة/موقع)" }}
            activeFilterCount={activeFilterCount}
            onResetFilters={filtersActive ? resetF : undefined}
            onRefresh={() => list.refetch()}
            refreshing={list.isFetching}
            filters={
              <>
                {/* FilterField يُظهر التسمية دائماً بصرياً — aria-label وحده لا يُرى إلا في قارئ الشاشة
                    فيضيع معنى الحقل للمستخدم البصريّ عند الاختيار (نمط PR #559/#566). */}
                <FilterField label="الفئة">
                  <select className={selectCls} value={f.category} onChange={(e) => setF({ category: e.target.value })} aria-label="الفئة">
                    <option value="">كل الفئات</option>
                    {ASSET_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </FilterField>
                <FilterField label="الفرع">
                  <select className={selectCls} value={f.branchId} onChange={(e) => setF({ branchId: e.target.value })} aria-label="الفرع">
                    <option value="">كل الفروع</option>
                    {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                  </select>
                </FilterField>
                <FilterField label="الحالة">
                  <select className={selectCls} value={f.status} onChange={(e) => setF({ status: e.target.value })} aria-label="الحالة">
                    <option value="">كل الحالات</option>
                    {ASSET_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </FilterField>
                <label className="flex items-center gap-2 h-8 text-sm self-end">
                  <input type="checkbox" className="size-4" checked={f.includeDisposed === "1"} onChange={(e) => setF({ includeDisposed: e.target.checked ? "1" : "" })} />
                  <span className="text-muted-foreground">يشمل المُستبعَد</span>
                </label>
              </>
            }
            exportSpec={{
              filename: "الأصول",
              rows,
              columns: [
                { key: "code", header: "الرمز" },
                { key: "name", header: "الأصل" },
                { key: "category", header: "الفئة", map: (r) => assetCategoryLabel(r.category) },
                { key: "serial", header: "الرقم التسلسلي", map: (r) => r.serial ?? "" },
                { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
                { key: "location", header: "الموقع", map: (r) => r.location ?? "" },
                { key: "custodianName", header: "العهدة", map: (r) => r.custodianName ?? "" },
                { key: "purchaseDate", header: "تاريخ الشراء", map: (r) => String(r.purchaseDate) },
                { key: "purchaseValue", header: "قيمة الشراء", map: (r) => Number(r.purchaseValue) },
                { key: "bookValue", header: "القيمة الدفترية", map: (r) => r.bookValue },
                { key: "status", header: "الحالة", map: (r) => assetStatusLabel(r.status) },
                { key: "settlementStatus", header: "تسوية الاقتناء", map: (r) => assetSettlementPresentation(r.settlementStatus).label },
              ],
            }}
            add={{ href: "/assets/new", label: "أصل جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الرمز</th>
                  <th className="p-2">الأصل</th>
                  <th className="p-2">الفرع / الموقع</th>
                  <th className="p-2">العهدة</th>
                  <th className="p-2">تاريخ الشراء</th>
                  <th className="p-2 text-right">قيمة الشراء</th>
                  <th className="p-2 text-right">القيمة الدفترية</th>
                  <th className="p-2 text-center">الحالة / التسوية</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t hover:bg-accent/50 cursor-pointer transition"
                    onClick={() => navigate(`/assets/${a.id}`)}
                  >
                    <td className="p-2 font-mono text-xs" dir="ltr">{a.code}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <CategoryIcon category={a.category} />
                        <div>
                          <div className="font-medium">{a.name}</div>
                          {a.serial && <div className="text-xs text-muted-foreground" dir="ltr">{a.serial}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="p-2 text-xs">{a.branchName ?? "—"}<div className="text-muted-foreground">{a.location ?? ""}</div></td>
                    <td className="p-2">
                      {a.custodianName ? (
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary text-[10px] font-semibold">{initials(a.custodianName)}</span>
                          <span className="text-xs">{a.custodianName}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">بلا عهدة</span>
                      )}
                    </td>
                    <td className="p-2 text-xs" dir="ltr">{a.purchaseDate}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(a.purchaseValue)}</td>
                    <td className="p-2 text-right tabular-nums font-medium" dir="ltr">{iqd(a.bookValue)}</td>
                    <td className="p-2 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <AssetStatusBadge status={a.status} />
                        {a.settlementStatus && (() => {
                          const settlement = assetSettlementPresentation(a.settlementStatus);
                          const badge = settlement.tone === "active"
                            ? "badge-status-active"
                            : settlement.tone === "cancelled"
                              ? "badge-status-cancelled"
                              : "badge-status-pending";
                          return <span title={settlement.detail} className={`${badge} rounded-full px-2 py-0.5 text-xs`}>{settlement.label}</span>;
                        })()}
                      </div>
                    </td>
                    <td className="p-2 text-muted-foreground"><ChevronLeft className="size-4" /></td>
                  </tr>
                ))}
                {!list.isLoading && rows.length === 0 && (
                  <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">لا أصول مطابقة. غيّر الفلاتر أو أضف أصلاً جديداً.</td></tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}

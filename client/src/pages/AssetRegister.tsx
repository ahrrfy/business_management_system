import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ListToolbar } from "@/components/list";
import { trpc } from "@/lib/trpc";
import { AssetStatusBadge, CategoryIcon, iqd } from "@/lib/assets/ui";
import { ASSET_CATEGORIES, ASSET_STATUSES, assetCategoryLabel, assetStatusLabel } from "@shared/assets";
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
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
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [includeDisposed, setIncludeDisposed] = useState(false);

  const opts = trpc.assets.formOptions.useQuery();
  const list = trpc.assets.list.useQuery({
    category: (category || undefined) as never,
    branchId: branchId ? Number(branchId) : undefined,
    status: (status || undefined) as never,
    includeDisposed,
  });

  const rows = useMemo(() => {
    const all = list.data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((a) =>
      [a.code, a.name, a.serial, a.custodianName, a.location].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [list.data, q]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">سجلّ الأصول</h1>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={rows.length}
            loading={list.isLoading}
            search={{ value: q, onChange: setQ, placeholder: "بحث (اسم/رمز/تسلسلي/عهدة/موقع)" }}
            filters={
              <>
                <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="الفئة">
                  <option value="">كل الفئات</option>
                  {ASSET_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="الفرع">
                  <option value="">كل الفروع</option>
                  {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                </select>
                <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
                  <option value="">كل الحالات</option>
                  {ASSET_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input type="checkbox" className="size-4" checked={includeDisposed} onChange={(e) => setIncludeDisposed(e.target.checked)} />
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
                  <th className="p-2 text-center">الحالة</th>
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
                    <td className="p-2 text-center"><AssetStatusBadge status={a.status} /></td>
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

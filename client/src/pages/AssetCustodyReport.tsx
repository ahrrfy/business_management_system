import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ListToolbar } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { CategoryIcon, StatCard, iqd } from "@/lib/assets/ui";
import { printCustodyAck } from "@/lib/assets/print";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { assetCategoryLabel } from "@shared/assets";
import { ChevronDown, ChevronLeft, Package, ShieldCheck, Users, Wallet } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Link } from "wouter";

/** هل نصّ الاحتواء يطابق البحث؟ فارغ ⇒ يمرّ الجميع. */
function textMatches(needle: string, ...vals: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return vals.some((v) => v != null && String(v).toLowerCase().includes(needle));
}

export default function AssetCustodyReport() {
  const q = trpc.assets.custodyReport.useQuery();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState("");

  const toggle = (id: number) => setOpen((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // فروع مُشتقّة من الأصول الفعلية الظاهرة بالتقرير — لا endpoint مخصّص لهذا التقرير.
  const branchOptions = useMemo(() => {
    if (!q.data) return [] as { id: number; name: string }[];
    const map = new Map<number, string>();
    for (const e of q.data.byEmployee) for (const i of e.items) if (i.branchId != null) map.set(i.branchId, i.branchName ?? `فرع #${i.branchId}`);
    for (const a of q.data.unassigned) if (a.branchId != null) map.set(a.branchId, a.branchName ?? `فرع #${a.branchId}`);
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [q.data]);

  // العهد مصفّاة حسب البحث/الفرع — يُعاد احتساب العدّ/القيمة من الأصول الباقية فقط بعد الفلترة،
  // وموظفٌ اسمه مطابق للبحث يُبقي كل أصوله (لا يشترط تطابق اسم الصنف نفسه).
  const filteredByEmployee = useMemo(() => {
    if (!q.data) return [];
    const needle = search.trim().toLowerCase();
    const bId = branchId ? Number(branchId) : null;
    return q.data.byEmployee
      .map((e) => {
        const empMatch = textMatches(needle, e.employeeName);
        const items = e.items.filter((i) => (bId == null || i.branchId === bId) && (empMatch || textMatches(needle, i.name, i.code, i.serial)));
        return { ...e, items, count: items.length, value: items.reduce((s, i) => s + i.bookValue, 0) };
      })
      .filter((e) => e.items.length > 0);
  }, [q.data, search, branchId]);

  const filteredUnassigned = useMemo(() => {
    if (!q.data) return [];
    const needle = search.trim().toLowerCase();
    const bId = branchId ? Number(branchId) : null;
    return q.data.unassigned.filter((a) => (bId == null || a.branchId === bId) && textMatches(needle, a.name, a.code, a.serial));
  }, [q.data, search, branchId]);

  const filtersActive = search.trim() !== "" || branchId !== "";

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;
  const d = q.data!;

  const totalAssets = d.byEmployee.reduce((s, e) => s + e.count, 0);
  const totalValue = d.byEmployee.reduce((s, e) => s + e.value, 0);

  // قائمة مسطّحة (بعد الفلترة) للتصدير/الطباعة — الكل لا الصفحة المعروضة فقط (لا ترقيم هنا أصلاً).
  const flat = [
    ...filteredByEmployee.flatMap((e) =>
      e.items.map((i) => ({
        employee: e.employeeName ?? "موظف",
        asset: i.name,
        code: i.code ?? "",
        category: assetCategoryLabel(i.category),
        branch: i.branchName ?? "—",
        value: i.bookValue,
      })),
    ),
    ...filteredUnassigned.map((a) => ({
      employee: "غير مُسنَد",
      asset: a.name,
      code: a.code ?? "",
      category: assetCategoryLabel(a.category),
      branch: a.branchName ?? "—",
      value: a.bookValue,
    })),
  ];
  const flatValueTotal = flat.reduce((s, r) => s + Number(r.value), 0);

  function onPrint() {
    const ok = printReportDoc({
      title: "تقرير العهد",
      headerExtra: [
        { label: "الفرع", value: branchId ? (branchOptions.find((b) => b.id === Number(branchId))?.name ?? "—") : "الكل" },
        { label: "بحث", value: search.trim() || "—" },
      ],
      columns: [
        { key: "employee", label: "الموظف" },
        { key: "asset", label: "الأصل" },
        { key: "code", label: "الرمز" },
        { key: "category", label: "الفئة" },
        { key: "branch", label: "الفرع" },
        { key: "value", label: "القيمة الدفترية", align: "left" },
      ],
      rows: flat.map((r) => ({ ...r, value: iqd(r.value) })),
      summary: [
        { label: "عدد الأصول", value: iqd(flat.length) },
        { label: "إجمالي القيمة الدفترية", value: `${iqd(flatValueTotal)} د.ع`, large: true, bold: true },
      ],
      emptyText: "لا عهد مطابقة للفلاتر.",
    });
    if (!ok) notify.err("اسمح بالنوافذ المنبثقة للطباعة");
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تقرير العهد"
        actions={<Link href="/assets/register"><Button variant="outline" size="sm">سجلّ الأصول</Button></Link>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="موظفون لديهم عهد" value={iqd(d.byEmployee.length)} icon={Users} />
        <StatCard label="أصول تحت العهدة" value={iqd(totalAssets)} icon={ShieldCheck} />
        <StatCard label="إجمالي القيمة الدفترية" value={iqd(totalValue)} icon={Wallet} sub="د.ع" />
        <StatCard label="أصول بلا عهدة" value={iqd(d.unassigned.length)} icon={Package} />
      </div>

      <Card>
        <CardHeader>
          <ListToolbar
            title="العهد حسب الموظف"
            count={filteredByEmployee.length}
            search={{ value: search, onChange: setSearch, placeholder: "بحث (موظف/أصل/رمز/تسلسلي)" }}
            filters={
              <AppSelect value={branchId} onValueChange={setBranchId} className="h-8 w-40" size="sm" placeholder="كل الفروع">
                <option value="">كل الفروع</option>
                {branchOptions.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </AppSelect>
            }
            onResetFilters={filtersActive ? () => { setSearch(""); setBranchId(""); } : undefined}
            onPrint={onPrint}
            printLabel="طباعة / PDF"
            exportSpec={{
              filename: "تقرير-العهد",
              rows: flat,
              columns: [
                { key: "employee", header: "الموظف" },
                { key: "asset", header: "الأصل" },
                { key: "code", header: "الرمز" },
                { key: "category", header: "الفئة" },
                { key: "branch", header: "الفرع" },
                { key: "value", header: "القيمة الدفترية", map: (r) => Number(r.value) },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr>
              <th className="p-2 w-8"></th>
              <th className="p-2">الموظف</th>
              <th className="p-2 text-center">عدد الأصول</th>
              <th className="p-2 text-right">القيمة الدفترية</th>
              <th className="p-2 text-center">إقرار</th>
            </tr></thead>
            <tbody>
              {filteredByEmployee.map((e) => (
                <Fragment key={e.employeeId}>
                  <tr className="border-t hover:bg-accent/50 cursor-pointer" onClick={() => toggle(e.employeeId)}>
                    <td className="p-2 text-muted-foreground">{open.has(e.employeeId) ? <ChevronDown className="size-4" /> : <ChevronLeft className="size-4" />}</td>
                    <td className="p-2 font-medium">{e.employeeName ?? "موظف"}</td>
                    <td className="p-2 text-center tabular-nums">{e.count}</td>
                    <td className="p-2 text-right tabular-nums font-medium" dir="ltr">{iqd(e.value)}</td>
                    <td className="p-2 text-center">
                      <Button variant="outline" size="sm" onClick={(ev) => { ev.stopPropagation(); printCustodyAck({ employeeName: e.employeeName ?? "موظف", items: e.items.map((i) => ({ code: i.code, name: i.name, serial: i.serial, bookValue: i.bookValue })) }); }}>إقرار عهدة</Button>
                    </td>
                  </tr>
                  {open.has(e.employeeId) && (
                    <tr className="bg-muted/20">
                      <td colSpan={5} className="p-0">
                        <table className="w-full text-xs">
                          <tbody>
                            {e.items.map((i) => (
                              <tr key={i.id} className="border-t border-border/40">
                                <td className="p-2 ps-10"><Link href={`/assets/${i.id}`} className="flex items-center gap-1.5 hover:text-primary"><CategoryIcon category={i.category} />{i.name}</Link></td>
                                <td className="p-2 font-mono" dir="ltr">{i.code}</td>
                                <td className="p-2 text-muted-foreground">{i.location ?? "—"}</td>
                                <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(i.bookValue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {filteredByEmployee.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">{d.byEmployee.length === 0 ? "لا عهد مُسندة حالياً." : "لا نتائج مطابقة للفلاتر."}</td></tr>
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {d.unassigned.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">أصول بلا عهدة ({filteredUnassigned.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr><th className="p-2">الأصل</th><th className="p-2">الرمز</th><th className="p-2">الفرع</th><th className="p-2 text-right">القيمة الدفترية</th></tr></thead>
              <tbody>
                {filteredUnassigned.map((a) => (
                  <tr key={a.id} className="border-t hover:bg-accent/50">
                    <td className="p-2"><Link href={`/assets/${a.id}`} className="flex items-center gap-1.5 hover:text-primary"><CategoryIcon category={a.category} />{a.name}</Link></td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{a.code}</td>
                    <td className="p-2 text-xs">{a.branchName ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(a.bookValue)}</td>
                  </tr>
                ))}
                {filteredUnassigned.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">لا نتائج مطابقة للفلاتر.</td></tr>
                )}
              </tbody>
            </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

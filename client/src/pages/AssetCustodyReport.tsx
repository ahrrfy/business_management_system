import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryIcon, StatCard, iqd } from "@/lib/assets/ui";
import { printCustodyAck } from "@/lib/assets/print";
import { exportRows } from "@/lib/export";
import { trpc } from "@/lib/trpc";
import { assetCategoryLabel } from "@shared/assets";
import { ChevronDown, ChevronLeft, Package, ShieldCheck, Users, Wallet } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "wouter";

export default function AssetCustodyReport() {
  const q = trpc.assets.custodyReport.useQuery();
  const [open, setOpen] = useState<Set<number>>(new Set());

  if (q.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (q.error) return <div className="p-10 text-center text-destructive">تعذّر التحميل: {q.error.message}</div>;
  const d = q.data!;

  const totalAssets = d.byEmployee.reduce((s, e) => s + e.count, 0);
  const totalValue = d.byEmployee.reduce((s, e) => s + e.value, 0);

  const toggle = (id: number) => setOpen((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // قائمة مسطّحة للتصدير: صفّ لكل (موظف × أصل) + الأصول بلا عهدة.
  const flat = [
    ...d.byEmployee.flatMap((e) =>
      e.items.map((i) => ({
        employee: e.employeeName ?? "موظف",
        asset: i.name,
        code: i.code ?? "",
        category: assetCategoryLabel(i.category),
        value: i.bookValue,
      })),
    ),
    ...d.unassigned.map((a) => ({
      employee: "غير مُسنَد",
      asset: a.name,
      code: a.code ?? "",
      category: assetCategoryLabel(a.category),
      value: a.bookValue,
    })),
  ];
  const exportExcel = () =>
    exportRows(flat, {
      filename: "تقرير-العهد",
      columns: [
        { key: "employee", header: "الموظف" },
        { key: "asset", header: "الأصل" },
        { key: "code", header: "الرمز" },
        { key: "category", header: "الفئة" },
        { key: "value", header: "القيمة الدفترية", map: (r) => Number(r.value) },
      ],
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">تقرير العهد</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!flat.length} onClick={exportExcel}>تصدير Excel</Button>
          <Link href="/assets/register"><Button variant="outline" size="sm">سجلّ الأصول</Button></Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="موظفون لديهم عهد" value={iqd(d.byEmployee.length)} icon={Users} />
        <StatCard label="أصول تحت العهدة" value={iqd(totalAssets)} icon={ShieldCheck} />
        <StatCard label="إجمالي القيمة الدفترية" value={iqd(totalValue)} icon={Wallet} sub="د.ع" />
        <StatCard label="أصول بلا عهدة" value={iqd(d.unassigned.length)} icon={Package} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">العهد حسب الموظف</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50"><tr className="text-right">
              <th className="p-2 w-8"></th>
              <th className="p-2">الموظف</th>
              <th className="p-2 text-center">عدد الأصول</th>
              <th className="p-2 text-left">القيمة الدفترية</th>
              <th className="p-2 text-center">إقرار</th>
            </tr></thead>
            <tbody>
              {d.byEmployee.map((e) => (
                <Fragment key={e.employeeId}>
                  <tr className="border-t hover:bg-accent/50 cursor-pointer" onClick={() => toggle(e.employeeId)}>
                    <td className="p-2 text-muted-foreground">{open.has(e.employeeId) ? <ChevronDown className="size-4" /> : <ChevronLeft className="size-4" />}</td>
                    <td className="p-2 font-medium">{e.employeeName ?? "موظف"}</td>
                    <td className="p-2 text-center tabular-nums">{e.count}</td>
                    <td className="p-2 text-left tabular-nums font-medium" dir="ltr">{iqd(e.value)}</td>
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
                                <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(i.bookValue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {d.byEmployee.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">لا عهد مُسندة حالياً.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {d.unassigned.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">أصول بلا عهدة ({d.unassigned.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50"><tr className="text-right"><th className="p-2">الأصل</th><th className="p-2">الرمز</th><th className="p-2">الفرع</th><th className="p-2 text-left">القيمة الدفترية</th></tr></thead>
              <tbody>
                {d.unassigned.map((a) => (
                  <tr key={a.id} className="border-t hover:bg-accent/50">
                    <td className="p-2"><Link href={`/assets/${a.id}`} className="flex items-center gap-1.5 hover:text-primary"><CategoryIcon category={a.category} />{a.name}</Link></td>
                    <td className="p-2 font-mono text-xs" dir="ltr">{a.code}</td>
                    <td className="p-2 text-xs">{a.branchName ?? "—"}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(a.bookValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

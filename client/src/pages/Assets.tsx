import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { CategoryIcon, StatCard, iqd } from "@/lib/assets/ui";
import { assetCategoryLabel } from "@shared/assets";
import { AlertTriangle, ArrowLeft, Banknote, Coins, Package, TrendingDown, Users, Wrench } from "lucide-react";
import { Link, useLocation } from "wouter";

export default function Assets() {
  const [, navigate] = useLocation();
  const dash = trpc.assets.dashboard.useQuery();

  if (dash.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (dash.error) return <div className="p-10 text-center text-destructive">تعذّر تحميل لوحة الأصول: {dash.error.message}</div>;
  const d = dash.data!;
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.value));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">لوحة الأصول الثابتة</h1>
        <div className="flex items-center gap-2">
          <Link href="/assets/register"><Button variant="outline" size="sm">سجلّ الأصول</Button></Link>
          <Button size="sm" onClick={() => navigate("/assets/new")}>+ أصل جديد</Button>
        </div>
      </div>

      {/* المؤشّرات */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="إجمالي الأصول" value={iqd(d.kpis.totalAssets)} icon={Package} />
        <StatCard label="القيمة الدفترية" value={iqd(d.kpis.bookValue)} icon={Banknote} sub="د.ع" />
        <StatCard label="قيمة الشراء" value={iqd(d.kpis.purchaseValue)} icon={Coins} sub="د.ع" />
        <StatCard label="الإهلاك المتراكم" value={iqd(d.kpis.accumulated)} icon={TrendingDown} sub="د.ع" />
        <StatCard label="في الصيانة" value={iqd(d.kpis.inMaintenance)} icon={Wrench} />
        <StatCard label="عهد لدى الموظفين" value={iqd(d.kpis.inCustody)} icon={Users} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* القيمة حسب الفئة */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">القيمة الدفترية حسب الفئة</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {d.byCategory.length === 0 && <p className="text-sm text-muted-foreground">لا أصول.</p>}
            {d.byCategory.map((c) => (
              <div key={c.category} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5"><CategoryIcon category={c.category} />{assetCategoryLabel(c.category)}</span>
                  <span className="tabular-nums text-muted-foreground" dir="ltr">{iqd(c.value)} · {c.count}</span>
                </div>
                <Progress value={(c.value / maxCat) * 100} />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* تحتاج إجراءً */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-1.5"><AlertTriangle className="size-4 text-amber-500" />تحتاج إجراءً</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d.needsAction.length === 0 && <p className="text-sm text-muted-foreground">لا شيء يحتاج إجراءً الآن. 👍</p>}
            {d.needsAction.map((n) => (
              <Link key={n.id} href={`/assets/${n.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent text-sm transition">
                <span className="truncate">{n.name}</span>
                <span className="text-xs text-muted-foreground shrink-0 me-1">{n.reason}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* أحدث الصيانة */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">أحدث عمليات الصيانة</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-end">
                  <th className="p-2">الأصل</th>
                  <th className="p-2">النوع</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2 text-start">التكلفة</th>
                </tr>
              </thead>
              <tbody>
                {d.recentMaintenance.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="p-2">{m.assetName ?? "—"} <span className="text-xs text-muted-foreground" dir="ltr">{m.assetCode ?? ""}</span></td>
                    <td className="p-2 text-xs">{m.type}</td>
                    <td className="p-2 text-xs" dir="ltr">{m.maintDate}</td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(m.cost)}</td>
                  </tr>
                ))}
                {d.recentMaintenance.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">لا عمليات صيانة بعد.</td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* التوزيع حسب الفرع */}
        <Card>
          <CardHeader><CardTitle className="text-base">القيمة حسب الفرع</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d.byBranch.map((b) => (
              <div key={b.branch} className="flex items-center justify-between text-sm border-b border-border/40 pb-1.5 last:border-0">
                <span>{b.branch}</span>
                <span className="tabular-nums text-muted-foreground" dir="ltr">{iqd(b.value)} · {b.count}</span>
              </div>
            ))}
            {d.byBranch.length === 0 && <p className="text-sm text-muted-foreground">لا بيانات.</p>}
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Link href="/assets/register" className="text-sm text-muted-foreground flex items-center gap-1">عرض كل الأصول <ArrowLeft className="size-3.5" /></Link>
      </div>
    </div>
  );
}

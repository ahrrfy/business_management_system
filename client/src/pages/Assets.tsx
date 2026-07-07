import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { CategoryIcon, StatCard, iqd } from "@/lib/assets/ui";
import { assetCategoryLabel } from "@shared/assets";
import { AlertTriangle, ArrowLeft, Banknote, CalendarClock, Coins, Package, ThumbsUp, TrendingDown, Users, Wrench } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";

/** الشهر السابق كـ YYYY-MM (نمط <input type="month">) — الافتراضي المألوف لترحيل إهلاك الشهر المُنتهي. */
function previousMonthYm(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based؛ month−1 يعطينا الشهر السابق (0=يناير)
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 12 : m; // 1..12
  return `${py}-${String(pm).padStart(2, "0")}`;
}

export default function Assets() {
  const [, navigate] = useLocation();
  const dash = trpc.assets.dashboard.useQuery();
  // #FI-02 (تدقيق التثبيت): postDepreciation endpoint كان يتيماً — الإهلاك الشهري لا يُرحَّل قطّ
  // ⇒ accumulatedDepreciation يبقى 0 والميزانية تعرض الأصول بقيمة الشراء والP&L يخلو من مصروف الإهلاك،
  // والربح مبالَغ كل فترة (حتى يقع التصرّف فيَنسف كامل المتراكم في شهر واحد عبر DEPR:id:DISP catch-up).
  // إضافة زرّ تشغيل يدوي يُكمل الشريحة الرأسية للـendpoint القائم والمُختبَر (idempotent).
  const [depPeriod, setDepPeriod] = useState<string>(previousMonthYm());
  const utils = trpc.useUtils();
  const postDep = trpc.assets.postDepreciation.useMutation({
    onSuccess: (r) => {
      notify.ok(`تمّ ترحيل إهلاك ${r.period}: ${r.assetsPosted} أصلاً، إجمالي ${iqd(r.totalDepreciation)} د.ع`);
      utils.assets.dashboard.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  async function runDepreciation() {
    const [ys, ms] = depPeriod.split("-");
    const year = parseInt(ys, 10);
    const month = parseInt(ms, 10);
    if (!(year >= 2000 && year <= 2200) || !(month >= 1 && month <= 12)) {
      notify.warn("اختر شهراً صالحاً.");
      return;
    }
    if (!(await confirm({
      variant: "info",
      title: "ترحيل إهلاك الشهر",
      description: `سيُرحَّل إهلاك ${depPeriod} لكل الأصول النشطة (يتخطّى تلقائياً ما رُحِّل سابقاً — idempotent). قيد ADJUST/DEPR في الدفتر.`,
      confirmText: "ترحيل",
    }))) return;
    postDep.mutate({ year, month });
  }

  if (dash.isLoading) return <LoadingState />;
  if (dash.error) return <ErrorState message={`تعذّر تحميل لوحة الأصول: ${dash.error.message}`} onRetry={() => dash.refetch()} />;
  const d = dash.data!;
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.value));

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة الأصول الثابتة"
        actions={
          <div className="flex items-center gap-2">
            <Link href="/assets/register"><Button variant="outline" size="sm">سجلّ الأصول</Button></Link>
            <Button size="sm" onClick={() => navigate("/assets/new")}>+ أصل جديد</Button>
          </div>
        }
      />

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
          <CardHeader><CardTitle className="text-base flex items-center gap-1.5"><AlertTriangle className="size-4 text-[var(--stock-low)]" />تحتاج إجراءً</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {d.needsAction.length === 0 && <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5">لا شيء يحتاج إجراءً الآن. <ThumbsUp aria-hidden className="size-4" /></p>}
            {d.needsAction.map((n) => (
              <Link key={n.id} href={`/assets/${n.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-accent text-sm transition">
                <span className="truncate">{n.name}</span>
                <span className="text-xs text-muted-foreground shrink-0 me-1">{n.reason}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* ترحيل الإهلاك الشهري — إكمال الشريحة الرأسية لـpostDepreciation (لا مُشغِّل قبل هذه الشاشة). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <CalendarClock aria-hidden className="size-4" />
            ترحيل الإهلاك الشهري
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-3 md:items-end">
            <div className="space-y-1">
              <Label htmlFor="dep-period">الشهر</Label>
              <Input
                id="dep-period"
                type="month"
                dir="ltr"
                value={depPeriod}
                min="2000-01"
                max="2200-12"
                onChange={(e) => setDepPeriod(e.target.value)}
                className="w-40"
              />
            </div>
            <Button onClick={runDepreciation} disabled={postDep.isPending}>
              {postDep.isPending ? "جارٍ الترحيل…" : "ترحيل إهلاك الشهر"}
            </Button>
            <p className="text-xs text-muted-foreground md:me-auto max-w-lg">
              يُرحَّل مصروف الإهلاك لكل الأصول النشطة (SL/DB) على أساس التاريخ المطلوب. آمن للتكرار — لن يُنشئ قيداً مضاعفاً لشهر مُرحَّل.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* أحدث الصيانة */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">أحدث عمليات الصيانة</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الأصل</th>
                  <th className="p-2">النوع</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2 text-right">التكلفة</th>
                </tr>
              </thead>
              <tbody>
                {d.recentMaintenance.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="p-2">{m.assetName ?? "—"} <span className="text-xs text-muted-foreground" dir="ltr">{m.assetCode ?? ""}</span></td>
                    <td className="p-2 text-xs">{m.type}</td>
                    <td className="p-2 text-xs" dir="ltr">{m.maintDate}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(m.cost)}</td>
                  </tr>
                ))}
                {d.recentMaintenance.length === 0 && (
                  <TableEmptyRow colSpan={4} message="لا عمليات صيانة بعد." />
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

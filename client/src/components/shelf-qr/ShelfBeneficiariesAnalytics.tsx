/**
 * ShelfBeneficiariesAnalytics — لوحة إحصائيات ومؤشرات المستفيدين من خدمة استعلام أسعار الرفوف بالباركود.
 *
 * تعرض لإدارة المعرض والفروع:
 *  - عدد المستفيدين الفريدين الفعليين من زوار المعرض.
 *  - إجمالي عمليات مسح الباركود واستعلامات الأسعار.
 *  - استعلامات اليوم ومعدل المطابقة والنجاح.
 *  - توزيع النشاط حسب الفروع وأجهزة الزبائن (Android / iOS).
 *  - منحنى ساعات الذروة لنشاط الزوار في المعرض.
 *  - قائمة أكثر الأصناف بحثاً واستعلاماً على الرفوف.
 *  - سجل العمليات اللحظي المباشر.
 */
import { useState } from "react";
import {
  Users,
  ScanLine,
  CheckCircle2,
  AlertCircle,
  Store,
  Smartphone,
  TrendingUp,
  RefreshCw,
  Sparkles,
  Layers,
  Clock,
  Laptop,
  Check,
  ShoppingBag,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtAr, formatIqd } from "@/lib/money";

interface Props {
  branches: Array<{ id: number; name: string }>;
  defaultBranchId?: string;
}

export function ShelfBeneficiariesAnalytics({ branches, defaultBranchId = "" }: Props) {
  const [range, setRange] = useState<"today" | "7d" | "30d" | "all">("7d");
  const [selectedBranchId, setSelectedBranchId] = useState<string>(defaultBranchId);

  const utils = trpc.useUtils();

  const branchFilterId = selectedBranchId ? Number(selectedBranchId) : undefined;

  const statsQ = trpc.shelfAnalytics.getStats.useQuery(
    {
      branchId: branchFilterId,
      range,
    },
    {
      refetchInterval: 20_000, // تحديث دوري تلقائي كل 20 ثانية لمتابعة الاستعلامات الحية
    },
  );

  const seedMutation = trpc.shelfAnalytics.seedDemo.useMutation({
    onSuccess: (res) => {
      notify.ok(`تمت تعبئة ${res.count} عملية استعلام استرشادية واقعية بنجاح.`);
      utils.shelfAnalytics.getStats.invalidate();
    },
    onError: () => {
      notify.err("تعذّرت تعبئة البيانات الاسترشادية.");
    },
  });

  const stats = statsQ.data;
  const isRefreshing = statsQ.isFetching;

  // إيجاد أقصى عدد استعلامات في المنحنى الزمني لحساب النسب المئوية للأعمدة
  const maxTimelineScans = Math.max(
    1,
    ...(stats?.activityTimeline.map((t) => t.scans) ?? [1]),
  );

  // إيجاد أقصى استعلام للمنتجات لحساب شريط التقدم
  const maxProductScans = Math.max(
    1,
    ...(stats?.topProducts.map((p) => p.scanCount) ?? [1]),
  );

  // حساب النسبة المئوية للأجهزة
  const totalDeviceScans =
    (stats?.deviceBreakdown.android ?? 0) +
    (stats?.deviceBreakdown.ios ?? 0) +
    (stats?.deviceBreakdown.desktop ?? 0) +
    (stats?.deviceBreakdown.other ?? 0) || 1;

  const androidPct = Math.round(((stats?.deviceBreakdown.android ?? 0) / totalDeviceScans) * 100);
  const iosPct = Math.round(((stats?.deviceBreakdown.ios ?? 0) / totalDeviceScans) * 100);
  const desktopPct = Math.round(
    (((stats?.deviceBreakdown.desktop ?? 0) + (stats?.deviceBreakdown.other ?? 0)) / totalDeviceScans) *
      100,
  );

  return (
    <div className="space-y-6">
      {/* شريط الفلاتر وأدوات التحكم */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-4 bg-card rounded-xl border shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground whitespace-nowrap">الفترة:</span>
            <AppSelect
              value={range}
              onValueChange={(v) => setRange(v as any)}
              className="w-36 h-9 text-xs"
            >
              <option value="today">اليوم فقط</option>
              <option value="7d">آخر 7 أيام</option>
              <option value="30d">آخر 30 يوماً</option>
              <option value="all">كل الأوقات</option>
            </AppSelect>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground whitespace-nowrap">الفرع:</span>
            <AppSelect
              value={selectedBranchId}
              onValueChange={setSelectedBranchId}
              className="w-44 h-9 text-xs"
            >
              <option value="">كل الفروع (عام)</option>
              {branches.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => statsQ.refetch()}
            disabled={isRefreshing}
            className="h-9 gap-1.5 text-xs"
            title="تحديث الأرقام والإحصائيات الحية"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin text-primary" : ""}`} />
            <span>تحديث مباشر</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => seedMutation.mutate({ count: 45 })}
            disabled={seedMutation.isPending}
            className="h-9 gap-1.5 text-xs font-medium"
            title="توليد عينة استعلامات واقعية لحركة زوار المعرض للمعاينة والتحليل"
          >
            <Sparkles className="size-3.5 text-primary" />
            <span>بيانات استرشادية</span>
          </Button>
        </div>
      </div>

      {/* بطاقات مؤشرات الأداء الحيوية الأربعة (KPIs) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* عدد المستفيدين الفريدين */}
        <Card className="border-primary/25 bg-gradient-to-br from-primary/5 via-card to-card shadow-xs">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs font-bold text-muted-foreground">عدد المستفيدين من الخدمة</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Users className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-foreground tracking-tight">
              {fmtAr(stats?.uniqueBeneficiaries ?? 0)}
              <span className="text-xs font-semibold text-muted-foreground mr-1.5">زبون مستفيد</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] bg-primary/10 text-primary border-primary/20">
                +{fmtAr(stats?.todayBeneficiaries ?? 0)} اليوم
              </Badge>
              <span>أجهزة زوار فريدة ممسوحة</span>
            </div>
          </CardContent>
        </Card>

        {/* إجمالي الاستعلامات والمسح */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs font-bold text-muted-foreground">إجمالي عمليات المسح</CardTitle>
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-600">
              <ScanLine className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-foreground tracking-tight">
              {fmtAr(stats?.totalScans ?? 0)}
              <span className="text-xs font-semibold text-muted-foreground mr-1.5">استعلام باركود</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] bg-blue-500/10 text-blue-700 border-blue-200">
                +{fmtAr(stats?.todayScans ?? 0)} اليوم
              </Badge>
              <span>مسح أسعار حي على الرفوف</span>
            </div>
          </CardContent>
        </Card>

        {/* نسبة نجاح ومطابقة الأصناف */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs font-bold text-muted-foreground">معدل مطابقة الأصناف</CardTitle>
            <div className="p-2 rounded-lg bg-[var(--status-active)]/10 text-[var(--status-active)]">
              <CheckCircle2 className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-foreground tracking-tight">
              %{stats ? stats.successRate : 100}
              <span className="text-xs font-semibold text-muted-foreground mr-1.5">نجاح الاستعلام</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
              <span className="text-[var(--status-active)] font-bold">{fmtAr(stats?.foundScans ?? 0)} تم العثور</span>
              <span>•</span>
              <span className="text-muted-foreground">{fmtAr(stats?.notFoundScans ?? 0)} غير مسجل</span>
            </div>
          </CardContent>
        </Card>

        {/* توزيع ونوع أجهزة الهواتف */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs font-bold text-muted-foreground">أجهزة الزبائن بالمعرض</CardTitle>
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-600">
              <Smartphone className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-black text-foreground tracking-tight">
              %{androidPct}
              <span className="text-xs font-semibold text-muted-foreground mr-1.5">أندرويد | %{iosPct} آيفون</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2 mt-2 flex overflow-hidden">
              <div className="bg-primary h-2" style={{ width: `${androidPct}%` }} title={`أندرويد: ${androidPct}%`} />
              <div className="bg-sky-500 h-2" style={{ width: `${iosPct}%` }} title={`iOS / آيفون: ${iosPct}%`} />
              <div className="bg-amber-400 h-2" style={{ width: `${desktopPct}%` }} title={`أخرى: ${desktopPct}%`} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* القسم التحليلي: منحنى النشاط الزمني وساعات الذروة + مقارنة الفروع */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* منحنى النشاط الزمني وساعات الذروة (7 أعمدة) */}
        <Card className="lg:col-span-7">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="size-4 text-primary" />
                  <span>ساعات الذروة ونشاط الاستعلام في المعرض</span>
                </CardTitle>
                <CardDescription>
                  {range === "today"
                    ? "توزيع فترات مسح الباركود على مدار ساعات عمل المعرض اليوم"
                    : "حجم استعلامات الأسعار والمستفيدين خلال الأيام المختارة"}
                </CardDescription>
              </div>
              <Badge variant="outline" className="text-xs">
                {range === "today" ? "بتوقيت بغداد" : `${stats?.activityTimeline.length ?? 0} فترات مسجلة`}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {stats && stats.activityTimeline.length > 0 ? (
              <div className="space-y-3 pt-2">
                <div className="grid grid-cols-5 sm:grid-cols-7 gap-2 items-end min-h-[160px] pb-2 border-b">
                  {stats.activityTimeline.map((item, idx) => {
                    const heightPercent = Math.max(12, Math.round((item.scans / maxTimelineScans) * 100));
                    return (
                      <div key={idx} className="flex flex-col items-center gap-1.5 flex-1 h-full justify-end group">
                        <div className="text-[10px] font-bold text-primary opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                          {fmtAr(item.scans)}
                        </div>
                        <div
                          className="w-full max-w-[36px] bg-primary/20 hover:bg-primary/40 rounded-t-md transition-all relative flex flex-col justify-end"
                          style={{ height: `${heightPercent}%` }}
                        >
                          <div
                            className="w-full bg-primary rounded-t-md"
                            style={{
                              height: item.scans > 0 ? `${Math.max(20, (item.beneficiaries / (item.scans || 1)) * 100)}%` : "0%",
                            }}
                          />
                        </div>
                        <div className="text-[10px] text-muted-foreground font-medium truncate max-w-full text-center">
                          {item.label}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground pt-1">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-full bg-primary inline-block" />
                      <span>المستفيدون (الزوار)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-full bg-primary/30 inline-block" />
                      <span>إجمالي المسح</span>
                    </div>
                  </div>
                  <span className="text-[11px]">البيانات تتجدد آلياً مع كل مسح باركود بالهاتف</span>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-muted-foreground text-sm">
                لا توجد عمليات مسح مسجلة في هذا النطاق الزمني حتى الآن.
              </div>
            )}
          </CardContent>
        </Card>

        {/* توزيع الفروع ونشاط المعارض (5 أعمدة) */}
        <Card className="lg:col-span-5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Store className="size-4 text-primary" />
              <span>توزيع الاستعلامات حسب المعارض والفروع</span>
            </CardTitle>
            <CardDescription>مقارنة حجم التفاعل ومسح الرفوف بين فروع الشركة</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {stats && stats.branchBreakdown.length > 0 ? (
              stats.branchBreakdown.map((b, i) => {
                const total = stats.totalScans || 1;
                const pct = Math.round((b.scanCount / total) * 100);
                return (
                  <div key={i} className="p-3 rounded-lg border bg-muted/20 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Store className="size-4 text-primary" />
                        <span className="font-bold text-foreground">{b.branchName}</span>
                        {b.branchCode && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {b.branchCode}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs font-semibold text-muted-foreground">
                        %{pct} ({fmtAr(b.scanCount)} مسح)
                      </div>
                    </div>

                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                      <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
                      <span>{fmtAr(b.beneficiaryCount)} زبون فريد</span>
                      <span>معدل {b.beneficiaryCount > 0 ? Math.round((b.scanCount / b.beneficiaryCount) * 10) / 10 : 0} مسح/زبون</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-8 text-center text-muted-foreground text-sm">
                لم يتم تسجيل أي استعلامات حسب الفروع بعد.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* أكثر الأصناف استعلاماً وبحثاً من الزبائن على الرفوف */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <ShoppingBag className="size-4 text-primary" />
                <span>أكثر الأصناف استعلاماً وبحثاً من قِبل الزبائن (Top Scanned Products)</span>
              </CardTitle>
              <CardDescription>
                المنتجات التي مسحها الزبائن على الرفوف بأعلى معدل لمعرفة الأسعار والعروض الترويجية
              </CardDescription>
            </div>
            <span className="text-xs text-muted-foreground font-medium">أفضل 10 منتجات</span>
          </div>
        </CardHeader>
        <CardContent>
          {stats && stats.topProducts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {stats.topProducts.map((p, idx) => {
                const relativeWidth = Math.max(10, Math.round((p.scanCount / maxProductScans) * 100));
                return (
                  <div
                    key={p.productId || idx}
                    className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors shadow-2xs"
                  >
                    {/* رتبة المنتج */}
                    <div
                      className={`size-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 ${
                        idx === 0
                          ? "bg-amber-500 text-white shadow-xs"
                          : idx === 1
                          ? "bg-gray-400 text-white"
                          : idx === 2
                          ? "bg-amber-700 text-white"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {idx + 1}
                    </div>

                    {/* الصورة إن وجدت */}
                    <div className="size-12 rounded-md bg-muted/40 border flex items-center justify-center shrink-0 overflow-hidden">
                      {p.imageUrl ? (
                        <img
                          src={p.imageUrl}
                          alt={p.productName}
                          className="size-full object-contain p-0.5"
                          loading="lazy"
                        />
                      ) : (
                        <ShoppingBag className="size-5 text-muted-foreground/40" />
                      )}
                    </div>

                    {/* تفاصيل المنتج وشريط المسح */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-xs font-bold text-foreground truncate" title={p.productName}>
                          {p.productName}
                        </h4>
                        <span className="text-xs font-black text-primary shrink-0">
                          {p.price ? formatIqd(p.price) : "غير محدد"}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        {p.brand && <span>{p.brand}</span>}
                        {p.brand && p.category && <span>•</span>}
                        {p.category && <span>{p.category}</span>}
                        <span>•</span>
                        <span className="font-mono">{p.barcode}</span>
                      </div>

                      <div className="flex items-center gap-2 pt-0.5">
                        <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className="bg-primary h-1.5 rounded-full"
                            style={{ width: `${relativeWidth}%` }}
                          />
                        </div>
                        <span className="text-[11px] font-bold text-foreground shrink-0">
                          {fmtAr(p.scanCount)} مسح
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground text-sm">
              لا توجد منتجات مسجلة في عمليات المسح حتى الآن.
            </div>
          )}
        </CardContent>
      </Card>

      {/* سجل العمليات والنشاط المباشر اللحظي (Live Stream) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="size-4 text-primary" />
                <span>سجل النشاط المباشر واللحظي (Live Activity Feed)</span>
              </CardTitle>
              <CardDescription>
                آخر عمليات الاستعلام التي نفذها زوار المعرض بكاميرات هواتفهم
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs gap-1">
              <span className="size-1.5 rounded-full bg-[var(--status-active)] animate-pulse" />
              <span>مباشر</span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {stats && stats.recentScans.length > 0 ? (
            <div className="divide-y rounded-lg border overflow-hidden">
              {stats.recentScans.map((scan) => {
                const scanDate = new Date(scan.createdAt);
                const timeString = scanDate.toLocaleTimeString("ar-IQ-u-nu-latn", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return (
                  <div
                    key={scan.id}
                    className="p-3 flex items-center justify-between gap-3 text-xs bg-card hover:bg-muted/20 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`size-8 rounded-full flex items-center justify-center shrink-0 ${
                          scan.found
                            ? "bg-[var(--status-active)]/10 text-[var(--status-active)]"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {scan.found ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-foreground truncate">
                            {scan.productName || "صنف غير مسجل بالباركود"}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground bg-muted px-1 rounded">
                            {scan.barcode}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                          <span>{scan.branchName || "عام"}</span>
                          <span>•</span>
                          <span className="capitalize">{scan.deviceType}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
                      <span className="text-[11px] font-mono">{timeString}</span>
                      <Badge
                        variant={scan.found ? "default" : "destructive"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {scan.found ? "مطابق" : "غير موجود"}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground text-sm">
              لا توجد عمليات مسح حديثة مسجلة في السجل.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

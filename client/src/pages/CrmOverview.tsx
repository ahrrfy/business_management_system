/**
 * CrmOverview — لوحة المتابعة العامة والأدوات التشغيلية المشتركة (Milestone 6)
 *
 * تقدم قمرة قيادة تنفيذية شاملة وموحدة تلخص الأجنحة الأربعة لمركز رعاية العملاء:
 * 1. خدمة ورعاية الزبائن (Care)
 * 2. المبيعات وعروض الأسعار (Sales)
 * 3. التسويق والكوبونات والولاء (Marketing)
 * 4. الحسابات والديون والتحصيل (Finance)
 *
 * مع مؤشرات الأداء الستة المعتمدة بالعقد (Feature 18)، وروابط الوصول السريع الأربعة،
 * وبوابات الأجنحة الهرمية، والبحث المباشر عن الزبون لفتح الملف الشامل 360° بضغطة زر واحدة.
 *
 * متوافق تماماً مع حراس المستودع: صفر إيموجي، صفر جداول خام، توكنز دلالية حصراً،
 * حماية الصلاحيات المالية (RoleGate)، وطباعة رسمية A4 عبر printReportDoc.
 */

import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  HeartHandshake,
  TrendingUp,
  Megaphone,
  Wallet,
  MessageSquareWarning,
  Star,
  Receipt,
  Lock,
  ChevronLeft,
  Printer,
  RotateCw,
  User,
  MessageSquarePlus,
  FileText,
  Clock,
  Sparkles,
  ArrowUpRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { D, fmtAr } from "@/lib/money";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { CustomerSearchPicker } from "@/components/crm/CustomerSearchPicker";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtDate } from "@/lib/date";
import { cn } from "@/lib/utils";

const REPORT_VIEWER_GATE: RoleGate = {
  roles: ["manager", "accountant", "auditor"],
  module: "reports",
  level: "READ",
};

/** الإجراءات السريعة الأربعة المعتمدة في عقد Feature 18 */
const PRIMARY_QUICK_ACTIONS = [
  {
    label: "تسجيل شكوى",
    target: "/crm?wing=care&tab=complaints",
    icon: MessageSquarePlus,
    description: "متابعة ملاحظات وجودة الخدمة ومستوى رضا الزبائن",
    colorBadge: "text-[var(--sem-warn)] bg-[var(--sem-warn-bg)] border-[var(--sem-warn)]/20",
  },
  {
    label: "عرض سعر جديد",
    target: "/crm?wing=sales&tab=quotations",
    icon: FileText,
    description: "إنشاء ومقايسة عروض أسعار المطبوعات والقرطاسية",
    colorBadge: "text-primary bg-primary/10 border-primary/20",
  },
  {
    label: "إطلاق حملة",
    target: "/crm?wing=marketing&tab=campaigns",
    icon: Megaphone,
    description: "تخطيط الحملات الإعلانية وترويج العروض والكوبونات",
    colorBadge: "text-[var(--sem-info)] bg-[var(--sem-info-bg)] border-[var(--sem-info)]/20",
  },
  {
    label: "كشف الحسابات",
    target: "/crm?wing=finance&tab=statement",
    icon: Receipt,
    description: "استعراض حركات وفواتير ومطابقات ذمم الزبائن",
    colorBadge: "text-[var(--sem-pos)] bg-[var(--sem-pos-bg)] border-[var(--sem-pos)]/20",
  },
] as const;

/** بوابات الأجنحة الوظيفية الأربعة */
const WING_LAUNCHERS = [
  {
    id: "care",
    title: "خدمة ورعاية الزبائن",
    subtitle: "إدارة بيانات الزبائن، الشكاوى ورضا الزبائن، الملاحظات والمتابعات، ودليل أرقام الهواتف",
    target: "/crm?wing=care&tab=customers",
    icon: HeartHandshake,
    badge: "الجناح الأول",
    subTabs: [{ label: "قائمة الزبائن", tab: "customers" }, { label: "الشكاوى ورضا الزبائن", tab: "complaints" }, { label: "الملاحظات والمتابعات", tab: "followups" }, { label: "دليل أرقام الهواتف", tab: "contacts" }],
  },
  {
    id: "sales",
    title: "المبيعات وعروض الأسعار",
    subtitle: "عروض الأسعار والمقايسات، متابعة الصفقات والطلبات، والأسعار الخاصة لعقود الشركات",
    target: "/crm?wing=sales&tab=quotations",
    icon: TrendingUp,
    badge: "الجناح الثاني",
    subTabs: [{ label: "عروض الأسعار", tab: "quotations" }, { label: "متابعة الصفقات", tab: "pipeline" }, { label: "عقود الشركات", tab: "contracts" }],
  },
  {
    id: "marketing",
    title: "التسويق والكوبونات والولاء",
    subtitle: "الحملات الترويجية، رسائل الواتساب الجماعية، العروض والتخفيضات، وقسائم الكوبونات والهدايا",
    target: "/crm?wing=marketing&tab=campaigns",
    icon: Megaphone,
    badge: "الجناح الثالث",
    subTabs: [{ label: "الحملات الإعلانية", tab: "campaigns" }, { label: "رسائل الواتساب الجماعية", tab: "broadcasts" }, { label: "العروض والتخفيضات", tab: "offers" }, { label: "الكوبونات وقسائم الهدايا", tab: "coupons" }],
  },
  {
    id: "finance",
    title: "الحسابات والديون والتحصيل",
    subtitle: "كشوفات الحساب، تذكيرات سداد الديون، متابعة الديون المتأخرة، والأقساط الشهرية",
    target: "/crm?wing=finance&tab=statement",
    icon: Wallet,
    badge: "الجناح الرابع",
    subTabs: [{ label: "كشف حساب الزبون", tab: "statement" }, { label: "تذكيرات سداد الديون", tab: "collections" }, { label: "متابعة الديون المتأخرة", tab: "aging" }, { label: "الأقساط الشهرية", tab: "installments" }],
  },
] as const;

export default function CrmOverview() {
  const me = trpc.auth.me.useQuery();
  const canViewReports = canSeeGate(REPORT_VIEWER_GATE, me.data?.role, me.data?.permissionsOverride);

  // استعلامات الأجنحة الأربعة
  const feedbackQ = trpc.customers.feedbackList.useQuery({ limit: 100 });
  const salesPipelineQ = trpc.salesPipeline.dashboard.useQuery();
  const crmStatsQ = trpc.crm.dashboard.useQuery();
  const arAgingQ = trpc.reports.arAging.useQuery(undefined, {
    enabled: Boolean(canViewReports),
  });

  const isLoadingMetrics =
    feedbackQ.isLoading || salesPipelineQ.isLoading || crmStatsQ.isLoading || (Boolean(canViewReports) && arAgingQ.isLoading);

  // حساب مؤشرات الأداء الستة المعتمدة
  const metrics = useMemo(() => {
    const feedbacks = feedbackQ.data ?? [];
    const totalFeedbacks = feedbacks.length;
    const avgRating = totalFeedbacks > 0
      ? (feedbacks.reduce((sum, item) => sum + (item.rating || 0), 0) / totalFeedbacks).toFixed(1)
      : "0.0";
    const satisfactionRate = totalFeedbacks > 0 ? Math.round((Number(avgRating) / 5) * 100) : 100;
    const pendingComplaints = feedbacks.filter((i) => i.issueStatus === "NEW" || i.issueStatus === "IN_PROGRESS").length;

    const oppCounts = salesPipelineQ.data?.opportunityCounts;
    const activeDeals = oppCounts ? (oppCounts.DISCOVERY ?? 0) + (oppCounts.PROPOSAL ?? 0) + (oppCounts.NEGOTIATION ?? 0) : 0;
    const activeCampaigns = crmStatsQ.data?.campaigns?.active ?? 0;

    let totalReceivables = D(0);
    let overdueCount = 0;
    if (canViewReports && arAgingQ.data) {
      for (const row of arAgingQ.data) {
        const currentBal = D(row.currentBalance ?? 0);
        const unbucketedVal = D(row.unbucketed ?? 0);
        const unbucketedPos = unbucketedVal.gt(0) ? unbucketedVal : D(0);
        const effectiveReceivable = currentBal.gt(0)
          ? currentBal
          : D(row.unpaidTotal ?? 0).plus(unbucketedPos);
        totalReceivables = totalReceivables.plus(effectiveReceivable);
        const overdueSum = D(row.d31_60 || 0).plus(D(row.d61_90 || 0)).plus(D(row.d91p || 0));
        if (overdueSum.gt(0)) overdueCount++;
      }
    }

    return {
      satisfactionScore: avgRating,
      satisfactionRate,
      pendingComplaintsCount: pendingComplaints,
      activeDealsCount: activeDeals,
      activeCampaignsCount: activeCampaigns,
      totalReceivablesBalance: totalReceivables.toFixed(2),
      overdueReceivablesCount: overdueCount,
    };
  }, [feedbackQ.data, salesPipelineQ.data, crmStatsQ.data, arAgingQ.data, canViewReports]);

  const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);

  const handleRefetch = () => {
    feedbackQ.refetch();
    salesPipelineQ.refetch();
    crmStatsQ.refetch();
    if (canViewReports) arAgingQ.refetch();
  };

  const handlePrintCockpitReport = () => {
    printReportDoc({
      title: "لوحة المتابعة العامة — التقرير التنفيذي الموحد",
      note: "ملخص الأداء الموحد لأجنحة خدمة ورعاية الزبائن، المبيعات، التسويق، والتحصيل.",
      headerExtra: [
        { label: "تاريخ الإصدار", value: fmtDate(new Date()) },
        { label: "المستخدم", value: me.data?.name || "المشرف العام" },
      ],
      columns: [
        { key: "metric", label: "المؤشر القياسي" },
        { key: "value", label: "القيمة الحالية", align: "left" },
        { key: "status", label: "حالة الأداء" },
        { key: "wing", label: "الجناح المسؤول" },
      ],
      rows: [
        { metric: "معدل رضا الزبائن", value: `${metrics.satisfactionScore} / 5.0 (${metrics.satisfactionRate}%)`, status: Number(metrics.satisfactionScore) >= 4 ? "ممتاز" : "يحتاج متابعة", wing: "خدمة ورعاية الزبائن" },
        { metric: "الشكاوى قيد المتابعة", value: `${metrics.pendingComplaintsCount} شكوى`, status: metrics.pendingComplaintsCount === 0 ? "مستقر" : "مفتوحة", wing: "خدمة ورعاية الزبائن" },
        { metric: "الصفقات الجارية في المسار", value: `${metrics.activeDealsCount} صفقة`, status: metrics.activeDealsCount > 0 ? "نشط" : "راكد", wing: "المبيعات وعروض الأسعار" },
        { metric: "الحملات الإعلانية النشطة", value: `${metrics.activeCampaignsCount} حملة`, status: metrics.activeCampaignsCount > 0 ? "جارية" : "لا توجد حملات", wing: "التسويق والكوبونات والولاء" },
        { metric: "إجمالي أرصدة الذمم والديون", value: canViewReports ? `${fmtAr(metrics.totalReceivablesBalance)} د.ع` : "محمي بالصلاحية", status: canViewReports ? "قائم" : "محمي", wing: "الحسابات والديون والتحصيل" },
        { metric: "الحسابات المتأخرة بالسداد", value: canViewReports ? `${metrics.overdueReceivablesCount} حساب` : "محمي بالصلاحية", status: canViewReports && metrics.overdueReceivablesCount > 0 ? "تنبيه متأخرات" : "مستقر", wing: "الحسابات والديون والتحصيل" },
      ],
      summary: [
        { label: "الصفقات الجارية", value: `${metrics.activeDealsCount}` },
        { label: "معدل الرضا العام", value: `${metrics.satisfactionRate}%` },
        ...(canViewReports ? [{ label: "إجمالي الذمم القائمة", value: `${fmtAr(metrics.totalReceivablesBalance)} د.ع`, large: true, bold: true }] : []),
      ],
    });
  };

  const kpiCards = [
    {
      id: "satisfaction",
      label: "معدل رضا الزبائن",
      icon: Star,
      iconCls: "text-[var(--sem-warn)]",
      val: `${metrics.satisfactionScore} / 5`,
      chip: `${metrics.satisfactionRate}% رضا`,
      chipCls: Number(metrics.satisfactionScore) >= 4.0 ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : Number(metrics.satisfactionScore) >= 3.0 ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
    },
    {
      id: "complaints",
      label: "شكاوى قيد المتابعة",
      icon: MessageSquareWarning,
      iconCls: "text-[var(--sem-warn)]",
      val: metrics.pendingComplaintsCount,
      chip: metrics.pendingComplaintsCount === 0 ? "كل الشكاوى محلولة" : "تحتاج معالجة",
      chipCls: metrics.pendingComplaintsCount === 0 ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    },
    {
      id: "deals",
      label: "الصفقات الجارية",
      icon: TrendingUp,
      iconCls: "text-primary",
      val: metrics.activeDealsCount,
      chip: metrics.activeDealsCount > 0 ? "في المسار التجاري" : "لا توجد صفقات",
      chipCls: metrics.activeDealsCount > 0 ? "bg-primary/10 text-primary" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    },
    {
      id: "campaigns",
      label: "الحملات الإعلانية",
      icon: Megaphone,
      iconCls: "text-[var(--sem-info)]",
      val: metrics.activeCampaignsCount,
      chip: metrics.activeCampaignsCount > 0 ? "حملات جارية" : "لا حملات نشطة",
      chipCls: metrics.activeCampaignsCount > 0 ? "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" : "bg-muted text-muted-foreground",
    },
    {
      id: "receivables",
      label: "إجمالي الذمم",
      icon: Wallet,
      iconCls: "text-[var(--sem-pos)]",
      locked: !canViewReports,
      val: `${fmtAr(metrics.totalReceivablesBalance)} د.ع`,
      chip: "ذمم قائمة",
      chipCls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    },
    {
      id: "overdue",
      label: "حسابات متأخرة",
      icon: Clock,
      iconCls: "text-[var(--sem-neg)]",
      locked: !canViewReports,
      val: metrics.overdueReceivablesCount,
      chip: metrics.overdueReceivablesCount === 0 ? "لا متأخرات" : "تحتاج تحصيل",
      chipCls: metrics.overdueReceivablesCount === 0 ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
    },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {/* 1. ترويسة الصفحة الرسمية */}
      <PageHeader
        title="لوحة المتابعة العامة"
        description="نظرة شاملة وموحدة على أداء رعاية الزبائن، المبيعات، الحملات، والتحصيل مع أدوات وصول سريعة."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefetch} className="gap-1.5" title="تحديث مؤشرات الأداء الحية">
              <RotateCw className="size-4" aria-hidden />
              <span>تحديث</span>
            </Button>
            <Button variant="outline" size="sm" onClick={handlePrintCockpitReport} className="gap-1.5" title="طباعة التقرير التنفيذي الرسمي A4">
              <Printer className="size-4" aria-hidden />
              <span>طباعة التقرير</span>
            </Button>
          </div>
        }
      />

      {/* 2. شريط البحث السريع والملف الشامل 360° للزبون */}
      <Card className="border-primary/20 bg-card/60 backdrop-blur-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <User className="size-5" aria-hidden />
              </div>
              <div>
                <CardTitle className="text-base font-bold">الملف الشامل 360° للزبون</CardTitle>
                <CardDescription className="text-xs">
                  ابحث بالاسم، الهاتف (07xx)، أو امسح الباركود لفتح بطاقة العميل وسجل المعاملات والديون فوراً
                </CardDescription>
              </div>
            </div>
            <Badge variant="outline" className="gap-1 text-xs">
              <Sparkles className="size-3 text-primary" aria-hidden />
              <span>وصول فوري موحّد</span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <CustomerSearchPicker onSelectCustomer={setDossierCustomerId} />
        </CardContent>
      </Card>

      {/* 3. شبكة مؤشرات الأداء العليا (6 Mandated Executive Cockpit Metrics) */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-muted-foreground">مؤشرات الأداء التشغيلية والتنفيذية</h2>
          <span className="text-xs text-muted-foreground">تحديث لحظي من الأجنحة الأربعة</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {kpiCards.map((kpi) => (
            <Card key={kpi.id} className="transition-colors hover:border-primary/40">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span className="text-xs font-semibold">{kpi.label}</span>
                  <kpi.icon className={cn("size-4", kpi.iconCls)} aria-hidden />
                </div>
                {kpi.locked ? (
                  <div className="space-y-1 py-1">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Lock className="size-3.5" aria-hidden />
                      <span>محمي بصلاحية الإدارة</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">غير متاح لدورك</span>
                  </div>
                ) : isLoadingMetrics ? (
                  <Skeleton className="h-8 w-20" />
                ) : (
                  <div className="space-y-1">
                    <div className="text-xl font-black truncate">{kpi.val}</div>
                    <div>
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", kpi.chipCls)}>
                        {kpi.chip}
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* 4. الإجراءات التشغيلية السريعة (4 Mandated Quick Links) */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-muted-foreground">أدوات وإجراءات الوصول السريع</h2>
          <span className="text-xs text-muted-foreground">انتقال مباشر للشاشات الميدانية</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {PRIMARY_QUICK_ACTIONS.map(({ label, target, icon: Icon, description, colorBadge }) => (
            <Link key={label} href={target} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full transition-all hover:border-primary/50 hover:bg-accent/40 hover:shadow-sm">
                <CardContent className="p-4 flex items-start gap-3">
                  <div className={cn("rounded-xl p-2.5 shrink-0 border", colorBadge)}>
                    <Icon className="size-5" aria-hidden />
                  </div>
                  <div className="space-y-1 min-w-0">
                    <div className="font-bold text-sm flex items-center gap-1">
                      <span>{label}</span>
                      <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden />
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      {description}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* 5. بوابات الأجنحة الوظيفية الأربعة (4 Wing Bento Cards) */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-muted-foreground">الأجنحة الوظيفية الأربعة</h2>
          <span className="text-xs text-muted-foreground">التنظيم الهرمي الشامل لوحدة العملاء</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {WING_LAUNCHERS.map(({ id, title, subtitle, target, icon: Icon, badge, subTabs }) => (
            <Card key={id} className="transition-all hover:border-primary/40 hover:shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-primary/10 text-primary p-3">
                    <Icon className="size-6" aria-hidden />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base font-bold">{title}</CardTitle>
                      <Badge variant="secondary" className="text-[10px] py-0 px-1.5">{badge}</Badge>
                    </div>
                    <CardDescription className="text-xs mt-1 leading-relaxed">{subtitle}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {subTabs.map(({ label, tab }) => (
                    <Link
                      key={tab}
                      href={`/crm?wing=${id}&tab=${tab}`}
                      className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-accent hover:text-foreground"
                    >
                      {label}
                    </Link>
                  ))}
                </div>
                <div className="pt-2 border-t flex justify-end">
                  <Link href={target} className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                    <span>الدخول للجناح</span>
                    <ChevronLeft className="size-3.5" aria-hidden />
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* 6. درج الملف الشامل للزبون 360° */}
      {dossierCustomerId && (
        <CustomerDossierDrawer
          customerId={dossierCustomerId}
          open={Boolean(dossierCustomerId)}
          onClose={() => setDossierCustomerId(null)}
        />
      )}
    </div>
  );
}

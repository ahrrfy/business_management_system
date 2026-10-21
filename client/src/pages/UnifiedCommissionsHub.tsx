// UnifiedCommissionsHub — محطة العمل الموحدة لإدارة العمولات والأهداف وإسناد المبيعات.
//
// تدمج الشاشات الثلاث السابقة (خطط العمولات + الأهداف الشهرية + احتساب العمولات)
// في محطة عمل واحدة متكاملة مع الحفاظ على التوافق الرجعي التام للروابط ودون فقدان
// مسودات الأهداف عند التبديل بين الأقسام (Zero Draft Loss).
//
// تتضمن لوحة مؤشرات عليا تفاعلية (Interactive Executive KPI Cockpit):
//   1. totalBaseSales: إجمالي المبيعات المؤهلة
//   2. averageAchievementPct: متوسط نسبة تحقيق الأهداف
//   3. totalCommissionDue: إجمالي العمولات المستحقة
//   4. runStatus: حالة الاعتماد وفصل المهام (SOD)
//   + الترحيل السالب (Negative Carryover)
import { useMemo, useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Calculator,
  Target,
  Layers,
  Users,
  Wallet,
  CheckCircle2,
  TrendingUp,
  ShieldCheck,
  ShieldAlert,
  Undo2,
  RefreshCw,
  Sparkles,
  Store,
  UserCheck,
  Receipt,
  Check,
  ArrowRightLeft,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { D } from "@/lib/money";
import { cn } from "@/lib/utils";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { thisMonth } from "@/components/form/MonthPicker";

// استيراد الأقسام الفرعية الأصلية للحفاظ على التوافق الكامل مع اختبارات الاعتماد والتشغيل
import CommissionRuns from "@/pages/CommissionRuns";
import CommissionTargets from "@/pages/CommissionTargets";
import CommissionPlans from "@/pages/CommissionPlans";

export type HubSubView = "runs" | "targets" | "plans" | "attribution";

export interface ExecutiveKpiCockpitProps {
  totalBaseSales: string | number;
  averageAchievementPct: number;
  totalCommissionDue: string | number;
  runStatus: string;
  negativeCarryover?: string | number;
}

interface StaffRosterRow {
  id: number;
  fullName: string;
  jobTitle: string;
  branchName: string;
  roleType: string;
  defaultSharePct: string;
  status: string;
}

export default function UnifiedCommissionsHub() {
  const [location] = useLocation();
  const search = useSearch();
  const utils = trpc.useUtils();

  // تحليل معامل الرابط الأولي ?tab= مع الحفاظ على التوافق الرجعي للروابط
  const resolveViewFromUrl = (queryStr: string): HubSubView => {
    const p = new URLSearchParams(queryStr).get("tab");
    if (p === "commission-runs" || p === "runs") return "runs";
    if (p === "commission-targets" || p === "targets") return "targets";
    if (p === "commission-plans" || p === "plans") return "plans";
    if (p === "attribution" || p === "sales-attribution") return "attribution";
    return "runs";
  };

  const [activeView, setActiveView] = useState<HubSubView>(() =>
    resolveViewFromUrl(search),
  );

  // التزامن التفاعلي مع تغيير الرابط الخارجي (مثل روابط شاشة الرواتب أو الرجوع بالمتصفح)
  useEffect(() => {
    const v = resolveViewFromUrl(search);
    setActiveView(v);
  }, [search]);

  // تبديل القسم الفرعي مع حفظ الرابط دون إلغاء تركيب الـ DOM
  const handleViewChange = (newView: HubSubView) => {
    setActiveView(newView);
    const legacyTabMap: Record<HubSubView, string> = {
      runs: "commission-runs",
      targets: "commission-targets",
      plans: "commission-plans",
      attribution: "attribution",
    };
    const params = new URLSearchParams(search);
    params.set("tab", legacyTabMap[newView]);
    const nextPath = `${location.split("?")[0]}?${params.toString()}`;
    window.history.replaceState(null, "", nextPath);
  };

  // استعلامات البيانات الحية للوحة المؤشرات العليا
  const me = trpc.auth.me.useQuery();
  const runsQ = trpc.commissions.runs.list.useQuery();
  const runs = runsQ.data ?? [];
  const latestRunId = runs.length > 0 ? Number(runs[0].id) : null;
  const runQ = trpc.commissions.runs.get.useQuery(
    { id: latestRunId ?? 0 },
    { enabled: latestRunId != null },
  );
  const run = runQ.data ?? null;

  const currentPeriod = run?.period ?? thisMonth();
  const targetsQ = trpc.commissions.targets.grid.useQuery({
    period: currentPeriod,
  });
  const targetRows = targetsQ.data ?? [];

  const employeesQ = trpc.employees.list.useQuery({
    status: "active",
    limit: 200,
  });
  const employees = employeesQ.data?.rows ?? [];

  // حساب مؤشرات الأداء التنفيذية الحية (Executive KPI Cockpit)
  const kpiData = useMemo(() => {
    const totalBaseSales = run
      ? D(run.totalBaseSales || "0")
          .minus(D(run.totalBaseReturns || "0"))
          .toFixed(2)
      : "0";
    const totalCommissionDue = run?.totalCommission ?? "0";
    const negativeCarryover =
      run?.lines
        ?.reduce((sumD, l) => sumD.plus(D(l.carryOut || "0")), D(0))
        .toFixed(2) ?? "0";

    const lines = run?.lines ?? [];
    let avgPct = 0;
    let reachedCount = 0;
    if (lines.length > 0) {
      const sumD = lines.reduce(
        (acc, l) => acc.plus(D(l.achievementPct || "0")),
        D(0),
      );
      avgPct = sumD.div(lines.length).toNumber();
      reachedCount = lines.filter((l) =>
        D(l.achievementPct || "0").gte(100),
      ).length;
    } else if (targetRows.length > 0) {
      reachedCount = targetRows.filter(
        (t) =>
          t.lastMonthActual != null &&
          t.target != null &&
          D(t.lastMonthActual).gte(D(t.target)),
      ).length;
      avgPct =
        targetRows.length > 0
          ? D(reachedCount).div(targetRows.length).times(100).toNumber()
          : 0;
    }

    const runStatus = run?.status ?? "draft";
    const runCreatedBy = run?.createdBy ?? null;
    const myUserId = Number(me.data?.id ?? 0);
    const isOwner = me.data?.isOwner === true;
    const canSelfApprove =
      isOwner || (runCreatedBy != null && runCreatedBy !== myUserId);

    return {
      totalBaseSales,
      averageAchievementPct: avgPct,
      totalCommissionDue,
      runStatus,
      negativeCarryover,
      reachedCount,
      totalStaffCount: lines.length || targetRows.length || employees.length,
      canSelfApprove,
      payrollRunId: run?.payrollRunId ?? null,
    };
  }, [run, targetRows, employees, me.data]);

  // تحديث البيانات الحية
  const handleRefreshAll = async () => {
    await Promise.all([
      utils.commissions.runs.list.invalidate(),
      utils.commissions.runs.get.invalidate(),
      utils.commissions.targets.grid.invalidate(),
      utils.commissions.plans.list.invalidate(),
      utils.employees.list.invalidate(),
    ]);
  };

  // بيانات جدول كادر صالة العرض وإسناد المبيعات
  const staffRosterData: StaffRosterRow[] = useMemo(() => {
    return employees.map((emp) => {
      const title = emp.position?.toLowerCase() ?? "";
      let roleType = "بائع صالة العرض (Floor Rep)";
      let share = "100% (مباشر)";

      if (title.includes("كاشير") || title.includes("صندوق")) {
        roleType = "كاشير ونقطة بيع (Cashier)";
        share = "حافز دقة ومطابقة الدرج";
      } else if (title.includes("استقبال") || title.includes("خدمة عملاء")) {
        roleType = "موظف استقبال (Receptionist)";
        share = "حافز فتح أوامر الشغل";
      } else if (
        title.includes("تجهيز") ||
        title.includes("مستودع") ||
        title.includes("توصيل")
      ) {
        roleType = "منفذ ومجهز طلبات (Fulfiller)";
        share = "مكافأة إنجاز الطرود";
      }

      return {
        id: Number(emp.id),
        fullName: emp.fullName || `موظف #${emp.id}`,
        jobTitle: emp.position || "موظف مبيعات",
        branchName: emp.branchName || "الفرع الرئيسي",
        roleType,
        defaultSharePct: share,
        status: emp.employmentStatus === "active" ? "نشط" : "غير نشط",
      };
    });
  }, [employees]);

  const staffRosterColumns: ColumnDef<StaffRosterRow, unknown>[] = useMemo(
    () => [
      {
        id: "employee",
        header: "الموظف",
        accessorFn: (r) => r.fullName,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <EmpAvatar name={row.original.fullName} sizePx={30} />
            <div>
              <div className="font-semibold text-sm">
                {row.original.fullName}
              </div>
              <div className="text-xs text-muted-foreground">
                {row.original.jobTitle}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "branch",
        header: "الفرع",
        accessorFn: (r) => r.branchName,
        cell: ({ row }) => (
          <span className="text-xs">{row.original.branchName}</span>
        ),
      },
      {
        id: "roleType",
        header: "الدور في دورة البيع",
        accessorFn: (r) => r.roleType,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
            <UserCheck className="size-3" aria-hidden />
            {row.original.roleType}
          </span>
        ),
      },
      {
        id: "defaultShare",
        header: "آلية الإسناد الافتراضية",
        accessorFn: (r) => r.defaultSharePct,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.defaultSharePct}
          </span>
        ),
      },
      {
        id: "status",
        header: "الحالة",
        accessorFn: (r) => r.status,
        cell: ({ row }) => (
          <span
            className={cn(
              "inline-block rounded-full px-2 py-0.5 text-xs font-semibold",
              row.original.status === "نشط"
                ? "badge-status-active"
                : "badge-stock-low",
            )}
          >
            {row.original.status}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {/* الترويسة الرئيسية لمحطة عمل العمولات */}
      <PageHeader
        title="مركز إدارة العمولات والأهداف"
        description="محطة عمل موحدة تجمع كشوفات وتشغيلات العمولات، الأهداف الشهرية، هيكل الخطط، وسياسات إسناد صالة العرض والمبيعات."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefreshAll}>
              <RefreshCw className="size-4" aria-hidden />
              تحديث البيانات
            </Button>
          </div>
        }
      />

      {/* لوحة المؤشرات العليا الحية (Live Interactive Executive KPI Summary Cockpit) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {/* بطاقة 1: إجمالي المبيعات المؤهلة (totalBaseSales) */}
        <Card
          data-testid="kpi-totalBaseSales"
          data-kpi="totalBaseSales"
          className="border-border/60 hover:border-primary/40 transition-colors"
        >
          <CardContent className="p-2.5">
            <div className="flex items-center justify-between text-muted-foreground text-xs">
              <span>إجمالي المبيعات المؤهلة</span>
              <span className="text-primary">
                <Wallet className="size-3.5" aria-hidden />
              </span>
            </div>
            <div
              className="mt-1 text-lg font-extrabold tabular-nums tracking-tight text-foreground"
              dir="ltr"
            >
              {iqd(kpiData.totalBaseSales)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              صافي المبيعات بعد المرتجعات
            </div>
          </CardContent>
        </Card>

        {/* بطاقة 2: المحقق من الأهداف (averageAchievementPct) */}
        <Card
          data-testid="kpi-averageAchievementPct"
          data-kpi="averageAchievementPct"
          className="border-border/60 hover:border-primary/40 transition-colors"
        >
          <CardContent className="p-2.5">
            <div className="flex items-center justify-between text-muted-foreground text-xs">
              <span>المحقق من الأهداف</span>
              <span className="text-blue-600 dark:text-blue-400">
                <TrendingUp className="size-3.5" aria-hidden />
              </span>
            </div>
            <div
              className="mt-1 text-lg font-extrabold tabular-nums tracking-tight text-foreground"
              dir="ltr"
            >
              {kpiData.averageAchievementPct.toFixed(1)}%
            </div>
            <div className="mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {kpiData.reachedCount} من {kpiData.totalStaffCount} موظفاً
              </span>
              <span
                className={
                  kpiData.averageAchievementPct >= 100
                    ? "text-money-positive font-bold"
                    : ""
                }
              >
                {kpiData.averageAchievementPct >= 100 ? "مكتمل" : "جارٍ"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* بطاقة 3: العمولات المستحقة (totalCommissionDue) */}
        <Card
          data-testid="kpi-totalCommissionDue"
          data-kpi="totalCommissionDue"
          className="border-border/60 hover:border-primary/40 transition-colors"
        >
          <CardContent className="p-2.5">
            <div className="flex items-center justify-between text-muted-foreground text-xs">
              <span>العمولات المستحقة</span>
              <span className="text-money-positive">
                <CheckCircle2 className="size-3.5" aria-hidden />
              </span>
            </div>
            <div
              className="mt-1 text-lg font-extrabold tabular-nums tracking-tight text-money-positive"
              dir="ltr"
            >
              {iqd(kpiData.totalCommissionDue)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {kpiData.payrollRunId
                ? "مدرجة في مسيّر الرواتب"
                : "مستحقة للكادر البيعي"}
            </div>
          </CardContent>
        </Card>

        {/* بطاقة 4: حالة التشغيلة والاعتماد (runStatus - Maker-Checker SOD) */}
        <Card
          data-testid="kpi-runStatus"
          data-kpi="runStatus"
          className="border-border/60 hover:border-primary/40 transition-colors"
        >
          <CardContent className="p-2.5">
            <div className="flex items-center justify-between text-muted-foreground text-xs">
              <span>حالة التشغيلة والاعتماد</span>
              <span
                className={
                  kpiData.runStatus === "approved"
                    ? "text-money-positive"
                    : "text-[var(--sem-warn)]"
                }
              >
                <ShieldCheck className="size-3.5" aria-hidden />
              </span>
            </div>
            <div className="mt-1 text-lg font-extrabold tracking-tight">
              {kpiData.runStatus === "approved" ? (
                <span className="text-money-positive">معتمدة أصولياً</span>
              ) : (
                <span className="text-[var(--sem-warn)]">مسودة</span>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {kpiData.runStatus === "approved"
                ? "معتمدة من مراجع مستقل (SOD)"
                : kpiData.canSelfApprove
                  ? "جاهزة للمراجعة والاعتماد"
                  : "بانتظار مراجع مستقل (فصل مهام)"}
            </div>
          </CardContent>
        </Card>

        {/* بطاقة 5: الترحيل السالب (negativeCarryover) */}
        <Card
          data-testid="kpi-negativeCarryover"
          data-kpi="negativeCarryover"
          className="border-border/60 hover:border-destructive/40 transition-colors"
        >
          <CardContent className="p-2.5">
            <div className="flex items-center justify-between text-muted-foreground text-xs">
              <span>الترحيل السالب</span>
              <span className="text-money-negative">
                <Undo2 className="size-3.5" aria-hidden />
              </span>
            </div>
            <div
              className="mt-1 text-lg font-extrabold tabular-nums tracking-tight text-money-negative"
              dir="ltr"
            >
              {iqd(kpiData.negativeCarryover)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              يُخصم من عمولة الشهر القادم
            </div>
          </CardContent>
        </Card>
      </div>

      {/* تحذير فصل المهام (SOD) لمسودات الاعتماد */}
      {!kpiData.canSelfApprove && kpiData.runStatus === "draft" && (
        <Card className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn)]/5 px-3 py-2 flex items-center gap-2.5">
          <ShieldAlert
            className="size-4 text-[var(--sem-warn)] shrink-0"
            aria-hidden
          />
          <div className="text-xs text-muted-foreground">
            <span className="font-bold text-foreground me-1">تحذير فصل المهام (SOD):</span>
            أنت من أنشأ هذه المسودة، ويلزم اعتمادها من مراجع/مدير آخر لضمان الحوكمة المؤسسية.
          </div>
        </Card>
      )}

      {/* شريط التحكم المجزأ بين الأقسام (Segmented View Controls - Zero Draft Loss) */}
      <div className="flex items-center gap-1.5 border-b border-border pb-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={() => handleViewChange("runs")}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all shrink-0 cursor-pointer",
            activeView === "runs"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-card border border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Calculator className="size-3.5" aria-hidden />
          احتساب وتشغيل العمولات
        </button>

        <button
          type="button"
          onClick={() => handleViewChange("targets")}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all shrink-0 cursor-pointer",
            activeView === "targets"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-card border border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Target className="size-3.5" aria-hidden />
          الأهداف الشهرية
        </button>

        <button
          type="button"
          onClick={() => handleViewChange("plans")}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all shrink-0 cursor-pointer",
            activeView === "plans"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-card border border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Layers className="size-3.5" aria-hidden />
          خطط العمولات
        </button>

        <button
          type="button"
          onClick={() => handleViewChange("attribution")}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all shrink-0 cursor-pointer",
            activeView === "attribution"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-card border border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Users className="size-3.5" aria-hidden />
          إسناد صالة العرض والمبيعات
        </button>
      </div>

      {/* قسم (1): تشغيل واحتساب العمولات */}
      <div className={activeView === "runs" ? "block space-y-3" : "hidden"}>
        <CommissionRuns />
      </div>

      {/* قسم (2): الأهداف الشهرية */}
      <div className={activeView === "targets" ? "block space-y-3" : "hidden"}>
        <CommissionTargets />
      </div>

      {/* قسم (3): خطط العمولات */}
      <div className={activeView === "plans" ? "block space-y-3" : "hidden"}>
        <CommissionPlans />
      </div>

      {/* قسم (4): إسناد صالة العرض والمبيعات */}
      <div
        className={activeView === "attribution" ? "block space-y-3" : "hidden"}
      >
        {/* جدول كادر صالة العرض والأدوار البيعية المسندة + ملخص قابل للطي لهندسة الإسناد */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between py-2.5 px-3.5">
            <div>
              <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                <Users className="size-4 text-primary" aria-hidden />
                كادر صالة العرض وتوزيع الأدوار البيعية
              </CardTitle>
              <div className="text-xs text-muted-foreground mt-0.5">
                سجل موظفي الصالة ومسؤولي المبيعات والاستقبال المؤهلين لاحتساب العمولات في الفروع.
              </div>
            </div>
            <details className="relative text-xs">
              <summary className="cursor-pointer select-none inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1 font-semibold text-primary hover:bg-primary/10">
                <Sparkles className="size-3.5" aria-hidden />
                هندسة إسناد المبيعات (٣ أنماط)
              </summary>
              <Card className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 p-2.5 text-xs shadow-sm">
                <div className="space-y-0.5">
                  <div className="font-bold text-foreground flex items-center gap-1">
                    <Check className="size-3 text-primary" aria-hidden />
                    إسناد مباشر (Direct - 100%)
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    تُسند المبيعات والعمولة بالكامل لموظف صالة العرض الذي باشر العميل.
                  </div>
                </div>
                <div className="space-y-0.5">
                  <div className="font-bold text-foreground flex items-center gap-1">
                    <ArrowRightLeft className="size-3 text-[var(--sem-info)]" aria-hidden />
                    عمولة مقسمة (Split Ratio)
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    تقسيم النسبة بعدالة (مثل 70% لبائع الصالة و 30% للكاشير أو الاستقبال).
                  </div>
                </div>
                <div className="space-y-0.5">
                  <div className="font-bold text-foreground flex items-center gap-1">
                    <Store className="size-3 text-money-positive" aria-hidden />
                    وعاء الصالة التشاركي (Team Pool)
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    تجميع عمولات الفرع في وعاء مشترك وتوزيعها بالتساوي أو بحسب الساعات.
                  </div>
                </div>
              </Card>
            </details>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <DataTable
              data={staffRosterData}
              columns={staffRosterColumns}
              searchable
              searchPlaceholder="بحث في كادر الصالة بالاسم أو المسمى…"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

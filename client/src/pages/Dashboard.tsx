import { trpc } from "@/lib/trpc";
import { fmtAr } from "@/lib/money";
import { fmtDate, fmtTime } from "@/lib/date";
import { useMediaQuery } from "@/hooks/useMobile";
import { Link } from "wouter";
import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { dashboardActionBranchId } from "@/lib/dashboardActionScope";
import { resolveWorkspaceProfile, type WorkspaceNavItem } from "@/lib/workspaceProfiles";
import { ROLE_LABEL } from "@/lib/roles";
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ArrowLeft, CalendarDays, MapPin, RefreshCw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { motion } from "framer-motion";
import { CashierHome } from "@/components/dashboard/CashierHome";
import { ErrorState, LoadingState } from "@/components/PageState";
import { TodaySalesBreakdown } from "@/components/dashboard/TodaySalesBreakdown";

/* ═══════════ THEME — CSS variables in tokens.css ═══════════
   مَربوطة بـ:root و.dark تِلقائياً ⇒ لا حاجة لـMutationObserver أو ThemeContext. */

const T = {
  bg:          "var(--dash-bg)",
  cardBg:      "var(--dash-card-bg)",
  cardBord:    "var(--dash-card-bord)",
  secLabel:    "var(--dash-sec-label)",
  text:        "var(--dash-text)",
  sub:         "var(--dash-sub)",
  muted:       "var(--dash-muted)",
  statBg:      "var(--dash-stat-bg)",
  statBord:    "var(--dash-stat-bord)",
  alertBg:     "var(--dash-alert-bg)",
  metricsBg:   "var(--dash-metrics-bg)",
  metricsBord: "var(--dash-metrics-bord)",
} as const;
const useT = () => T;

/* ═══════════ METRICS BAR ═══════════ */

const TrendIco = ({ color }: { color: string }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
    <polyline points="2,12 5,7 9,9 14,4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="10,4 14,4 14,8" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const WarnIco = ({ color }: { color: string }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
    <path d="M8,2 L14.5,13.5 H1.5 Z" stroke={color} strokeWidth="1.6" fill="none" strokeLinejoin="round" />
    <line x1="8" y1="7" x2="8" y2="10.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    <circle cx="8" cy="12.5" r="0.8" fill={color} />
  </svg>
);
const ShiftIco = ({ color }: { color: string }) => (
  <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.7" />
    <polyline points="8,4.5 8,8.5 10.5,10.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ═══════════ CONTEXT HEADER ═══════════
   رأسٌ عمليّ للصفحة: مَن يعمل؟ وفي أي نطاق؟ */

function DashboardHeader({
  branchScope,
  isAdmin,
  onBranchScopeChange,
}: {
  branchScope: number | undefined;
  isAdmin: boolean;
  onBranchScopeChange: (branchId: number | undefined) => void;
}) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: Boolean(me.data) });
  const selectedBranch = branches.data?.find((branch) => branch.id === branchScope);
  const branchLabel = branchScope == null ? "كل الفروع" : (selectedBranch?.name ?? "الفرع المعيّن");
  const roleLabel = me.data?.isOwner ? "مالك النظام" : (me.data?.customRoleLabel ?? (role ? ROLE_LABEL[role] : undefined) ?? "مستخدم النظام");
  const dateLabel = new Intl.DateTimeFormat("ar-IQ", { weekday: "long", day: "numeric", month: "long", year: "numeric", numberingSystem: "latn" }).format(new Date());

  return (
    <header style={{ background: T.cardBg, borderBottom: `1px solid ${T.cardBord}`, padding: "22px 24px 18px" }}>
      <div style={{ maxWidth: 1600, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 700, color: T.secLabel, marginBottom: 5 }}>الشاشة الرئيسية</div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", lineHeight: 1.35, fontWeight: 900, color: T.text }}>أهلاً {me.data?.name ?? "بك"}</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 9, color: T.sub, fontSize: "0.75rem" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <CalendarDays aria-hidden size={14} />
              {dateLabel}
            </span>
            <span aria-hidden style={{ color: T.cardBord }}>
              •
            </span>
            <span style={{ fontWeight: 700 }}>{roleLabel}</span>
            <span aria-hidden style={{ color: T.cardBord }}>
              •
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <MapPin aria-hidden size={13} />
              {branchLabel}
            </span>
          </div>
        </div>

        {isAdmin && (
          <div className="w-full sm:w-44">
            <AppSelect
              aria-label="نطاق فرع الشاشة الرئيسية"
              className="h-[42px] bg-background text-xs font-bold"
              value={branchScope == null ? "all" : String(branchScope)}
              onValueChange={(value) => onBranchScopeChange(value === "all" ? undefined : Number(value))}
            >
              <option value="all">كل الفروع</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={String(branch.id)}>{branch.name}</option>
              ))}
            </AppSelect>
          </div>
        )}
      </div>
    </header>
  );
}

function PrimaryActionsPanel({ items }: { items: readonly WorkspaceNavItem[] }) {
  const T = useT();
  if (items.length === 0) return null;

  return (
    <section
      aria-label="الإجراءات الرئيسية"
      style={{ maxWidth: 1648, margin: "0 auto", padding: "18px 24px 4px" }}
    >
      <div
        style={{
          padding: "14px",
          border: `1px solid ${T.cardBord}`,
          borderRadius: 10,
          background: T.cardBg,
        }}
      >
        <header style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 900, color: T.text }}>
            الإجراءات الرئيسية
          </h2>
          <p style={{ margin: "3px 0 0", fontSize: "0.75rem", color: T.muted }}>
            المسارات اليومية المتاحة حسب دورك وصلاحياتك.
          </p>
        </header>
        <nav
          aria-label="مسارات العمل الرئيسية"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 8 }}
        >
          {items.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              style={{
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                border: `1px solid ${T.cardBord}`,
                borderRadius: 8,
                background: T.statBg,
                color: T.text,
                fontSize: "0.8125rem",
                fontWeight: 800,
                textDecoration: "none",
              }}
            >
              <span>{item.label}</span>
              <ArrowLeft aria-hidden size={16} style={{ flexShrink: 0, color: T.sub }} />
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}

function profileActionHref(
  primaryNav: readonly WorkspaceNavItem[],
  actionId: string,
): string | undefined {
  return primaryNav.find((item) => item.id === actionId)?.href;
}

function MetricsBar({
  branchScope,
  primaryNav,
}: {
  branchScope: number | undefined;
  primaryNav: readonly WorkspaceNavItem[];
}) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const isXNarrow = useMediaQuery("(max-width: 640px)");
  const isNarrow = useMediaQuery("(max-width: 1023px)");
  const isCompactDesktop = useMediaQuery("(max-width: 1359px)");
  const metricCols = isXNarrow ? 2 : isNarrow ? 3 : isCompactDesktop ? 4 : 6;
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  // رؤية الأرقام المالية (ذمم متأخّرة/نبض المبيعات) — نفس بوّابة reportViewerProcedure/الخادم عبر
  // moduleAccessAllowed (لا قائمة أدوار حرفية ⇒ لا تباعُد). الخادم يُصفّر هذه الحقول لغير المخوّل؛
  // هنا نُخفي البطاقة كي لا تُعرَض «٠ ذمم متأخّرة» مضلِّلة لكاشير/مخزن (تدقيق تسريب dashboardMetrics).
  const canViewReports =
    !!role &&
    moduleAccessAllowed(
      role as RoleKey,
      override,
      "reports",
      "READ",
      ["manager", "accountant", "auditor"],
    );
  const canViewTreasury = !!role && hasModuleAccess(role, override, "treasury", "READ");
  const canViewInventory = !!role && hasModuleAccess(role, override, "inventory", "READ");
  const canViewCollections = !!role && hasModuleAccess(role, override, "collections", "READ");
  const canSeeStocktakes =
    (role === "admin" || role === "manager" || role === "warehouse") &&
    hasModuleAccess(role, override, "inventory", "FULL");
  const scopeReady = role === "admin" || branchScope !== undefined;
  const shift = trpc.shifts.current.useQuery(
    { branchId: branchScope ?? 0 },
    { enabled: canViewTreasury && branchScope !== undefined },
  );
  // مقاييس لوحة التحكم: مخزون منخفض + ذمم متأخّرة (الخلفية تُطبّق عزل الفرع).
  const metrics = trpc.reports.dashboardMetrics.useQuery(
    { branchId: branchScope, includeTodaySales: true },
    { enabled: (canViewReports || canViewInventory) && scopeReady },
  );
  // جلسات جرد بانتظار المراجعة — للأدوار المخوّلة فقط (الخادم warehouseProcedure).
  const stk = trpc.stocktakes.stats.useQuery(undefined, { enabled: canSeeStocktakes });

  const shiftLabel = shift.data ? "مفتوحة" : "لا وردية";
  const shiftSince = shift.data ? `منذ ${fmtTime(shift.data.openedAt)}` : "";

  const sourceErrors = metrics.data?.health.sourceErrors ?? [];
  const metricsUnavailable = metrics.isError;
  const todaySalesUnavailable = metricsUnavailable || sourceErrors.includes("todaySales");
  const pulseUnavailable = metricsUnavailable || sourceErrors.includes("salesPulse");
  const todaySales = metrics.data?.todaySales;
  const todaySalesValue = metrics.isLoading
    ? "—"
    : todaySalesUnavailable
      ? "غير متاح"
      : fmtAr(todaySales?.total ?? 0);
  const todayInvoicesValue = metrics.isLoading
    ? "—"
    : todaySalesUnavailable
      ? "غير متاح"
      : fmtAr(todaySales?.invoiceCount ?? 0);

  // قيم بطاقتَي التنبيه — حالة صريحة أثناء التحميل/التعذّر، والأرقام بعد النجاح.
  const lowStockValue = metrics.isLoading
    ? "—"
    : metricsUnavailable
      ? "غير متاح"
      : fmtAr(metrics.data?.lowStockCount ?? 0);
  const overdueCount = metrics.data?.overdueAR.count ?? 0;
  const overdueValue = metrics.isLoading ? "—" : metricsUnavailable ? "غير متاح" : fmtAr(overdueCount);
  // إجمالٌ مختصر بالدينار (بلا كسور — IQD).
  const overdueTotalShort = metrics.data
    ? fmtAr(Number(metrics.data.overdueAR.total))
    : "";
  const overdueUnit = metrics.isLoading
    ? ACTION_LABELS.refreshing
    : metricsUnavailable
      ? "حاول مجدداً"
    : overdueCount > 0
      ? `${overdueTotalShort} د.ع`
      : "> 30 يوم";

  // نص النسخ موحَّد: «التسمية: القيمة الوحدة» — يفيد المالك عند لصق رقم في واتساب/مراسلة.
  // أثناء التحميل أو التعذّر والحالات النصّية بلا قيمة = لا نسخ (CopyButton يُعطَّل تلقائياً على الفارغ).
  // نبض المبيعات (خلفية) — مبيعات أمس مقابل معدّل ٧ أيام + اتجاه بلون/سهم.
  const pulse = metrics.data?.salesPulse;
  const pulseColor =
    pulse?.direction === "up" ? "var(--sem-pos)" // أخضر — أعلى من المعدّل
    : pulse?.direction === "down" ? "var(--sem-neg)" // أحمر — أدنى
    : "var(--dash-muted)"; // رمادي — قرب المعدّل
  const pulseArrow = pulse?.direction === "up" ? "↑" : pulse?.direction === "down" ? "↓" : "=";
  const hasBaseline = !!pulse && Number(pulse.avg7d) > 0;

  const stats = [
    ...(canViewReports
      ? [
          {
            label: "مبيعات اليوم",
            value: todaySalesValue,
            unit: metrics.isLoading ? ACTION_LABELS.refreshing : todaySalesUnavailable ? "حاول مجدداً" : "د.ع",
            copyText: metrics.isLoading || todaySalesUnavailable
              ? ""
              : `مبيعات اليوم: ${fmtAr(todaySales?.total ?? 0)} د.ع`,
            ico: <TrendIco color="var(--sem-pos)" />,
            iBg: "var(--sem-pos-bg)",
          },
          {
            label: "فواتير اليوم",
            value: todayInvoicesValue,
            unit: metrics.isLoading ? ACTION_LABELS.refreshing : todaySalesUnavailable ? "حاول مجدداً" : "فاتورة",
            copyText: metrics.isLoading || todaySalesUnavailable
              ? ""
              : `فواتير اليوم: ${fmtAr(todaySales?.invoiceCount ?? 0)} فاتورة`,
            ico: <TrendIco color="var(--sem-pos)" />,
            iBg: "var(--sem-pos-bg)",
          },
        ]
      : []),
    // بطاقة نبض المبيعات: بلا معدّل ٧ أيام (لا مبيعات سابقة) = لا نص حشو — تُخفى كاملاً
    // (تدقيق الفجوات ٥/٧، بند ١٢) — نفس اصطلاح إخفاء بطاقة الجرد أدناه عبر spread شرطي.
    ...(canViewReports && (metrics.isLoading || pulseUnavailable || hasBaseline)
      ? [
          {
            label: "مبيعات أمس مقابل المعدّل",
            value: metrics.isLoading ? "—" : pulseUnavailable ? "غير متاح" : fmtAr(Number(pulse?.yesterday ?? 0)),
            unit: metrics.isLoading
              ? ACTION_LABELS.refreshing
              : pulseUnavailable
                ? "حاول مجدداً"
              : `${pulseArrow} ${fmtAr(Math.abs(pulse!.changePct))}٪ عن المعدّل`,
            copyText: metrics.isLoading || pulseUnavailable || !pulse
              ? ""
              : `مبيعات أمس: ${fmtAr(Number(pulse.yesterday))} د.ع (${pulseArrow}${fmtAr(Math.abs(pulse.changePct))}٪ عن معدّل ٧ أيام = ${fmtAr(Number(pulse.avg7d))} د.ع)`,
            ico: <TrendIco color={pulseColor} />,
            iBg: `color-mix(in oklch, ${pulseColor} 15%, transparent)`,
          },
        ]
      : []),
    ...(canViewTreasury && branchScope !== undefined
      ? [{
          label: "الوردية الحالية",
          value: shift.isLoading ? "—" : shift.isError ? "غير متاح" : shiftLabel,
          unit: shift.isLoading ? ACTION_LABELS.refreshing : shift.isError ? "حاول مجدداً" : shiftSince,
          copyText: shift.isLoading || shift.isError
            ? ""
            : shift.data
              ? `الوردية الحالية: مفتوحة ${shiftSince}`.trim()
              : "الوردية الحالية: لا وردية",
          ico: <ShiftIco color="var(--sem-info)" />,
          iBg: "var(--sem-info-bg)",
        }]
      : []),
    ...(canViewInventory
      ? [{
          label: "مخزون منخفض",
          value: lowStockValue,
          unit: metrics.isLoading ? ACTION_LABELS.refreshing : metricsUnavailable ? "حاول مجدداً" : "منتج",
          copyText: metrics.isLoading || metricsUnavailable
            ? ""
            : `مخزون منخفض: ${fmtAr(metrics.data?.lowStockCount ?? 0)} منتج`,
          ico: <WarnIco color="var(--sem-warn)" />,
          iBg: "var(--sem-warn-bg)",
          isAlert: true,
          alertC: "var(--sem-warn)",
          href: profileActionHref(primaryNav, "inventory"),
        }]
      : []),
    // بطاقة الذمم المتأخّرة ماليّة ⇒ للمخوّلين برؤية التقارير فقط (الخادم يُصفّرها لغيرهم؛ نُخفيها
    // هنا كي لا يُعرَض صفرٌ مضلِّل لكاشير/مخزن). نفس بوّابة بطاقة «مبيعات أمس» أعلاه (تُخفى ذاتياً بالصفر).
    ...(canViewReports
      ? [
          {
            label: "ذمم متأخّرة",
            value: overdueValue,
            unit: overdueUnit,
            copyText: metrics.isLoading || metricsUnavailable
              ? ""
              : overdueCount > 0
                ? `ذمم متأخّرة: ${fmtAr(overdueCount)} عميل — ${overdueTotalShort} د.ع`
                : `ذمم متأخّرة: ${fmtAr(overdueCount)} عميل`,
            ico: <WarnIco color="var(--sem-neg)" />,
            iBg: "var(--sem-neg-bg)",
            isAlert: true,
            alertC: "var(--sem-neg)",
            href: canViewCollections ? profileActionHref(primaryNav, "ar") : undefined,
          },
        ]
      : []),
    // بطاقة الجرد: تظهر للأدوار المخوّلة فقط، وتتحوّل تنبيهاً عند وجود جلسات بانتظار المراجعة.
    ...(canSeeStocktakes
      ? [
          {
            label: "جرد بانتظار المراجعة",
            value: stk.isLoading ? "—" : stk.isError ? "غير متاح" : fmtAr(stk.data?.review ?? 0),
            unit: stk.isLoading ? ACTION_LABELS.refreshing : stk.isError ? "حاول مجدداً" : stk.data?.counting ? `${fmtAr(stk.data.counting)} قيد العدّ` : "جلسة",
            copyText: stk.isLoading || stk.isError
              ? ""
              : `جرد بانتظار المراجعة: ${fmtAr(stk.data?.review ?? 0)} جلسة${
                  stk.data?.counting ? ` — ${fmtAr(stk.data.counting)} قيد العدّ` : ""
                }`,
            ico: <WarnIco color="var(--sem-info)" />,
            iBg: "var(--sem-info-bg)",
            isAlert: (stk.data?.review ?? 0) > 0,
            alertC: "var(--sem-info)",
            href: profileActionHref(primaryNav, "my_stocktakes"),
          },
        ]
      : []),
  ];
  const hasRefreshIssue =
    ((canViewReports || canViewInventory) &&
      (metrics.isError || metrics.data?.health.status === "degraded")) ||
    (canViewTreasury && shift.isError) ||
    (canSeeStocktakes && stk.isError);

  return (
    <section aria-label="مؤشرات اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "16px 24px 4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 9 }}>
        <h2 style={{ margin: 0, color: T.text, fontSize: "0.875rem", fontWeight: 900 }}>مؤشرات اليوم</h2>
        <span style={{ color: T.muted, fontSize: "0.6875rem" }}>تتحدث تلقائياً حسب صلاحياتك ونطاق فرعك</span>
      </div>
      {hasRefreshIssue && (
        <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10, padding: "9px 11px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          <span>تعذّر تحديث بعض المؤشرات؛ القيم المتاحة ما زالت معروضة.</span>
          <button type="button" onClick={() => { if (canViewReports || canViewInventory) void metrics.refetch(); if (canViewTreasury && branchScope !== undefined) void shift.refetch(); if (canSeeStocktakes) void stk.refetch(); }} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.cardBord}`, borderRadius: 7, background: T.cardBg, color: T.text, padding: "6px 9px", font: "inherit", fontWeight: 800, cursor: "pointer" }}>
            <RefreshCw aria-hidden size={13} />
            إعادة المحاولة
          </button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${metricCols}, minmax(0, 1fr))`, gap: 10 }}>
        {stats.map((s, i) => {
          // بطاقة تنبيه في «صَفا»: تِنت خفيف بلون حالتها (كل تنبيه بلونه لا أحمر موحّد) + حدّ ملوّن رقيق.
          const abg = s.isAlert ? `color-mix(in oklch, ${s.iBg} 62%, var(--dash-card-bg))` : T.statBg;
          const abd = s.isAlert ? `color-mix(in oklch, ${s.alertC} 42%, ${T.statBord})` : T.statBord;
          const card = (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: i * 0.04, duration: 0.3, ease: "easeOut" }}
              whileHover={{ y: -2, boxShadow: "0 4px 12px oklch(0 0 0 / 0.08)" }}
              className="group"
              style={{ minWidth: 0, minHeight: 74, borderRadius: 11, padding: "11px 12px", display: "flex", alignItems: "center", gap: 10, background: abg, border: `1px solid ${abd}`, boxShadow: "0 1px 4px oklch(0 0 0 / 0.04)", cursor: s.href ? "pointer" : "default", textDecoration: "none" }}
            >
              <div style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, background: s.iBg, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.ico}</div>
              <div>
                <div style={{ fontSize: "1.0625rem", fontWeight: 800, lineHeight: 1.25, color: s.isAlert ? s.alertC : T.text }}>{s.value}</div>
                <div style={{ fontSize: "0.6875rem", color: T.muted, lineHeight: 1.3, marginTop: 2 }}>{s.label}</div>
              </div>
              {s.unit && <div style={{ marginRight: "auto", fontSize: "0.6875rem", color: T.muted, textAlign: "left" }}>{s.unit}</div>}
              {/* زِرّ نَسخ يَظهَر عِند الـhover — يَنسَخ «التَسمية: القيمة الوحدة»
                stopPropagation/preventDefault لمَنع تَفعيل رابط البِطاقة (href). */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                style={{ marginInlineStart: s.unit ? 4 : "auto", flexShrink: 0 }}
              >
                <CopyButton value={s.copyText} title={`نسخ ${s.label}`} successMessage={`نُسخت ${s.label}`} />
              </div>
            </motion.div>
          );
          return s.href ? (
            <Link key={i} href={s.href} style={{ display: "block", minWidth: 0, textDecoration: "none" }}>
              {card}
            </Link>
          ) : (
            card
          );
        })}
      </div>
      <TodaySalesBreakdown branchScope={branchScope} canView={canViewReports} ready={canViewReports && scopeReady} />
    </section>
  );
}

/* ═══════════ MORNING BRIEF ═══════════
   قسم «برنامج اليوم» فوق الوحدات: ٣ بطاقات فعل (تذكيرات AR + وعود اليوم + أوامر شغل متأخّرة).
   يظهر فقط حين يتيح ملف العمل المحلول مدخل أوامر الشغل وتسمح الوحدة فعلياً بقراءته.
   عند «كل الأصفار» يختفي القسم كلياً (لا نُشتت الشاشة بلوحة فارغة). */

function BriefCard({
  href, label, count, sub, accent, iconBg, icon,
}: {
  href: string;
  label: string;
  count: number;
  sub: string;
  accent: string;
  iconBg: string;
  icon: React.ReactNode;
}) {
  const T = useT();
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 10,
        background: T.cardBg,
        border: `1px solid ${T.cardBord}`,
        borderRight: `3px solid ${accent}`,
        cursor: "pointer",
        transition: "box-shadow 0.15s, transform 0.15s",
        color: T.text,
        textDecoration: "none",
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 4px 16px color-mix(in oklch, ${accent} 16%, transparent)`;
        (e.currentTarget as HTMLAnchorElement).style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
        (e.currentTarget as HTMLAnchorElement).style.transform = "none";
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
        aria-hidden
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.75rem", color: T.sub, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: "1.375rem", fontWeight: 900, color: accent, lineHeight: 1, marginBottom: 2 }}>
          <span dir="ltr" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtAr(count)}</span>
        </div>
        <div style={{ fontSize: "0.75rem", color: T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
      </div>
    </Link>
  );
}

function MorningBrief({
  branchScope,
  isAdmin,
  primaryNav,
}: {
  branchScope: number | undefined;
  isAdmin: boolean;
  primaryNav: readonly WorkspaceNavItem[];
}) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const workOrdersHref = profileActionHref(primaryNav, "work_orders");
  const canViewWorkOrders =
    !!role &&
    !!workOrdersHref &&
    hasModuleAccess(role, override, "workorders", "READ");
  const canViewReceivableBrief =
    !!role &&
    !!profileActionHref(primaryNav, "reports") &&
    moduleAccessAllowed(
      role,
      override,
      "reports",
      "READ",
      ["manager", "accountant", "auditor"],
    ) &&
    moduleAccessAllowed(
      role,
      override,
      "collections",
      "FULL",
      ["manager", "accountant"],
    );
  const receivableHref = canViewReceivableBrief
    ? `/reports/ar-reminders?branch=${branchScope}`
    : undefined;
  const canViewBrief = canViewWorkOrders || canViewReceivableBrief;
  // برنامج اليوم تنفيذيّ لا تجميعيّ: لا نختار أول فرع صامتاً للأدمن. المنتقي أعلى الشاشة هو
  // المصدر الواحد، والروابط تحمل الفرع نفسه إلى قائمة المتابعة.
  const metrics = trpc.reports.dashboardMetrics.useQuery(
    { branchId: branchScope, includeTodaySales: true },
    { enabled: canViewBrief && branchScope !== undefined },
  );

  // الاستعلام المشترك يعمل إن وُجد نوع واحد على الأقل من البنود المسموحة؛ كل بطاقة أدناه
  // تبقى محكومة ببوابتها المستقلة، فلا يحجب إطفاء أوامر الشغل تذكيرات الذمم والعكس.
  if (!canViewBrief) return null;
  if (isAdmin && branchScope === undefined) {
    return (
      <section aria-label="برنامج اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "12px 24px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: `1px solid ${T.cardBord}`, borderRadius: 9, background: T.statBg, color: T.sub, fontSize: "0.75rem" }}>
          <MapPin aria-hidden size={14} />
          اختر فرعاً من أعلى الشاشة لعرض برنامج اليوم القابل للتنفيذ.
        </div>
      </section>
    );
  }
  if (metrics.isLoading) {
    return (
      <section aria-label="برنامج اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "12px 24px 4px", color: T.muted, fontSize: "0.75rem" }}>
        جارٍ تجهيز برنامج اليوم…
      </section>
    );
  }
  if (metrics.isError || !metrics.data) {
    return (
      <section aria-label="برنامج اليوم" style={{ maxWidth: 1648, margin: "0 auto", padding: "12px 24px 4px" }}>
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          <span>تعذّر تحميل برنامج اليوم.</span>
          <button type="button" onClick={() => void metrics.refetch()} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.cardBord}`, borderRadius: 7, background: T.cardBg, color: T.text, padding: "6px 9px", font: "inherit", fontWeight: 800, cursor: "pointer" }}>
            <RefreshCw aria-hidden size={13} />
            إعادة المحاولة
          </button>
        </div>
      </section>
    );
  }
  const brief = metrics.data.morningBrief;
  const remindersDegraded =
    canViewReceivableBrief &&
    metrics.data.health.sourceErrors.includes("receivableReminders");
  // promisedToday مجموعة جزئية من arRemindersDue؛ لا نعدّها مرّتين في إجمالي البنود.
  const total =
    (canViewReceivableBrief ? brief.arRemindersDue : 0) +
    (canViewWorkOrders ? brief.overdueWorkOrders : 0);
  // كل الأصفار ⇒ لا حاجة لبانر «برنامج اليوم» — تنظيف بصريّ حين لا شيء يستحقّ الفعل.
  if (total === 0 && !remindersDegraded) return null;

  const dt = new Date();
  const dateLabel = fmtDate(dt);

  return (
    <section
      style={{
        maxWidth: 1648,
        margin: "0 auto",
        padding: "16px 24px 4px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
      aria-label="برنامج اليوم"
    >
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "0.9375rem", fontWeight: 800, color: T.text, margin: 0 }}>
            برنامج اليوم
          </h2>
          <div style={{ fontSize: "0.75rem", color: T.muted, marginTop: 2 }}>
            ضمن فرع التنفيذ — افتح كل بطاقة للوصول إلى قائمتها
          </div>
        </div>
        <span style={{ fontSize: "0.75rem", color: T.sub }}>{dateLabel} — {fmtAr(total)} بند{total === 1 ? "" : "ود"} للمتابعة</span>
      </header>
      {remindersDegraded && (
        <div role="status" style={{ padding: "9px 11px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          تعذّر تحديث تذكيرات الذمم؛ بنود التشغيل الأخرى ما زالت معروضة.
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 10,
        }}
      >
        {receivableHref && brief.promisedToday > 0 && (
          <BriefCard
            href={receivableHref}
            label="عملاء موعودون اليوم"
            count={brief.promisedToday}
            sub="راجع الوعود المستحقّة قبل نهاية اليوم"
            accent="var(--sem-warn)"
            iconBg="var(--sem-warn-bg)"
            icon={<PromiseIco color="var(--sem-warn)" />}
          />
        )}
        {receivableHref && brief.arRemindersDue > 0 && (
          <BriefCard
            href={receivableHref}
            label="تذكيرات ذمم مستحقّة"
            count={brief.arRemindersDue}
            sub="افتح قائمة العملاء ثم أرسل أو سجّل قرار المتابعة"
            accent="var(--sem-info)"
            iconBg="var(--sem-info-bg)"
            icon={<ARIco color="var(--sem-info)" />}
          />
        )}
        {canViewWorkOrders && brief.overdueWorkOrders > 0 && workOrdersHref && (
          <BriefCard
            href={`${workOrdersHref}?branch=${branchScope}`}
            label="أوامر شغل متأخّرة"
            count={brief.overdueWorkOrders}
            sub="تجاوزت التاريخ المتوقّع للتسليم"
            accent="var(--sem-neg)"
            iconBg="var(--sem-neg-bg)"
            icon={<WOIco color="var(--sem-neg)" />}
          />
        )}
      </div>
    </section>
  );
}

const PromiseIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <rect x="3" y="4" width="14" height="13" rx="2" stroke={color} strokeWidth="1.6" />
    <path d="M3 8h14" stroke={color} strokeWidth="1.6" />
    <path d="M7 2v3M13 2v3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    <path d="M7.5 12.5l1.5 1.5 3.5-3.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ARIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <path d="M2.5 10c0-4 3.5-7 7.5-7s7.5 3 7.5 7-3.5 7-7.5 7c-1.4 0-2.7-.3-3.8-.9l-3.7 1 1-3.5C2.8 12.6 2.5 11.3 2.5 10z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="7" cy="10" r="0.9" fill={color} />
    <circle cx="10" cy="10" r="0.9" fill={color} />
    <circle cx="13" cy="10" r="0.9" fill={color} />
  </svg>
);

const WOIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <path d="M5 2h7l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M12 2v4h4" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M7.5 11.5l1.5 1.5 3.5-3.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TasksIco = ({ color }: { color: string }) => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
    <rect x="3" y="3" width="14" height="14" rx="2.5" stroke={color} strokeWidth="1.6" />
    <path d="M6.5 7.5h7M6.5 10.5h7M6.5 13.5h4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/* ═══════════ المهام والتذاكر (نظام المهام الموحّد S2/T2.3) ═══════════
   بطاقتان: «مهامي المفتوحة» (شخصيّ — assignedTo=أنا، لا RESOLVED/CANCELLED) و«مهام متأخّرة»
   (تشغيليّ — نطاق فرع المستخدم نفسه المُستعمَل في MetricsBar/MorningBrief). يظهر لأي دور يملك
   tasks≥READ ويُبقي ملفُ عمله «مهامي» ضمن الإجراءات الرئيسية؛ ويختفي كلياً عند صفرَين.
   myOpenTasks يُحسب خادمياً بلا حدّ صفحات، والراوتر يمرّر هوية المستخدم المصادَق حصراً. */
function TasksBrief({
  branchScope,
  primaryNav,
}: {
  branchScope: number | undefined;
  primaryNav: readonly WorkspaceNavItem[];
}) {
  const T = useT();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const tasksHref = profileActionHref(primaryNav, "my_tasks");

  // بوّابة رؤية — مرآة hasModuleAccess (القالب فقط، بلا استثناء أدوار خارج القائمة) مطابقةً تماماً
  // لبوّابة الخادم tasksReadProcedure (requireModule("tasks","READ")، بلا قائمة أدوار صريحة هناك أيضاً).
  const canSeeTasks =
    !!role &&
    !!tasksHref &&
    hasModuleAccess(role, override, "tasks", "READ");

  // overdueTasks تشغيليّ — نفس مفتاح استعلام dashboardMetrics المُستهلَك أصلاً في MetricsBar/
  // MorningBrief (branchId مطابق) ⇒ react-query يُدَدِّب الطلب، لا شبكة إضافية.
  const metrics = trpc.reports.dashboardMetrics.useQuery(
    { branchId: branchScope, includeTodaySales: true },
    { enabled: canSeeTasks },
  );
  const overdueTasks = metrics.data?.morningBrief.overdueTasks ?? 0;
  const myOpenTasks = metrics.data?.morningBrief.myOpenTasks ?? 0;

  if (!canSeeTasks || !tasksHref) return null;
  if (metrics.isLoading) {
    return (
      <section aria-label="المهام والتذاكر" style={{ maxWidth: 1648, margin: "0 auto", padding: "8px 24px 4px", color: T.muted, fontSize: "0.75rem" }}>
        جارٍ تحديث المهام…
      </section>
    );
  }
  if (metrics.isError) {
    return (
      <section aria-label="المهام والتذاكر" style={{ maxWidth: 1648, margin: "0 auto", padding: "8px 24px 4px" }}>
        <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", border: "1px solid var(--sem-warn)", borderRadius: 9, background: "var(--sem-warn-bg)", color: T.text, fontSize: "0.75rem" }}>
          <span>تعذّر تحديث المهام.</span>
          <button type="button" onClick={() => void metrics.refetch()} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${T.cardBord}`, borderRadius: 7, background: T.cardBg, color: T.text, padding: "6px 9px", font: "inherit", fontWeight: 800, cursor: "pointer" }}>
            <RefreshCw aria-hidden size={13} />
            إعادة المحاولة
          </button>
        </div>
      </section>
    );
  }
  if (myOpenTasks === 0 && overdueTasks === 0) return null;

  return (
    <section
      style={{ maxWidth: 1648, margin: "0 auto", padding: "8px 24px 4px", display: "flex", flexDirection: "column", gap: 10 }}
      aria-label="المهام والتذاكر"
    >
      <h2 style={{ fontSize: "0.8125rem", fontWeight: 800, color: T.text, margin: 0, letterSpacing: "0.01em" }}>
        المهام والتذاكر
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        {myOpenTasks > 0 && (
          <BriefCard
            href={tasksHref}
            label="مهامي المفتوحة"
            count={myOpenTasks}
            sub="مهام مُسنَدة إليك بانتظار المتابعة"
            accent="var(--sem-info)"
            iconBg="var(--sem-info-bg)"
            icon={<TasksIco color="var(--sem-info)" />}
          />
        )}
        {overdueTasks > 0 && (
          <BriefCard
            href={`${tasksHref.split("?")[0]}?tab=list&overdue=1`}
            label="مهام متأخّرة"
            count={overdueTasks}
            sub="تجاوزت الاستحقاق الفعلي — تحتاج متابعة"
            accent="var(--sem-neg)"
            iconBg="var(--sem-neg-bg)"
            icon={<TasksIco color="var(--sem-neg)" />}
          />
        )}
      </div>
    </section>
  );
}

/* ═══════════ DASHBOARD ═══════════ */

export default function Dashboard() {
  const me = trpc.auth.me.useQuery();
  const [adminBranchScope, setAdminBranchScope] = useState<number | undefined>(undefined);
  if (me.isLoading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: T.bg, margin: "-24px" }}>
        <LoadingState message={ACTION_LABELS.verifyingPermissions} />
      </div>
    );
  }
  if (me.isError || !me.data) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: T.bg, margin: "-24px" }}>
        <ErrorState
          message="تعذّر التحقّق من جلستك. تحقّق من الاتصال ثم أعد المحاولة."
          onRetry={() => void me.refetch()}
        />
      </div>
    );
  }

  const profile = resolveWorkspaceProfile({
    role: me.data.role as RoleKey,
    permissionsOverride: (me.data.permissionsOverride ?? null) as PermissionMap | null,
  });
  const cashierStation = profile.defaultAction?.access.kind === "STATION"
    ? profile.defaultAction.access.station
    : undefined;

  // ملف العمل هو الذي يختار المحطة. كاشير بلا محطة فعلية يسقط إلى اللوحة العامة الآمنة
  // بدلاً من افتراض محطة تجزئة أو استنتاج الاستقبال من صلاحية أخرى.
  if (me.data.role === "cashier" && cashierStation && profile.defaultAction) {
    return (
      <CashierHome
        station={cashierStation}
        defaultAction={profile.defaultAction}
        tasksBrief={(
          <TasksBrief
            branchScope={dashboardActionBranchId(me.data.branchId)}
            primaryNav={profile.primaryNav}
          />
        )}
      />
    );
  }

  const isAdmin = me.data.role === "admin";
  const branchScope = isAdmin ? adminBranchScope : dashboardActionBranchId(me.data.branchId);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} style={{ minHeight: "100vh", background: T.bg, direction: "rtl", fontFamily: "'Cairo', sans-serif", margin: "-24px" }}>
      <DashboardHeader branchScope={branchScope} isAdmin={isAdmin} onBranchScopeChange={setAdminBranchScope} />
      <PrimaryActionsPanel items={profile.primaryNav} />
      <MetricsBar branchScope={branchScope} primaryNav={profile.primaryNav} />
      <MorningBrief branchScope={branchScope} isAdmin={isAdmin} primaryNav={profile.primaryNav} />
      <TasksBrief branchScope={branchScope} primaryNav={profile.primaryNav} />
    </motion.div>
  );
}

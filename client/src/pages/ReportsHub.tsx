// ReportsHub — صفحة وحدة «التقارير» بتبويبات: النظرة العامة (الكوكبِت) + كل التقارير (الكتالوج).
// الكوكبِت هو الافتراضي والقلب — يجيب على أسئلة المالك الخمسة. التبويبات الأخرى روافد للتعمّق.
// تبويب «أدوات» (حزمة المحاسب) يُضاف في مرحلة لاحقة. كل تبويب صفحة كاملة (lazy) بـPageHeader خاصّ.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const ReportsOverview = lazy(() => import("@/pages/ReportsOverview"));
const ReportsCenter = lazy(() => import("@/pages/ReportsCenter"));
const ReportsTools = lazy(() => import("@/pages/ReportsTools"));
const CommissionLeaderboard = lazy(() => import("@/pages/CommissionLeaderboard"));

// مرآة reportViewerProcedure: قائمة الأدوار القالبية + فتحٌ إضافي بمنح reports الصريح.
const REPORT_VIEWER_GATE: NonNullable<HubTab["gate"]> = {
  roles: ["manager", "accountant", "auditor"],
  module: "reports",
  level: "READ",
};

const TABS: HubTab[] = [
  { value: "overview", label: "النظرة العامة", gate: REPORT_VIEWER_GATE, Component: ReportsOverview },
  // لوحة الإنجاز (العمولات) — بوّابة الخادم reportViewerProcedure (مرآة gate الواجهة هنا).
  { value: "commission-board", label: "لوحة الإنجاز", gate: REPORT_VIEWER_GATE, Component: CommissionLeaderboard },
  { value: "catalog", label: "كل التقارير", Component: ReportsCenter },
  { value: "tools", label: "أدوات المحاسب", gate: REPORT_VIEWER_GATE, Component: ReportsTools },
];

export default function ReportsHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام التقارير" />;
}

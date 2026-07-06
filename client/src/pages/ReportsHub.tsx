// ReportsHub — صفحة وحدة «التقارير» بتبويبات: النظرة العامة (الكوكبِت) + كل التقارير (الكتالوج).
// الكوكبِت هو الافتراضي والقلب — يجيب على أسئلة المالك الخمسة. التبويبات الأخرى روافد للتعمّق.
// تبويب «أدوات» (حزمة المحاسب) يُضاف في مرحلة لاحقة. كل تبويب صفحة كاملة (lazy) بـPageHeader خاصّ.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const ReportsOverview = lazy(() => import("@/pages/ReportsOverview"));
const ReportsCenter = lazy(() => import("@/pages/ReportsCenter"));
const ReportsTools = lazy(() => import("@/pages/ReportsTools"));
const CommissionLeaderboard = lazy(() => import("@/pages/CommissionLeaderboard"));

const TABS: HubTab[] = [
  { value: "overview", label: "النظرة العامة", gate: { roles: ["admin", "manager", "accountant", "auditor"] }, Component: ReportsOverview },
  // لوحة الإنجاز (العمولات) — بوّابة الخادم reportViewerProcedure (مرآة gate الواجهة هنا).
  { value: "commission-board", label: "لوحة الإنجاز", gate: { roles: ["admin", "manager", "accountant", "auditor"] }, Component: CommissionLeaderboard },
  { value: "catalog", label: "كل التقارير", Component: ReportsCenter },
  { value: "tools", label: "أدوات المحاسب", gate: { roles: ["admin", "manager", "accountant"] }, Component: ReportsTools },
];

export default function ReportsHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام التقارير" />;
}

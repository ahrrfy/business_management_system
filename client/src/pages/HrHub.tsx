// HrHub — وحدة «الموارد البشرية» بتبويبات (الموظفون + الحضور + الرواتب + الإجازات + الترقيات +
// التوظيف + الأجهزة). كلها managerOnly. مسارات موظف الإنشاء/التفصيل تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Employees = lazy(() => import("@/pages/Employees"));
const Attendance = lazy(() => import("@/pages/Attendance"));
const Payroll = lazy(() => import("@/pages/Payroll"));
const CommissionPlans = lazy(() => import("@/pages/CommissionPlans"));
const CommissionTargets = lazy(() => import("@/pages/CommissionTargets"));
const Leaves = lazy(() => import("@/pages/Leaves"));
const Promotions = lazy(() => import("@/pages/Promotions"));
const Recruitment = lazy(() => import("@/pages/Recruitment"));
const HrDevices = lazy(() => import("@/pages/HrDevices"));

const TABS: HubTab[] = [
  { value: "employees", label: "الموظفون", gate: { managerOnly: true }, Component: Employees },
  { value: "attendance", label: "الحضور والدوام", gate: { managerOnly: true }, Component: Attendance },
  { value: "payroll", label: "الرواتب", gate: { managerOnly: true }, Component: Payroll },
  { value: "commission-plans", label: "خطط العمولات", gate: { managerOnly: true }, Component: CommissionPlans },
  { value: "commission-targets", label: "الأهداف الشهرية", gate: { managerOnly: true }, Component: CommissionTargets },
  { value: "leaves", label: "الإجازات", gate: { managerOnly: true }, Component: Leaves },
  { value: "promotions", label: "الترقيات", gate: { managerOnly: true }, Component: Promotions },
  { value: "recruitment", label: "التوظيف", gate: { managerOnly: true }, Component: Recruitment },
  { value: "devices", label: "أجهزة البصمة", gate: { managerOnly: true }, Component: HrDevices },
];

export default function HrHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الموارد البشرية" />;
}

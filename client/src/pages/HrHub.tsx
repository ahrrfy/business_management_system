// HrHub — وحدة «الموارد البشرية» بتبويبات (الموظفون + الحضور + الرواتب + الإجازات + الترقيات +
// التوظيف + الأجهزة). البوّابات مرآة الخادم: تبويبات hr على requireModule("hr","READ")
// وتبويبات العمولات على requireModule("commissions","READ") — أدوار القالب + المنح الصريح.
// مسارات موظف الإنشاء/التفصيل تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { trpc } from "@/lib/trpc";

const Employees = lazy(() => import("@/pages/Employees"));
const Attendance = lazy(() => import("@/pages/Attendance"));
const Payroll = lazy(() => import("@/pages/Payroll"));
const PayrollLegalSettings = lazy(() => import("@/pages/PayrollLegalSettings"));
const EmployeeAdvances = lazy(() => import("@/pages/EmployeeAdvances"));
const CommissionPlans = lazy(() => import("@/pages/CommissionPlans"));
const CommissionTargets = lazy(() => import("@/pages/CommissionTargets"));
const CommissionRuns = lazy(() => import("@/pages/CommissionRuns"));
const Leaves = lazy(() => import("@/pages/Leaves"));
const Promotions = lazy(() => import("@/pages/Promotions"));
const Recruitment = lazy(() => import("@/pages/Recruitment"));
const HrDevices = lazy(() => import("@/pages/HrDevices"));

// مرآة بوّابات الخادم (لا قائمة أدوار هناك): tabs الموارد البشرية على requireModule("hr","READ")
// وtabs العمولات على requireModule("commissions","READ") — أدوار القالب تمرّ بقائمة roles،
// وغيرها بمنح صريح عبر module (canSeeGate). بلا هذا يجتاز الممنوحُ حارسَ المسار ثم يجد صفحة فارغة.
const HR_GATE: HubTab["gate"] = { roles: ["admin", "manager", "accountant", "auditor"], module: "hr" };
const COMMISSIONS_GATE: HubTab["gate"] = { roles: ["admin", "manager", "accountant", "auditor"], module: "commissions" };

const TABS: HubTab[] = [
  { value: "employees", label: "الموظفون", gate: HR_GATE, Component: Employees },
  { value: "attendance", label: "الحضور والدوام", gate: HR_GATE, Component: Attendance },
  { value: "payroll", label: "الرواتب", gate: HR_GATE, Component: Payroll },
  // المكوّنات القانونية (البند ④): إعدادات معطَّلة افتراضياً — محصورة بالمدير/الأدمن (بلا module ⇒
  // لا تظهر لمحاسب/مدقّق؛ الخادم يفرض managerProcedure على الكتابة).
  { value: "payroll-legal", label: "المكوّنات القانونية", gate: { roles: ["admin", "manager"] }, Component: PayrollLegalSettings },
  { value: "advances", label: "سلف الموظفين", gate: HR_GATE, Component: EmployeeAdvances },
  { value: "commission-plans", label: "خطط العمولات", gate: COMMISSIONS_GATE, Component: CommissionPlans },
  { value: "commission-targets", label: "الأهداف الشهرية", gate: COMMISSIONS_GATE, Component: CommissionTargets },
  { value: "commission-runs", label: "احتساب العمولات", gate: COMMISSIONS_GATE, Component: CommissionRuns },
  { value: "leaves", label: "الإجازات", gate: HR_GATE, Component: Leaves },
  { value: "promotions", label: "الترقيات", gate: HR_GATE, Component: Promotions },
  { value: "recruitment", label: "التوظيف", gate: HR_GATE, Component: Recruitment },
  { value: "devices", label: "أجهزة البصمة", gate: HR_GATE, Component: HrDevices },
];

export default function HrHub() {
  const bridge = trpc.hrDevices.bridgeStatus.useQuery();
  // تعطيل الجسر سياسة تشغيلية صريحة، لا حالة تحميل: نخفي أدوات الأجهزة فقط عند false
  // المؤكدة، ونبقيها عند التحميل/خطأ الشبكة كي لا تتحول مشكلة اتصال إلى اختفاءٍ مضلّل.
  const visibleTabs = bridge.data?.enabled === false
    ? TABS.filter((tab) => tab.value !== "devices")
    : TABS;
  return <PageTabs tabs={visibleTabs} ariaLabel="أقسام الموارد البشرية" />;
}

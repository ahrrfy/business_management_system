// HrHub — وحدة «الموارد البشرية» بتبويبات (الموظفون + الحضور + الرواتب + الإجازات + الترقيات +
// التوظيف + الأجهزة). البوّابات مرآة الخادم: تبويبات hr على requireModule("hr","READ")
// وتبويبات العمولات على requireModule("commissions","READ") — أدوار القالب + المنح الصريح.
// مسارات موظف الإنشاء/التفصيل تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { trpc } from "@/lib/trpc";
import { useSearch } from "wouter";

const Employees = lazy(() => import("@/pages/Employees"));
const Attendance = lazy(() => import("@/pages/Attendance"));
const Payroll = lazy(() => import("@/pages/Payroll"));
const PayrollLegalSettings = lazy(() => import("@/pages/PayrollLegalSettings"));
const EmployeeAdvances = lazy(() => import("@/pages/EmployeeAdvances"));
const UnifiedCommissionsHub = lazy(
  () => import("@/pages/UnifiedCommissionsHub"),
);
const Leaves = lazy(() => import("@/pages/Leaves"));
const Promotions = lazy(() => import("@/pages/Promotions"));
const Recruitment = lazy(() => import("@/pages/Recruitment"));
const HrDevices = lazy(() => import("@/pages/HrDevices"));

// مرآة بوّابات الخادم (لا قائمة أدوار هناك): tabs الموارد البشرية على requireModule("hr","READ")
// وtabs العمولات على requireModule("commissions","READ") — أدوار القالب تمرّ بقائمة roles،
// وغيرها بمنح صريح عبر module (canSeeGate). بلا هذا يجتاز الممنوحُ حارسَ المسار ثم يجد صفحة فارغة.
const HR_GATE: HubTab["gate"] = {
  roles: ["admin", "manager", "accountant", "auditor"],
  module: "hr",
};
const COMMISSIONS_GATE: HubTab["gate"] = {
  roles: ["admin", "manager", "accountant", "auditor"],
  module: "commissions",
};

const TABS: HubTab[] = [
  {
    value: "employees",
    label: "الموظفون",
    gate: HR_GATE,
    Component: Employees,
  },
  {
    value: "attendance",
    label: "الحضور والدوام",
    gate: HR_GATE,
    Component: Attendance,
  },
  { value: "payroll", label: "الرواتب", gate: HR_GATE, Component: Payroll },
  // المكوّنات القانونية (البند ④): إعدادات معطَّلة افتراضياً — محصورة بالمدير/الأدمن (بلا module ⇒
  // لا تظهر لمحاسب/مدقّق؛ الخادم يفرض managerProcedure على الكتابة).
  {
    value: "payroll-legal",
    label: "المكوّنات القانونية",
    gate: { roles: ["admin", "manager"] },
    Component: PayrollLegalSettings,
  },
  {
    value: "advances",
    label: "سلف الموظفين",
    gate: HR_GATE,
    Component: EmployeeAdvances,
  },
  {
    value: "commissions",
    label: "العمولات والأهداف",
    gate: COMMISSIONS_GATE,
    Component: UnifiedCommissionsHub,
  },
  { value: "leaves", label: "الإجازات", gate: HR_GATE, Component: Leaves },
  {
    value: "promotions",
    label: "الترقيات",
    gate: HR_GATE,
    Component: Promotions,
  },
  {
    value: "recruitment",
    label: "التوظيف",
    gate: HR_GATE,
    Component: Recruitment,
  },
  {
    value: "devices",
    label: "أجهزة البصمة",
    gate: HR_GATE,
    Component: HrDevices,
  },
];

export default function HrHub() {
  const search = useSearch();
  const requested = new URLSearchParams(search).get("tab");
  const bridge = trpc.hrDevices.bridgeStatus.useQuery();

  // توافق رجعي شفاف: عند طلب أي من روابط العمولات القديمة (commission-runs, commission-targets, commission-plans)
  // أو أسماء الأقسام الفرعية، يتم مواءمة قيمة التبويب ليقوم PageTabs بتنشيط مركز العمولات الموحد مع إظهار زر تبويب واحد.
  const isLegacyCommissionTab =
    requested === "commission-runs" ||
    requested === "commission-targets" ||
    requested === "commission-plans" ||
    requested === "runs" ||
    requested === "targets" ||
    requested === "plans" ||
    requested === "attribution";

  const tabsWithCommissions = TABS.map((tab) => {
    if (tab.value === "commissions" && isLegacyCommissionTab && requested) {
      return { ...tab, value: requested };
    }
    return tab;
  });

  // تعطيل الجسر سياسة تشغيلية صريحة، لا حالة تحميل: نخفي أدوات الأجهزة فقط عند false
  // المؤكدة، ونبقيها عند التحميل/خطأ الشبكة كي لا تتحول مشكلة اتصال إلى اختفاءٍ مضلّل.
  const visibleTabs =
    bridge.data?.enabled === false
      ? tabsWithCommissions.filter((tab) => tab.value !== "devices")
      : tabsWithCommissions;
  return <PageTabs tabs={visibleTabs} ariaLabel="أقسام الموارد البشرية" />;
}

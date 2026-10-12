// DeliveryCenter — وحدة «التوصيل» بتبويبين (إدارة التوصيل + جهات التوصيل). محصورة بأدوار التوصيل.
// (الاسم DeliveryCenter لتفادي التضارب مع DeliveryHub القائمة = شاشة الإرسال/التسوية المُضمَّنة.)
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const DeliveryHub = lazy(() => import("@/pages/DeliveryHub"));
const ReceptionWorkflowPage = lazy(() => import("@/pages/reception/ReceptionWorkflowPage"));
const DeliveryParties = lazy(() => import("@/pages/DeliveryParties"));
const DeliveryPricingZones = lazy(() => import("@/pages/DeliveryPricingZones"));
const CommissionComparisonReport = lazy(() => import("@/pages/CommissionComparisonReport"));
const CourierPerformanceReport = lazy(() => import("@/pages/CourierPerformanceReport"));
const DeliveryAgingReport = lazy(() => import("@/pages/DeliveryAgingReport"));

const TABS: HubTab[] = [
  {
    value: "workflow",
    label: "سير العمل بالباركود (إسناد وتحصيل)",
    gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "store" },
    Component: ReceptionWorkflowPage,
  },
  { value: "dispatch", label: "إدارة التوصيل والمتابعة", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "store" }, Component: DeliveryHub },
  { value: "parties", label: "جهات التوصيل", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "store" }, Component: DeliveryParties },
  // Slice I (٢٩/٨/٢٦): إدارة مناطق التسعير — للمدير فقط (deliveryManagerProcedure على الخادم).
  {
    value: "pricing",
    label: "مناطق التسعير",
    gate: {
      roles: ["admin", "manager"],
      module: "store",
      operations: ["delivery.listZones", "delivery.listPricingRules"],
    },
    Component: DeliveryPricingZones,
  },
  // Slice K (٢٩/٨/٢٦): مقارنةُ الأجرة المدفوعة بالعمولة التقديريّة — قرارُ تفعيل H2 يتّخذه المالك
  // بعد رؤية أرقامٍ حقيقيّة (بلاغه: «راقب الأرقام أسبوعين»). للمدير + المحاسب + المدقّق.
  { value: "commission-comparison", label: "مقارنة العمولة", gate: { roles: ["admin", "manager", "accountant", "auditor"], module: "reports", operations: ["delivery.commissionComparison"] }, Component: CommissionComparisonReport },
  // أداء المناديب: تقريرٌ يكشف قيمة/تحصيل النقد ⇒ بوّابة التقارير (يُخفى عن الكاشير؛ الخادم يفرض reportViewerProcedure).
  { value: "performance", label: "أداء المناديب", gate: { roles: ["admin", "manager", "accountant", "auditor"], module: "reports", operations: ["reports.courierPerformance"] }, Component: CourierPerformanceReport },
  // أعمار الإرساليات (١٠/٨): نظير أعمار الذمم لعُهد المناديب — نفس بوّابة التقارير.
  { value: "aging", label: "أعمار الإرساليات", gate: { roles: ["admin", "manager", "accountant", "auditor"], module: "reports", operations: ["reports.consignmentAging"] }, Component: DeliveryAgingReport },
];

export default function DeliveryCenter() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام التوصيل" />;
}

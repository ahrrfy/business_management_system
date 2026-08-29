// DeliveryCenter — وحدة «التوصيل» بتبويبين (إدارة التوصيل + جهات التوصيل). محصورة بأدوار التوصيل.
// (الاسم DeliveryCenter لتفادي التضارب مع DeliveryHub القائمة = شاشة الإرسال/التسوية المُضمَّنة.)
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const DeliveryHub = lazy(() => import("@/pages/DeliveryHub"));
const DeliveryParties = lazy(() => import("@/pages/DeliveryParties"));
const DeliveryPricingZones = lazy(() => import("@/pages/DeliveryPricingZones"));
const CourierPerformanceReport = lazy(() => import("@/pages/CourierPerformanceReport"));
const DeliveryAgingReport = lazy(() => import("@/pages/DeliveryAgingReport"));

const DELIVERY_ROLES = { roles: ["admin", "manager", "accountant", "cashier", "auditor"] as const };

const TABS: HubTab[] = [
  { value: "dispatch", label: "إدارة التوصيل", gate: { roles: [...DELIVERY_ROLES.roles] }, Component: DeliveryHub },
  { value: "parties", label: "جهات التوصيل", gate: { roles: [...DELIVERY_ROLES.roles] }, Component: DeliveryParties },
  // Slice I (٢٩/٨/٢٦): إدارة مناطق التسعير — للمدير فقط (deliveryManagerProcedure على الخادم).
  { value: "pricing", label: "مناطق التسعير", gate: { roles: ["admin", "manager"] }, Component: DeliveryPricingZones },
  // أداء المناديب: تقريرٌ يكشف قيمة/تحصيل النقد ⇒ بوّابة التقارير (يُخفى عن الكاشير؛ الخادم يفرض reportViewerProcedure).
  { value: "performance", label: "أداء المناديب", gate: { roles: ["admin", "manager", "accountant", "auditor"], module: "reports" }, Component: CourierPerformanceReport },
  // أعمار الإرساليات (١٠/٨): نظير أعمار الذمم لعُهد المناديب — نفس بوّابة التقارير.
  { value: "aging", label: "أعمار الإرساليات", gate: { roles: ["admin", "manager", "accountant", "auditor"], module: "reports" }, Component: DeliveryAgingReport },
];

export default function DeliveryCenter() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام التوصيل" />;
}

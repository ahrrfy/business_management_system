// DeliveryCenter — وحدة «التوصيل» بتبويبين (إدارة التوصيل + جهات التوصيل). محصورة بأدوار التوصيل.
// (الاسم DeliveryCenter لتفادي التضارب مع DeliveryHub القائمة = شاشة الإرسال/التسوية المُضمَّنة.)
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const DeliveryHub = lazy(() => import("@/pages/DeliveryHub"));
const DeliveryParties = lazy(() => import("@/pages/DeliveryParties"));

const DELIVERY_ROLES = { roles: ["admin", "manager", "accountant", "cashier", "auditor"] as const };

const TABS: HubTab[] = [
  { value: "dispatch", label: "إدارة التوصيل", gate: { roles: [...DELIVERY_ROLES.roles] }, Component: DeliveryHub },
  { value: "parties", label: "جهات التوصيل", gate: { roles: [...DELIVERY_ROLES.roles] }, Component: DeliveryParties },
];

export default function DeliveryCenter() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام التوصيل" />;
}

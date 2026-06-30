// ExchangeHub — صفحة وحدة «الصيرفة» (الصرّاف/التحويل) بتبويبات ثانوية.
// الصيرفات (قائمة + أرصدة) · العمليات (إيداع/سحب/شراء دولار) · تسديد مورد · كشف الحساب · المطابقة.
// الوصول كله manager+ (RequireRole على المسار في App.tsx) — التأثير المالي مباشر على أرصدة الشركة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const ExchangeAccounts = lazy(() => import("@/pages/ExchangeAccounts"));
const ExchangeOperations = lazy(() => import("@/pages/ExchangeOperations"));
const ExchangeSettle = lazy(() => import("@/pages/ExchangeSettle"));
const ExchangeStatement = lazy(() => import("@/pages/ExchangeStatement"));
const ExchangeReconcile = lazy(() => import("@/pages/ExchangeReconcile"));

const TABS: HubTab[] = [
  { value: "accounts", label: "الصيرفات", Component: ExchangeAccounts },
  { value: "operations", label: "إيداع / سحب / شراء دولار", Component: ExchangeOperations },
  { value: "settle", label: "تسديد مورد", Component: ExchangeSettle },
  { value: "statement", label: "كشف الحساب", Component: ExchangeStatement },
  { value: "reconcile", label: "مطابقة الأرصدة", Component: ExchangeReconcile },
];

export default function ExchangeHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الصيرفة" />;
}

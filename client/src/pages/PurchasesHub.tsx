// PurchasesHub — وحدة «المشتريات» بتبويبات (أوامر الشراء + مرتجعات الشراء).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Purchases = lazy(() => import("@/pages/Purchases"));
const PurchaseReturns = lazy(() => import("@/pages/PurchaseReturns"));

const TABS: HubTab[] = [
  { value: "orders", label: "أوامر الشراء", Component: Purchases },
  { value: "returns", label: "مرتجعات الشراء", Component: PurchaseReturns },
];

export default function PurchasesHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المشتريات" />;
}

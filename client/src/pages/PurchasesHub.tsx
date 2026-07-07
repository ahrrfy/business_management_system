// PurchasesHub — وحدة «المشتريات» بتبويبات (أوامر الشراء + مرتجعات الشراء).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Purchases = lazy(() => import("@/pages/Purchases"));
const PurchaseReturns = lazy(() => import("@/pages/PurchaseReturns"));

const TABS: HubTab[] = [
  { value: "orders", label: "أوامر الشراء", Component: Purchases },
  // purchaseReturns.list خادمياً = purchasesManagerProcedure(["manager", "purchasing"], "purchases", "FULL") — التبويب مرآتها (يُخفى عمّن يرفضه الخادم حتماً).
  { value: "returns", label: "مرتجعات الشراء", gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" }, Component: PurchaseReturns },
];

export default function PurchasesHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المشتريات" />;
}

// SalesHub — وحدة «المبيعات» بتبويبات (فواتير + عروض أسعار + مرتجعات + تقرير + صندوق الوارد).
// نقطة البيع وقارئ الأسعار أدواتٌ ملء‑شاشة مستقلّة في الشريط (ليست تبويبات هنا).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Invoices = lazy(() => import("@/pages/Invoices"));
const SalesReturns = lazy(() => import("@/pages/SalesReturns"));
const SalesReport = lazy(() => import("@/pages/SalesReport"));

const TABS: HubTab[] = [
  { value: "invoices", label: "فواتير المبيعات", Component: Invoices },
  // returns.list خادمياً = salesManagerProcedure(["manager"], "sales", "FULL") — التبويب مرآتها (يُخفى عمّن يرفضه الخادم حتماً).
  { value: "returns", label: "مرتجعات البيع", gate: { roles: ["manager"], module: "sales", level: "FULL" }, Component: SalesReturns },
  { value: "report", label: "تقرير المبيعات", gate: { managerOnly: true }, Component: SalesReport },
];

export default function SalesHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المبيعات" />;
}

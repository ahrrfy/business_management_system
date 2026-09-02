// SalesHub — وحدة «المبيعات» بتبويبات (فواتير + عروض أسعار + مرتجعات + تقرير + صندوق الوارد).
// نقطة البيع وقارئ الأسعار أدواتٌ ملء‑شاشة مستقلّة في الشريط (ليست تبويبات هنا).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Invoices = lazy(() => import("@/pages/Invoices"));
const SalesReturns = lazy(() => import("@/pages/SalesReturns"));
const SalesReport = lazy(() => import("@/pages/SalesReport"));

// مرآة reportViewerProcedure: الأدوار المالية القالبية تمرّ عبر خريطة صلاحياتها،
// وأي دور آخر لا يرى التبويب إلا بمنح reports صريح.
const REPORT_VIEWER_GATE: NonNullable<HubTab["gate"]> = {
  roles: ["manager", "accountant", "auditor"],
  module: "reports",
  level: "READ",
};

const TABS: HubTab[] = [
  { value: "invoices", label: "فواتير المبيعات", Component: Invoices },
  // returns.list خادمياً = salesManagerProcedure(["manager"], "sales", "FULL") — التبويب مرآتها (يُخفى عمّن يرفضه الخادم حتماً).
  { value: "returns", label: "مرتجعات البيع", gate: { roles: ["manager"], module: "sales", level: "FULL" }, Component: SalesReturns },
  { value: "report", label: "تقرير المبيعات", gate: REPORT_VIEWER_GATE, Component: SalesReport },
];

export default function SalesHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المبيعات" />;
}

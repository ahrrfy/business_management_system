// SalesHub — وحدة «المبيعات» بتبويبات (فواتير + عروض أسعار + مرتجعات + تقرير + صندوق الوارد).
// نقطة البيع وقارئ الأسعار أدواتٌ ملء‑شاشة مستقلّة في الشريط (ليست تبويبات هنا).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Invoices = lazy(() => import("@/pages/Invoices"));
const Quotations = lazy(() => import("@/pages/Quotations"));
const SalesReturns = lazy(() => import("@/pages/SalesReturns"));
const SalesReport = lazy(() => import("@/pages/SalesReport"));
const Inbox = lazy(() => import("@/pages/Inbox"));

const TABS: HubTab[] = [
  { value: "invoices", label: "فواتير المبيعات", Component: Invoices },
  { value: "quotations", label: "عروض الأسعار", Component: Quotations },
  // returns.list خادمياً = salesManagerProcedure(["manager"], "sales", "FULL") — التبويب مرآتها (يُخفى عمّن يرفضه الخادم حتماً).
  { value: "returns", label: "مرتجعات البيع", gate: { roles: ["manager"], module: "sales", level: "FULL" }, Component: SalesReturns },
  { value: "report", label: "تقرير المبيعات", gate: { managerOnly: true }, Component: SalesReport },
  // مرآة بوّابة الخادم (conversationRouter): قراءة الوارد = requireModule("channels","READ") —
  // القوالب تمنحها أيضاً لفنّي المطبعة/مندوب المبيعات/المدقّق، وmodule يفتح التبويب لمن مُنح «القنوات» صراحةً.
  { value: "inbox", label: "صندوق الوارد", gate: { roles: ["admin", "manager", "cashier", "print_operator", "sales_rep", "auditor"], module: "channels" }, Component: Inbox },
];

export default function SalesHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المبيعات" />;
}

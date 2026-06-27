// CustomersHub — صفحة وحدة «العملاء» بتبويبات ثانوية (قائمة + كشف حساب + أعمار الذمم).
// يُوحِّد ٣ مَداخل كانت مُتفرّقة في الشريط (قائمة العملاء + كَشف حساب عميل + أعمار الذمم
// المَدينة) في صفحة واحدة. كَشف الحساب والأعمار managerOnly (كَما كانا في الشريط سابقاً).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Customers = lazy(() => import("@/pages/Customers"));
const CustomerStatement = lazy(() => import("@/pages/CustomerStatement"));
const ARAging = lazy(() => import("@/pages/ARAging"));

const TABS: HubTab[] = [
  { value: "list", label: "العملاء", Component: Customers },
  { value: "statement", label: "كشف حساب عميل", gate: { managerOnly: true }, Component: CustomerStatement },
  { value: "aging", label: "أعمار الذمم (مدينة)", gate: { managerOnly: true }, Component: ARAging },
];

export default function CustomersHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام العملاء" />;
}

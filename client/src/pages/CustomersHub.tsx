// CustomersHub — صفحة وحدة «العملاء» بتبويبات ثانوية (قائمة + متابعة + كشف حساب + أعمار الذمم).
// يُوحِّد ٤ مَداخل كانت مُتفرّقة في الشريط (قائمة العملاء + متابعة العملاء + كَشف حساب عميل +
// أعمار الذمم المَدينة) في صفحة واحدة. كَشف الحساب والأعمار managerOnly (كَما كانا في الشريط سابقاً).
// «متابعة العملاء» متاحة لكل الأدوار (تسجيل ملاحظة متابعة عملية يومية، لا تقرير إشرافي).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Customers = lazy(() => import("@/pages/Customers"));
const CustomerNotes = lazy(() => import("@/pages/CustomerNotes"));
const CustomerStatement = lazy(() => import("@/pages/CustomerStatement"));
const ARAging = lazy(() => import("@/pages/ARAging"));

const TABS: HubTab[] = [
  { value: "list", label: "العملاء", Component: Customers },
  { value: "notes", label: "متابعة العملاء", Component: CustomerNotes },
  { value: "statement", label: "كشف حساب عميل", gate: { managerOnly: true }, Component: CustomerStatement },
  { value: "aging", label: "أعمار الذمم (مدينة)", gate: { managerOnly: true }, Component: ARAging },
];

export default function CustomersHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام العملاء" />;
}

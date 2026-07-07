// CustomersHub — صفحة وحدة «العملاء» بتبويبات ثانوية (قائمة + متابعة + كشف حساب + أعمار الذمم).
// يُوحِّد ٤ مَداخل كانت مُتفرّقة في الشريط (قائمة العملاء + متابعة العملاء + كَشف حساب عميل +
// أعمار الذمم المَدينة) في صفحة واحدة. كَشف الحساب والأعمار بمرآة بوّابة التقارير الخادمية
// reportViewerProcedure (مدير/محاسب/مدقّق + منح صريح reports).
// «متابعة العملاء» متاحة لكل الأدوار (تسجيل ملاحظة متابعة عملية يومية، لا تقرير إشرافي).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Customers = lazy(() => import("@/pages/Customers"));
const CustomerNotes = lazy(() => import("@/pages/CustomerNotes"));
const CustomerStatement = lazy(() => import("@/pages/CustomerStatement"));
const ARAging = lazy(() => import("@/pages/ARAging"));
const InstallmentPlans = lazy(() => import("@/pages/InstallmentPlans"));
const ContractPrices = lazy(() => import("@/pages/ContractPrices"));

const TABS: HubTab[] = [
  { value: "list", label: "العملاء", Component: Customers },
  { value: "notes", label: "متابعة العملاء", Component: CustomerNotes },
  // بند 12أ (٧/٧): الأقساط والشيكات الآجلة — بوّابة مرآة راوترها (treasury: مدير/محاسب + منح صريح).
  {
    value: "installments",
    label: "الأقساط",
    gate: { roles: ["manager", "accountant"], module: "treasury" },
    Component: InstallmentPlans,
  },
  // بند 12ب (٧/٧): أسعار تعاقدية خاصة بعميل (عقود الدوائر الحكومية) — إدارة بمدير.
  { value: "contracts", label: "التسعير التعاقدي", gate: { managerOnly: true }, Component: ContractPrices },
  // بوّابة مرآة reportViewerProcedure (server/trpc.ts): manager/accountant/auditor + منح صريح reports≥READ —
  // كانت managerOnly فتحجب التبويبين عن المحاسب/المدقّق رغم سماح الخادم لهما.
  {
    value: "statement",
    label: "كشف حساب عميل",
    gate: { roles: ["manager", "accountant", "auditor"], module: "reports" },
    Component: CustomerStatement,
  },
  {
    value: "aging",
    label: "أعمار الذمم (مدينة)",
    gate: { roles: ["manager", "accountant", "auditor"], module: "reports" },
    Component: ARAging,
  },
];

export default function CustomersHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام العملاء" />;
}

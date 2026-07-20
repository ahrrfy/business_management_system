// SuppliersHub — صفحة وحدة «الموردون» بتبويبات ثانوية (قائمة + كشف حساب + أعمار الذمم الدائنة).
// يُوحِّد قائمة الموردين مع كَشف حساب مورد وأعمار الذمم الدائنة (كانا managerOnly تحت
// «التقارير» في الشريط) في صفحة واحدة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Suppliers = lazy(() => import("@/pages/Suppliers"));
const SupplierStatement = lazy(() => import("@/pages/SupplierStatement"));
const APAging = lazy(() => import("@/pages/APAging"));
const ConsignmentNotes = lazy(() => import("@/pages/ConsignmentNotes"));

const TABS: HubTab[] = [
  { value: "list", label: "الموردون", Component: Suppliers },
  // بضاعة الأمانة (ش٢): سندات الإيداع/السحب/الاستبدال — خلف مفتاح consignments.
  { value: "consignment-notes", label: "سندات الأمانة", gate: { module: "consignments", level: "READ" }, Component: ConsignmentNotes },
  { value: "statement", label: "كشف حساب مورد", gate: { managerOnly: true }, Component: SupplierStatement },
  { value: "aging", label: "أعمار الذمم (دائنة)", gate: { managerOnly: true }, Component: APAging },
];

export default function SuppliersHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الموردين" />;
}

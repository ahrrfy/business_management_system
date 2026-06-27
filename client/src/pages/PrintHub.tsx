// PrintHub — وحدة «المطبعة والإنتاج» بتبويبات (طابور المطبعة + محطة التنفيذ + الإنتاج + الوصفات).
// مسارات الإنشاء/التفصيل (‎/work-orders/new، ‎/work-orders/:id، ‎/production/:id) تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const WorkOrders = lazy(() => import("@/pages/WorkOrders"));
const WorkOrderStation = lazy(() => import("@/pages/WorkOrderStation"));
const Production = lazy(() => import("@/pages/Production"));
const ProductionRecipes = lazy(() => import("@/pages/ProductionRecipes"));

const TABS: HubTab[] = [
  { value: "queue", label: "طابور المطبعة", Component: WorkOrders },
  { value: "station", label: "محطة التنفيذ", gate: { roles: ["admin", "manager", "print_operator", "cashier"] }, Component: WorkOrderStation },
  { value: "production", label: "الإنتاج والتحويل", gate: { managerOnly: true }, Component: Production },
  { value: "recipes", label: "وصفات الإنتاج", gate: { managerOnly: true }, Component: ProductionRecipes },
];

export default function PrintHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المطبعة والإنتاج" />;
}

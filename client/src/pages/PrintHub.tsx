// PrintHub — وحدة «المطبعة والإنتاج» بتبويبات (طابور المطبعة + محطة التنفيذ + الإنتاج + الوصفات).
// الإنشاء يتم من شاشة الاستقبال الموحدة؛ مسارات التفصيل (‎/work-orders/:id، ‎/production/:id) تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const WorkOrders = lazy(() => import("@/pages/WorkOrders"));
const WorkOrderStation = lazy(() => import("@/pages/WorkOrderStation"));
const Production = lazy(() => import("@/pages/Production"));
const ProductionRecipes = lazy(() => import("@/pages/ProductionRecipes"));
const PrintPricingCalculator = lazy(() => import("@/pages/PrintPricingCalculator"));
const PrintPricingSettings = lazy(() => import("@/pages/PrintPricingSettings"));

const TABS: HubTab[] = [
  // توحيد اصطلاحي (٣/٨): «طابور المطبعة» يطابق الآن عنوان الصفحة نفسها («أوامر الشغل» —
  // WorkOrders.tsx:841) بدل تسمية قديمة منفصلة توحي بمفهوم مختلف (طابور المطبعة فقط).
  { value: "queue", label: "أوامر الشغل", Component: WorkOrders },
  { value: "station", label: "محطة التنفيذ", gate: { roles: ["admin", "manager", "print_operator", "cashier"] }, Component: WorkOrderStation },
  { value: "production", label: "الإنتاج والتحويل", gate: { managerOnly: true }, Component: Production },
  { value: "recipes", label: "وصفات الإنتاج", gate: { managerOnly: true }, Component: ProductionRecipes },
  // محرّك تسعير الطباعة الرقمية (البند⑥ ط٢) — حاسبة + إعدادات، محصورة بالمدير.
  { value: "print-pricing", label: "حاسبة التسعير", gate: { managerOnly: true }, Component: PrintPricingCalculator },
  { value: "print-pricing-settings", label: "إعدادات التسعير", gate: { managerOnly: true }, Component: PrintPricingSettings },
];

export default function PrintHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المطبعة والإنتاج" />;
}

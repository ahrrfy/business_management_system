// StoreHub — لوحة تحكّم المتجر الإلكتروني (نمط hPanel): لوحة + طلبات + بنرات + إعدادات.
// البنرات/الإعدادات مديرية (storeManagerProcedure)؛ اللوحة/الطلبات لحاملي وحدة store.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const StoreDashboard = lazy(() => import("@/pages/store/StoreDashboard"));
const OrderFulfillment = lazy(() => import("@/pages/OrderFulfillment"));
const StoreCategories = lazy(() => import("@/pages/store/StoreCategories"));
const StoreCatalog = lazy(() => import("@/pages/store/StoreCatalog"));
const BannerManager = lazy(() => import("@/pages/store/BannerManager"));
const StoreSettingsPanel = lazy(() => import("@/pages/store/StoreSettingsPanel"));

const TABS: HubTab[] = [
  { value: "dashboard", label: "لوحة المتجر", Component: StoreDashboard },
  { value: "orders", label: "الطلبات", Component: OrderFulfillment },
  { value: "categories", label: "الفئات", gate: { managerOnly: true }, Component: StoreCategories },
  { value: "catalog", label: "الكتالوج والعرض", gate: { managerOnly: true }, Component: StoreCatalog },
  { value: "banners", label: "البنرات", gate: { managerOnly: true }, Component: BannerManager },
  { value: "settings", label: "الإعدادات", gate: { managerOnly: true }, Component: StoreSettingsPanel },
];

export default function StoreHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المتجر" />;
}

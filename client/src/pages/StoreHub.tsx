// StoreHub — لوحة تحكّم المتجر الإلكتروني (نمط hPanel): لوحة + طلبات + بنرات + إعدادات.
// التحكم العالمي بالمتجر (الفئات/البنرات/الإعدادات) admin حصراً؛ اللوحة/الطلبات لحاملي وحدة store.
import { ExternalLink } from "lucide-react";
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { Button } from "@/components/ui/button";
import { storefrontUrl } from "@/lib/siteHosts";

const StoreDashboard = lazy(() => import("@/pages/store/StoreDashboard"));
const OrderFulfillment = lazy(() => import("@/pages/OrderFulfillment"));
const StoreCategories = lazy(() => import("@/pages/store/StoreCategories"));
const StoreCatalog = lazy(() => import("@/pages/store/StoreCatalog"));
const StoreAnalytics = lazy(() => import("@/pages/store/StoreAnalytics"));
const BannerManager = lazy(() => import("@/pages/store/BannerManager"));
const StoreSettingsPanel = lazy(() => import("@/pages/store/StoreSettingsPanel"));
const LoyaltyManager = lazy(() => import("@/pages/store/LoyaltyManager"));
const StorePushCampaignManager = lazy(() => import("@/pages/store/StorePushCampaignManager"));

const TABS: HubTab[] = [
  { value: "dashboard", label: "لوحة المتجر", Component: StoreDashboard },
  { value: "orders", label: "الطلبات", Component: OrderFulfillment },
  { value: "categories", label: "الفئات", gate: { adminOnly: true }, Component: StoreCategories },
  { value: "catalog", label: "الكتالوج والعرض", gate: { managerOnly: true }, Component: StoreCatalog },
  { value: "analytics", label: "التحليلات", gate: { managerOnly: true }, Component: StoreAnalytics },
  { value: "banners", label: "البنرات", gate: { adminOnly: true }, Component: BannerManager },
  { value: "loyalty", label: "الولاء", gate: { adminOnly: true }, Component: LoyaltyManager },
  { value: "notifications", label: "إشعارات العملاء", gate: { adminOnly: true }, Component: StorePushCampaignManager },
  { value: "settings", label: "الإعدادات", gate: { adminOnly: true }, Component: StoreSettingsPanel },
];

export default function StoreHub() {
  // زرّ ثابت في كل التبويبات: يفتح متجر الزبون كما يراه الناس تماماً — على الدومين العام
  // (alarabiya.online) لا على دومين النظام، بتبويب جديد كي لا تُفقَد اللوحة.
  return (
    <PageTabs
      tabs={TABS}
      ariaLabel="أقسام المتجر"
      actions={
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => window.open(storefrontUrl(), "_blank", "noopener,noreferrer")}
          title="يفتح المتجر العلني (alarabiya.online) في تبويب جديد"
        >
          <ExternalLink aria-hidden className="size-4" />
          فتح المتجر
        </Button>
      }
    />
  );
}

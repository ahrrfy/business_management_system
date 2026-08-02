import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const DigitalDashboard = lazy(() => import("@/pages/digitalCards/DigitalDashboard"));
const DigitalOfferings = lazy(() => import("@/pages/digitalCards/DigitalOfferings"));
const DigitalPricing = lazy(() => import("@/pages/digitalCards/DigitalPricing"));
const DigitalProviders = lazy(() => import("@/pages/digitalCards/DigitalProviders"));
const DigitalReview = lazy(() => import("@/pages/digitalCards/DigitalReview"));
const DigitalSubscriptions = lazy(() => import("@/pages/digitalCards/DigitalSubscriptions"));
const DigitalWallets = lazy(() => import("@/pages/digitalCards/DigitalWallets"));

// البوّابة على مستوى المسار (RequireRole في App.tsx) تعكس digitalCardsAdminReadProcedure
// خادمياً — لا حاجة لقيد إضافي على كل تبويب.
const TABS: HubTab[] = [
  { value: "dashboard", label: "اللوحة", Component: DigitalDashboard },
  // التسعير ثانياً: هو العمل اليوميّ المتكرّر، وما بعده تعريفٌ يُضبط مرّة.
  { value: "pricing", label: "أسعار اليوم", gate: { managerOnly: true }, Component: DigitalPricing },
  // المراجعة قبل التعريفات: عملياتٌ عالقة تنتظر قراراً، وتأخيرها يُجمّد رصيد محفظة.
  { value: "review", label: "المراجعة والتسويات", Component: DigitalReview },
  { value: "offerings", label: "البطاقات والاشتراكات", Component: DigitalOfferings },
  { value: "subscriptions", label: "الاشتراكات وتجديداتها", Component: DigitalSubscriptions },
  { value: "providers", label: "المزوّدون", Component: DigitalProviders },
  { value: "wallets", label: "المحافظ", Component: DigitalWallets },
];

export default function DigitalCardsHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام البطاقات الرقمية" />;
}

import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { useDigitalGiftOperationAccess } from "@/lib/digitalGiftOperationAccess";

const DigitalDashboard = lazy(() => import("@/pages/digitalCards/DigitalDashboard"));
const DigitalOfferings = lazy(() => import("@/pages/digitalCards/DigitalOfferings"));
const DigitalPricing = lazy(() => import("@/pages/digitalCards/DigitalPricing"));
const DigitalProviders = lazy(() => import("@/pages/digitalCards/DigitalProviders"));
const DigitalReview = lazy(() => import("@/pages/digitalCards/DigitalReview"));
const DigitalSubscriptions = lazy(() => import("@/pages/digitalCards/DigitalSubscriptions"));
const DigitalWallets = lazy(() => import("@/pages/digitalCards/DigitalWallets"));

// Each tab summarizes its own operations; action controls still check their exact path.
const TABS: HubTab[] = [
  { value: "dashboard", label: "ملخص التشغيل", Component: DigitalDashboard },
  // التسعير ثانياً: هو العمل اليوميّ المتكرّر، وما بعده تعريفٌ يُضبط مرّة.
  { value: "pricing", label: "الأسعار", gate: { managerOnly: true }, Component: DigitalPricing },
  // المراجعة قبل التعريفات: عملياتٌ عالقة تنتظر قراراً، وتأخيرها يُجمّد رصيد محفظة.
  { value: "review", label: "عمليات تحتاج معالجة", Component: DigitalReview },
  { value: "offerings", label: "البطاقات والاشتراكات", Component: DigitalOfferings },
  { value: "subscriptions", label: "مبيعات الاشتراكات", Component: DigitalSubscriptions },
  { value: "providers", label: "المزوّدون", Component: DigitalProviders },
  { value: "wallets", label: "أرصدة أجهزة المزوّدين", Component: DigitalWallets },
];

export default function DigitalCardsHub() {
  const digitalAccess = useDigitalGiftOperationAccess();
  const tabOperations: Record<string, string[]> = {
    dashboard: ["dashboard.summary", "dashboard.providerBalances", "dashboard.postpaidDues", "dashboard.priceHealth", "dashboard.pendingExecutions", "dashboard.topOfferings", "dashboard.reconciliationStatus"],
    pricing: ["pricing.getMorningSheet", "pricing.mismatchReports", "pricing.saveDraft", "pricing.publish", "pricing.copyPrevious", "pricing.approveMismatch", "pricing.rejectMismatch", "pricing.cancelDraft", "pricing.approveBigChange"],
    review: ["sales.needsReview", "sales.reviewDetails", "sales.requestReviewResolution", "sales.approveReviewResolution", "sales.rejectReviewResolution", "wallets.reconciliations", "sales.expireStale"],
    offerings: ["offerings.list", "offerings.get", "offerings.create", "offerings.update", "offerings.toggle"],
    subscriptions: ["subscriptions.list"],
    providers: ["providers.list", "providers.create", "providers.update", "providers.toggle"],
    wallets: ["wallets.list", "wallets.statement", "wallets.create", "wallets.update", "wallets.deposit", "wallets.withdraw", "wallets.reconcile", "wallets.requestAdjustment", "wallets.approveAdjustment", "wallets.rejectAdjustment"],
  };
  const tabs = digitalAccess.canonical
    ? TABS.filter((tab) => tabOperations[tab.value]?.some((operation) => digitalAccess.can(`digitalCards.${operation}`))).map((tab) => ({ ...tab, gate: undefined }))
    : TABS;
  return <PageTabs tabs={tabs} ariaLabel="أقسام البطاقات الرقمية" />;
}

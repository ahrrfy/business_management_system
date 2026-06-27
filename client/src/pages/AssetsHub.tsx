// AssetsHub — وحدة «الأصول الثابتة» بتبويبات (اللوحة + السجلّ + العُهد + الاستبعاد). كلها managerOnly.
// مسارات الإنشاء/التفصيل (‎/assets/new، ‎/assets/:id، ‎/assets/:id/edit) تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Assets = lazy(() => import("@/pages/Assets"));
const AssetRegister = lazy(() => import("@/pages/AssetRegister"));
const AssetCustodyReport = lazy(() => import("@/pages/AssetCustodyReport"));
const AssetDisposalLog = lazy(() => import("@/pages/AssetDisposalLog"));

const TABS: HubTab[] = [
  { value: "dashboard", label: "لوحة الأصول", gate: { managerOnly: true }, Component: Assets },
  { value: "register", label: "سجلّ الأصول", gate: { managerOnly: true }, Component: AssetRegister },
  { value: "custody", label: "تقرير العُهد", gate: { managerOnly: true }, Component: AssetCustodyReport },
  { value: "disposal", label: "سجلّ الاستبعاد", gate: { managerOnly: true }, Component: AssetDisposalLog },
];

export default function AssetsHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الأصول الثابتة" />;
}

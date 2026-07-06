// ClosingHub — وحدة «الإقفال والرقابة المالية» بتبويبات (الإقفال الشهري + تدقيق التوافق +
// موافقات الائتمان + WIP + إقفال الفترات + الإقفال السنوي). مُركَّبة على مسار /closing.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const MonthlyClosePack = lazy(() => import("@/pages/MonthlyClosePack"));
const Reconcile = lazy(() => import("@/pages/Reconcile"));
const CreditApprovals = lazy(() => import("@/pages/CreditApprovals"));
const WIPReport = lazy(() => import("@/pages/WIPReport"));
const PeriodLock = lazy(() => import("@/pages/PeriodLock"));
const YearEnd = lazy(() => import("@/pages/YearEnd"));

const TABS: HubTab[] = [
  // بند 11 (٧/٧): صورة الشهر المالية الموحّدة — أول تبويب (أكثرها استعمالاً للمالك).
  { value: "monthly", label: "الإقفال الشهري", gate: { managerOnly: true }, Component: MonthlyClosePack },
  { value: "reconcile", label: "تدقيق التوافق المالي", gate: { managerOnly: true }, Component: Reconcile },
  { value: "credit", label: "موافقات الائتمان", gate: { managerOnly: true }, Component: CreditApprovals },
  { value: "wip", label: "الإنتاج تحت التنفيذ", gate: { managerOnly: true }, Component: WIPReport },
  { value: "period", label: "إقفال الفترات", gate: { adminOnly: true }, Component: PeriodLock },
  { value: "yearend", label: "الإقفال السنوي", gate: { adminOnly: true }, Component: YearEnd },
];

export default function ClosingHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الإقفال والرقابة" />;
}

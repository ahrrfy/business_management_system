// TreasuryHub — صفحة وحدة «الخزينة» بتبويبات ثانوية (لوحة + تحويلات نقدية + مصروفات + سندات + ورديات).
// يُوحِّد مَداخل الخزينة المُتفرّقة. الرابط في الشريط بلا قيد دور (كَما كانت المصروفات/السندات/
// الورديات مَرئية للكل) — والقيد يُطبَّق على التبويبات: اللوحة لأدوار مُحدَّدة، والتحويلات managerOnly.
// التوصيل (delivery) ليس جزءاً من هذا الـ hub — له مَدخله المُستقلّ في الشريط.
// مَسارات الإنشاء (‎/expenses/new، ‎/vouchers/*/new) تَبقى مُستقلّة خارج الـ hub.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Treasury = lazy(() => import("@/pages/Treasury"));
const TreasuryTransfers = lazy(() => import("@/pages/TreasuryTransfers"));
const Expenses = lazy(() => import("@/pages/Expenses"));
const Vouchers = lazy(() => import("@/pages/Vouchers"));
const Shifts = lazy(() => import("@/pages/Shifts"));

const TABS: HubTab[] = [
  { value: "dashboard", label: "لوحة الخزينة", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"] }, Component: Treasury },
  { value: "transfers", label: "تحويلات نقدية", gate: { managerOnly: true }, Component: TreasuryTransfers },
  { value: "expenses", label: "المصروفات", Component: Expenses },
  { value: "vouchers", label: "السندات", Component: Vouchers },
  { value: "shifts", label: "الورديات", Component: Shifts },
];

export default function TreasuryHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الخزينة" />;
}

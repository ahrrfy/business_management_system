// TreasuryHub — صفحة وحدة «الخزينة» بتبويبات ثانوية (لوحة + تحويلات نقدية + مصروفات + سندات + ورديات).
// يُوحِّد مَداخل الخزينة المُتفرّقة. رابط الشريط مُقيَّد (AppLayout) وكل تبويب بوّابته مرآةُ بوّابة
// الخادم لاستعلامات صفحته (نمط CustomersHub) — لا يُعرَض تبويبٌ كل استعلاماته تُرفَض بـ403.
// التوصيل (delivery) ليس جزءاً من هذا الـ hub — له مَدخله المُستقلّ في الشريط.
// مَسارات الإنشاء (‎/expenses/new، ‎/vouchers/*/new) تَبقى مُستقلّة خارج الـ hub.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Treasury = lazy(() => import("@/pages/Treasury"));
const DayCloseReport = lazy(() => import("@/pages/DayCloseReport"));
const TreasuryTransfers = lazy(() => import("@/pages/TreasuryTransfers"));
const Expenses = lazy(() => import("@/pages/Expenses"));
const ExpenseCategories = lazy(() => import("@/pages/ExpenseCategories"));
const Vouchers = lazy(() => import("@/pages/Vouchers"));
const VoucherCategories = lazy(() => import("@/pages/VoucherCategories"));
const Shifts = lazy(() => import("@/pages/Shifts"));
const CashVarianceResolutionPanel = lazy(() => import("@/components/treasury/CashVarianceResolutionPanel"));

// بوّابات التبويبات = مرآة بوّابات الخادم لاستعلامات كل صفحة (server/trpc.ts + الراوترات):
//  - اللوحة/الورديات: requireModule("treasury","READ") ⇒ الأدوار التي قالبها treasury≥READ + منح صريح.
//  - التحويلات/السندات: treasuryManagerReadProcedure(["manager","accountant"],"treasury") — الكاشير
//    (treasury=READ قالبياً) خارج قائمتها فكان يهبط على تبويبٍ ترفض قائمتُه بـ403 رغم ظهوره.
//  - المصروفات: expensesReadProcedure = requireModule("expenses","READ") (أمين المخزن expenses=NONE).
const TABS: HubTab[] = [
  { value: "dashboard", label: "لوحة الخزينة", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "treasury" }, Component: Treasury },
  { value: "daily-reconciliation", label: "المطابقة اليومية", gate: { roles: ["admin", "manager", "accountant", "auditor"], module: "reports" }, Component: DayCloseReport },
  { value: "cash-variance", label: "فروقات النقد", gate: { roles: ["admin", "manager", "accountant"], module: "treasury" }, Component: CashVarianceResolutionPanel },
  { value: "transfers", label: "تحويلات نقدية", gate: { roles: ["manager", "accountant"], module: "treasury" }, Component: TreasuryTransfers },
  { value: "expenses", label: "المصروفات", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "expenses" }, Component: Expenses },
  // فئات المصروفات: إدارة (مدير/محاسب) — الكاشير يُنشئ مصروفاً ويقرأ المنتقي لكنه لا يديره.
  { value: "expense-categories", label: "فئات المصروفات", gate: { roles: ["manager", "accountant"], module: "expenses" }, Component: ExpenseCategories },
  { value: "vouchers", label: "السندات", gate: { roles: ["manager", "accountant"], module: "treasury" }, Component: Vouchers },
  // فئات السندات: كانت شاشةً يتيمة بلا مدخلٍ في التنقّل — لا تُبلَغ إلّا من رابطٍ صغير داخل نموذج
  // السند، بينما فئتُها **إلزامية** لإتمام سند «أخرى». مكانها الطبيعيّ تبويبٌ في محور الخزينة.
  { value: "voucher-categories", label: "فئات السندات", gate: { roles: ["manager", "accountant"], module: "treasury" }, Component: VoucherCategories },
  { value: "shifts", label: "الورديات", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "treasury" }, Component: Shifts },
];

export default function TreasuryHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الخزينة" />;
}

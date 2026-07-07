// TreasuryHub — صفحة وحدة «الخزينة» بتبويبات ثانوية (لوحة + تحويلات نقدية + مصروفات + سندات + ورديات).
// يُوحِّد مَداخل الخزينة المُتفرّقة. رابط الشريط مُقيَّد (AppLayout) وكل تبويب بوّابته مرآةُ بوّابة
// الخادم لاستعلامات صفحته (نمط CustomersHub) — لا يُعرَض تبويبٌ كل استعلاماته تُرفَض بـ403.
// التوصيل (delivery) ليس جزءاً من هذا الـ hub — له مَدخله المُستقلّ في الشريط.
// مَسارات الإنشاء (‎/expenses/new، ‎/vouchers/*/new) تَبقى مُستقلّة خارج الـ hub.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Treasury = lazy(() => import("@/pages/Treasury"));
const TreasuryTransfers = lazy(() => import("@/pages/TreasuryTransfers"));
const Expenses = lazy(() => import("@/pages/Expenses"));
const Vouchers = lazy(() => import("@/pages/Vouchers"));
const Shifts = lazy(() => import("@/pages/Shifts"));

// بوّابات التبويبات = مرآة بوّابات الخادم لاستعلامات كل صفحة (server/trpc.ts + الراوترات):
//  - اللوحة/الورديات: requireModule("treasury","READ") ⇒ الأدوار التي قالبها treasury≥READ + منح صريح.
//  - التحويلات/السندات: treasuryManagerReadProcedure(["manager","accountant"],"treasury") — الكاشير
//    (treasury=READ قالبياً) خارج قائمتها فكان يهبط على تبويبٍ ترفض قائمتُه بـ403 رغم ظهوره.
//  - المصروفات: expensesReadProcedure = requireModule("expenses","READ") (أمين المخزن expenses=NONE).
const TABS: HubTab[] = [
  { value: "dashboard", label: "لوحة الخزينة", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "treasury" }, Component: Treasury },
  { value: "transfers", label: "تحويلات نقدية", gate: { roles: ["manager", "accountant"], module: "treasury" }, Component: TreasuryTransfers },
  { value: "expenses", label: "المصروفات", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "expenses" }, Component: Expenses },
  { value: "vouchers", label: "السندات", gate: { roles: ["manager", "accountant"], module: "treasury" }, Component: Vouchers },
  { value: "shifts", label: "الورديات", gate: { roles: ["admin", "manager", "accountant", "cashier", "auditor"], module: "treasury" }, Component: Shifts },
];

export default function TreasuryHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام الخزينة" />;
}

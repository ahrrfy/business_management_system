// تَوزيع الشيفرة (code-splitting): كل صفحة تُحمَّل عند الطَلب عبر `lazy()` ⇒ الحُزمة
// الأوّليّة تَنخفض من ~3.6MB chunk واحد إلى ~vendor + AppLayout + Login فقط، وكل مَسار
// يَجلب chunk صَغيراً عند الزيارة. السَبب: على VPS مُشترك بشبكة بطيئة، تَحميل 3.6MB قبل
// أيّ paint يُعطي إحساس «النظام ثقيل ولا يَفتح» — حتى لو الخادم سَريع. SW يُخبّئ الـchunks
// بعد أوّل زيارة (انظر vite.config.ts → workbox.maximumFileSizeToCacheInBytes=5MiB).
//
// استثناءات eager (تَبقى في الحُزمة الأساسية):
//  • Login: أوّل شاشة لمُستخدم غير مُصادَق ⇒ تجنّب وَميض Suspense قبل النَموذج.
//  • AppLayout/ErrorBoundary/RouteErrorBoundary/RequireRole/Protected: بنية الـshell.
//
// حَدّ Suspense واحد حَول `Switch` (لا حَول كل Route) ⇒ تَنقّل المَسارات يُظهر fallback
// مَرّة واحدة فَقط أثناء جَلب chunk الوِجهة، والـAppLayout (الشَريط الجانبي/الترويسة) يَبقى
// مَرسوماً. fallback نَفس نَصّ `Protected` ⇒ تَتابع بصري سَلِس.
import { Suspense } from "react";
import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RequireRole } from "@/components/RequireRole";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { RouteFallback } from "@/components/RouteFallback";
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { trpc } from "@/lib/trpc";
import Login from "@/pages/Login";
import { Redirect, Route, Switch } from "wouter";

const CustomerNew = lazy(() => import("@/pages/CustomerNew"));
const CustomerEdit = lazy(() => import("@/pages/CustomerEdit"));
const SupplierNew = lazy(() => import("@/pages/SupplierNew"));
const SupplierEdit = lazy(() => import("@/pages/SupplierEdit"));
// صَفحات الوحدات بتبويبات ثانوية (hubs): تَجمع شاشات الوحدة في صفحة واحدة بشريط ?tab=،
// وتُسطّح الشريط الجانبي إلى مَدخل واحد لكل وحدة. المسارات القَديمة للقوائم تُعيد التوجيه.
const CustomersHub = lazy(() => import("@/pages/CustomersHub"));
const SuppliersHub = lazy(() => import("@/pages/SuppliersHub"));
const InventoryHub = lazy(() => import("@/pages/InventoryHub"));
const TreasuryHub = lazy(() => import("@/pages/TreasuryHub"));
const SalesHub = lazy(() => import("@/pages/SalesHub"));
const PurchasesHub = lazy(() => import("@/pages/PurchasesHub"));
const PrintHub = lazy(() => import("@/pages/PrintHub"));
const AssetsHub = lazy(() => import("@/pages/AssetsHub"));
const HrHub = lazy(() => import("@/pages/HrHub"));
const DeliveryCenter = lazy(() => import("@/pages/DeliveryCenter"));
const ClosingHub = lazy(() => import("@/pages/ClosingHub"));
const AdminHub = lazy(() => import("@/pages/AdminHub"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const ExpenseNew = lazy(() => import("@/pages/ExpenseNew"));
const VoucherPaymentNew = lazy(() => import("@/pages/VoucherPaymentNew"));
const VoucherReceiptNew = lazy(() => import("@/pages/VoucherReceiptNew"));
const InvoiceDetail = lazy(() => import("@/pages/InvoiceDetail"));
const PointOfSale = lazy(() => import("@/pages/PointOfSale"));
const PriceChecker = lazy(() => import("@/pages/PriceChecker"));
const Kiosk = lazy(() => import("@/pages/Kiosk"));
const SalesInvoiceNew = lazy(() => import("@/pages/SalesInvoiceNew"));
const ProductEdit = lazy(() => import("@/pages/ProductEdit"));
const ProductNew = lazy(() => import("@/pages/ProductNew"));
const PurchaseNew = lazy(() => import("@/pages/PurchaseNew"));
const PurchaseReceive = lazy(() => import("@/pages/PurchaseReceive"));
const QuotationNew = lazy(() => import("@/pages/QuotationNew"));
const QuotationDetail = lazy(() => import("@/pages/QuotationDetail"));
const Returns = lazy(() => import("@/pages/Returns"));
const SalesReturnNew = lazy(() => import("@/pages/SalesReturnNew"));
const PurchaseReturnNew = lazy(() => import("@/pages/PurchaseReturnNew"));
const WorkOrderDetail = lazy(() => import("@/pages/WorkOrderDetail"));
const WorkOrderNew = lazy(() => import("@/pages/WorkOrderNew"));
const ProductionNew = lazy(() => import("@/pages/ProductionNew"));
const ProductionDetail = lazy(() => import("@/pages/ProductionDetail"));
const AssetDetail = lazy(() => import("@/pages/AssetDetail"));
const AssetNew = lazy(() => import("@/pages/AssetNew"));
const AssetEdit = lazy(() => import("@/pages/AssetEdit"));
const EmployeeNew = lazy(() => import("@/pages/EmployeeNew"));
const EmployeeDetail = lazy(() => import("@/pages/EmployeeDetail"));
const JobApply = lazy(() => import("@/pages/JobApply"));
const UserNew = lazy(() => import("@/pages/UserNew"));
const UserEdit = lazy(() => import("@/pages/UserEdit"));
const RoleEdit = lazy(() => import("@/pages/RoleEdit"));
const Account = lazy(() => import("@/pages/Account"));
const SalesReportsHub = lazy(() => import("@/pages/SalesReportsHub"));
const AgingReportsHub = lazy(() => import("@/pages/AgingReportsHub"));
const ReportsCenter = lazy(() => import("@/pages/ReportsCenter"));
const ReportsHub = lazy(() => import("@/pages/ReportsHub"));
const CreditExposureReport = lazy(() => import("@/pages/CreditExposureReport"));
const ProfitabilityReport = lazy(() => import("@/pages/ProfitabilityReport"));
const InventoryOpsReport = lazy(() => import("@/pages/InventoryOpsReport"));
const ProfitLoss = lazy(() => import("@/pages/ProfitLoss"));
const GeneralLedger = lazy(() => import("@/pages/GeneralLedger"));
const TrialBalance = lazy(() => import("@/pages/TrialBalance"));
const BalanceSheet = lazy(() => import("@/pages/BalanceSheet"));
const CashFlow = lazy(() => import("@/pages/CashFlow"));
const SalesRegister = lazy(() => import("@/pages/SalesRegister"));
const SalesByDimension = lazy(() => import("@/pages/SalesByDimension"));
const PurchasesReport = lazy(() => import("@/pages/PurchasesReport"));
const PurchaseRegister = lazy(() => import("@/pages/PurchaseRegister"));
const ArApAgingDetail = lazy(() => import("@/pages/ArApAgingDetail"));
const InventoryValuation = lazy(() => import("@/pages/InventoryValuation"));
const StockStatus = lazy(() => import("@/pages/StockStatus"));
const ItemLedger = lazy(() => import("@/pages/ItemLedger"));
const AbcAnalysis = lazy(() => import("@/pages/AbcAnalysis"));
const TreasuryReport = lazy(() => import("@/pages/TreasuryReport"));
const ExpensesReport = lazy(() => import("@/pages/ExpensesReport"));
const CashOrphanReport = lazy(() => import("@/pages/CashOrphanReport"));
const ProductionReport = lazy(() => import("@/pages/ProductionReport"));
const WorkOrdersReport = lazy(() => import("@/pages/WorkOrdersReport"));
const PayrollReport = lazy(() => import("@/pages/PayrollReport"));
const AttendanceReport = lazy(() => import("@/pages/AttendanceReport"));
const LeaveReport = lazy(() => import("@/pages/LeaveReport"));
const HrChangesReport = lazy(() => import("@/pages/HrChangesReport"));
const ExecutiveDashboard = lazy(() => import("@/pages/ExecutiveDashboard"));
const StocktakeNew = lazy(() => import("@/pages/StocktakeNew"));
const StocktakeMonitor = lazy(() => import("@/pages/StocktakeMonitor"));
const StocktakeReview = lazy(() => import("@/pages/StocktakeReview"));
const StocktakeReport = lazy(() => import("@/pages/StocktakeReport"));
const StocktakeCountSheets = lazy(() => import("@/pages/StocktakeCountSheets"));
const CountPortal = lazy(() => import("@/pages/CountPortal"));

function Protected({ children }: { children: React.ReactNode }) {
  const me = trpc.auth.me.useQuery();
  if (me.isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">جارٍ التحميل…</div>;
  }
  if (!me.data) return <Redirect to="/login" />;
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Protected>
      <AppLayout>
        {/* حدّ خطأ لكل صفحة: عطل شاشة واحدة لا يُعطّل التنقّل/الشريط الجانبي. */}
        <RouteErrorBoundary>{children}</RouteErrorBoundary>
      </AppLayout>
    </Protected>
  );
}

function NotFound() {
  return <div className="p-10 text-center text-muted-foreground">404 — الصفحة غير موجودة</div>;
}

export default function App() {
  return (
    <ErrorBoundary>
    <Suspense fallback={<RouteFallback />}>
    <Switch>
      <Route path="/login" component={Login} />
      {/* نقطة البيع الموحَّدة — Shell واحد لـ٣ أوضاع (تجزئة/خدمات طباعة/استقبال أوامر شغل) */}
      <Route path="/pos">
        <Protected>
          <PointOfSale />
        </Protected>
      </Route>
      {/* إعادة توجيه قَديمة: /print-pos ⇒ /pos?mode=PRINT_SERVICES */}
      <Route path="/print-pos">
        <Redirect to="/pos?mode=PRINT_SERVICES" />
      </Route>
      {/* شاشة قارئ الأسعار (الكشك) بملء الشاشة (بلا قائمة جانبية) — جهاز المتجر مسجَّل الدخول */}
      <Route path="/price-checker">
        <Protected>
          <PriceChecker />
        </Protected>
      </Route>
      {/* جهاز الكشك الخارجي — بملء الشاشة بمصادقة جهاز (كوكي رمز للقراءة فقط)، بلا جلسة دخول وبلا AppLayout */}
      <Route path="/kiosk" component={Kiosk} />
      {/* بوابة العدّ الخارجية لعامل الجرد — عامة بمصادقة PIN خاصة، بلا جلسة دخول وبلا AppLayout */}
      <Route path="/count/:code" component={CountPortal} />
      {/* استمارة التقديم على الوظائف — صفحة عامة بلا جلسة دخول وبلا AppLayout (رابط خارجي للمتقدّمين) */}
      <Route path="/apply" component={JobApply} />
      <Route path="/"><Shell><Dashboard /></Shell></Route>
      {/* أُدمجت في وحدة المخزون (InventoryHub) — إعادة توجيه تَحفظ الروابط القديمة */}
      <Route path="/products"><Redirect to="/inventory?tab=products" /></Route>
      <Route path="/products/new"><Shell><ProductNew /></Shell></Route>
      <Route path="/products/:id/edit"><Shell><ProductEdit /></Shell></Route>
      <Route path="/categories"><Redirect to="/inventory?tab=categories" /></Route>
      <Route path="/barcode-labels"><Redirect to="/inventory?tab=barcodes" /></Route>
      <Route path="/invoices"><Shell><SalesHub /></Shell></Route>
      <Route path="/sales/new"><Shell><SalesInvoiceNew /></Shell></Route>
      <Route path="/invoices/:id"><Shell><InvoiceDetail /></Shell></Route>
      <Route path="/quotations"><Redirect to="/invoices?tab=quotations" /></Route>
      <Route path="/quotations/new"><Shell><QuotationNew /></Shell></Route>
      <Route path="/quotations/:id"><Shell><QuotationDetail /></Shell></Route>
      <Route path="/customers"><Shell><CustomersHub /></Shell></Route>
      <Route path="/customers/new"><Shell><CustomerNew /></Shell></Route>
      <Route path="/customers/:id/edit"><Shell><CustomerEdit /></Shell></Route>
      <Route path="/returns"><Shell><Returns /></Shell></Route>
      <Route path="/sales-returns/new"><Shell><SalesReturnNew /></Shell></Route>
      <Route path="/sales-returns"><Redirect to="/invoices?tab=returns" /></Route>
      <Route path="/purchase-returns/new"><Shell><PurchaseReturnNew /></Shell></Route>
      <Route path="/purchase-returns"><Redirect to="/purchases?tab=returns" /></Route>
      <Route path="/purchases"><Shell><PurchasesHub /></Shell></Route>
      <Route path="/purchases/new"><Shell><PurchaseNew /></Shell></Route>
      <Route path="/purchases/:id/receive"><Shell><PurchaseReceive /></Shell></Route>
      <Route path="/inventory"><Shell><InventoryHub /></Shell></Route>
      <Route path="/stocktakes"><Redirect to="/inventory?tab=stocktakes" /></Route>
      <Route path="/stocktakes/new"><Shell><StocktakeNew /></Shell></Route>
      <Route path="/stocktakes/:id/review"><Shell><StocktakeReview /></Shell></Route>
      <Route path="/stocktakes/:id/report"><Shell><StocktakeReport /></Shell></Route>
      <Route path="/stocktakes/:id/sheets"><Shell><StocktakeCountSheets /></Shell></Route>
      <Route path="/stocktakes/:id"><Shell><StocktakeMonitor /></Shell></Route>
      <Route path="/inventory-movements"><Redirect to="/inventory?tab=movements" /></Route>
      <Route path="/transfers"><Redirect to="/inventory?tab=transfers" /></Route>
      <Route path="/work-orders"><Shell><PrintHub /></Shell></Route>
      <Route path="/work-orders/new"><Shell><WorkOrderNew /></Shell></Route>
      {/* إعادة توجيه قَديمة: /work-orders/reception ⇒ /pos?mode=RECEPTION */}
      <Route path="/work-orders/reception"><Redirect to="/pos?mode=RECEPTION" /></Route>
      <Route path="/work-orders/station"><Redirect to="/work-orders?tab=station" /></Route>
      <Route path="/inbox"><Redirect to="/invoices?tab=inbox" /></Route>
      <Route path="/settings/integrations"><Redirect to="/settings?tab=integrations" /></Route>
      <Route path="/work-orders/:id"><Shell><WorkOrderDetail /></Shell></Route>
      <Route path="/production"><Redirect to="/work-orders?tab=production" /></Route>
      <Route path="/production/new"><Shell><ProductionNew /></Shell></Route>
      <Route path="/production/:id"><Shell><ProductionDetail /></Shell></Route>
      <Route path="/production-recipes"><Redirect to="/work-orders?tab=recipes" /></Route>
      <Route path="/assets"><Shell><RequireRole roles={["admin","manager"]}><AssetsHub /></RequireRole></Shell></Route>
      <Route path="/assets/new"><Shell><AssetNew /></Shell></Route>
      <Route path="/assets/register"><Redirect to="/assets?tab=register" /></Route>
      <Route path="/assets/custody-report"><Redirect to="/assets?tab=custody" /></Route>
      <Route path="/assets/disposal-log"><Redirect to="/assets?tab=disposal" /></Route>
      <Route path="/assets/:id/edit"><Shell><AssetEdit /></Shell></Route>
      <Route path="/assets/:id"><Shell><AssetDetail /></Shell></Route>
      <Route path="/hr"><Shell><RequireRole roles={["admin","manager"]}><HrHub /></RequireRole></Shell></Route>
      <Route path="/hr/employees"><Redirect to="/hr?tab=employees" /></Route>
      <Route path="/hr/employees/new"><Shell><EmployeeNew /></Shell></Route>
      <Route path="/hr/employees/:id/edit"><Shell><EmployeeNew /></Shell></Route>
      <Route path="/hr/employees/:id"><Shell><EmployeeDetail /></Shell></Route>
      <Route path="/hr/attendance"><Redirect to="/hr?tab=attendance" /></Route>
      <Route path="/hr/payroll"><Redirect to="/hr?tab=payroll" /></Route>
      <Route path="/hr/leaves"><Redirect to="/hr?tab=leaves" /></Route>
      <Route path="/hr/recruitment"><Redirect to="/hr?tab=recruitment" /></Route>
      <Route path="/hr/devices"><Redirect to="/hr?tab=devices" /></Route>
      <Route path="/hr/promotions"><Redirect to="/hr?tab=promotions" /></Route>
      {/* أُدمجت في وحدة الخزينة (TreasuryHub) — إعادة توجيه تَحفظ الروابط القديمة */}
      <Route path="/expenses"><Redirect to="/treasury?tab=expenses" /></Route>
      <Route path="/expenses/new"><Shell><ExpenseNew /></Shell></Route>
      <Route path="/vouchers"><Redirect to="/treasury?tab=vouchers" /></Route>
      <Route path="/vouchers/receipt/new"><Shell><VoucherReceiptNew /></Shell></Route>
      <Route path="/vouchers/payment/new"><Shell><VoucherPaymentNew /></Shell></Route>
      <Route path="/shifts"><Redirect to="/treasury?tab=shifts" /></Route>
      <Route path="/treasury"><Shell><TreasuryHub /></Shell></Route>
      <Route path="/treasury/transfers"><Redirect to="/treasury?tab=transfers" /></Route>
      <Route path="/delivery"><Shell><RequireRole roles={["admin","manager","accountant","cashier","auditor"]}><DeliveryCenter /></RequireRole></Shell></Route>
      <Route path="/delivery/parties"><Redirect to="/delivery?tab=parties" /></Route>
      <Route path="/reports"><Shell><ReportsHub /></Shell></Route>
      <Route path="/reports/credit-exposure"><Shell><RequireRole roles={["admin","manager","accountant","auditor"]}><CreditExposureReport /></RequireRole></Shell></Route>
      <Route path="/reports/profit-loss"><Shell><RequireRole roles={["admin","manager"]}><ProfitLoss /></RequireRole></Shell></Route>
      <Route path="/reports/general-ledger"><Shell><RequireRole roles={["admin","manager"]}><GeneralLedger /></RequireRole></Shell></Route>
      <Route path="/reports/trial-balance"><Shell><RequireRole roles={["admin","manager"]}><TrialBalance /></RequireRole></Shell></Route>
      <Route path="/reports/balance-sheet"><Shell><RequireRole roles={["admin","manager"]}><BalanceSheet /></RequireRole></Shell></Route>
      <Route path="/reports/cash-flow"><Shell><RequireRole roles={["admin","manager"]}><CashFlow /></RequireRole></Shell></Route>
      <Route path="/reports/sales-register"><Shell><RequireRole roles={["admin","manager"]}><SalesRegister /></RequireRole></Shell></Route>
      <Route path="/reports/sales-by-dimension"><Shell><RequireRole roles={["admin","manager"]}><SalesByDimension /></RequireRole></Shell></Route>
      <Route path="/reports/profitability"><Shell><RequireRole roles={["admin","manager","accountant","auditor"]}><ProfitabilityReport /></RequireRole></Shell></Route>
      <Route path="/reports/purchases"><Shell><RequireRole roles={["admin","manager"]}><PurchasesReport /></RequireRole></Shell></Route>
      <Route path="/reports/purchase-register"><Shell><RequireRole roles={["admin","manager"]}><PurchaseRegister /></RequireRole></Shell></Route>
      <Route path="/reports/aging-detail"><Shell><RequireRole roles={["admin","manager"]}><ArApAgingDetail /></RequireRole></Shell></Route>
      <Route path="/reports/inventory-valuation"><Shell><RequireRole roles={["admin","manager"]}><InventoryValuation /></RequireRole></Shell></Route>
      <Route path="/reports/stock-status"><Shell><RequireRole roles={["admin","manager"]}><StockStatus /></RequireRole></Shell></Route>
      <Route path="/reports/inventory-ops"><Shell><RequireRole roles={["admin","manager","warehouse","purchasing","auditor"]}><InventoryOpsReport /></RequireRole></Shell></Route>
      <Route path="/reports/item-ledger"><Shell><RequireRole roles={["admin","manager"]}><ItemLedger /></RequireRole></Shell></Route>
      <Route path="/reports/abc"><Shell><RequireRole roles={["admin","manager"]}><AbcAnalysis /></RequireRole></Shell></Route>
      <Route path="/reports/treasury"><Shell><RequireRole roles={["admin","manager"]}><TreasuryReport /></RequireRole></Shell></Route>
      <Route path="/reports/expenses"><Shell><RequireRole roles={["admin","manager"]}><ExpensesReport /></RequireRole></Shell></Route>
      <Route path="/reports/cash-orphans"><Shell><RequireRole roles={["admin","manager"]}><CashOrphanReport /></RequireRole></Shell></Route>
      <Route path="/reports/production"><Shell><RequireRole roles={["admin","manager"]}><ProductionReport /></RequireRole></Shell></Route>
      <Route path="/reports/work-orders"><Shell><RequireRole roles={["admin","manager"]}><WorkOrdersReport /></RequireRole></Shell></Route>
      <Route path="/reports/payroll"><Shell><RequireRole roles={["admin","manager"]}><PayrollReport /></RequireRole></Shell></Route>
      <Route path="/reports/attendance"><Shell><RequireRole roles={["admin","manager"]}><AttendanceReport /></RequireRole></Shell></Route>
      <Route path="/reports/leaves"><Shell><RequireRole roles={["admin","manager"]}><LeaveReport /></RequireRole></Shell></Route>
      <Route path="/reports/hr-changes"><Shell><RequireRole roles={["admin","manager"]}><HrChangesReport /></RequireRole></Shell></Route>
      <Route path="/reports/executive"><Shell><RequireRole roles={["admin","manager"]}><ExecutiveDashboard /></RequireRole></Shell></Route>
      <Route path="/sales-report"><Redirect to="/invoices?tab=report" /></Route>
      <Route path="/reports/sales-hub"><Shell><RequireRole roles={["admin","manager"]}><SalesReportsHub /></RequireRole></Shell></Route>
      <Route path="/reports/aging-hub"><Shell><RequireRole roles={["admin","manager"]}><AgingReportsHub /></RequireRole></Shell></Route>
      {/* أُدمجت في وحدة العملاء (CustomersHub) — إعادة توجيه تَحفظ الروابط القديمة */}
      <Route path="/ar-aging"><Redirect to="/customers?tab=aging" /></Route>
      <Route path="/customers-statement"><Redirect to="/customers?tab=statement" /></Route>
      <Route path="/suppliers"><Shell><SuppliersHub /></Shell></Route>
      <Route path="/suppliers/new"><Shell><SupplierNew /></Shell></Route>
      <Route path="/suppliers/:id/edit"><Shell><SupplierEdit /></Shell></Route>
      {/* أُدمجت في وحدة الموردين (SuppliersHub) — إعادة توجيه تَحفظ الروابط القديمة */}
      <Route path="/ap-aging"><Redirect to="/suppliers?tab=aging" /></Route>
      <Route path="/suppliers-statement"><Redirect to="/suppliers?tab=statement" /></Route>
      <Route path="/kiosk-devices"><Redirect to="/settings?tab=devices" /></Route>
      <Route path="/users"><Redirect to="/settings?tab=users" /></Route>
      <Route path="/users/new"><Shell><RequireRole roles={["admin","manager"]}><UserNew /></RequireRole></Shell></Route>
      <Route path="/users/:id/edit"><Shell><RequireRole roles={["admin","manager"]}><UserEdit /></RequireRole></Shell></Route>
      <Route path="/roles"><Redirect to="/settings?tab=roles" /></Route>
      <Route path="/roles/new"><Shell><RequireRole roles={["admin"]}><RoleEdit /></RequireRole></Shell></Route>
      <Route path="/roles/:id/edit"><Shell><RequireRole roles={["admin"]}><RoleEdit /></RequireRole></Shell></Route>
      <Route path="/account"><Shell><Account /></Shell></Route>
      <Route path="/audit"><Redirect to="/settings?tab=audit" /></Route>
      <Route path="/closing"><Shell><RequireRole roles={["admin","manager"]}><ClosingHub /></RequireRole></Shell></Route>
      <Route path="/period-lock"><Redirect to="/closing?tab=period" /></Route>
      <Route path="/credit-approvals"><Redirect to="/closing?tab=credit" /></Route>
      <Route path="/year-end"><Redirect to="/closing?tab=yearend" /></Route>
      <Route path="/wip-report"><Redirect to="/closing?tab=wip" /></Route>
      <Route path="/reconcile"><Redirect to="/closing?tab=reconcile" /></Route>
      <Route path="/settings"><Shell><RequireRole roles={["admin","manager"]}><AdminHub /></RequireRole></Shell></Route>
      <Route><Shell><NotFound /></Shell></Route>
    </Switch>
    </Suspense>
    </ErrorBoundary>
  );
}

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
import { lazy, Suspense } from "react";
import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RequireRole } from "@/components/RequireRole";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { RouteFallback } from "@/components/RouteFallback";
import { trpc } from "@/lib/trpc";
import Login from "@/pages/Login";
import { Redirect, Route, Switch } from "wouter";

const APAging = lazy(() => import("@/pages/APAging"));
const ARAging = lazy(() => import("@/pages/ARAging"));
const BarcodeLabels = lazy(() => import("@/pages/BarcodeLabels"));
const CustomerStatement = lazy(() => import("@/pages/CustomerStatement"));
const Customers = lazy(() => import("@/pages/Customers"));
const CustomerNew = lazy(() => import("@/pages/CustomerNew"));
const CustomerEdit = lazy(() => import("@/pages/CustomerEdit"));
const SupplierStatement = lazy(() => import("@/pages/SupplierStatement"));
const Suppliers = lazy(() => import("@/pages/Suppliers"));
const SupplierNew = lazy(() => import("@/pages/SupplierNew"));
const SupplierEdit = lazy(() => import("@/pages/SupplierEdit"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const ExpenseNew = lazy(() => import("@/pages/ExpenseNew"));
const Expenses = lazy(() => import("@/pages/Expenses"));
const Inventory = lazy(() => import("@/pages/Inventory"));
const VoucherPaymentNew = lazy(() => import("@/pages/VoucherPaymentNew"));
const VoucherReceiptNew = lazy(() => import("@/pages/VoucherReceiptNew"));
const Vouchers = lazy(() => import("@/pages/Vouchers"));
const InvoiceDetail = lazy(() => import("@/pages/InvoiceDetail"));
const Invoices = lazy(() => import("@/pages/Invoices"));
const POS = lazy(() => import("@/pages/POS"));
const PrintPOS = lazy(() => import("@/pages/PrintPOS"));
const PriceChecker = lazy(() => import("@/pages/PriceChecker"));
const Kiosk = lazy(() => import("@/pages/Kiosk"));
const KioskDevices = lazy(() => import("@/pages/KioskDevices"));
const SalesInvoiceNew = lazy(() => import("@/pages/SalesInvoiceNew"));
const ProductEdit = lazy(() => import("@/pages/ProductEdit"));
const ProductNew = lazy(() => import("@/pages/ProductNew"));
const Products = lazy(() => import("@/pages/Products"));
const Purchases = lazy(() => import("@/pages/Purchases"));
const PurchaseNew = lazy(() => import("@/pages/PurchaseNew"));
const PurchaseReceive = lazy(() => import("@/pages/PurchaseReceive"));
const Quotations = lazy(() => import("@/pages/Quotations"));
const QuotationNew = lazy(() => import("@/pages/QuotationNew"));
const QuotationDetail = lazy(() => import("@/pages/QuotationDetail"));
const Returns = lazy(() => import("@/pages/Returns"));
const SalesReturnNew = lazy(() => import("@/pages/SalesReturnNew"));
const SalesReturns = lazy(() => import("@/pages/SalesReturns"));
const PurchaseReturnNew = lazy(() => import("@/pages/PurchaseReturnNew"));
const PurchaseReturns = lazy(() => import("@/pages/PurchaseReturns"));
const Transfers = lazy(() => import("@/pages/Transfers"));
const WorkOrderDetail = lazy(() => import("@/pages/WorkOrderDetail"));
const WorkOrderNew = lazy(() => import("@/pages/WorkOrderNew"));
const WorkOrderStation = lazy(() => import("@/pages/WorkOrderStation"));
const WorkOrders = lazy(() => import("@/pages/WorkOrders"));
const Production = lazy(() => import("@/pages/Production"));
const ProductionNew = lazy(() => import("@/pages/ProductionNew"));
const ProductionDetail = lazy(() => import("@/pages/ProductionDetail"));
const ProductionRecipes = lazy(() => import("@/pages/ProductionRecipes"));
const Assets = lazy(() => import("@/pages/Assets"));
const AssetRegister = lazy(() => import("@/pages/AssetRegister"));
const AssetDetail = lazy(() => import("@/pages/AssetDetail"));
const AssetNew = lazy(() => import("@/pages/AssetNew"));
const AssetCustodyReport = lazy(() => import("@/pages/AssetCustodyReport"));
const AssetDisposalLog = lazy(() => import("@/pages/AssetDisposalLog"));
const AssetEdit = lazy(() => import("@/pages/AssetEdit"));
const Employees = lazy(() => import("@/pages/Employees"));
const EmployeeNew = lazy(() => import("@/pages/EmployeeNew"));
const EmployeeDetail = lazy(() => import("@/pages/EmployeeDetail"));
const Attendance = lazy(() => import("@/pages/Attendance"));
const Payroll = lazy(() => import("@/pages/Payroll"));
const Leaves = lazy(() => import("@/pages/Leaves"));
const Recruitment = lazy(() => import("@/pages/Recruitment"));
const HrDevices = lazy(() => import("@/pages/HrDevices"));
const Promotions = lazy(() => import("@/pages/Promotions"));
const JobApply = lazy(() => import("@/pages/JobApply"));
const Shifts = lazy(() => import("@/pages/Shifts"));
const Users = lazy(() => import("@/pages/Users"));
const UserNew = lazy(() => import("@/pages/UserNew"));
const UserEdit = lazy(() => import("@/pages/UserEdit"));
const Roles = lazy(() => import("@/pages/Roles"));
const RoleEdit = lazy(() => import("@/pages/RoleEdit"));
const Account = lazy(() => import("@/pages/Account"));
const AuditLogs = lazy(() => import("@/pages/AuditLogs"));
const PeriodLock = lazy(() => import("@/pages/PeriodLock"));
const CreditApprovals = lazy(() => import("@/pages/CreditApprovals"));
const YearEnd = lazy(() => import("@/pages/YearEnd"));
const WIPReport = lazy(() => import("@/pages/WIPReport"));
const InventoryMovements = lazy(() => import("@/pages/InventoryMovements"));
const SalesReport = lazy(() => import("@/pages/SalesReport"));
const ReportsCenter = lazy(() => import("@/pages/ReportsCenter"));
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
const Treasury = lazy(() => import("@/pages/Treasury"));
const TreasuryTransfers = lazy(() => import("@/pages/TreasuryTransfers"));
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
const Reconcile = lazy(() => import("@/pages/Reconcile"));
const Settings = lazy(() => import("@/pages/Settings"));
const Stocktakes = lazy(() => import("@/pages/Stocktakes"));
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
      {/* نقطة البيع بملء الشاشة (بلا قائمة جانبية) */}
      <Route path="/pos">
        <Protected>
          <POS />
        </Protected>
      </Route>
      {/* نقطة بيع قسم الطباعة والاستنساخ بملء الشاشة (بلا قائمة جانبية) */}
      <Route path="/print-pos">
        <Protected>
          <PrintPOS />
        </Protected>
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
      <Route path="/products"><Shell><Products /></Shell></Route>
      <Route path="/products/new"><Shell><ProductNew /></Shell></Route>
      <Route path="/products/:id/edit"><Shell><ProductEdit /></Shell></Route>
      <Route path="/barcode-labels"><Shell><BarcodeLabels /></Shell></Route>
      <Route path="/invoices"><Shell><Invoices /></Shell></Route>
      <Route path="/sales/new"><Shell><SalesInvoiceNew /></Shell></Route>
      <Route path="/invoices/:id"><Shell><InvoiceDetail /></Shell></Route>
      <Route path="/quotations"><Shell><Quotations /></Shell></Route>
      <Route path="/quotations/new"><Shell><QuotationNew /></Shell></Route>
      <Route path="/quotations/:id"><Shell><QuotationDetail /></Shell></Route>
      <Route path="/customers"><Shell><Customers /></Shell></Route>
      <Route path="/customers/new"><Shell><CustomerNew /></Shell></Route>
      <Route path="/customers/:id/edit"><Shell><CustomerEdit /></Shell></Route>
      <Route path="/returns"><Shell><Returns /></Shell></Route>
      <Route path="/sales-returns/new"><Shell><SalesReturnNew /></Shell></Route>
      <Route path="/sales-returns"><Shell><SalesReturns /></Shell></Route>
      <Route path="/purchase-returns/new"><Shell><PurchaseReturnNew /></Shell></Route>
      <Route path="/purchase-returns"><Shell><PurchaseReturns /></Shell></Route>
      <Route path="/purchases"><Shell><Purchases /></Shell></Route>
      <Route path="/purchases/new"><Shell><PurchaseNew /></Shell></Route>
      <Route path="/purchases/:id/receive"><Shell><PurchaseReceive /></Shell></Route>
      <Route path="/inventory"><Shell><Inventory /></Shell></Route>
      <Route path="/stocktakes"><Shell><Stocktakes /></Shell></Route>
      <Route path="/stocktakes/new"><Shell><StocktakeNew /></Shell></Route>
      <Route path="/stocktakes/:id/review"><Shell><StocktakeReview /></Shell></Route>
      <Route path="/stocktakes/:id/report"><Shell><StocktakeReport /></Shell></Route>
      <Route path="/stocktakes/:id/sheets"><Shell><StocktakeCountSheets /></Shell></Route>
      <Route path="/stocktakes/:id"><Shell><StocktakeMonitor /></Shell></Route>
      <Route path="/inventory-movements"><Shell><InventoryMovements /></Shell></Route>
      <Route path="/transfers"><Shell><Transfers /></Shell></Route>
      <Route path="/work-orders"><Shell><WorkOrders /></Shell></Route>
      <Route path="/work-orders/new"><Shell><WorkOrderNew /></Shell></Route>
      <Route path="/work-orders/station"><Shell><RequireRole roles={["admin","manager","print_operator","cashier"]}><WorkOrderStation /></RequireRole></Shell></Route>
      <Route path="/work-orders/:id"><Shell><WorkOrderDetail /></Shell></Route>
      <Route path="/production"><Shell><Production /></Shell></Route>
      <Route path="/production/new"><Shell><ProductionNew /></Shell></Route>
      <Route path="/production/:id"><Shell><ProductionDetail /></Shell></Route>
      <Route path="/production-recipes"><Shell><ProductionRecipes /></Shell></Route>
      <Route path="/assets"><Shell><Assets /></Shell></Route>
      <Route path="/assets/new"><Shell><AssetNew /></Shell></Route>
      <Route path="/assets/register"><Shell><AssetRegister /></Shell></Route>
      <Route path="/assets/custody-report"><Shell><AssetCustodyReport /></Shell></Route>
      <Route path="/assets/disposal-log"><Shell><AssetDisposalLog /></Shell></Route>
      <Route path="/assets/:id/edit"><Shell><AssetEdit /></Shell></Route>
      <Route path="/assets/:id"><Shell><AssetDetail /></Shell></Route>
      <Route path="/hr/employees"><Shell><Employees /></Shell></Route>
      <Route path="/hr/employees/new"><Shell><EmployeeNew /></Shell></Route>
      <Route path="/hr/employees/:id/edit"><Shell><EmployeeNew /></Shell></Route>
      <Route path="/hr/employees/:id"><Shell><EmployeeDetail /></Shell></Route>
      <Route path="/hr/attendance"><Shell><Attendance /></Shell></Route>
      <Route path="/hr/payroll"><Shell><Payroll /></Shell></Route>
      <Route path="/hr/leaves"><Shell><Leaves /></Shell></Route>
      <Route path="/hr/recruitment"><Shell><Recruitment /></Shell></Route>
      <Route path="/hr/devices"><Shell><HrDevices /></Shell></Route>
      <Route path="/hr/promotions"><Shell><Promotions /></Shell></Route>
      <Route path="/expenses"><Shell><Expenses /></Shell></Route>
      <Route path="/expenses/new"><Shell><ExpenseNew /></Shell></Route>
      <Route path="/vouchers"><Shell><Vouchers /></Shell></Route>
      <Route path="/vouchers/receipt/new"><Shell><VoucherReceiptNew /></Shell></Route>
      <Route path="/vouchers/payment/new"><Shell><VoucherPaymentNew /></Shell></Route>
      <Route path="/shifts"><Shell><Shifts /></Shell></Route>
      <Route path="/treasury"><Shell><Treasury /></Shell></Route>
      <Route path="/treasury/transfers"><Shell><TreasuryTransfers /></Shell></Route>
      <Route path="/reports"><Shell><ReportsCenter /></Shell></Route>
      <Route path="/reports/profit-loss"><Shell><RequireRole roles={["admin","manager"]}><ProfitLoss /></RequireRole></Shell></Route>
      <Route path="/reports/general-ledger"><Shell><RequireRole roles={["admin","manager"]}><GeneralLedger /></RequireRole></Shell></Route>
      <Route path="/reports/trial-balance"><Shell><RequireRole roles={["admin","manager"]}><TrialBalance /></RequireRole></Shell></Route>
      <Route path="/reports/balance-sheet"><Shell><RequireRole roles={["admin","manager"]}><BalanceSheet /></RequireRole></Shell></Route>
      <Route path="/reports/cash-flow"><Shell><RequireRole roles={["admin","manager"]}><CashFlow /></RequireRole></Shell></Route>
      <Route path="/reports/sales-register"><Shell><RequireRole roles={["admin","manager"]}><SalesRegister /></RequireRole></Shell></Route>
      <Route path="/reports/sales-by-dimension"><Shell><RequireRole roles={["admin","manager"]}><SalesByDimension /></RequireRole></Shell></Route>
      <Route path="/reports/purchases"><Shell><RequireRole roles={["admin","manager"]}><PurchasesReport /></RequireRole></Shell></Route>
      <Route path="/reports/purchase-register"><Shell><RequireRole roles={["admin","manager"]}><PurchaseRegister /></RequireRole></Shell></Route>
      <Route path="/reports/aging-detail"><Shell><RequireRole roles={["admin","manager"]}><ArApAgingDetail /></RequireRole></Shell></Route>
      <Route path="/reports/inventory-valuation"><Shell><RequireRole roles={["admin","manager"]}><InventoryValuation /></RequireRole></Shell></Route>
      <Route path="/reports/stock-status"><Shell><RequireRole roles={["admin","manager"]}><StockStatus /></RequireRole></Shell></Route>
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
      <Route path="/sales-report"><Shell><SalesReport /></Shell></Route>
      <Route path="/ar-aging"><Shell><ARAging /></Shell></Route>
      <Route path="/customers-statement"><Shell><CustomerStatement /></Shell></Route>
      <Route path="/suppliers"><Shell><Suppliers /></Shell></Route>
      <Route path="/suppliers/new"><Shell><SupplierNew /></Shell></Route>
      <Route path="/suppliers/:id/edit"><Shell><SupplierEdit /></Shell></Route>
      <Route path="/ap-aging"><Shell><APAging /></Shell></Route>
      <Route path="/suppliers-statement"><Shell><SupplierStatement /></Shell></Route>
      <Route path="/kiosk-devices"><Shell><RequireRole roles={["admin","manager"]}><KioskDevices /></RequireRole></Shell></Route>
      <Route path="/users"><Shell><RequireRole roles={["admin","manager"]}><Users /></RequireRole></Shell></Route>
      <Route path="/users/new"><Shell><RequireRole roles={["admin","manager"]}><UserNew /></RequireRole></Shell></Route>
      <Route path="/users/:id/edit"><Shell><RequireRole roles={["admin","manager"]}><UserEdit /></RequireRole></Shell></Route>
      <Route path="/roles"><Shell><RequireRole roles={["admin"]}><Roles /></RequireRole></Shell></Route>
      <Route path="/roles/new"><Shell><RequireRole roles={["admin"]}><RoleEdit /></RequireRole></Shell></Route>
      <Route path="/roles/:id/edit"><Shell><RequireRole roles={["admin"]}><RoleEdit /></RequireRole></Shell></Route>
      <Route path="/account"><Shell><Account /></Shell></Route>
      <Route path="/audit"><Shell><RequireRole roles={["admin","manager"]}><AuditLogs /></RequireRole></Shell></Route>
      <Route path="/period-lock"><Shell><RequireRole roles={["admin"]}><PeriodLock /></RequireRole></Shell></Route>
      <Route path="/credit-approvals"><Shell><RequireRole roles={["admin","manager"]}><CreditApprovals /></RequireRole></Shell></Route>
      <Route path="/year-end"><Shell><RequireRole roles={["admin"]}><YearEnd /></RequireRole></Shell></Route>
      <Route path="/wip-report"><Shell><RequireRole roles={["admin","manager"]}><WIPReport /></RequireRole></Shell></Route>
      <Route path="/reconcile"><Shell><RequireRole roles={["admin","manager"]}><Reconcile /></RequireRole></Shell></Route>
      <Route path="/settings"><Shell><RequireRole roles={["admin","manager"]}><Settings /></RequireRole></Shell></Route>
      <Route><Shell><NotFound /></Shell></Route>
    </Switch>
    </Suspense>
    </ErrorBoundary>
  );
}

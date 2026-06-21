import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { trpc } from "@/lib/trpc";
import APAging from "@/pages/APAging";
import ARAging from "@/pages/ARAging";
import BarcodeLabels from "@/pages/BarcodeLabels";
import CustomerStatement from "@/pages/CustomerStatement";
import Customers from "@/pages/Customers";
import CustomerNew from "@/pages/CustomerNew";
import CustomerEdit from "@/pages/CustomerEdit";
import SupplierStatement from "@/pages/SupplierStatement";
import Suppliers from "@/pages/Suppliers";
import SupplierNew from "@/pages/SupplierNew";
import SupplierEdit from "@/pages/SupplierEdit";
import Dashboard from "@/pages/Dashboard";
import ExpenseNew from "@/pages/ExpenseNew";
import Expenses from "@/pages/Expenses";
import Inventory from "@/pages/Inventory";
import VoucherPaymentNew from "@/pages/VoucherPaymentNew";
import VoucherReceiptNew from "@/pages/VoucherReceiptNew";
import Vouchers from "@/pages/Vouchers";
import InvoiceDetail from "@/pages/InvoiceDetail";
import Invoices from "@/pages/Invoices";
import Login from "@/pages/Login";
import POS from "@/pages/POS";
import PrintPOS from "@/pages/PrintPOS";
import PriceChecker from "@/pages/PriceChecker";
import Kiosk from "@/pages/Kiosk";
import KioskDevices from "@/pages/KioskDevices";
import SalesInvoiceNew from "@/pages/SalesInvoiceNew";
import ProductEdit from "@/pages/ProductEdit";
import ProductNew from "@/pages/ProductNew";
import Products from "@/pages/Products";
import Purchases from "@/pages/Purchases";
import PurchaseNew from "@/pages/PurchaseNew";
import PurchaseReceive from "@/pages/PurchaseReceive";
import Quotations from "@/pages/Quotations";
import QuotationNew from "@/pages/QuotationNew";
import QuotationDetail from "@/pages/QuotationDetail";
import Returns from "@/pages/Returns";
import SalesReturnNew from "@/pages/SalesReturnNew";
import SalesReturns from "@/pages/SalesReturns";
import PurchaseReturnNew from "@/pages/PurchaseReturnNew";
import PurchaseReturns from "@/pages/PurchaseReturns";
import Transfers from "@/pages/Transfers";
import WorkOrderDetail from "@/pages/WorkOrderDetail";
import WorkOrderNew from "@/pages/WorkOrderNew";
import WorkOrderStation from "@/pages/WorkOrderStation";
import WorkOrders from "@/pages/WorkOrders";
import Production from "@/pages/Production";
import ProductionNew from "@/pages/ProductionNew";
import ProductionDetail from "@/pages/ProductionDetail";
import ProductionRecipes from "@/pages/ProductionRecipes";
import Assets from "@/pages/Assets";
import AssetRegister from "@/pages/AssetRegister";
import AssetDetail from "@/pages/AssetDetail";
import AssetNew from "@/pages/AssetNew";
import AssetCustodyReport from "@/pages/AssetCustodyReport";
import AssetDisposalLog from "@/pages/AssetDisposalLog";
import AssetEdit from "@/pages/AssetEdit";
import Employees from "@/pages/Employees";
import EmployeeNew from "@/pages/EmployeeNew";
import EmployeeDetail from "@/pages/EmployeeDetail";
import Attendance from "@/pages/Attendance";
import Payroll from "@/pages/Payroll";
import Leaves from "@/pages/Leaves";
import Recruitment from "@/pages/Recruitment";
import HrDevices from "@/pages/HrDevices";
import Promotions from "@/pages/Promotions";
import JobApply from "@/pages/JobApply";
import Shifts from "@/pages/Shifts";
import Users from "@/pages/Users";
import UserNew from "@/pages/UserNew";
import UserEdit from "@/pages/UserEdit";
import Roles from "@/pages/Roles";
import RoleEdit from "@/pages/RoleEdit";
import Account from "@/pages/Account";
import AuditLogs from "@/pages/AuditLogs";
import PeriodLock from "@/pages/PeriodLock";
import CreditApprovals from "@/pages/CreditApprovals";
import YearEnd from "@/pages/YearEnd";
import WIPReport from "@/pages/WIPReport";
import InventoryMovements from "@/pages/InventoryMovements";
import SalesReport from "@/pages/SalesReport";
import ReportsCenter from "@/pages/ReportsCenter";
import ProfitLoss from "@/pages/ProfitLoss";
import GeneralLedger from "@/pages/GeneralLedger";
import TrialBalance from "@/pages/TrialBalance";
import BalanceSheet from "@/pages/BalanceSheet";
import CashFlow from "@/pages/CashFlow";
import SalesRegister from "@/pages/SalesRegister";
import SalesByDimension from "@/pages/SalesByDimension";
import PurchasesReport from "@/pages/PurchasesReport";
import PurchaseRegister from "@/pages/PurchaseRegister";
import ArApAgingDetail from "@/pages/ArApAgingDetail";
import InventoryValuation from "@/pages/InventoryValuation";
import StockStatus from "@/pages/StockStatus";
import ItemLedger from "@/pages/ItemLedger";
import AbcAnalysis from "@/pages/AbcAnalysis";
import TreasuryReport from "@/pages/TreasuryReport";
import ExpensesReport from "@/pages/ExpensesReport";
import CashOrphanReport from "@/pages/CashOrphanReport";
import ProductionReport from "@/pages/ProductionReport";
import WorkOrdersReport from "@/pages/WorkOrdersReport";
import PayrollReport from "@/pages/PayrollReport";
import AttendanceReport from "@/pages/AttendanceReport";
import LeaveReport from "@/pages/LeaveReport";
import HrChangesReport from "@/pages/HrChangesReport";
import ExecutiveDashboard from "@/pages/ExecutiveDashboard";
import Reconcile from "@/pages/Reconcile";
import Settings from "@/pages/Settings";
import Stocktakes from "@/pages/Stocktakes";
import StocktakeNew from "@/pages/StocktakeNew";
import StocktakeMonitor from "@/pages/StocktakeMonitor";
import StocktakeReview from "@/pages/StocktakeReview";
import StocktakeReport from "@/pages/StocktakeReport";
import StocktakeCountSheets from "@/pages/StocktakeCountSheets";
import CountPortal from "@/pages/CountPortal";
import { RequireRole } from "@/components/RequireRole";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { Redirect, Route, Switch } from "wouter";

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
    </ErrorBoundary>
  );
}

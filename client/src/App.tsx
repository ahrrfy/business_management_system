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
import WorkOrders from "@/pages/WorkOrders";
import Shifts from "@/pages/Shifts";
import Users from "@/pages/Users";
import UserNew from "@/pages/UserNew";
import UserEdit from "@/pages/UserEdit";
import Account from "@/pages/Account";
import AuditLogs from "@/pages/AuditLogs";
import InventoryMovements from "@/pages/InventoryMovements";
import SalesReport from "@/pages/SalesReport";
import Reconcile from "@/pages/Reconcile";
import Settings from "@/pages/Settings";
import Stocktakes from "@/pages/Stocktakes";
import StocktakeNew from "@/pages/StocktakeNew";
import StocktakeMonitor from "@/pages/StocktakeMonitor";
import StocktakeReview from "@/pages/StocktakeReview";
import StocktakeReport from "@/pages/StocktakeReport";
import StocktakeCountSheets from "@/pages/StocktakeCountSheets";
import CountPortal from "@/pages/CountPortal";
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
      {/* بوابة العدّ الخارجية لعامل الجرد — عامة بمصادقة PIN خاصة، بلا جلسة دخول وبلا AppLayout */}
      <Route path="/count/:code" component={CountPortal} />
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
      <Route path="/work-orders/:id"><Shell><WorkOrderDetail /></Shell></Route>
      <Route path="/expenses"><Shell><Expenses /></Shell></Route>
      <Route path="/expenses/new"><Shell><ExpenseNew /></Shell></Route>
      <Route path="/vouchers"><Shell><Vouchers /></Shell></Route>
      <Route path="/vouchers/receipt/new"><Shell><VoucherReceiptNew /></Shell></Route>
      <Route path="/vouchers/payment/new"><Shell><VoucherPaymentNew /></Shell></Route>
      <Route path="/shifts"><Shell><Shifts /></Shell></Route>
      <Route path="/sales-report"><Shell><SalesReport /></Shell></Route>
      <Route path="/ar-aging"><Shell><ARAging /></Shell></Route>
      <Route path="/customers-statement"><Shell><CustomerStatement /></Shell></Route>
      <Route path="/suppliers"><Shell><Suppliers /></Shell></Route>
      <Route path="/suppliers/new"><Shell><SupplierNew /></Shell></Route>
      <Route path="/suppliers/:id/edit"><Shell><SupplierEdit /></Shell></Route>
      <Route path="/ap-aging"><Shell><APAging /></Shell></Route>
      <Route path="/suppliers-statement"><Shell><SupplierStatement /></Shell></Route>
      <Route path="/users"><Shell><Users /></Shell></Route>
      <Route path="/users/new"><Shell><UserNew /></Shell></Route>
      <Route path="/users/:id/edit"><Shell><UserEdit /></Shell></Route>
      <Route path="/account"><Shell><Account /></Shell></Route>
      <Route path="/audit"><Shell><AuditLogs /></Shell></Route>
      <Route path="/reconcile"><Shell><Reconcile /></Shell></Route>
      <Route path="/settings"><Shell><Settings /></Shell></Route>
      <Route><Shell><NotFound /></Shell></Route>
    </Switch>
    </ErrorBoundary>
  );
}

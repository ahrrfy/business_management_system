import { AppLayout } from "@/components/AppLayout";
import { trpc } from "@/lib/trpc";
import Dashboard from "@/pages/Dashboard";
import Inventory from "@/pages/Inventory";
import Invoices from "@/pages/Invoices";
import Login from "@/pages/Login";
import POS from "@/pages/POS";
import ProductEdit from "@/pages/ProductEdit";
import ProductNew from "@/pages/ProductNew";
import Products from "@/pages/Products";
import Purchases from "@/pages/Purchases";
import PurchaseNew from "@/pages/PurchaseNew";
import PurchaseReceive from "@/pages/PurchaseReceive";
import Returns from "@/pages/Returns";
import Transfers from "@/pages/Transfers";
import WorkOrderDetail from "@/pages/WorkOrderDetail";
import WorkOrderNew from "@/pages/WorkOrderNew";
import WorkOrders from "@/pages/WorkOrders";
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
      <AppLayout>{children}</AppLayout>
    </Protected>
  );
}

function NotFound() {
  return <div className="p-10 text-center text-muted-foreground">٤٠٤ — الصفحة غير موجودة</div>;
}

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      {/* نقطة البيع بملء الشاشة (بلا قائمة جانبية) */}
      <Route path="/pos">
        <Protected>
          <POS />
        </Protected>
      </Route>
      <Route path="/"><Shell><Dashboard /></Shell></Route>
      <Route path="/products"><Shell><Products /></Shell></Route>
      <Route path="/products/new"><Shell><ProductNew /></Shell></Route>
      <Route path="/products/:id/edit"><Shell><ProductEdit /></Shell></Route>
      <Route path="/invoices"><Shell><Invoices /></Shell></Route>
      <Route path="/returns"><Shell><Returns /></Shell></Route>
      <Route path="/purchases"><Shell><Purchases /></Shell></Route>
      <Route path="/purchases/new"><Shell><PurchaseNew /></Shell></Route>
      <Route path="/purchases/:id/receive"><Shell><PurchaseReceive /></Shell></Route>
      <Route path="/inventory"><Shell><Inventory /></Shell></Route>
      <Route path="/transfers"><Shell><Transfers /></Shell></Route>
      <Route path="/work-orders"><Shell><WorkOrders /></Shell></Route>
      <Route path="/work-orders/new"><Shell><WorkOrderNew /></Shell></Route>
      <Route path="/work-orders/:id"><Shell><WorkOrderDetail /></Shell></Route>
      <Route><Shell><NotFound /></Shell></Route>
    </Switch>
  );
}

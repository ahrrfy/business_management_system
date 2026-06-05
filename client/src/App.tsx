import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Home from "./pages/Home";
import POS from "./pages/POS";
import Attendance from "./pages/Attendance";
import Products from "./pages/Products";
import Customers from "./pages/Customers";
import Suppliers from "./pages/Suppliers";
import Invoices from "./pages/Invoices";
import Purchases from "./pages/Purchases";
import Accounts from "./pages/Accounts";
import HR from "./pages/HR";
import Reports from "./pages/Reports";
import ImportExport from "./pages/ImportExport";
import Inventory from "./pages/Inventory";

function Router() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/pos" component={POS} />
        <Route path="/products" component={Products} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/customers" component={Customers} />
        <Route path="/suppliers" component={Suppliers} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/purchases" component={Purchases} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/hr" component={HR} />
        <Route path="/attendance" component={Attendance} />
        <Route path="/reports" component={Reports} />
        <Route path="/import-export" component={ImportExport} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

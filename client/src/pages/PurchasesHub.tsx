// PurchasesHub — وحدة «المشتريات» بتبويبات (أوامر الشراء + مرتجعات الشراء).
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";

const Purchases = lazy(() => import("@/pages/Purchases"));
const PurchaseReturns = lazy(() => import("@/pages/PurchaseReturns"));
const PurchaseRequisitions = lazy(() => import("@/pages/PurchaseRequisitions"));
const PurchaseApprovals = lazy(() => import("@/pages/PurchaseApprovals"));
const PurchaseReturnsGovernance = lazy(
  () => import("@/pages/PurchaseReturnsGovernance"),
);
const SupplierPaymentsGovernance = lazy(
  () => import("@/pages/SupplierPaymentsGovernance"),
);
const PurchaseChargesGovernance = lazy(
  () => import("@/pages/PurchaseChargesGovernance"),
);
const PurchaseIntegrityCases = lazy(
  () => import("@/pages/PurchaseIntegrityCases"),
);
const PurchaseControlSettings = lazy(
  () => import("@/pages/PurchaseControlSettings"),
);

const TABS: HubTab[] = [
  {
    value: "orders",
    label: "أوامر الشراء",
    gate: {
      roles: ["manager", "purchasing", "warehouse", "accountant", "auditor"],
      module: "purchases",
      level: "READ",
    },
    Component: Purchases,
  },
  {
    value: "requisitions",
    label: "طلبات الشراء",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseRequisitions,
  },
  {
    value: "approvals",
    label: "الاعتمادات",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseApprovals,
  },
  // purchaseReturns.list خادمياً = purchasesManagerProcedure(["manager", "purchasing"], "purchases", "FULL") — التبويب مرآتها (يُخفى عمّن يرفضه الخادم حتماً).
  {
    value: "returns",
    label: "مرتجعات الشراء",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseReturns,
  },
  {
    value: "returns-governance",
    label: "حوكمة المرتجعات",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseReturnsGovernance,
  },
  {
    value: "supplier-payments",
    label: "سداد الموردين",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: SupplierPaymentsGovernance,
  },
  {
    value: "charges",
    label: "مصاريف الشراء",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseChargesGovernance,
  },
  {
    value: "integrity",
    label: "نزاهة المشتريات",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseIntegrityCases,
  },
  {
    value: "control-settings",
    label: "ضوابط المشتريات",
    gate: {
      roles: ["manager", "purchasing"],
      module: "purchases",
      level: "FULL",
    },
    Component: PurchaseControlSettings,
  },
];

export default function PurchasesHub() {
  return <PageTabs tabs={TABS} ariaLabel="أقسام المشتريات" />;
}

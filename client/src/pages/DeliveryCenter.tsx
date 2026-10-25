// DeliveryCenter — المداخل اليومية الثلاثة لدورة التوصيل، مع الأدوات الإدارية تحت «المزيد».
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { useSearch } from "wouter";

const DeliveryFollowup = lazy(async () => ({
  default: (await import("@/pages/DeliveryHub")).DeliveryFollowupHub,
}));
const DeliverySettlement = lazy(async () => ({
  default: (await import("@/pages/DeliveryHub")).DeliverySettlementHub,
}));
const DeliveryMore = lazy(() => import("@/pages/DeliveryMore"));
const FulfillmentHub = lazy(() => import("@/pages/FulfillmentHub"));
const ReceptionWorkflowPage = lazy(
  () => import("@/pages/reception/ReceptionWorkflowPage"),
);

const TABS: HubTab[] = [
  {
    value: "workflow",
    label: "التنفيذ بالباركود",
    gate: {
      roles: ["admin", "manager", "accountant", "cashier", "auditor"],
      module: "store",
    },
    Component: ReceptionWorkflowPage,
  },
  {
    value: "followup",
    label: "المتابعة والاستثناءات",
    gate: {
      roles: ["admin", "manager", "accountant", "cashier", "auditor"],
      module: "store",
    },
    Component: DeliveryFollowup,
  },
  {
    value: "settlement",
    label: "تسوية الجهات",
    gate: {
      roles: ["admin", "manager", "accountant", "cashier", "auditor"],
      module: "store",
    },
    Component: DeliverySettlement,
  },
  {
    value: "more",
    label: "المزيد",
    gate: {
      roles: ["admin", "manager", "accountant", "cashier", "auditor"],
      module: "store",
    },
    Component: DeliveryMore,
  },
];

const LEGACY_TAB_ALIASES = {
  dispatch: "followup",
  transit: "followup",
  board: "followup",
  settle: "settlement",
  parties: "more",
  pricing: "more",
  "commission-comparison": "more",
  performance: "more",
  aging: "more",
} as const;

export default function DeliveryCenter() {
  const search = useSearch();
  if (new URLSearchParams(search).get("tab") === "fulfillment")
    return <FulfillmentHub />;
  return (
    <PageTabs
      tabs={TABS}
      ariaLabel="محطات التوصيل"
      tabAliases={LEGACY_TAB_ALIASES}
    />
  );
}

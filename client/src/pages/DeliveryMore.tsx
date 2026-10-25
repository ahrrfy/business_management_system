import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  Building2,
  ChevronRight,
  MapPinned,
  MoreHorizontal,
} from "lucide-react";
import { Link, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import type { OperationPolicy } from "@shared/operationPermissions";
import type { PermissionMap } from "@shared/permissions";

const DeliveryParties = lazy(() => import("@/pages/DeliveryParties"));
const DeliveryPricingZones = lazy(() => import("@/pages/DeliveryPricingZones"));
const CommissionComparisonReport = lazy(
  () => import("@/pages/CommissionComparisonReport"),
);
const CourierPerformanceReport = lazy(
  () => import("@/pages/CourierPerformanceReport"),
);
const DeliveryAgingReport = lazy(() => import("@/pages/DeliveryAgingReport"));

type MoreSection =
  | "parties"
  | "pricing"
  | "commission-comparison"
  | "performance"
  | "aging";

const ITEMS: ReadonlyArray<{
  key: MoreSection;
  label: string;
  description: string;
  icon: typeof Building2;
  gate: RoleGate;
}> = [
  {
    key: "parties",
    label: "جهات التوصيل",
    description: "البيانات والعقود والأرصدة",
    icon: Building2,
    gate: {
      roles: ["admin", "manager", "accountant", "cashier", "auditor"],
      module: "store",
    },
  },
  {
    key: "pricing",
    label: "مناطق التسعير",
    description: "المناطق وقواعد احتساب الأجرة",
    icon: MapPinned,
    gate: {
      roles: ["admin", "manager"],
      module: "store",
      operations: ["delivery.listZones", "delivery.listPricingRules"],
    },
  },
  {
    key: "commission-comparison",
    label: "مقارنة العمولة",
    description: "مقارنة الأجرة المدفوعة بالمقدّرة",
    icon: BarChart3,
    gate: {
      roles: ["admin", "manager", "accountant", "auditor"],
      module: "reports",
      operations: ["delivery.commissionComparison"],
    },
  },
  {
    key: "performance",
    label: "أداء جهات التوصيل",
    description: "التسليم والتحصيل والتعذر",
    icon: BarChart3,
    gate: {
      roles: ["admin", "manager", "accountant", "auditor"],
      module: "reports",
      operations: ["reports.courierPerformance"],
    },
  },
  {
    key: "aging",
    label: "أعمار الإرساليات",
    description: "الإرساليات والعهد المتأخرة",
    icon: BarChart3,
    gate: {
      roles: ["admin", "manager", "accountant", "auditor"],
      module: "reports",
      operations: ["reports.consignmentAging"],
    },
  },
];

function selectedSection(search: string): MoreSection | null {
  const params = new URLSearchParams(search);
  const candidate =
    params.get("tab") === "more" ? params.get("section") : params.get("tab");
  return ITEMS.some((item) => item.key === candidate)
    ? (candidate as MoreSection)
    : null;
}

function SelectedPage({ section }: { section: MoreSection }) {
  if (section === "parties") return <DeliveryParties />;
  if (section === "pricing") return <DeliveryPricingZones />;
  if (section === "commission-comparison")
    return <CommissionComparisonReport />;
  if (section === "performance") return <CourierPerformanceReport />;
  return <DeliveryAgingReport />;
}

export default function DeliveryMore() {
  const search = useSearch();
  const section = selectedSection(search);
  const me = trpc.auth.me.useQuery();
  const role = me.data?.isOwner ? "admin" : me.data?.role;
  const permissionsOverride = (
    me.data?.isOwner ? null : (me.data?.permissionsOverride ?? null)
  ) as PermissionMap | null;
  const operationPolicy =
    !me.data?.isOwner && me.data?.operationPolicyEnabled
      ? ((me.data.resolvedOperationPolicy as OperationPolicy | undefined) ??
        null)
      : null;
  const visibleItems = ITEMS.filter((item) =>
    canSeeGate(item.gate, role, permissionsOverride, operationPolicy),
  );
  const selectedItem = section
    ? visibleItems.find((item) => item.key === section)
    : undefined;
  if (selectedItem) {
    return (
      <div className="space-y-2">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="mx-3 gap-1 md:mx-4"
        >
          <Link href="/delivery?tab=more">
            <ChevronRight className="size-4" aria-hidden />
            العودة إلى المزيد
          </Link>
        </Button>
        <SelectedPage section={selectedItem.key} />
      </div>
    );
  }
  return (
    <div className="space-y-3 p-3 md:p-4" dir="rtl">
      <PageHeader
        title="المزيد"
        description="إعدادات الجهات والتسعير والتقارير التي لا يحتاجها التنفيذ اليومي."
        icon={<MoreHorizontal className="size-5 text-primary" aria-hidden />}
      />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              key={item.key}
              asChild
              variant="outline"
              className="h-auto justify-start gap-3 p-4 text-start"
            >
              <Link href={`/delivery?tab=more&section=${item.key}`}>
                <Icon className="size-5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-bold text-foreground">
                    {item.label}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </Link>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

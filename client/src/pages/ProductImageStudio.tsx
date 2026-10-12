import { trpc } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { OPERATION_PERMISSIONS, hasOperationPolicy, operationDecision, type OperationUser } from "@shared/operationPermissions";
import { Loader2 } from "lucide-react";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { lazy, Suspense } from "react";

import { ACTION_LABELS } from "@shared/actionLabels";

// Lazy load the heavy roles
const StudioManagerDashboard = lazy(() => import("@/components/product-studio/StudioManagerDashboard"));
const StudioPhotographerWorkspace = lazy(() => import("@/components/product-studio/StudioPhotographerWorkspace"));

export const STUDIO_STORAGE_DISABLED_MESSAGE = "خدمة التخزين السحابي غير متصلة. لا يمكن رفع صور جديدة أو سحب المسودات السابقة. استعادة المسودة المحلية متاح للحفظ المؤقت.";

export default function ProductImageStudio() {
  const studioMe = trpc.auth.me.useQuery();
  const canReadDashboard = useOperationPermission("productStudio.dashboard").allowed;
  const connectivity = useConnectivity();
  const offline = isDisconnected(connectivity) || (typeof navigator !== "undefined" && !navigator.onLine);
  
  const dashboard = trpc.productStudio.dashboard.useQuery(undefined, {
    enabled: !offline && canReadDashboard,
  });

  if (!offline && dashboard.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="size-10 animate-spin text-primary" />
          <p className="text-muted-foreground animate-pulse text-sm">{ACTION_LABELS.loading}</p>
        </div>
      </div>
    );
  }

  const studioUser = studioMe.data as OperationUser | undefined;
  const canManage = studioUser && hasOperationPolicy(studioUser)
    ? OPERATION_PERMISSIONS.some(operation => operation.domain === "productStudio" &&
        operation.delegable && (operation.roles.length === 1 && operation.roles[0] === "manager" ||
          ["productStudio.campaigns", "productStudio.campaignBoard", "productStudio.campaignAnalytics", "productStudio.productImages"].includes(operation.path)) &&
        operationDecision(studioUser, operation.path).allowed)
    : dashboard.data?.canManage === true;

  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-10 animate-spin text-primary" />
      </div>
    }>
      {canManage ? (
        <StudioManagerDashboard offline={offline} dashboardData={dashboard.data} />
      ) : (
        <StudioPhotographerWorkspace offline={offline} dashboardData={dashboard.data} />
      )}
    </Suspense>
  );
}

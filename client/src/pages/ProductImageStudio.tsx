import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { lazy, Suspense } from "react";

// Lazy load the heavy roles
const StudioManagerDashboard = lazy(() => import("@/components/product-studio/StudioManagerDashboard"));
const StudioPhotographerWorkspace = lazy(() => import("@/components/product-studio/StudioPhotographerWorkspace"));

export const STUDIO_STORAGE_DISABLED_MESSAGE = "خدمة التخزين السحابي غير متصلة. لا يمكن رفع صور جديدة أو سحب المسودات السابقة. استعادة المسودة المحلية متاح للحفظ المؤقت.";

export default function ProductImageStudio() {
  const connectivity = useConnectivity();
  const offline = isDisconnected(connectivity) || (typeof navigator !== "undefined" && !navigator.onLine);
  
  const dashboard = trpc.productStudio.dashboard.useQuery(undefined, {
    enabled: !offline,
  });

  if (!offline && dashboard.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="size-10 animate-spin text-primary" />
          <p className="text-muted-foreground animate-pulse text-sm">جاري تحميل مساحة العمل الاستوديو...</p>
        </div>
      </div>
    );
  }

  const canManage = dashboard.data?.canManage === true;

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

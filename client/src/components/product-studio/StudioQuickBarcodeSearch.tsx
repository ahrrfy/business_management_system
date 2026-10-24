import { lazy, Suspense } from "react";
import { QuickStudioImagePreviewDialog } from "./quick-lookup/QuickStudioImagePreviewDialog";
import { QuickStudioProductDialog } from "./quick-lookup/QuickStudioProductDialog";
import { QuickStudioSearchBar } from "./quick-lookup/QuickStudioSearchBar";
import { useQuickStudioController } from "./quick-lookup/useQuickStudioController";
import type { QuickStudioProps } from "./quick-lookup/types";

export type { QuickStudioTarget } from "./quick-lookup/types";

const CameraScanner = lazy(() =>
  import("@/components/scan/CameraScanner").then((module) => ({
    default: module.CameraScanner,
  })),
);

export function StudioQuickBarcodeSearch(props: QuickStudioProps) {
  const controller = useQuickStudioController(props);
  return (
    <>
      {!props.hideSearchBar && (
        <QuickStudioSearchBar
          controller={controller}
          className={props.className ?? ""}
        />
      )}
      {controller.cameraScannerOpen && (
        <Suspense fallback={null}>
          <CameraScanner
            open={controller.cameraScannerOpen}
            onClose={() => controller.setCameraScannerOpen(false)}
            onDetect={controller.handleCameraDetect}
          />
        </Suspense>
      )}
      <QuickStudioProductDialog controller={controller} />
      <QuickStudioImagePreviewDialog controller={controller} />
    </>
  );
}

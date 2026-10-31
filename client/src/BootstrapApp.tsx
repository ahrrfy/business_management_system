import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RouteFallback } from "@/components/RouteFallback";
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { Suspense } from "react";
import { useLocation } from "wouter";
import {
  StorefrontBootstrap,
  shouldBootStandalonePublicShell,
} from "./StorefrontBootstrap";
export {
  isStandalonePublicRoute,
  shouldBootStandalonePublicShell,
} from "./StorefrontBootstrap";

const ErpApp = lazy(() =>
  Promise.all([
    import("./erp.css"),
    import("./styles/erp-variants.css"),
    import("./App"),
  ]).then(([, , mod]) => mod),
);

export function BootstrapApp() {
  const [loc] = useLocation();
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  if (shouldBootStandalonePublicShell(loc, hostname))
    return <StorefrontBootstrap />;
  return (
    <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <ErpApp />
      </Suspense>
    </ErrorBoundary>
  );
}
export default BootstrapApp;

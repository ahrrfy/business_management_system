import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RouteFallback } from "@/components/RouteFallback";
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import {
  isPublicHost,
  isPublicPath,
  redirectTargetUrl,
  resolveHostRedirect,
} from "@/lib/siteHosts";
import { trpc } from "@/lib/trpc";
import { Suspense, useEffect } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";

const Storefront = lazy(() => import("@/pages/Storefront"));
const MobileTurnstile = lazy(() => import("@/pages/MobileTurnstile"));
const LegalDocument = lazy(() => import("@/pages/LegalDocument"));
const JobApply = lazy(() => import("@/pages/JobApply"));
const ShelfPriceLookup = lazy(() => import("@/pages/ShelfPriceLookup"));
const ErpApp = lazy(() => import("./App"));

function normalizePathname(pathname: string): string {
  return (pathname || "/").split("?", 1)[0].split("#", 1)[0] || "/";
}

/** هل المسار من الصفحات العامة المستقلّة التي تعمل بلا قشرة ERP ولا صلاحياتها؟ */
export function isStandalonePublicRoute(pathname: string): boolean {
  return isPublicPath(normalizePathname(pathname));
}

/**
 * يحدّد وجهة الجذر `/` على الدومين العام مع الحفاظ على أولوية توجيه المندوب المسجَّل
 * إلى `/my-deliveries` (تطبيق المندوب يبدأ من `/` على الدومين العام)، وتوجيه الزوّار وبقية الأدوار إلى `/store`.
 */
export function resolvePublicRootTarget(
  actor:
    | {
        courierShellOnly?: boolean | null;
        role?: string | null;
        operationPolicyEnabled?: boolean | null;
        isOwner?: boolean | null;
      }
    | null
    | undefined,
): "/my-deliveries" | "/store" {
  const courierShellOnly =
    actor?.courierShellOnly ??
    (actor?.role === "courier" && !actor.operationPolicyEnabled);
  if (courierShellOnly && !actor?.isOwner) {
    return "/my-deliveries";
  }
  return "/store";
}

/**
 * هل يجب إقلاع القشرة العامة الخفيفة بدلاً من تحميل شجرة ERP الكاملة؟
 * يشمل المسارات العامة المستقلة، والجذر `/` على الدومين العام، وأي مسار محكوم بتحويل فوري بين الدومينَين.
 */
export function shouldBootStandalonePublicShell(
  pathname: string,
  hostname: string,
): boolean {
  const cleanPath = normalizePathname(pathname);
  if (isStandalonePublicRoute(cleanPath)) return true;
  if (cleanPath === "/" && isPublicHost(hostname)) return true;
  return resolveHostRedirect(hostname, cleanPath) !== null;
}

function HostPolicy() {
  const [loc] = useLocation();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const { hostname, pathname, search, hash } = window.location;
    const kind = resolveHostRedirect(hostname, pathname);
    if (kind) {
      window.location.replace(
        redirectTargetUrl(kind, { pathname, search, hash }),
      );
    }
  }, [loc]);
  return null;
}

function PublicRootRoute() {
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  if (me.isLoading) return <RouteFallback />;
  return <Redirect to={resolvePublicRootTarget(me.data)} />;
}

function PublicNotFound() {
  return (
    <div className="p-10 text-center text-muted-foreground">
      404 — الصفحة غير موجودة
    </div>
  );
}

export function BootstrapApp() {
  const [loc] = useLocation();
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  const cleanPath = normalizePathname(loc);
  const pendingHostRedirect =
    hostname.length > 0 && resolveHostRedirect(hostname, cleanPath) !== null;

  if (pendingHostRedirect) {
    return (
      <ErrorBoundary>
        <HostPolicy />
        <RouteFallback />
      </ErrorBoundary>
    );
  }

  if (shouldBootStandalonePublicShell(cleanPath, hostname)) {
    return (
      <ErrorBoundary>
        <HostPolicy />
        <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path="/store/mobile-turnstile" component={MobileTurnstile} />
            <Route path="/store/product/:productId" component={Storefront} />
            <Route path="/store/category/:categoryId" component={Storefront} />
            <Route path="/store" component={Storefront} />
            <Route path="/legal/privacy" component={LegalDocument} />
            <Route path="/legal/terms" component={LegalDocument} />
            <Route path="/legal/returns" component={LegalDocument} />
            <Route path="/legal/delete-account" component={LegalDocument} />
            <Route path="/apply" component={JobApply} />
            <Route path="/shelf-lookup" component={ShelfPriceLookup} />
            <Route path="/price-check">
              <Redirect to="/shelf-lookup" />
            </Route>
            <Route path="/" component={PublicRootRoute} />
            <Route component={PublicNotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <HostPolicy />
      <Suspense fallback={<RouteFallback />}>
        <ErpApp />
      </Suspense>
    </ErrorBoundary>
  );
}

export default BootstrapApp;

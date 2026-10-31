import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RouteFallback } from "@/components/RouteFallback";
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import {
  isPublicHost,
  isPublicPath,
  isSharedPath,
  redirectTargetUrl,
  resolveHostRedirect,
} from "@/lib/siteHosts";
import { Suspense, useEffect } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";

const Storefront = lazy(() => import("@/pages/Storefront"));
const MobileTurnstile = lazy(() => import("@/pages/MobileTurnstile"));
const LegalDocument = lazy(() => import("@/pages/LegalDocument"));
const JobApply = lazy(() => import("@/pages/JobApply"));
const ShelfPriceLookup = lazy(() => import("@/pages/ShelfPriceLookup"));
function normalizePathname(pathname: string): string {
  return (pathname || "/").split("?", 1)[0].split("#", 1)[0] || "/";
}

/** هل المسار من الصفحات العامة المستقلّة التي تعمل بلا قشرة ERP ولا صلاحياتها؟ */
export function isStandalonePublicRoute(pathname: string): boolean {
  return isPublicPath(normalizePathname(pathname));
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

function PublicNotFound() {
  return (
    <div className="p-10 text-center text-muted-foreground">
      404 — الصفحة غير موجودة
    </div>
  );
}

/** Public routes share this module; the standalone entry never imports the ERP shell. */
function SharedEntry() {
  useEffect(() => {
    window.location.replace(window.location.href);
  }, []);
  return <RouteFallback />;
}

export function StorefrontBootstrap() {
  const [loc] = useLocation();
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  if (isSharedPath(normalizePathname(loc))) return <SharedEntry />;
  if (resolveHostRedirect(hostname, normalizePathname(loc))) {
    return (
      <ErrorBoundary>
        <HostPolicy />
        <RouteFallback />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary>
      <HostPolicy />
      <Suspense fallback={<RouteFallback />}>
        <PublicRoutes />
      </Suspense>
    </ErrorBoundary>
  );
}

export function PublicRoutes() {
  return (
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
      <Route path="/">
        <Redirect to="/store" />
      </Route>
      <Route component={PublicNotFound} />
    </Switch>
  );
}

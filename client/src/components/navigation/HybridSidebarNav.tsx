import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ApplicationModule } from "@/lib/moduleRegistry";
import {
  findSidebarModule,
  groupSidebarModules,
  isSidebarHrefActive,
} from "@/lib/sidebarNavigation";
import {
  NAV_FAVORITES_LIMIT,
  type NavWorkspace,
} from "@/lib/navWorkspace";
import type { WorkspaceNavItem } from "@/lib/workspaceProfiles";
import {
  ChevronDown,
  ClipboardCheck,
  History,
  Home,
  Menu,
  Star,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";

type HybridSidebarNavProps = Readonly<{
  currentPath: string;
  currentSearch: string;
  showDashboard: boolean;
  hasMyStocktake: boolean;
  primaryNav: readonly WorkspaceNavItem[];
  visibleModules: readonly ApplicationModule[];
  workspace: NavWorkspace;
  onToggleFavorite: (path: string) => void;
  workOrderReadyCount: number;
  deliveryReadyCount: number;
}>;

function routeBadge(
  href: string,
  workOrderReadyCount: number,
  deliveryReadyCount: number,
): number {
  if (href === "/work-orders") return workOrderReadyCount;
  if (href === "/delivery") return deliveryReadyCount;
  return 0;
}

function NavBadge({ href, count }: { href: string; count: number }) {
  if (count <= 0) return null;
  const delivery = href === "/delivery";
  return (
    <span
      aria-label={delivery ? `${count} إرسالية جاهزة` : `${count} أمر جاهز`}
      title={delivery ? `${count} إرسالية جاهزة للتوصيل` : `${count} أمر شغل جاهز للتسليم`}
      className="ms-auto inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-[var(--sem-warn)] px-1.5 py-0.5 text-[10px] font-black text-background tabular-nums"
    >
      {count > 99 ? "99+" : String(count)}
    </span>
  );
}

export function HybridSidebarNav({
  currentPath,
  currentSearch,
  showDashboard,
  hasMyStocktake,
  primaryNav,
  visibleModules,
  workspace,
  onToggleFavorite,
  workOrderReadyCount,
  deliveryReadyCount,
}: HybridSidebarNavProps) {
  const [allModulesOpen, setAllModulesOpen] = useState(false);
  const groupedNav = groupSidebarModules(visibleModules);
  const primaryHasMyStocktake = primaryNav.some(
    (item) => item.activePath === "/my-stocktake",
  );
  const primaryRouteActive = primaryNav.some((item) =>
    isSidebarHrefActive(currentPath, currentSearch, item.href),
  );
  const secondaryRouteActive = visibleModules.some((item) =>
    isSidebarHrefActive(currentPath, currentSearch, item.href),
  );

  useEffect(() => {
    if (secondaryRouteActive && !primaryRouteActive) setAllModulesOpen(true);
  }, [primaryRouteActive, secondaryRouteActive]);

  const navByPath = new Map(
    visibleModules.map((item) => [item.href, item] as const),
  );
  const favoriteLinks = workspace.favorites.flatMap((path) => {
    const item = navByPath.get(path);
    return item ? [item] : [];
  });
  const favoritePaths = new Set(workspace.favorites);
  const recentLinks = workspace.recent
    .flatMap((path) => {
      const item = navByPath.get(path);
      return item && !favoritePaths.has(path) ? [item] : [];
    })
    .slice(0, 3);
  const favoritesFull = workspace.favorites.length >= NAV_FAVORITES_LIMIT;

  return (
    <nav className="sb-scroll flex-1 overflow-y-auto py-2" aria-label="التنقل الرئيسي">
      {showDashboard && (
        <>
          <Link
            href="/"
            aria-current={currentPath === "/" ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 px-3 py-2 min-h-[40px] text-sm transition",
              currentPath === "/" ? "sb-active font-semibold" : "sb-item rounded-md mx-2",
            )}
          >
            <Home className="size-4 shrink-0" aria-hidden />
            <span className="truncate">لوحة التحكم</span>
          </Link>
          <div className="my-1 mx-2 sb-divider" />
        </>
      )}

      {primaryNav.length > 0 && (
        <section aria-label="عملي" className="mb-1">
          <div className="px-3 pb-1 pt-0.5 text-[11px] font-semibold sb-sub">عملي</div>
          {primaryNav.map((item) => {
            const module = findSidebarModule(item.href, visibleModules);
            const Icon = module?.icon ?? ClipboardCheck;
            const active = isSidebarHrefActive(currentPath, currentSearch, item.href);
            const badge = routeBadge(
              item.activePath,
              workOrderReadyCount,
              deliveryReadyCount,
            );
            return (
              <Link
                key={item.id}
                href={item.href}
                title={item.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-[40px] items-center gap-2 px-3 py-2 text-sm transition",
                  active ? "sb-active font-semibold" : "sb-item mx-2 rounded-md",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
                <NavBadge href={item.activePath} count={badge} />
              </Link>
            );
          })}
          <div className="my-1 mx-2 sb-divider" />
        </section>
      )}

      {hasMyStocktake && !primaryHasMyStocktake && (
        <>
          <Link
            href="/my-stocktake"
            aria-current={isSidebarHrefActive(currentPath, currentSearch, "/my-stocktake") ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 mb-0.5 px-3 py-2 min-h-[40px] text-sm transition",
              isSidebarHrefActive(currentPath, currentSearch, "/my-stocktake")
                ? "sb-active font-semibold"
                : "sb-item rounded-md mx-2",
            )}
          >
            <ClipboardCheck className="size-4 shrink-0" aria-hidden />
            <span className="truncate">جردي</span>
          </Link>
          <div className="my-1 mx-2 sb-divider" />
        </>
      )}

      {(favoriteLinks.length > 0 || recentLinks.length > 0) && (
        <Collapsible
          defaultOpen={[...favoriteLinks, ...recentLinks].some((item) =>
            isSidebarHrefActive(currentPath, currentSearch, item.href),
          )}
          className="mb-1"
        >
          <CollapsibleTrigger className="group mx-2 flex min-h-[36px] w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-xs font-medium sb-item">
            <Star className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1 text-start">اختصاراتي</span>
            <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            {favoriteLinks.map((item) => {
              const active = isSidebarHrefActive(currentPath, currentSearch, item.href);
              return (
                <Link
                  key={`favorite:${item.href}`}
                  href={item.href}
                  title={`مفضلة: ${item.label}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[36px] items-center gap-2 px-3 py-1.5 text-sm transition",
                    active ? "sb-active font-semibold" : "sb-item mx-2 rounded-md",
                  )}
                >
                  <Star className="size-3.5 shrink-0 fill-current" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
            {recentLinks.map((item) => {
              const active = isSidebarHrefActive(currentPath, currentSearch, item.href);
              return (
                <Link
                  key={`recent:${item.href}`}
                  href={item.href}
                  title={`حديثا: ${item.label}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[36px] items-center gap-2 px-3 py-1.5 text-sm transition",
                    active ? "sb-active font-semibold" : "sb-item mx-2 rounded-md",
                  )}
                >
                  <History className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </CollapsibleContent>
          <div className="my-1 mx-2 sb-divider" />
        </Collapsible>
      )}

      {visibleModules.length > 0 && (
        <Collapsible open={allModulesOpen} onOpenChange={setAllModulesOpen}>
          <CollapsibleTrigger className="group mx-2 flex min-h-[40px] w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-sm font-medium sb-item">
            <Menu className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 text-start">كل الوحدات</span>
            <span className="text-[10px] tabular-nums opacity-60">{visibleModules.length}</span>
            <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            {groupedNav.map((group) => (
              <section key={group.id} aria-label={group.label} className="pb-1">
                <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium sb-sub">{group.label}</div>
                {group.modules.map((module) => {
                  const active = isSidebarHrefActive(currentPath, currentSearch, module.href);
                  const favorite = favoritePaths.has(module.href);
                  const Icon = module.icon;
                  const badge = routeBadge(
                    module.href,
                    workOrderReadyCount,
                    deliveryReadyCount,
                  );
                  return (
                    <div key={module.href} className="group relative">
                      <Link
                        href={module.href}
                        title={module.label}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2 mb-0.5 px-3 pe-11 py-2 min-h-[40px] text-sm transition",
                          active ? "sb-active font-semibold" : "sb-item rounded-md mx-2",
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{module.label}</span>
                        <NavBadge href={module.href} count={badge} />
                      </Link>
                      <button
                        type="button"
                        onClick={() => onToggleFavorite(module.href)}
                        aria-disabled={!favorite && favoritesFull ? true : undefined}
                        aria-pressed={favorite}
                        aria-label={favorite
                          ? `إزالة ${module.label} من المفضلة`
                          : favoritesFull
                            ? `لا يمكن إضافة ${module.label} إلى المفضلة؛ بلغت الحد الأقصى`
                            : `إضافة ${module.label} إلى المفضلة`}
                        title={favorite
                          ? "إزالة من المفضلة"
                          : favoritesFull
                            ? `بلغت الحد (${NAV_FAVORITES_LIMIT})`
                            : "إضافة إلى المفضلة"}
                        className={cn(
                          "absolute left-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          favorite ? "text-primary" : "opacity-55 hover:bg-accent hover:opacity-100",
                          !favorite && favoritesFull && "cursor-not-allowed opacity-30 hover:bg-transparent hover:opacity-30",
                        )}
                      >
                        <Star className={cn("size-3.5", favorite && "fill-current")} aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </section>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </nav>
  );
}

import { cn } from "@/lib/utils";
import { Link, useLocation } from "wouter";
import {
  Home,
  Receipt,
  Wallet,
  Printer,
  ShoppingCart,
  ScanLine,
  PackageCheck,
  ClipboardCheck,
  Boxes,
  Package,
  ListChecks,
  Truck,
  Menu,
  type LucideIcon,
} from "lucide-react";
import type { PermissionMap } from "@shared/permissions";

interface BottomNavItem {
  href?: string;
  label: string;
  icon: LucideIcon;
  isAction?: boolean;
  actionType?: "menu";
}

interface MobileBottomNavProps {
  role?: string;
  permsOverride?: PermissionMap | null;
  onOpenMenu: () => void;
}

function triggerHaptic() {
  try {
    if (typeof window !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(8);
    }
  } catch {
    // الاهتزاز اختياري ولا يؤثر على العمل
  }
}

export function MobileBottomNav({ role, onOpenMenu }: MobileBottomNavProps) {
  const [loc] = useLocation();

  const isCourier = role === "courier";
  const isCashier = role === "cashier";
  const isWarehouse = role === "warehouse";

  let items: BottomNavItem[] = [];

  if (isCourier) {
    items = [
      { href: "/my-deliveries", label: "توصيلاتي", icon: PackageCheck },
      { href: "/tasks", label: "المهام", icon: ListChecks },
      { label: "القائمة", icon: Menu, isAction: true, actionType: "menu" },
    ];
  } else if (isCashier) {
    items = [
      { href: "/pos", label: "نقطة البيع", icon: ShoppingCart },
      { href: "/price-checker", label: "الماسح", icon: ScanLine },
      { href: "/delivery", label: "التوصيل", icon: Truck },
      { href: "/tasks", label: "المهام", icon: ListChecks },
      { label: "المزيد", icon: Menu, isAction: true, actionType: "menu" },
    ];
  } else if (isWarehouse) {
    items = [
      { href: "/my-stocktake", label: "جردي", icon: ClipboardCheck },
      { href: "/inventory", label: "المخزون", icon: Boxes },
      { href: "/purchases", label: "المشتريات", icon: Package },
      { href: "/tasks", label: "المهام", icon: ListChecks },
      { label: "المزيد", icon: Menu, isAction: true, actionType: "menu" },
    ];
  } else {
    // الأدوار الإدارية والمحاسبية والعامة
    items = [
      { href: "/", label: "الرئيسية", icon: Home },
      { href: "/invoices", label: "المبيعات", icon: Receipt },
      { href: "/treasury", label: "الخزينة", icon: Wallet },
      { href: "/work-orders", label: "المطبعة", icon: Printer },
      { label: "المزيد", icon: Menu, isAction: true, actionType: "menu" },
    ];
  }

  // لا تعرض الشريط السفلي داخل شاشة نقطة البيع أو قارئ الأسعار كاملة الشاشة
  if (loc === "/price-checker" || loc === "/pos") {
    return null;
  }

  return (
    <nav
      aria-label="التنقّل السريع للهاتف"
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-card/95 backdrop-blur-md border-t border-border/80 shadow-lg px-2 pb-[max(env(safe-area-inset-bottom,0px),0.5rem)] pt-1.5 transition-all"
    >
      <div className="flex items-center justify-around gap-1 max-w-md mx-auto">
        {items.map((item, index) => {
          const Icon = item.icon;
          if (item.isAction) {
            return (
              <button
                key={`action-${index}`}
                type="button"
                onClick={() => {
                  triggerHaptic();
                  onOpenMenu();
                }}
                className="flex flex-1 flex-col items-center justify-center py-1 px-1 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={item.label}
              >
                <div className="relative flex items-center justify-center size-8 rounded-lg">
                  <Icon className="size-5 transition-transform" aria-hidden />
                </div>
                <span className="text-[11px] font-medium leading-none mt-0.5 truncate">{item.label}</span>
              </button>
            );
          }

          const active = item.href === "/" ? loc === "/" : loc === item.href || loc.startsWith(item.href + "/");

          return (
            <Link
              key={item.href}
              href={item.href!}
              onClick={triggerHaptic}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center justify-center py-1 px-1 rounded-xl transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "text-primary font-bold"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
              )}
            >
              <div
                className={cn(
                  "relative flex items-center justify-center size-8 rounded-lg transition-colors",
                  active && "bg-primary/10 text-primary shadow-xs"
                )}
              >
                <Icon className={cn("size-5", active && "scale-105")} aria-hidden />
                {active && (
                  <span className="absolute -bottom-1 size-1 bg-primary rounded-full" aria-hidden />
                )}
              </div>
              <span
                className={cn(
                  "text-[11px] leading-none mt-0.5 truncate transition-colors",
                  active ? "font-bold text-primary" : "font-medium text-muted-foreground"
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

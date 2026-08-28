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
import { visibleStations, type PermissionMap } from "@shared/permissions";
import { INVOICE_LIST_GATE, canSeeGate, type RoleGate } from "@/lib/navVisibility";

export interface BottomNavItem {
  href?: string;
  label: string;
  icon: LucideIcon;
  isAction?: boolean;
  actionType?: "menu";
  /** بوّابة الظهور — نفس بوّابات الشريط الجانبي (مرآةُ الخادم بلا ازدواج منطق). */
  gate?: RoleGate;
}

interface MobileBottomNavProps {
  role?: string;
  permsOverride?: PermissionMap | null;
  onOpenMenu: () => void;
}

const TASKS_GATE = {
  roles: [
    "admin",
    "manager",
    "accountant",
    "cashier",
    "warehouse",
    "print_operator",
    "sales_rep",
    "auditor",
    "user",
  ],
  module: "tasks",
  level: "READ",
} satisfies RoleGate;

const DELIVERY_GATE = {
  roles: ["admin", "manager", "accountant", "cashier", "auditor"],
  module: "store",
  level: "READ",
} satisfies RoleGate;

const MENU_ITEM: BottomNavItem = {
  label: "المزيد",
  icon: Menu,
  isAction: true,
  actionType: "menu",
};

function visibleItems(
  candidates: BottomNavItem[],
  role: string | null | undefined,
  permsOverride?: PermissionMap | null,
) {
  return candidates.filter((item) =>
    canSeeGate(item.gate, role, permsOverride),
  );
}

/**
 * يبني اختصارات الهاتف من الصلاحيات المحلولة نفسها التي تحكم بقية التنقّل.
 * الروابط العامة/الذاتية وحدها بلا بوابة وحدة؛ أما كل رابط وحدة فيُصفّى قبل حدّ
 * العناصر الأربعة كي لا يزيح رابطٌ محجوب اختصاراً صالحاً.
 */
export function getMobileBottomNavItems(
  role: string | null | undefined,
  permsOverride?: PermissionMap | null,
): BottomNavItem[] {
  if (role === "courier") {
    const candidates: BottomNavItem[] = [
      {
        href: "/my-deliveries",
        label: "توصيلاتي",
        icon: PackageCheck,
        gate: { roles: ["courier"], module: "courier", level: "READ" },
      },
      { href: "/tasks", label: "المهام", icon: ListChecks, gate: TASKS_GATE },
    ];
    return [
      ...visibleItems(candidates, role, permsOverride),
      { ...MENU_ITEM, label: "القائمة" },
    ];
  }

  if (role === "cashier") {
    const canOpenPos = visibleStations(role, permsOverride).length > 0;
    const candidates: BottomNavItem[] = [
      ...(canOpenPos ? [{
        href: "/pos",
        label: "نقطة البيع",
        icon: ShoppingCart,
      }] : []),
      {
        href: "/invoices",
        label: "فواتيري",
        icon: Receipt,
        gate: INVOICE_LIST_GATE,
      },
      {
        href: "/work-orders",
        label: "المطبعة",
        icon: Printer,
        gate: { module: "workorders" },
      },
      { href: "/delivery", label: "التوصيل", icon: Truck, gate: DELIVERY_GATE },
      { href: "/price-checker", label: "الماسح", icon: ScanLine },
      { href: "/tasks", label: "المهام", icon: ListChecks, gate: TASKS_GATE },
    ];
    return [
      ...visibleItems(candidates, role, permsOverride).slice(0, 4),
      MENU_ITEM,
    ];
  }

  if (role === "warehouse") {
    const candidates: BottomNavItem[] = [
      // مدخل ذاتي محميّ بالتكليف للمستخدم، لا بوحدة المخزون (count.mine = stocktakeAssignmentProcedure).
      { href: "/my-stocktake", label: "جردي", icon: ClipboardCheck },
      {
        href: "/inventory",
        label: "المخزون",
        icon: Boxes,
        gate: { module: "inventory" },
      },
      {
        href: "/purchases",
        label: "المشتريات",
        icon: Package,
        gate: { module: "purchases" },
      },
      { href: "/tasks", label: "المهام", icon: ListChecks, gate: TASKS_GATE },
    ];
    return [
      ...visibleItems(candidates, role, permsOverride).slice(0, 4),
      MENU_ITEM,
    ];
  }

  const candidates: BottomNavItem[] = [
    { href: "/", label: "الرئيسية", icon: Home },
    {
      href: "/invoices",
      label: "المبيعات",
      icon: Receipt,
      gate: INVOICE_LIST_GATE,
    },
    {
      href: "/treasury",
      label: "الخزينة",
      icon: Wallet,
      gate: {
        roles: ["manager", "accountant", "cashier", "auditor"],
        module: "treasury",
      },
    },
    {
      href: "/work-orders",
      label: "المطبعة",
      icon: Printer,
      gate: { module: "workorders" },
    },
  ];
  return [...visibleItems(candidates, role, permsOverride), MENU_ITEM];
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

export function MobileBottomNav({ role, permsOverride, onOpenMenu }: MobileBottomNavProps) {
  const [loc] = useLocation();
  const items = getMobileBottomNavItems(role, permsOverride);

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

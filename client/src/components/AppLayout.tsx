import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { openSearch } from "@/lib/searchEvents";
import { Menu, Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";

type NavItem = { href: string; label: string; adminOnly?: boolean; managerOnly?: boolean };
type NavGroup = {
  key: string;
  label: string;
  icon: string;
  items: NavItem[];
  adminOnly?: boolean;
};

const NAV_GROUPS: NavGroup[] = [
  {
    key: "sales",
    label: "البيع والكاشير",
    icon: "🛒",
    items: [
      { href: "/pos", label: "نقطة البيع" },
      { href: "/print-pos", label: "نقطة بيع الطباعة" },
      { href: "/price-checker", label: "قارئ الأسعار (شاشة الزبون)" },
      { href: "/sales/new", label: "فاتورة بيع متقدّمة" },
      { href: "/invoices", label: "الفواتير" },
      { href: "/quotations", label: "عروض الأسعار" },
      { href: "/quotations/new", label: "عرض سعر جديد" },
      { href: "/returns", label: "المرتجعات" },
      { href: "/sales-returns/new", label: "مرتجع بيع جديد" },
      { href: "/sales-returns", label: "سجلّ مرتجعات البيع" },
    ],
  },
  {
    key: "purchases",
    label: "المشتريات والموردون",
    icon: "📦",
    items: [
      { href: "/purchases", label: "أوامر الشراء" },
      { href: "/purchases/new", label: "فاتورة شراء جديدة" },
      { href: "/purchase-returns/new", label: "مرتجع شراء جديد" },
      { href: "/purchase-returns", label: "سجلّ مرتجعات الشراء" },
      { href: "/suppliers", label: "الموردون" },
    ],
  },
  {
    key: "print",
    label: "المطبعة والإنتاج",
    icon: "🖨️",
    items: [
      { href: "/work-orders", label: "أوامر الشغل" },
      { href: "/production", label: "الإنتاج والتحويل", managerOnly: true },
      { href: "/production-recipes", label: "وصفات الإنتاج", managerOnly: true },
    ],
  },
  {
    key: "inventory",
    label: "المخزون والبضاعة",
    icon: "🗃️",
    items: [
      { href: "/products", label: "المنتجات" },
      { href: "/inventory", label: "أرصدة المخزون" },
      { href: "/stocktakes", label: "الجرد والتسوية" },
      { href: "/inventory-movements", label: "حركات المخزون" },
      { href: "/transfers", label: "تحويلات بين الفروع" },
      { href: "/barcode-labels", label: "ملصقات الباركود" },
    ],
  },
  {
    key: "assets",
    label: "الأصول الثابتة",
    icon: "🖥️",
    items: [
      { href: "/assets", label: "لوحة الأصول", managerOnly: true },
      { href: "/assets/register", label: "سجلّ الأصول", managerOnly: true },
      { href: "/assets/new", label: "أصل جديد", managerOnly: true },
      { href: "/assets/custody-report", label: "تقرير العهد", managerOnly: true },
      { href: "/assets/disposal-log", label: "سجلّ الاستبعاد", managerOnly: true },
    ],
  },
  {
    key: "hr",
    label: "الموارد البشرية",
    icon: "💼",
    items: [
      { href: "/hr/employees", label: "الموظفون", managerOnly: true },
      { href: "/hr/employees/new", label: "موظف جديد", managerOnly: true },
      { href: "/hr/attendance", label: "الحضور والدوام", managerOnly: true },
      { href: "/hr/payroll", label: "الرواتب", managerOnly: true },
      { href: "/hr/leaves", label: "الإجازات", managerOnly: true },
      { href: "/hr/promotions", label: "الترقيات وإنهاء الخدمات", managerOnly: true },
      { href: "/hr/recruitment", label: "التوظيف والتقديم", managerOnly: true },
      { href: "/hr/devices", label: "أجهزة البصمة", managerOnly: true },
    ],
  },
  {
    key: "treasury",
    label: "الخزينة والمدفوعات",
    icon: "💰",
    items: [
      { href: "/expenses", label: "المصروفات اليومية" },
      { href: "/vouchers", label: "سندات قبض وصرف" },
      { href: "/shifts", label: "سجلّ الورديات" },
    ],
  },
  {
    key: "customers",
    label: "العملاء",
    icon: "👥",
    items: [
      { href: "/customers", label: "العملاء" },
    ],
  },
  {
    key: "reports",
    label: "التقارير والكشوفات",
    icon: "📊",
    items: [
      { href: "/reports", label: "مركز التقارير" },
      { href: "/sales-report", label: "تقرير المبيعات", managerOnly: true },
      { href: "/customers-statement", label: "كشف حساب عميل", managerOnly: true },
      { href: "/ar-aging", label: "أعمار الذمم المدينة", managerOnly: true },
      { href: "/suppliers-statement", label: "كشف حساب مورد", managerOnly: true },
      { href: "/ap-aging", label: "أعمار الذمم الدائنة", managerOnly: true },
      { href: "/reports/cash-orphans", label: "نقد بلا وردية (يتيم)", managerOnly: true },
    ],
  },
  {
    key: "admin",
    label: "الإدارة",
    icon: "⚙️",
    adminOnly: true,
    items: [
      { href: "/users", label: "المستخدمون", adminOnly: true },
      { href: "/roles", label: "الأدوار والصلاحيات", adminOnly: true },
      { href: "/kiosk-devices", label: "شاشات قارئ الأسعار (الأجهزة)", adminOnly: true },
      { href: "/audit", label: "سجلّ التدقيق", adminOnly: true },
      { href: "/reconcile", label: "تدقيق التوافق المالي", adminOnly: true },
      { href: "/period-lock", label: "إقفال الفترات المالية", adminOnly: true },
      { href: "/year-end", label: "الإقفال السنوي", adminOnly: true },
      { href: "/credit-approvals", label: "موافقات الائتمان", managerOnly: true },
      { href: "/wip-report", label: "تقرير الإنتاج تحت التنفيذ (WIP)", managerOnly: true },
      { href: "/settings", label: "النسخ الاحتياطي والإعدادات", adminOnly: true },
    ],
  },
];

const STORAGE_KEY = "nav_open_groups";

function loadOpenGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {/* ignore */}
  return new Set();
}

function saveOpenGroups(keys: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keys)));
  } catch {/* ignore */}
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [loc, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      navigate("/login");
    },
  });

  const [openGroups, setOpenGroups] = useState<Set<string>>(() => loadOpenGroups());

  // درج التنقّل للأجهزة اللوحية/الأصغر (<lg) — يُغلق تلقائياً عند تغيّر المسار.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    setNavOpen(false);
  }, [loc]);

  // تفتح المجموعة التي تحتوي الصفحة النشطة تلقائياً
  const activeGroupKey = useMemo(() => {
    for (const g of NAV_GROUPS) {
      if (g.items.some((item) => item.href === loc)) return g.key;
    }
    return null;
  }, [loc]);

  useEffect(() => {
    if (activeGroupKey && !openGroups.has(activeGroupKey)) {
      setOpenGroups((prev) => {
        const next = new Set(prev);
        next.add(activeGroupKey);
        saveOpenGroups(next);
        return next;
      });
    }
  }, [activeGroupKey]); // eslint-disable-line

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveOpenGroups(next);
      return next;
    });
  }

  const isAdmin = me.data?.role === "admin";
  const isManager = isAdmin || me.data?.role === "manager";

  const sidebarInner = (
    <>
        {/* شريط البحث — يفتح CommandPalette */}
        <div className="px-2 pt-2 pb-1">
          <button
            type="button"
            onClick={openSearch}
            className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Search className="size-3.5 shrink-0" />
            <span className="flex-1 text-right">بحث…</span>
            <kbd className="rounded border border-border/50 bg-background px-1 font-mono text-[10px] opacity-70">Ctrl+K</kbd>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {/* لوحة التحكم — مستقلة */}
          <Link
            href="/"
            className={cn(
              "flex items-center gap-2 rounded-md mx-2 px-3 py-2 text-sm transition",
              loc === "/" ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-accent"
            )}
          >
            <span>🏠</span>
            <span>لوحة التحكم</span>
          </Link>

          <div className="my-1 mx-2 border-b border-border/50" />

          {/* المجموعات */}
          {NAV_GROUPS.filter((g) => !g.adminOnly || isAdmin).map((group) => {
            const isOpen = openGroups.has(group.key);
            const hasActive = group.items.some((item) => item.href === loc);
            const visibleItems = group.items.filter((item) => (!item.adminOnly || isAdmin) && (!item.managerOnly || isManager));
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.key} className="mx-2 mb-0.5">
                {/* رأس المجموعة */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-semibold transition",
                    "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                    hasActive && "text-primary"
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span>{group.icon}</span>
                    <span>{group.label}</span>
                  </span>
                  <span
                    className={cn(
                      "text-[10px] transition-transform duration-150",
                      isOpen ? "rotate-90" : ""
                    )}
                  >
                    ▶
                  </span>
                </button>

                {/* عناصر المجموعة */}
                {isOpen && (
                  <div className="mt-0.5 space-y-0.5 ps-2 border-s-2 border-border/40 ms-3">
                    {visibleItems.map((item) => {
                      const active = loc === item.href;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={cn(
                            "block rounded-md px-3 py-1.5 text-sm transition",
                            active
                              ? "bg-primary text-primary-foreground font-semibold"
                              : "hover:bg-accent text-foreground/80"
                          )}
                        >
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* معلومات المستخدم والخروج */}
        <div className="border-t p-3 text-xs text-muted-foreground">
          <Link
            href="/account"
            className={cn(
              "mb-1 block rounded px-1 py-0.5 hover:underline truncate",
              loc === "/account" ? "text-primary" : ""
            )}
          >
            {me.data?.name ?? me.data?.email}
            <span className="opacity-60 me-1"> ({me.data?.role})</span>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            تسجيل الخروج
          </Button>
        </div>
    </>
  );

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-muted/30" dir="rtl">
      {/* الشريط الجانبي — سطح المكتب (≥lg) */}
      <aside className="hidden lg:flex w-60 shrink-0 border-l bg-card flex-col">
        <div className="px-4 py-4 border-b flex items-center justify-between gap-2">
          <span className="font-semibold text-base leading-tight">الرؤية العربية</span>
          <ThemeToggle />
        </div>
        {sidebarInner}
      </aside>

      {/* الشريط العلوي + درج التنقّل — اللوحي/الأصغر (<lg). Sheet جذرٌ بلا DOM فيبقى
          الـheader طفلاً مباشراً للحاوية، وSheetTrigger يُنسّق الفتح/الإغلاق (يتجنّب
          مشكلة نقرة الفتح التي تصل لطبقة الإغلاق في النمط المُتحكَّم به يدوياً). */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <header className="lg:hidden flex items-center justify-between gap-2 border-b bg-card px-3 py-2">
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label="فتح القائمة"
              className="flex size-9 items-center justify-center rounded-md border border-border/60 text-foreground transition-colors hover:bg-accent"
            >
              <Menu className="size-5" />
            </button>
          </SheetTrigger>
          <span className="font-semibold text-base leading-tight">الرؤية العربية</span>
          <ThemeToggle />
        </header>

        <SheetContent side="right" dir="rtl" className="w-72 p-0">
          <SheetHeader className="border-b px-4 py-4 text-right">
            <SheetTitle>الرؤية العربية</SheetTitle>
          </SheetHeader>
          {sidebarInner}
        </SheetContent>
      </Sheet>

      <main className="flex-1 p-3 md:p-6 overflow-auto">{children}</main>
    </div>
  );
}

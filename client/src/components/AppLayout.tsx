import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { Link, useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";

type NavItem = { href: string; label: string; adminOnly?: boolean };
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
    label: "العملاء والذمم",
    icon: "👥",
    items: [
      { href: "/customers", label: "العملاء" },
      { href: "/customers-statement", label: "كشف حساب عميل" },
      { href: "/ar-aging", label: "أعمار الذمم المدينة" },
    ],
  },
  {
    key: "reports",
    label: "التقارير والكشوفات",
    icon: "📊",
    items: [
      { href: "/sales-report", label: "تقرير المبيعات" },
      { href: "/suppliers-statement", label: "كشف حساب مورد" },
      { href: "/ap-aging", label: "أعمار الذمم الدائنة" },
    ],
  },
  {
    key: "admin",
    label: "الإدارة",
    icon: "⚙️",
    adminOnly: true,
    items: [
      { href: "/users", label: "المستخدمون", adminOnly: true },
      { href: "/audit", label: "سجلّ التدقيق", adminOnly: true },
      { href: "/reconcile", label: "تدقيق التوافق المالي", adminOnly: true },
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

  return (
    <div className="min-h-screen flex bg-muted/30" dir="rtl">
      <aside className="w-60 shrink-0 border-l bg-card flex flex-col">
        {/* الرأس */}
        <div className="px-4 py-4 border-b flex items-center justify-between gap-2">
          <span className="font-semibold text-base leading-tight">الرؤية العربية</span>
          <ThemeToggle />
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
            const visibleItems = group.items.filter((item) => !item.adminOnly || isAdmin);
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
      </aside>
      <main className="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  );
}

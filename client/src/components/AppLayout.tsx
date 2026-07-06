import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { openSearch } from "@/lib/searchEvents";
import {
  Menu, Search, Home, ScanLine, Receipt,
  ShoppingCart, Package, Printer, Boxes, Server,
  Briefcase, Wallet, Users, BarChart3, Settings, Lock, Truck, Building2, DollarSign,
  UserCircle2, ChevronLeft, LogOut,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";

type NavLink = RoleGate & { href: string; label: string; icon: LucideIcon };

// تَنقّل الشريط الجانبي — مُسطَّح بالكامل (الموجة ٢، يونيو ٢٠٢٦): كل وَحدة = مَدخل واحد يَفتح
// شاشة الوحدة، وتبويباتها الثانوية أعلى الشاشة (أزرار). لا مَجموعات قابلة للطيّ، لا تَمرير مُملّ.
//  - لوحة التحكم تَبقى رابطاً مُستقلّاً أعلى القائمة.
//  - نقطة البيع وقارئ الأسعار أدواتٌ ملء‑شاشة (روابط مُباشرة).
//  - بقية الوَحدات صَفحات hub بتبويبات ?tab= (المبيعات/المشتريات/المطبعة/الأصول/الموارد/الإقفال/الإدارة...).
//  - القيود: managerOnly (الأصول/الموارد/الصيرفة/الإقفال/الإدارة) و roles (التوصيل)؛ والتبويبات
//    الحسّاسة داخل كل hub مُقيَّدة إضافةً (admin‑فقط للتكاملات/الأدوار/إقفال الفترات...).
//
// ⚙️ ترتيب القائمة = بحسب الاستعمال اليومي والأهمية (الأكثر استخداماً أولاً) لنشاط مطبعة+قرطاسية:
//   ‏(أ) تشغيل يومي دائم على المنضدة: نقطة البيع ← قارئ الأسعار ← المطبعة والإنتاج ← العملاء ← المبيعات.
//   ‏(ب) يومي مالي/تشغيلي: الخزينة ← التوصيل ← المخزون.
//   ‏(ج) دوري (أسبوعي/عند الحاجة): المشتريات ← الموردون ← التقارير.
//   ‏(د) متخصّص/نادر: الصيرفة ← الأصول ← الموارد ← الإقفال ← الإدارة والإعدادات (في الأسفل دائماً).
const NAV_LINKS: NavLink[] = [
  // (أ) الأكثر استعمالاً يومياً — تشغيل الواجهة الأمامية
  { href: "/pos", label: "نقطة البيع", icon: ShoppingCart },
  { href: "/price-checker", label: "قارئ الأسعار", icon: ScanLine },
  { href: "/work-orders", label: "المطبعة والإنتاج", icon: Printer },
  { href: "/customers", label: "العملاء", icon: Users },
  { href: "/invoices", label: "المبيعات", icon: Receipt },
  // (ب) يومي مالي/تشغيلي
  { href: "/treasury", label: "الخزينة والمدفوعات", icon: Wallet },
  { href: "/delivery", label: "التوصيل", icon: Truck, roles: ["admin", "manager", "accountant", "cashier", "auditor"] },
  { href: "/inventory", label: "المخزون والبضاعة", icon: Boxes },
  // (ج) دوري — أسبوعي/عند الحاجة
  { href: "/purchases", label: "المشتريات", icon: Package },
  { href: "/suppliers", label: "الموردون", icon: Building2 },
  { href: "/reports", label: "التقارير والكشوفات", icon: BarChart3 },
  // (د) متخصّص/نادر — الإعدادات في الأسفل دائماً
  // الصيرفة تتبع وحدة «الخزينة» (راوترها يسمح لـmanager/accountant + منح صريح) — والمحاسب
  // القالبيّ يظهر عبر قائمة الأدوار، والمنح الصريح لغيره عبر module (تبويبات الصيرفة غير مُقيَّدة).
  { href: "/exchange", label: "الصيرفة", icon: DollarSign, roles: ["admin", "manager", "accountant"], module: "treasury" },
  // الأصول/الموارد/الإعدادات: محاور بتبويبات managerOnly داخلها ⇒ لا نفتحها بمنح وحدة (وإلا
  // وصل المستخدم لمحور بلا تبويبات مرئية = صفحة فارغة، مراجعة Codex). تبقى مديرية بالكامل.
  { href: "/assets", label: "الأصول الثابتة", icon: Server, managerOnly: true },
  { href: "/hr", label: "الموارد البشرية", icon: Briefcase, managerOnly: true },
  { href: "/closing", label: "الإقفال والرَقابة", icon: Lock, managerOnly: true },
  { href: "/settings", label: "الإدارة والإعدادات", icon: Settings, managerOnly: true },
];

// نشِط = المسار يطابق الوَحدة أو يقع تحتها (تبويب ?tab أو شاشة تفصيل ‎/x/…). الحارس ‎+"/" يَمنع
// التقاط بادئة خاطئة (‎/inventory لا يَلتقط ‎/inventory-movements).
function isModuleActive(loc: string, href: string): boolean {
  return loc === href || loc.startsWith(href + "/");
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

  // درج التنقّل للأجهزة اللوحية/الأصغر (<lg) — يُغلق تلقائياً عند تغيّر المسار.
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setNavOpen(false);
    // عند تغيّر المسار: صفّر تمرير المحتوى وانقل التركيز إليه (WCAG focus-on-route-change) —
    // فلا تبقى الصفحة الجديدة مُمرَّرة لموضع سابق، ويُعلن قارئ الشاشة الانتقال بدل إبقاء التركيز على الرابط.
    mainRef.current?.scrollTo({ top: 0 });
    mainRef.current?.focus();
  }, [loc]);

  const role = me.data?.role;
  // الصلاحيات الممنوحة (override فردي/دور مخصّص) — تُمرَّر لفلترة التنقّل مع الدور.
  const permsOverride = (me.data?.permissionsOverride ?? null) as
    | import("@shared/permissions").PermissionMap
    | null;

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
            <span className="flex-1 text-start">بحث…</span>
            <kbd className="rounded border border-border/50 bg-background px-1 font-mono text-[10px] opacity-70">Ctrl+K</kbd>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {/* لوحة التحكم — رابط مستقلّ */}
          <Link
            href="/"
            aria-current={loc === "/" ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md mx-2 px-3 py-2 min-h-[40px] text-sm transition",
              loc === "/" ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-accent",
            )}
          >
            <Home className="size-4 shrink-0" aria-hidden />
            <span className="truncate">لوحة التحكم</span>
          </Link>

          <div className="my-1 mx-2 border-b border-border/50" />

          {/* الوَحدات — قائمة مُسطّحة، مَدخل واحد لكل وحدة */}
          {NAV_LINKS.filter((m) => canSeeGate(m, role, permsOverride)).map((m) => {
            const active = isModuleActive(loc, m.href);
            const Icon = m.icon;
            return (
              <Link
                key={m.href}
                href={m.href}
                title={m.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md mx-2 mb-0.5 px-3 py-2 min-h-[40px] text-sm transition",
                  active ? "bg-primary text-primary-foreground font-semibold" : "text-foreground/90 hover:bg-accent",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{m.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* معلومات المستخدم والخروج — كارت واضح النقر (مدخل «حسابي») + زرّ الخروج.
            كان الرابط سابقاً نصّاً خافتاً بلا أيقونة ⇒ المالك لم يجد كيف يفتح /account (٦/٧).
            الآن: أيقونة مُلوَّنة + الاسم/الدور بوضوح + شارة nav-item + hover واضح + aria-current. */}
        <div className="border-t p-2 space-y-1">
          <Link
            href="/account"
            aria-label="حسابي"
            aria-current={loc === "/account" ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition",
              loc === "/account"
                ? "bg-primary text-primary-foreground font-semibold"
                : "bg-muted/40 hover:bg-accent text-foreground",
            )}
          >
            <div className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              loc === "/account" ? "bg-primary-foreground/20" : "bg-primary/10 text-primary",
            )}>
              <UserCircle2 className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium leading-tight">{me.data?.name ?? me.data?.email ?? "—"}</div>
              <div className={cn(
                "truncate text-[11px] leading-tight",
                loc === "/account" ? "opacity-80" : "text-muted-foreground",
              )}>
                حسابي{me.data?.role ? ` · ${me.data.role}` : ""}
              </div>
            </div>
            <ChevronLeft className="size-4 shrink-0 opacity-60" aria-hidden />
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut className="size-4" aria-hidden />
            تسجيل الخروج
          </Button>
        </div>
    </>
  );

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-muted/30" dir="rtl">
      {/* الشريط الجانبي — سطح المكتب (≥lg) */}
      <aside className="hidden lg:flex w-64 shrink-0 border-s bg-card flex-col">
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
              className="flex size-11 items-center justify-center rounded-md border border-border/60 text-foreground transition-colors hover:bg-accent"
            >
              <Menu className="size-5" />
            </button>
          </SheetTrigger>
          <span className="font-semibold text-base leading-tight">الرؤية العربية</span>
          <ThemeToggle />
        </header>

        <SheetContent side="right" dir="rtl" className="w-72 p-0">
          <SheetHeader className="border-b px-4 py-4 text-start">
            <SheetTitle>الرؤية العربية</SheetTitle>
          </SheetHeader>
          {sidebarInner}
        </SheetContent>
      </Sheet>

      <main ref={mainRef} tabIndex={-1} className="flex-1 p-3 md:p-6 overflow-auto outline-none">{children}</main>
    </div>
  );
}

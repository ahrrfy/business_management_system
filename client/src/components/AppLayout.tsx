import { MobileBottomNav } from "@/components/MobileBottomNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { openSearch } from "@/lib/searchEvents";
import { resetSessionForLogout } from "@/lib/offline/sessionBoundary";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import {
  getOfflineProfile,
  getOfflineUnlockedProfile,
  isOfflineUnlocked,
  subscribeOfflineUnlock,
  type OfflineProfile,
} from "@/lib/offline/pinLock";
import {
  coldStudioShellCapabilities,
  shouldSkipColdStudioAuth,
} from "@/lib/productStudio/coldOfflinePolicy";
import { usePrinterConnection } from "@/hooks/usePrinterConnection";
import { useQueryClient } from "@tanstack/react-query";
import {
  Menu, Search, Home, ScanLine, Receipt,
  ShoppingCart, Package, Printer, Boxes, Server,
  Briefcase, Wallet, Users, BarChart3, Settings, Lock, Truck, Building2, Gift, DollarSign, CreditCard,
  UserCircle2, ChevronLeft, LogOut, Store, PackageCheck, ListChecks, Landmark, Check, WalletCards, ClipboardCheck,
  History, Star, Images, Megaphone,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CASHIER_NAV_PATHS, INVOICE_LIST_GATE, canSeeGate, type RoleGate } from "@/lib/navVisibility";
import { ROLE_LABEL } from "@/lib/roles";
import {
  NAV_FAVORITES_LIMIT,
  loadNavWorkspace,
  navWorkspaceStorageKey,
  readLastCompanyCode,
  recordRecent,
  resolveNavRoot,
  saveNavWorkspace,
  toggleFavorite,
  type NavWorkspace,
} from "@/lib/navWorkspace";

/**
 * ربط الطابعة الحرارية — متاحٌ من الشريط العلوي في كل شاشة (لا الكاشير فقط)، كي تُربط مرّةً
 * واحدة وتُستعمَل تلقائياً في كل مكان تُطبَع فيه (فواتير/سندات/أوامر شغل/إيصال وردية) — الإذن
 * والاتصال (thermal.ts) عالميّان بالفعل داخل الجلسة. لا تظهر على /pos (خارج AppLayout بتصميمه
 * الخاص بملء الشاشة) — تلك الشاشة تملك زرّها المستقلّ في شاشة فتح الوردية نفسها.
 */
function PrinterStatusButton({
  printerReady, connect, supported,
}: { printerReady: boolean; connect: () => void; supported: boolean }) {
  if (!supported) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={connect}
      aria-label={printerReady ? "الطابعة الحرارية مربوطة" : "ربط طابعة حرارية"}
      title={printerReady
        ? "الطابعة الحرارية مربوطة (تلقائياً في كل شاشة) — اضغط لتبديلها"
        : "اربط طابعة حرارية — تُستعمل تلقائياً بعدها في كل شاشات الطباعة"}
      className={cn("relative", printerReady && "text-money-positive")}
    >
      <Printer className="size-5" aria-hidden />
      {printerReady && (
        <Check className="absolute bottom-1.5 left-1.5 size-3 rounded-full bg-background" aria-hidden strokeWidth={3.5} />
      )}
    </Button>
  );
}

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
  { href: "/work-orders", label: "المطبعة والإنتاج", icon: Printer, module: "workorders" },
  { href: "/crm", label: "CRM والعلاقات", icon: Users, module: "crm" },
  // نظام المهام الموحّد (S2/T2.3) — module فقط (بلا roles) ⇒ مرآة hasModuleAccess تماماً كبوّابة
  // الخادم tasksReadProcedure (requireModule("tasks","READ") — لا قائمة أدوار صريحة هناك أيضاً).
  // ش٦ (١٩/٨): سطحُ «ما ينتظره منّي العمل». بلا بوّابة وحدة (protectedProcedure) — والمحتوى
  // يُصفّى خادمياً بصلاحية كل مصدرٍ على حِدة، فلا يرى أحدٌ قراراً لا يملكه.
  { href: "/my-work", label: "مطلوب مني الآن", icon: ClipboardCheck },
  { href: "/tasks", label: "المهام والتذاكر", icon: ListChecks, module: "tasks" },
  { href: "/invoices", label: "المبيعات", icon: Receipt, ...INVOICE_LIST_GATE },
  // (ب) يومي مالي/تشغيلي
  // الخزينة: كل تبويباتها مُقيَّدة (treasury/expenses ≥ READ في TreasuryHub) — بلا قيدٍ هنا يهبط
  // أمين المخزن/الفني على hub بلا تبويبات = صفحة فارغة (نفس مبدأ الأصول/الموارد أدناه).
  { href: "/treasury", label: "الخزينة والمدفوعات", icon: Wallet, roles: ["manager", "accountant", "cashier", "auditor"], module: "treasury" },
  // حساب البطاقة/البنك: رصيد أموال البطاقة (منفصل عن الدرج) — ماليّ يُحجَب عن الكاشير (module=reports كخدمته).
  { href: "/card-account", label: "حساب البطاقة/البنك", icon: CreditCard, roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  { href: "/delivery", label: "التوصيل", icon: Truck, roles: ["admin", "manager", "accountant", "cashier", "auditor"] },
  // شاشة المندوب الذاتية — courier فقط (admin يراها عبر canSeeGate؛ المدير يدير عبر /delivery).
  { href: "/my-deliveries", label: "توصيلاتي", icon: PackageCheck, roles: ["courier"], module: "courier" },
  { href: "/store-admin", label: "طلبات المتجر", icon: Store, roles: ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"], module: "store" },
  { href: "/catalog/image-studio", label: "استوديو المنتجات", icon: Images, roles: ["admin", "manager", "print_operator", "auditor"], module: "productStudio" },
  // ٢٨/٨: بندٌ منفصلٌ لإدارة الحملات — قرار المالك «رابط في القائمة الجانبية + زرّ داخل
  // استوديو المنتجات». المدير يكتشفها من هنا مباشرةً بلا الحاجة إلى فتح الاستوديو والبحث
  // في قسمه الداخليّ. Icon Megaphone يميّزها عن الاستوديو نفسه (Images).
  { href: "/catalog/image-studio/campaigns", label: "حملات التصوير", icon: Megaphone, roles: ["admin", "manager", "auditor"], module: "productStudio" },
  { href: "/inventory", label: "المخزون والبضاعة", icon: Boxes },
  // (ج) دوري — أسبوعي/عند الحاجة
  { href: "/purchases", label: "المشتريات", icon: Package },
  { href: "/suppliers", label: "الموردون", icon: Building2 },
  { href: "/gifts", label: "الهدايا والمجانيات", icon: Gift, roles: ["admin", "manager", "accountant", "warehouse", "purchasing", "auditor"], module: "gifts" },
  { href: "/digital-cards", label: "البطاقات الرقمية", icon: WalletCards, roles: ["admin", "manager", "accountant", "auditor"], module: "digital_cards" },
  { href: "/reports", label: "التقارير والكشوفات", icon: BarChart3 },
  { href: "/chart-of-accounts", label: "شجرة الحسابات", icon: Landmark, roles: ["admin", "manager", "accountant", "auditor"], module: "reports" },
  // (د) متخصّص/نادر — الإعدادات في الأسفل دائماً
  // الصيرفة تتبع وحدة «الخزينة» (راوترها يسمح لـmanager/accountant + منح صريح) — والمحاسب
  // القالبيّ يظهر عبر قائمة الأدوار، والمنح الصريح لغيره عبر module (تبويبات الصيرفة غير مُقيَّدة).
  { href: "/exchange", label: "الصيرفة", icon: DollarSign, roles: ["admin", "manager", "accountant"], module: "treasury" },
  // الأصول/الإعدادات: محاور بتبويبات managerOnly داخلها ⇒ لا نفتحها بمنح وحدة (وإلا
  // وصل المستخدم لمحور بلا تبويبات مرئية = صفحة فارغة، مراجعة Codex). تبقى مديرية بالكامل.
  { href: "/assets", label: "الأصول الثابتة", icon: Server, managerOnly: true },
  // الموارد البشرية: تبويباتها صارت مرآة الخادم (HrHub) ⇒ تُفتح كبوّابته requireModule("hr","READ")
  // — أدوار القالب (accountant/auditor قالباهما hr=READ) + المنح الصريح عبر module.
  { href: "/hr", label: "الموارد البشرية", icon: Briefcase, roles: ["admin", "manager", "accountant", "auditor"], module: "hr" },
  {
    href: "/closing",
    label: "الإقفال والرَقابة",
    icon: Lock,
    roles: ["admin", "manager", "accountant", "auditor"],
    module: "reports",
  },
  { href: "/settings", label: "الإدارة والإعدادات", icon: Settings, managerOnly: true },
];

// نشِط = المسار يطابق الوَحدة أو يقع تحتها (تبويب ?tab أو شاشة تفصيل ‎/x/…). الحارس ‎+"/" يَمنع
// التقاط بادئة خاطئة (‎/inventory لا يَلتقط ‎/inventory-movements).
function isModuleActive(loc: string, href: string): boolean {
  return loc === href || loc.startsWith(href + "/");
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [loc] = useLocation();
  const queryClient = useQueryClient();
  const connectivity = useConnectivity();
  const unlocked = useSyncExternalStore(
    subscribeOfflineUnlock,
    isOfflineUnlocked,
    isOfflineUnlocked,
  );
  const coldStudio = shouldSkipColdStudioAuth({
    location: loc,
    offline:
      isDisconnected(connectivity) ||
      (typeof navigator !== "undefined" && !navigator.onLine),
    pinVerified: unlocked,
    localProfile: getOfflineUnlockedProfile(),
  });
  const [coldProfile, setColdProfile] = useState<OfflineProfile | null>(null);
  const shellCapabilities = coldStudioShellCapabilities(coldStudio);
  const me = trpc.auth.me.useQuery(undefined, { enabled: !coldStudio });
  const myStocktakes = trpc.count.mine.useQuery(undefined, {
    enabled: !coldStudio && Boolean(me.data),
    refetchInterval: 30_000,
  });
  const printer = usePrinterConnection();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: async () => {
      await resetSessionForLogout(queryClient);
      window.location.replace("/login");
    },
  });

  // درج التنقّل للأجهزة اللوحية/الأصغر (<lg) — يُغلق تلقائياً عند تغيّر المسار.
  const [navOpen, setNavOpen] = useState(false);
  const [navWorkspace, setNavWorkspace] = useState<NavWorkspace>({ favorites: [], recent: [] });
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!coldStudio) {
      setColdProfile(null);
      return;
    }
    void getOfflineProfile().then(setColdProfile);
  }, [coldStudio]);
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
  // المندوب (courier) شاشةٌ واحدة «توصيلاتي» فقط — نخفي بقية الروابط (كلها إمّا محجوبة خادمياً أو
  // بلا معنى له) بدل عرض جدارٍ من روابط ميتة (مراجعة عدائية ١٢/٧). العزل الحقيقي خادميّ؛ هذا تحسين UX.
  const isCourier = role === "courier";
  // «مساحة العمل المركّزة» لفئة الكاشير (٢٤/٧، قرار المالك): موظف الوردية عمله فتح وردية ← بيع ←
  // إغلاق وتسليم — يرى أدوات منضدته فقط لا جدار وحدات النظام (تعميم نمط المندوب أعلاه). القائمة
  // البيضاء تُقاطَع مع canSeeGate ⇒ ما يظهر محكوم بصلاحيات دوره الفعلية (كاشير طباعة بلا store
  // لا يرى «طلبات المتجر»)، وإطفاء وحدةٍ من شاشة «الأدوار» يُسقط بندها هنا فوراً. العزل الحقيقي
  // خادميّ كما هو؛ وبقية الشاشات المسموحة تبقى بلوغاً بالبحث (Ctrl+K) — تركيزٌ لا حجبٌ جديد.
  const isCashier = role === "cashier";
  // طلبات المتجر التشغيلية والحجوزات والقنوات أصبحت داخل محطة الاستقبال؛ يبقى StoreHub
  // للإدارة (كتالوج/بنرات/إعدادات) ولا يُشتّت قائمة الكاشير اليومية.
  // «/delivery» (٩/٨): الكاشير هو منفِّذ توريد المناديب الطبيعي وكان مخوَّلاً بلا مدخل مرئي
  // (الوصول بالبحث فقط) ⇒ تتراكم التسويات أو تُنفَّذ من زرّ «تسوية» المجمّع الخطأ.
  // ١٩/٨ (بلاغ المالك «الفواتير لا تظهر للمستخدم المنفّذ… ولا يرى فواتيره التي أنشأها»):
  // أُضيفت `/invoices` و`/work-orders`. الخادم صار يقبلهما لهذه الأدوار بنطاقٍ يقصّ القناة،
  // وكانت القائمة البيضاء تحجبهما عرضاً — فيُرفَض الموظّف في الشاشة لا في الصلاحية. كلٌّ يبقى
  // محكوماً ببوّابته أدناه (`canSeeGate`)، فالإضافة هنا **إتاحةُ وصولٍ لا منحُ صلاحية**.
  // القائمة البيضاء صارت في `navVisibility.ts` بجوار البوّابة التي تُطبَّق معها — ويحرسها
  // اختبارُ تطابقٍ مع الخادم بعد أن أخفت مدخلاً مسموحاً (بلاغ ٢٠/٨).
  const CASHIER_NAV = CASHIER_NAV_PATHS;
  // `coldStudio` (من main): شلٌّ كاملٌ للتنقّل في وضع الاستوديو البارد — يبقى **قبل** كلّ
  // فرعٍ آخر، فالإضافةُ أعلاه لا تفتح مدخلاً في وضعٍ صُمّم ليكون بلا مداخل.
  const visibleNav = coldStudio
    ? []
    : isCourier
    ? NAV_LINKS.filter((m) => m.roles?.includes("courier"))
    : isCashier
      ? NAV_LINKS.filter((m) => CASHIER_NAV.includes(m.href) && canSeeGate(m, role, permsOverride))
      : NAV_LINKS.filter((m) => canSeeGate(m, role, permsOverride));
  const hasMyStocktake = (myStocktakes.data?.length ?? 0) > 0;
  const allowedNavPaths = visibleNav.map((item) => item.href);
  const allowedNavPathsKey = allowedNavPaths.join("|");
  const navStorageKey = me.data?.id && typeof window !== "undefined"
    ? navWorkspaceStorageKey(me.data.id, readLastCompanyCode(window.localStorage))
    : null;

  // أعد القراءة والترشيح عند تبدّل المستخدم/الشركة/الصلاحيات، وسجّل جذر الوحدة فقط؛
  // صفحات التفاصيل (وأرقامها) لا تدخل localStorage إطلاقاً.
  useEffect(() => {
    if (!navStorageKey || typeof window === "undefined") {
      setNavWorkspace({ favorites: [], recent: [] });
      return;
    }
    const loaded = loadNavWorkspace(window.localStorage, navStorageKey, allowedNavPaths);
    const currentRoot = resolveNavRoot(loc, allowedNavPaths);
    const next = currentRoot ? recordRecent(loaded, currentRoot) : loaded;
    setNavWorkspace(saveNavWorkspace(window.localStorage, navStorageKey, next, allowedNavPaths));
    // allowedNavPathsKey هو تمثيل ثابت للقائمة المسموحة؛ المصفوفة نفسها تُنشأ مع كل render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, navStorageKey, allowedNavPathsKey]);

  function handleFavorite(path: string) {
    setNavWorkspace((current) => {
      const next = toggleFavorite(current, path);
      if (next === current || !navStorageKey || typeof window === "undefined") return next;
      return saveNavWorkspace(window.localStorage, navStorageKey, next, allowedNavPaths);
    });
  }

  const navByPath = new Map(visibleNav.map((item) => [item.href, item] as const));
  const favoriteLinks = navWorkspace.favorites.flatMap((path) => {
    const item = navByPath.get(path);
    return item ? [item] : [];
  });
  const favoritePaths = new Set(navWorkspace.favorites);
  const recentLinks = navWorkspace.recent.flatMap((path) => {
    const item = navByPath.get(path);
    return item && !favoritePaths.has(path) ? [item] : [];
  }).slice(0, 3);
  const favoritesFull = navWorkspace.favorites.length >= NAV_FAVORITES_LIMIT;
  const displayName =
    me.data?.name ?? me.data?.email ?? coldProfile?.name ?? "—";
  const displayRole = me.data?.role ?? coldProfile?.role;

  const coldStudioSidebar = (
    <div className="flex flex-1 flex-col justify-end p-3">
      <div className="rounded-md border p-3 text-sm">
        <div className="font-medium">{displayName}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {displayRole ? ROLE_LABEL[displayRole] ?? displayRole : "استعادة محلية"}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          هذه الجلسة مخصصة لمسودة الاستوديو المحلية فقط.
        </p>
      </div>
    </div>
  );

  const sidebarInner = (
    <>
        {/* شريط البحث — يفتح CommandPalette */}
        {shellCapabilities.mountGlobalSearch && (
          <div className="px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={openSearch}
              className="sb-search flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors"
            >
              <Search className="size-3.5 shrink-0" />
              <span className="flex-1 text-start">بحث…</span>
              <kbd className="rounded px-1 font-mono text-[10px]">Ctrl+K</kbd>
            </button>
          </div>
        )}

        <nav className="sb-scroll flex-1 overflow-y-auto py-2" aria-label="التنقّل الرئيسي">
          {/* لوحة التحكم — رابط مستقلّ (يُخفى عن المندوب والكاشير: مساحتاهما مركّزتان) */}
          {!isCourier && !isCashier && (
            <>
              <Link
                href="/"
                aria-current={loc === "/" ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 min-h-[40px] text-sm transition",
                  loc === "/" ? "sb-active font-semibold" : "sb-item rounded-md mx-2",
                )}
              >
                <Home className="size-4 shrink-0" aria-hidden />
                <span className="truncate">لوحة التحكم</span>
              </Link>
              <div className="my-1 mx-2 sb-divider" />
            </>
          )}

          {hasMyStocktake && (
            <>
              <Link
                href="/my-stocktake"
                aria-current={loc === "/my-stocktake" || loc.startsWith("/my-stocktake/") ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 mb-0.5 px-3 py-2 min-h-[40px] text-sm transition",
                  loc === "/my-stocktake" || loc.startsWith("/my-stocktake/") ? "sb-active font-semibold" : "sb-item rounded-md mx-2",
                )}
              >
                <ClipboardCheck className="size-4 shrink-0" aria-hidden />
                <span className="truncate">جردي</span>
              </Link>
              <div className="my-1 mx-2 sb-divider" />
            </>
          )}

          {(favoriteLinks.length > 0 || recentLinks.length > 0) && (
            <section aria-label="اختصارات التنقّل" className="mb-1">
              <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium sb-sub">اختصاراتي</div>
              {favoriteLinks.map((item) => {
                const active = isModuleActive(loc, item.href);
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
                const active = isModuleActive(loc, item.href);
                return (
                  <Link
                    key={`recent:${item.href}`}
                    href={item.href}
                    title={`حديثاً: ${item.label}`}
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
              <div className="my-1 mx-2 sb-divider" />
            </section>
          )}

          {/* الوَحدات — قائمة مُسطّحة، مَدخل واحد لكل وحدة */}
          {visibleNav.map((m) => {
            const active = isModuleActive(loc, m.href);
            const favorite = favoritePaths.has(m.href);
            const Icon = m.icon;
            return (
              <div key={m.href} className="group relative">
                <Link
                  href={m.href}
                  title={m.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 mb-0.5 px-3 pe-11 py-2 min-h-[40px] text-sm transition",
                    active ? "sb-active font-semibold" : "sb-item rounded-md mx-2",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{m.label}</span>
                </Link>
                <button
                  type="button"
                  onClick={() => handleFavorite(m.href)}
                  aria-disabled={!favorite && favoritesFull ? true : undefined}
                  aria-pressed={favorite}
                  aria-label={favorite
                    ? `إزالة ${m.label} من المفضلة`
                    : favoritesFull
                      ? `لا يمكن إضافة ${m.label} إلى المفضلة؛ بلغت الحد الأقصى`
                      : `إضافة ${m.label} إلى المفضلة`}
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
        </nav>

        {/* معلومات المستخدم والخروج — كارت واضح النقر (مدخل «حسابي») + زرّ الخروج.
            كان الرابط سابقاً نصّاً خافتاً بلا أيقونة ⇒ المالك لم يجد كيف يفتح /account (٦/٧).
            الآن: أيقونة مُلوَّنة + الاسم/الدور بوضوح + شارة nav-item + hover واضح + aria-current. */}
        <div className="sb-footer p-2 space-y-1">
          <Link
            href={coldStudio ? "/catalog/image-studio" : "/account"}
            aria-label="حسابي"
            aria-current={loc === "/account" ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition",
              loc === "/account" ? "sb-account-active font-semibold" : "sb-account",
            )}
          >
            <div className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              loc === "/account" ? "bg-primary/10 text-primary" : "sb-avatar",
            )}>
              <UserCircle2 className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium leading-tight">{displayName}</div>
              <div className={cn(
                "truncate text-[11px] leading-tight",
                loc === "/account" ? "opacity-80" : "sb-sub",
              )}>
                {/* تسمية الدور الحقيقية بالعربية (الدور المخصّص أولاً) — كان يعرض المفتاح الخام «cashier». */}
                حسابي{displayRole ? ` · ${me.data?.isOwner ? "مالك النظام" : (me.data?.customRoleLabel ?? ROLE_LABEL[displayRole] ?? displayRole)}` : ""}
              </div>
            </div>
            <ChevronLeft className="size-4 shrink-0 opacity-60" aria-hidden />
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="sb-logout w-full justify-start gap-2"
            onClick={() => logout.mutate()}
            disabled={coldStudio || logout.isPending}
          >
            <LogOut className="size-4" aria-hidden />
            تسجيل الخروج
          </Button>
        </div>
    </>
  );

  return (
    <div className="app-shell min-h-screen flex flex-col lg:flex-row bg-muted/30" dir="rtl">
      {/* الشريط الجانبي — سطح المكتب (≥lg) */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col app-sidebar">
        <div className="sb-header px-4 py-4 flex items-center justify-between gap-1">
          <span className="font-semibold text-base leading-tight">الرؤية العربية</span>
          <div className="flex items-center gap-0.5">
            <PrinterStatusButton printerReady={printer.printerReady} connect={printer.connect} supported={printer.supported} />
            <ThemeToggle />
          </div>
        </div>
        {shellCapabilities.allowRemoteNavigation ? sidebarInner : coldStudioSidebar}
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
          <div className="flex items-center gap-0.5">
            <PrinterStatusButton printerReady={printer.printerReady} connect={printer.connect} supported={printer.supported} />
            <ThemeToggle />
          </div>
        </header>

        <SheetContent side="right" dir="rtl" className="app-sidebar w-72 p-0">
          <SheetHeader className="sb-header px-4 py-4 text-start">
            <SheetTitle className="text-[color:var(--sidebar-on-strong)]">الرؤية العربية</SheetTitle>
          </SheetHeader>
          {shellCapabilities.allowRemoteNavigation ? sidebarInner : coldStudioSidebar}
        </SheetContent>
      </Sheet>

      <main ref={mainRef} tabIndex={-1} className="app-main flex-1 p-3 md:p-6 pb-24 lg:pb-6 overflow-auto outline-none">{children}</main>

      {/* شريط التنقل السريع للهاتف أسفل الشاشة (<lg) */}
      {shellCapabilities.mountMobileBottomNav && (
        <MobileBottomNav
          role={role}
          permsOverride={permsOverride}
          onOpenMenu={() => setNavOpen(true)}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState, useSyncExternalStore, Suspense, lazy } from "react";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { NotificationBell } from "@/components/NotificationBell";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DisplayScaleControl } from "@/components/DisplayScaleControl";
import { QuranHeaderButton } from "@/components/quran/QuranHeaderButton";
import { BroadcastTicker } from "@/components/announcements/BroadcastTicker";
import { PushNotificationPrompt } from "@/components/notifications/PushNotificationPrompt";
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
  Menu, Search, Printer, UserCircle2, ChevronLeft, LogOut, Check,
} from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { CASHIER_NAV_PATHS, canSeeGate } from "@/lib/navVisibility";
import { hasModuleAccess } from "@shared/permissions";
import { ROLE_LABEL } from "@/lib/roles";
import { APPLICATION_MODULES as NAV_LINKS } from "@/lib/moduleRegistry";
import { resolveWorkspaceProfile } from "@/lib/workspaceProfiles";
import {
  loadNavWorkspace,
  navWorkspaceStorageKey,
  readLastCompanyCode,
  recordRecent,
  resolveNavRoot,
  saveNavWorkspace,
  toggleFavorite,
  type NavWorkspace,
} from "@/lib/navWorkspace";

const QuranSidebarCard = lazy(() =>
  import("@/components/quran/QuranSidebarCard").then((module) => ({
    default: module.QuranSidebarCard,
  })),
);

const HybridSidebarNav = lazy(() =>
  import("@/components/navigation/HybridSidebarNav").then((module) => ({
    default: module.HybridSidebarNav,
  })),
);

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

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const [loc, setLocation] = useLocation();
  const search = useSearch();

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const handlePushNavigate = (event: MessageEvent) => {
      if (
        event.data &&
        typeof event.data === "object" &&
        event.data.type === "PUSH_NAVIGATE" &&
        typeof event.data.url === "string" &&
        event.data.url.startsWith("/") &&
        !event.data.url.startsWith("//")
      ) {
        setLocation(event.data.url);
      }
    };
    navigator.serviceWorker.addEventListener("message", handlePushNavigate);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handlePushNavigate);
    };
  }, [setLocation]);

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
  // ٢٩/٨ (بلاغ المالك): «الفنيّ حوّله لجاهز — لا شي يظهر ولا يلاحظه موظفو الاستقبال». Slice A كان
  // إشعاراً داخل شاشة الطابور فقط (يعمل حين تكون مفتوحة). هنا شارةٌ عالميّة على /work-orders
  // و/delivery تظهر عدد الطلبات الجاهزة بصرف النظر عن أيّ شاشة يفتحها الموظف.
  //
  // Codex P2 (٢٩/٨) — الاستعلامان محكومان بأذونات الوحدة لا بقائمة أدوارٍ ثابتة:
  //  - workorders:READ للـ workOrders.counts
  //  - store:READ لـ readyForDispatchCount
  // بلا هذا: محاسبٌ قالبه `workorders:NONE` يُصدر FORBIDDEN متكرّراً رغم إخفاء الرابط.
  //
  // Codex P1 (٢٩/٨) — للـsupervisors (workorders:FULL): تمرير `branchQueue: true` كي يُلغى
  // `scopedOwnerId` ⇒ الشارة تعدّ طابور الفرع كاملاً (الأمر الجاهز الذي أنشأه زميل يظهر أيضاً،
  // وهو سيناريو تسليم الوردية الذي صُمّمت له الشارة أصلاً).
  const roleForGate = me.data?.role ?? "";
  const overrideForGate = (me.data?.permissionsOverride ?? null) as
    | import("@shared/permissions").PermissionMap
    | null;
  const canReadWorkOrders = !coldStudio && Boolean(me.data)
    && hasModuleAccess(roleForGate, overrideForGate, "workorders", "READ");
  const canReadDelivery = !coldStudio && Boolean(me.data)
    && hasModuleAccess(roleForGate, overrideForGate, "store", "READ");
  const canBranchQueueWorkOrders = canReadWorkOrders
    && hasModuleAccess(roleForGate, overrideForGate, "workorders", "FULL");
  const woCounts = trpc.workOrders.counts.useQuery(
    canBranchQueueWorkOrders ? { branchQueue: true } : {},
    {
      enabled: canReadWorkOrders,
      refetchInterval: 20_000,
      refetchOnWindowFocus: true,
    },
  );
  // Codex P2 (٢٩/٨) — نستهلك عدّاداً خفيفاً بدل الصفوف الكاملة (شارة تحتاج `.length` فقط).
  const deliveryReadyCountQ = trpc.delivery.readyForDispatchCount.useQuery(undefined, {
    enabled: canReadDelivery,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const workOrderReadyCount = woCounts.data?.ready ?? 0;
  const deliveryReadyCount = deliveryReadyCountQ.data ?? 0;
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
  const visibleNav = coldStudio || !me.data
    ? []
    : isCourier
    ? NAV_LINKS.filter((m) => m.roles?.includes("courier"))
    : isCashier
      ? NAV_LINKS.filter((m) => CASHIER_NAV.includes(m.href) && canSeeGate(m, role, permsOverride))
      : NAV_LINKS.filter((m) => canSeeGate(m, role, permsOverride));
  const workspaceProfile = resolveWorkspaceProfile({
    role: role ?? null,
    permissionsOverride: permsOverride,
  });
  const primaryNav = workspaceProfile.primaryNav;
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

        {/* إذاعة القرآن الكريم — بطاقة بارزة في القائمة الجانبية */}
        <Suspense fallback={null}>
          <QuranSidebarCard />
        </Suspense>

        <Suspense fallback={<nav className="sb-scroll flex-1 overflow-y-auto py-2" aria-label="جار تحميل التنقل" />}>
          <HybridSidebarNav
            currentPath={loc}
            currentSearch={search}
            showDashboard={!isCourier && !isCashier}
            hasMyStocktake={hasMyStocktake}
            primaryNav={primaryNav}
            visibleModules={visibleNav}
            workspace={navWorkspace}
            onToggleFavorite={handleFavorite}
            workOrderReadyCount={workOrderReadyCount}
            deliveryReadyCount={deliveryReadyCount}
          />
        </Suspense>

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
          <div className="flex items-center gap-1">
            <NotificationBell enabled={!coldStudio && Boolean(me.data)} identity={String(me.data?.id ?? "")} />
            <PrinterStatusButton printerReady={printer.printerReady} connect={printer.connect} supported={printer.supported} />
            <DisplayScaleControl />
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
          <div className="flex items-center gap-1">
            {!coldStudio && <QuranHeaderButton />}
            <NotificationBell enabled={!coldStudio && Boolean(me.data)} identity={String(me.data?.id ?? "")} />
            <PrinterStatusButton printerReady={printer.printerReady} connect={printer.connect} supported={printer.supported} />
            <DisplayScaleControl />
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

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <BroadcastTicker />
        <div className="px-3 pt-3 md:px-6 md:pt-4 empty:hidden">
          <PushNotificationPrompt />
        </div>
        <main ref={mainRef} tabIndex={-1} className="app-main flex-1 p-3 md:p-6 pb-24 lg:pb-6 overflow-auto outline-none">{children}</main>
      </div>

      {/* شريط التنقل السريع للهاتف أسفل الشاشة (<lg) */}
      {shellCapabilities.mountMobileBottomNav && (
        <MobileBottomNav
          role={role}
          permsOverride={permsOverride}
          onOpenMenu={() => setNavOpen(true)}
          // Codex P2 (٢٩/٨) — الشارات على الجوال أيضاً: القائمة الجانبية مخفيّة أقلَّ من lg،
          // فبلا هذا لا يرى موظّفو الاستقبال على الهاتف/التابلت أيَّ إعلانٍ للجاهز.
          workOrderReadyCount={workOrderReadyCount}
          deliveryReadyCount={deliveryReadyCount}
        />
      )}
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppLayoutInner>{children}</AppLayoutInner>;
}

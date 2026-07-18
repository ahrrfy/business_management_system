import { Suspense, useEffect, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ShoppingCart, Printer, Palette, Lock, Home } from "lucide-react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { levelSatisfies, type PermissionMap, type RoleKey } from "@shared/permissions";

/**
 * نقطة البيع المُوحَّدة — Shell واحد لـ٣ أوضاع: تجزئة / خدمات طباعة / استقبال.
 *
 * المرحلة الأولى من شريحة pos-unification (٢٣/٦/٢٦):
 * - URL واحد `/pos` + ?mode=RETAIL|PRINT_SERVICES|RECEPTION
 * - Tab bar علوي مَوحَّد للتَبديل (Ctrl+1/2/3 اختصارات)
 * - بَند تَنقّل واحد بدل ثلاثة في AppLayout
 * - إعادة توجيه المسارات القديمة `/print-pos` و`/work-orders/reception`
 * - الصفحات الداخلية (POS/PrintPOS/Reception) تَبقى كَما هي ⇒ صفر مَخاطر تَراجع وظيفي
 *
 * المرحلة الثانية (شريحة لاحقة): استخراج المكوّنات المُشتركة (SmartSearch، CartTable، NumPad،
 * PaymentPanel، ShiftBadge، CustomerPicker، PrinterStatus) ودَمج المنطق الداخلي ⇒ تَقليص الكود
 * بـ~٤٠٪. تُؤجَّل احتراماً لـDoD «شَريحة واحدة كاملة ١٠٠٪».
 *
 * إصلاحات Codex (٢٤/٦/٢٦):
 * - P1: استعمال useSearch() من wouter بَدل قراءة window.location.search عبر useMemo
 *   (useLocation يَعيد pathname فقط ⇒ التَبديل كان لا يُعيد تَقييم activeMode).
 * - P2: حارس دور لـRECEPTION (= الدور القَديم على /work-orders/reception) — إخفاء الـtab
 *   وعَرض Forbidden للوصول المُباشر بـURL.
 * - P3: lazyWithRetry بَدل React.lazy لتَجاوز فَشل تَحميل chunks بعد النَشر (نَمط App.tsx).
 */

type Mode = "RETAIL" | "PRINT_SERVICES" | "RECEPTION";

// lazyWithRetry: حارس chunks مُسَتَهلَكة بعد النَشر (تَطابق نَمط App.tsx الذي يَفعل
// `import { lazyWithRetry as lazy }`).
const POS = lazyWithRetry(() => import("@/pages/POS"));
const PrintPOS = lazyWithRetry(() => import("@/pages/PrintPOS"));
const Reception = lazyWithRetry(() => import("@/pages/Reception"));

const MODES: { v: Mode; label: string; subtitle: string; Icon: typeof ShoppingCart; activeCls: string; roles?: RoleKey[] }[] = [
  {
    v: "RETAIL",
    label: "تجزئة",
    subtitle: "كاشير القرطاسية والمبيعات",
    Icon: ShoppingCart,
    activeCls: "border-emerald-500 bg-emerald-50 text-emerald-700",
  },
  {
    v: "PRINT_SERVICES",
    label: "خدمات طباعة",
    subtitle: "نسخ • تجليد • طباعة فورية",
    Icon: Printer,
    activeCls: "border-[var(--sem-info)] bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
  },
  {
    v: "RECEPTION",
    label: "استقبال أوامر شغل",
    subtitle: "تصميم • أمر شغل • قنوات",
    Icon: Palette,
    activeCls: "border-violet-500 bg-violet-50 text-violet-700",
    // حارس دور P2 — كان على /work-orders/reception كَـRequireRole في App.tsx السابق.
    roles: ["admin", "manager", "cashier"],
  },
];

function readMode(searchString: string): Mode {
  const m = new URLSearchParams(searchString).get("mode");
  if (m === "PRINT_SERVICES" || m === "RECEPTION" || m === "RETAIL") return m;
  return "RETAIL";
}

// ٦/٧: admin يمرّ دائماً، والمنح الصريح لوحدة «خدمة العملاء» (workorders=FULL عبر مصفوفة
// الصلاحيات/دور مخصّص) يفتح وضع الاستقبال أيضاً — مرآة بوّابة الخادم workordersCashierProcedure.
function canSee(
  roles: RoleKey[] | undefined,
  current: RoleKey | undefined,
  override?: PermissionMap | null
): boolean {
  if (!roles) return true;
  if (!current) return false;
  if (current === "admin") return true;
  if (roles.includes(current)) return true;
  return levelSatisfies(override?.workorders, "FULL");
}

export default function PointOfSale() {
  const [, navigate] = useLocation();
  // P1 fix (٢٤/٦/٢٦): useSearch تُعيد query string مُتفاعلاً (يَتغيّر مع كل تَنقّل بـquery
  // مُختلف). useLocation وَحدها تُعيد pathname فقط ⇒ التَبديل بَين الأوضاع لم يكن يُعيد
  // تَقييم activeMode، فيَبقى RETAIL مَركَّباً والـtabs «تَعمل بَصرياً» بلا تَأثير.
  const search = useSearch();
  const activeMode = useMemo(() => readMode(search), [search]);

  const me = trpc.auth.me.useQuery();
  const myRole = me.data?.role as RoleKey | undefined;
  const myPerms = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  // P1 (ورشة عَدائية ٢٤/٦/٢٦): لا نَحسب visibleModes/accessDenied قبل اِكتمال me ⇒ سَنَّتظر
  // الدور قبل عَرض الـtabs/المحتوى. يَحلّ ٤ مَشاكل: وَميض tab RECEPTION، وَميض Forbidden عند
  // الوصول المُباشر بـURL لـadmin، وحدّة canSee الدلالية، ودَور مُخصَّص يَتأخّر في الوصول.
  const meLoading = me.isLoading;

  const visibleModes = useMemo(
    () => (meLoading ? [] : MODES.filter((m) => canSee(m.roles, myRole, myPerms))),
    [meLoading, myRole, myPerms],
  );
  const activeModeMeta = MODES.find((m) => m.v === activeMode);
  const accessDenied = !meLoading && activeModeMeta != null && !canSee(activeModeMeta.roles, myRole, myPerms);

  function setMode(next: Mode) {
    if (next === activeMode) return;
    if (meLoading) return; // لا تَبديل قَبل اِكتمال الدور.
    const meta = MODES.find((m) => m.v === next);
    if (!canSee(meta?.roles, myRole, myPerms)) return;
    const url = next === "RETAIL" ? "/pos" : `/pos?mode=${next}`;
    navigate(url, { replace: true });
  }

  // اختصارات الـtab (Ctrl+1/2/3) — تَحترم حارس الدور وحالة التَحميل.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (meLoading) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      // لا تَلتقط الاختصار أثناء كَتابة الكاشير في حقل بحث الـPOS الداخلي.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const idx = e.key === "1" ? 0 : e.key === "2" ? 1 : e.key === "3" ? 2 : -1;
      if (idx < 0) return;
      const target = MODES[idx];
      if (!canSee(target.roles, myRole)) return;
      e.preventDefault();
      setMode(target.v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode, myRole, meLoading]);

  // P2 edge (ورشة): إن هَبَط دور المستخدم لحظياً (auth.me refetch) وأَصبح الوَضع الحالي مَمنوعاً،
  // أعِد توجيهه تِلقائياً لـRETAIL (الوَضع الآمن للجَميع) بَدل تَركه على Forbidden صَامتاً.
  useEffect(() => {
    if (accessDenied && activeMode !== "RETAIL") {
      navigate("/pos", { replace: true });
    }
  }, [accessDenied, activeMode, navigate]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background" dir="rtl">
      {/* شريط الأوضاع — مَوحَّد عبر الأوضاع الثلاثة */}
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b bg-card px-3">
        <div className="flex items-center gap-1.5" role="tablist" aria-label="أوضاع نقطة البيع">
          {visibleModes.map((m) => {
            const active = m.v === activeMode;
            return (
              <button
                key={m.v}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(m.v)}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-lg border-2 px-3 text-sm font-bold transition-all",
                  active ? m.activeCls : "border-transparent bg-muted/40 hover:bg-muted",
                )}
                title={`${m.label} — ${m.subtitle}`}
              >
                <m.Icon aria-hidden className="size-4" />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
        <div className="ms-auto flex items-center gap-3">
          <span className="hidden text-[11px] text-muted-foreground sm:block">
            Ctrl+1/2/3 لتَبديل الوَضع
          </span>
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-muted/40 px-3 text-sm font-bold text-foreground transition-colors hover:bg-muted"
            title="العودة إلى الرئيسية"
          >
            <Home aria-hidden className="size-4" />
            <span>الرئيسية</span>
          </Link>
        </div>
      </div>

      {/* محتوى الوَضع النشط — h-0 + flex-1 لمَنع تَجاوز height */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {meLoading ? (
          <div className="grid h-full place-items-center text-muted-foreground">
            جارٍ التحقّق من الصلاحيات…
          </div>
        ) : accessDenied ? (
          <Forbidden mode={activeMode} />
        ) : (
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-muted-foreground">
                جارٍ تحميل وَضع {activeModeMeta?.label}…
              </div>
            }
          >
            {activeMode === "RETAIL" && <POS />}
            {activeMode === "PRINT_SERVICES" && <PrintPOS />}
            {activeMode === "RECEPTION" && <Reception />}
          </Suspense>
        )}
      </div>
    </div>
  );
}

function Forbidden({ mode }: { mode: Mode }) {
  const meta = MODES.find((m) => m.v === mode);
  return (
    <div className="grid h-full place-items-center px-4">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Lock aria-hidden className="size-16 text-muted-foreground" />
        <h1 className="text-xl font-semibold">لا تَملك صلاحية للوصول إلى وَضع «{meta?.label}»</h1>
        <p className="text-sm text-muted-foreground">
          هذا الوَضع مَخصّص لأدوار: {meta?.roles?.map((r) => `«${r}»`).join("، ")}. تَواصل مع مدير النظام لمَنحك الصلاحية.
        </p>
        <Link href="/pos" className="mt-2 text-sm text-primary hover:underline">
          عُد إلى وَضع «تجزئة»
        </Link>
      </div>
    </div>
  );
}

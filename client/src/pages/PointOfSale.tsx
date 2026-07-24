import { Suspense, useEffect, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ShoppingCart, Printer, Palette, Lock, Home } from "lucide-react";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { type PermissionMap, type RoleKey } from "@shared/permissions";
import { type Mode, canSeeMode } from "./pos/posModeGates";

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

// lazyWithRetry: حارس chunks مُسَتَهلَكة بعد النَشر (تَطابق نَمط App.tsx الذي يَفعل
// `import { lazyWithRetry as lazy }`).
const POS = lazyWithRetry(() => import("@/pages/POS"));
const PrintPOS = lazyWithRetry(() => import("@/pages/PrintPOS"));
const Reception = lazyWithRetry(() => import("@/pages/Reception"));

// عزل الصلاحيات بين الأقسام (٢٣/٧/٢٦): بوّابة كل تبويب مُعرَّفة في posModeGates (سياسةٌ نقيّة قابلة
// للاختبار) — RETAIL→sales ، PRINT_SERVICES→pos ، RECEPTION→workorders، موحَّدةٌ مع بوّابات الخادم
// عبر canSeeMode. MODES هنا للعرض فقط (تسمية/أيقونة/تنسيق).
const MODES: {
  v: Mode;
  label: string;
  subtitle: string;
  Icon: typeof ShoppingCart;
  activeCls: string;
}[] = [
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
  },
];

function readMode(searchString: string): Mode {
  const m = new URLSearchParams(searchString).get("mode");
  if (m === "PRINT_SERVICES" || m === "RECEPTION" || m === "RETAIL") return m;
  return "RETAIL";
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
    () => (meLoading ? [] : MODES.filter((m) => canSeeMode(m.v, myRole, myPerms))),
    [meLoading, myRole, myPerms],
  );
  const activeModeMeta = MODES.find((m) => m.v === activeMode);
  const accessDenied = !meLoading && activeModeMeta != null && !canSeeMode(activeModeMeta.v, myRole, myPerms);

  function setMode(next: Mode) {
    if (next === activeMode) return;
    if (meLoading) return; // لا تَبديل قَبل اِكتمال الدور.
    const meta = MODES.find((m) => m.v === next);
    if (!meta || !canSeeMode(meta.v, myRole, myPerms)) return;
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
      if (!canSeeMode(target.v, myRole, myPerms)) return;
      e.preventDefault();
      setMode(target.v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode, myRole, myPerms, meLoading]);

  // إن كان الوَضع الحالي مَمنوعاً (وصولٌ مُباشر بـURL لقسمٍ لا يملكه، أو هبوط دورٍ لحظيّ) ⇒ أعِد
  // توجيهه تِلقائياً لأوّل قسمٍ مسموحٍ له (لا لـRETAIL المُثبَّت — كاشير الطباعة لا يراه بعد الفصل).
  // إن لم يملك أيّ قسم ⇒ يَبقى على شاشة Forbidden (لا توجيه).
  useEffect(() => {
    if (meLoading || !accessDenied || visibleModes.length === 0) return;
    const first = visibleModes[0];
    navigate(first.v === "RETAIL" ? "/pos" : `/pos?mode=${first.v}`, { replace: true });
  }, [meLoading, accessDenied, visibleModes, navigate]);

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
          {/* صدق الهوية: صاحب الدور المخصّص المحصور بقسمٍ (مثل «كاشير طباعة») يرى لماذا
              يظهر له قسم واحد — كان يظهر تبويب وحيد بلا تفسير فيبدو النظام «غير منطقي».
              والتخصيص الفرديّ (permissionsOverride بلا دور مخصّص) يُعلَن كذلك — نفس الفجوة بطريق ثانٍ. */}
          {me.data?.customRoleLabel ? (
            <span className="hidden text-[11px] font-medium text-muted-foreground sm:block">
              الدور: {me.data.customRoleLabel}
            </span>
          ) : me.data && Object.keys((me.data.permissionsOverride as Record<string, string> | null) ?? {}).length > 0 ? (
            <span className="hidden text-[11px] font-medium text-muted-foreground sm:block">
              صلاحيات مخصّصة
            </span>
          ) : null}
          {visibleModes.length > 1 && (
            <span className="hidden text-[11px] text-muted-foreground sm:block">
              Ctrl+1/2/3 لتَبديل الوَضع
            </span>
          )}
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
          هذا الوَضع مَخصّص للمُصرَّح لهم بوحدة الصلاحيات المرتبطة به. تَواصل مع مدير النظام لمَنحك الصلاحية.
        </p>
        <Link href="/" className="mt-2 text-sm text-primary hover:underline">
          العودة إلى الرئيسية
        </Link>
      </div>
    </div>
  );
}

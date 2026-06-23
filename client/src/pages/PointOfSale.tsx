import { lazy, Suspense, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { ShoppingCart, Printer, Palette } from "lucide-react";
import { cn } from "@/lib/utils";

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
 * ملاحظة layout: PointOfSale يُركَّب خارج AppLayout (نَفس /pos القديم) ⇒ يَأخذ كامل الشاشة (100vh)،
 * يَحجز ٤٨px للـtab bar، ويُمَرّر الباقي للصفحة الداخلية. الصفحات الداخلية عُدّلت لاستعمال h:100%
 * بَدل h:100vh لئلا تَتجاوز حدّها.
 */

type Mode = "RETAIL" | "PRINT_SERVICES" | "RECEPTION";

const POS = lazy(() => import("@/pages/POS"));
const PrintPOS = lazy(() => import("@/pages/PrintPOS"));
const Reception = lazy(() => import("@/pages/Reception"));

const MODES: { v: Mode; label: string; subtitle: string; Icon: typeof ShoppingCart; activeCls: string }[] = [
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
    activeCls: "border-sky-500 bg-sky-50 text-sky-700",
  },
  {
    v: "RECEPTION",
    label: "استقبال أوامر شغل",
    subtitle: "تصميم • أمر شغل • قنوات",
    Icon: Palette,
    activeCls: "border-violet-500 bg-violet-50 text-violet-700",
  },
];

function readMode(): Mode {
  if (typeof window === "undefined") return "RETAIL";
  const m = new URLSearchParams(window.location.search).get("mode");
  if (m === "PRINT_SERVICES" || m === "RECEPTION" || m === "RETAIL") return m;
  return "RETAIL";
}

export default function PointOfSale() {
  const [location, navigate] = useLocation();
  // wouter لا يَكشف query string عبر useLocation — نَقرأها مع كل تَنقّل من window.location.
  const activeMode = useMemo(() => readMode(), [location]);

  function setMode(next: Mode) {
    if (next === activeMode) return;
    const url = next === "RETAIL" ? "/pos" : `/pos?mode=${next}`;
    navigate(url, { replace: true });
  }

  // اختصارات الـtab (Ctrl+1/2/3) — لا تَتعارض مع F2/F4/F9 داخل الصفحات.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "1") {
        e.preventDefault();
        setMode("RETAIL");
      } else if (e.key === "2") {
        e.preventDefault();
        setMode("PRINT_SERVICES");
      } else if (e.key === "3") {
        e.preventDefault();
        setMode("RECEPTION");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background" dir="rtl">
      {/* شريط الأوضاع — مَوحَّد عبر الأوضاع الثلاثة */}
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b bg-card px-3">
        <div className="flex items-center gap-1.5" role="tablist" aria-label="أوضاع نقطة البيع">
          {MODES.map((m) => {
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
        <div className="ms-auto hidden text-[11px] text-muted-foreground sm:block">
          Ctrl+1 تجزئة · Ctrl+2 طباعة · Ctrl+3 استقبال
        </div>
      </div>

      {/* محتوى الوَضع النشط — h-0 + flex-1 لمَنع تَجاوز height */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center text-muted-foreground">
              جارٍ تحميل وَضع {MODES.find((m) => m.v === activeMode)?.label}…
            </div>
          }
        >
          {activeMode === "RETAIL" && <POS />}
          {activeMode === "PRINT_SERVICES" && <PrintPOS />}
          {activeMode === "RECEPTION" && <Reception />}
        </Suspense>
      </div>
    </div>
  );
}

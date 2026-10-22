// PageTabs — شريط تبويبات ثانوية أعلى صفحة الوحدة (hub)، مَربوط بـ ?tab= في الـURL.
//
// لماذا ?tab= لا state داخلي: روابط قابلة للمشاركة (deep-link) + زرّ رجوع المتصفّح يعمل
// لكل تبويب — على نمط ?mode= المُثبَت في PointOfSale.tsx. كل تبويب يَعرض صفحة كاملة قائمة
// عبر lazy + Suspense (Radix يُركّب التبويب النشط فقط ⇒ لا تَحميل للصفحات غير المرئية).
//
// التصميم: أزرار تبويب مُحدَّدة بأوتلاين (segmented) — RTL (تبدأ يميناً)، حالة نشطة بارزة
// (تعبئة primary + ظلّ)، وتأثيرات hover/focus/press ناعمة. نستعمل بدائل Radix مباشرةً
// (لا غلاف shadcn الافتراضي الباهت) لتحكّم كامل بالستايل مع إبقاء الإتاحة (tablist/tab/
// tabpanel + تنقّل لوحة المفاتيح بالأسهم، dir=rtl يَعكس اتّجاه الأسهم صحيحاً).
//
// العنوان: الـ hub لا يَرسم h1 خاصّاً به — كل صفحة مُضمَّنة تَحتفظ بـ PageHeader خاصّها،
// فلا ازدواج عناوين (شريط تبويبات + PageHeader واحد).
import React, { Suspense, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import type { OperationPolicy } from "@shared/operationPermissions";

export type HubTab = {
  /** معرّف التبويب (قيمة ?tab=). */
  value: string;
  /** نصّ التبويب الظاهر. */
  label: string;
  /** قيد دور اختياري (يُخفي التبويب لغير المسموح). */
  gate?: RoleGate;
  /** الصفحة المُضمَّنة (lazy) — تُحمَّل عند تنشيط التبويب فقط. */
  Component: React.ComponentType;
};

function TabFallback() {
  return (
    <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>
  );
}

// ستايل زرّ التبويب: أوتلاين + تعبئة عند التنشيط + تأثيرات. ارتفاع ٣٢px مدمج لسطح المكتب.
const tabClass = cn(
  "inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg border px-3",
  "text-xs font-bold whitespace-nowrap outline-none transition-all duration-150 ease-out",
  // الحالة الافتراضية — زرّ مُحدَّد هادئ
  "border-border bg-card text-muted-foreground shadow-2xs",
  // hover — يُبرز الحدّ ويرفع التباين
  "hover:border-primary/40 hover:bg-accent hover:text-foreground",
  // تركيز لوحة المفاتيح — حلقة واضحة
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  // ضغط — انكماش طفيف
  "active:scale-[0.97]",
  // نشط — تعبئة primary بارزة + حدّ مُطابق + ظلّ
  "data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-xs data-[state=active]:hover:bg-primary",
);

export function PageTabs({
  tabs,
  ariaLabel,
  header,
  actions,
  tabAliases,
}: {
  tabs: HubTab[];
  ariaLabel?: string;
  /** عنوان أو أيقونة الوحدة في بداية شريط التبويبات الموحّد (اختياري). */
  header?: React.ReactNode;
  /** إجراءات على مستوى الوحدة كلّها (تظهر بمحاذاة شريط التبويبات، خارج tablist حفاظاً على الإتاحة). */
  actions?: React.ReactNode;
  /** Nested tab deep links activate their visible parent without rewriting the URL. */
  tabAliases?: Readonly<Record<string, string>>;
}) {
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.isOwner ? "admin" : me.data?.role;
  const permsOverride = (me.data?.isOwner ? null : me.data?.permissionsOverride ?? null) as
    | import("@shared/permissions").PermissionMap
    | null;

  // تصفية حسب الدور + المنح الصريح — الإنفاذ الحقيقي خادمي؛ هذا إخفاء بصري + سقوط آمن للتبويب الأوّل.
  const operationPolicy = !me.data?.isOwner && (me.data as { operationPolicyEnabled?: boolean })
    ?.operationPolicyEnabled
    ? (me.data as { resolvedOperationPolicy?: OperationPolicy })
        .resolvedOperationPolicy
    : null;
  const visible = tabs.filter((t) =>
    canSeeGate(t.gate, role, permsOverride, operationPolicy),
  );
  const requested = new URLSearchParams(search).get("tab");
  const active = visible.find((t) => t.value === requested)
    ?? (requested ? visible.find((t) => t.value === tabAliases?.[requested]) : undefined)
    ?? visible[0];
  const activeTriggerRef = useRef<HTMLButtonElement>(null);

  // On narrow screens the tabs stay on one scrollable row. Deep links can open
  // a tab that starts outside the visible portion, so keep the active trigger
  // fully in view without changing the page's vertical position.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      activeTriggerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active?.value]);

  /*
   * ⚠️ **بعد الخطّافات** (٢/٩/٢٦): كان هذا الحارس فوق `useRef` و`useEffect`. و`visible`
   * يُشتقّ من `me.data.role` الذي يصل **بعد** أوّل تصيير: فالتصييرُ الأوّل بلا دورٍ قد
   * يُفرغ التبويبات فيخرج المكوّن مبكّراً بخطّافَين أقلّ، ثمّ يصل الدور فيُصيَّران —
   * وReact يسقط على اختلاف العدد. أمسكه `react-hooks/rules-of-hooks`.
   * ولذلك صار `active` قد يكون `undefined` هنا: الخطّافات تُنفَّذ قبل التأكّد من وجوده.
   */
  if (visible.length === 0) return null; // دور محدود جداً — لا تبويبات (نادر).

  function selectTab(value: string) {
    if (value === active.value) return;
    // التبويب الافتراضي (الأوّل المرئي) ⇒ URL نظيف بلا ?tab ؛ غيره ⇒ ?tab=value.
    // push (لا replace) ⇒ زرّ الرجوع يَتنقّل بين التبويبات.
    const isDefault = value === visible[0].value;
    navigate(isDefault ? loc : `${loc}?tab=${value}`);
  }

  return (
    <TabsPrimitive.Root value={active.value} onValueChange={selectTab} dir="rtl" className="min-w-0 max-w-full space-y-2.5 overflow-x-hidden">
      {/* شريط الأزرار — RTL يَبدأ يميناً؛ تمرير أفقي على الشاشات الضيّقة بلا كسر.
          الإجراءات (إن وُجدت) خارج tablist: role=tablist لا يَصحّ أن يَحوي غير tabs. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-card px-2.5 py-1.5 shadow-2xs">
        {header && (
          <>
            <div className="flex shrink-0 items-center gap-2">{header}</div>
            <div className="hidden h-5 w-px bg-border sm:block" aria-hidden />
          </>
        )}
        <TabsPrimitive.List
          aria-label={ariaLabel}
          className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto scroll-px-1 [scrollbar-width:none] md:flex-wrap md:overflow-x-visible [&::-webkit-scrollbar]:hidden"
        >
          {visible.map((t) => (
            <TabsPrimitive.Trigger
              key={t.value}
              ref={t.value === active.value ? activeTriggerRef : undefined}
              value={t.value}
              className={tabClass}
            >
              {t.label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        {actions && <div className="shrink-0 ms-auto flex items-center gap-1.5">{actions}</div>}
      </div>
      {visible.map((t) => {
        const Active = t.Component;
        return (
          <TabsPrimitive.Content key={t.value} value={t.value} className="outline-none">
            <Suspense fallback={<TabFallback />}>
              <Active />
            </Suspense>
          </TabsPrimitive.Content>
        );
      })}
    </TabsPrimitive.Root>
  );
}

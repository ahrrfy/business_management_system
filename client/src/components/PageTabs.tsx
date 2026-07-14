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
import { Suspense } from "react";
import { useLocation, useSearch } from "wouter";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";

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
  return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
}

// ستايل زرّ التبويب: أوتلاين + تعبئة عند التنشيط + تأثيرات. ارتفاع ٤٤px (هدف اللمس).
const tabClass = cn(
  "inline-flex h-11 shrink-0 cursor-pointer select-none items-center gap-2 rounded-xl border px-4",
  "text-sm font-semibold whitespace-nowrap outline-none transition-all duration-200 ease-out",
  // الحالة الافتراضية — زرّ مُحدَّد هادئ
  "border-border bg-card text-muted-foreground shadow-xs",
  // hover — يُبرز الحدّ ويرفع التباين
  "hover:border-primary/40 hover:bg-accent hover:text-foreground",
  // تركيز لوحة المفاتيح — حلقة واضحة
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  // ضغط — انكماش طفيف
  "active:scale-[0.97]",
  // نشط — تعبئة primary بارزة + حدّ مُطابق + ظلّ
  "data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm data-[state=active]:hover:bg-primary",
);

export function PageTabs({
  tabs,
  ariaLabel,
  actions,
}: {
  tabs: HubTab[];
  ariaLabel?: string;
  /** إجراءات على مستوى الوحدة كلّها (تظهر بمحاذاة شريط التبويبات، خارج tablist حفاظاً على الإتاحة). */
  actions?: React.ReactNode;
}) {
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const permsOverride = (me.data?.permissionsOverride ?? null) as
    | import("@shared/permissions").PermissionMap
    | null;

  // تصفية حسب الدور + المنح الصريح — الإنفاذ الحقيقي خادمي؛ هذا إخفاء بصري + سقوط آمن للتبويب الأوّل.
  const visible = tabs.filter((t) => canSeeGate(t.gate, role, permsOverride));
  if (visible.length === 0) return null; // دور محدود جداً — لا تبويبات (نادر).

  const requested = new URLSearchParams(search).get("tab");
  const active = visible.find((t) => t.value === requested) ?? visible[0];

  function selectTab(value: string) {
    if (value === active.value) return;
    // التبويب الافتراضي (الأوّل المرئي) ⇒ URL نظيف بلا ?tab ؛ غيره ⇒ ?tab=value.
    // push (لا replace) ⇒ زرّ الرجوع يَتنقّل بين التبويبات.
    const isDefault = value === visible[0].value;
    navigate(isDefault ? loc : `${loc}?tab=${value}`);
  }

  return (
    <TabsPrimitive.Root value={active.value} onValueChange={selectTab} dir="rtl" className="space-y-4">
      {/* شريط الأزرار — RTL يَبدأ يميناً؛ تمرير أفقي على الشاشات الضيّقة (٧ تبويبات) بلا كسر.
          الإجراءات (إن وُجدت) خارج tablist: role=tablist لا يَصحّ أن يَحوي غير tabs. */}
      <div className="flex items-center gap-3">
        <TabsPrimitive.List
          aria-label={ariaLabel}
          className="flex flex-1 items-center gap-2 overflow-x-auto pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {visible.map((t) => (
            <TabsPrimitive.Trigger key={t.value} value={t.value} className={tabClass}>
              {t.label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        {actions && <div className="shrink-0">{actions}</div>}
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

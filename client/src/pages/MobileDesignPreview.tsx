import { useState } from "react";
import {
  ArrowRight,
  Bell,
  Boxes,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  ChevronLeft,
  CircleDollarSign,
  ClipboardList,
  Cloud,
  Factory,
  FileText,
  LayoutDashboard,
  Menu,
  Package,
  Plus,
  Receipt,
  ScanLine,
  Search,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Store,
  Truck,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";

type View = "home" | "work" | "sales" | "activity" | "profile";
type Device = "phone" | "tablet";
type UserRole = "manager" | "sales" | "warehouse";

const roleDetails: Record<UserRole, { label: string; focus: string }> = {
  manager: { label: "وضع مدير الفرع", focus: "الموافقات ومؤشرات اليوم" },
  sales: { label: "وضع موظف المبيعات", focus: "البيع والتحصيل السريع" },
  warehouse: { label: "وضع أمين المخزن", focus: "الجرد والتوريد" },
};

const roleDashboard: Record<
  UserRole,
  {
    title: string;
    value: string;
    unit: string;
    progress: string;
    footer: string;
    moduleIndexes: number[];
  }
> = {
  manager: {
    title: "مبيعات اليوم",
    value: "1,850,000",
    unit: "د.ع",
    progress: "68%",
    footer: "38 فاتورة مكتملة · ↑ 12% عن الأمس",
    moduleIndexes: [0, 1, 2, 3],
  },
  sales: {
    title: "تحصيل ورديتك",
    value: "685,000",
    unit: "د.ع",
    progress: "54%",
    footer: "14 فاتورة مكتملة · 3 بانتظار الدفع",
    moduleIndexes: [0, 1, 2, 5],
  },
  warehouse: {
    title: "جاهزية المخزون",
    value: "92",
    unit: "%",
    progress: "92%",
    footer: "7 أصناف تحتاج توريد · استلام واحد اليوم",
    moduleIndexes: [3, 4, 8, 6],
  },
};

const modules = [
  {
    label: "نقطة البيع",
    icon: ShoppingCart,
    tone: "bg-emerald-700",
    view: "sales" as const,
  },
  {
    label: "الماسح",
    icon: ScanLine,
    tone: "bg-teal-700",
    view: "work" as const,
  },
  {
    label: "المبيعات",
    icon: Receipt,
    tone: "bg-orange-600",
    view: "sales" as const,
  },
  {
    label: "المخزون",
    icon: Boxes,
    tone: "bg-slate-700",
    view: "work" as const,
  },
  {
    label: "المشتريات",
    icon: Package,
    tone: "bg-amber-700",
    view: "work" as const,
  },
  { label: "العملاء", icon: Users, tone: "bg-cyan-700", view: "work" as const },
  {
    label: "الطباعة والإنتاج",
    icon: Factory,
    tone: "bg-violet-700",
    view: "work" as const,
  },
  {
    label: "الخزينة",
    icon: Wallet,
    tone: "bg-lime-700",
    view: "work" as const,
  },
  { label: "التوصيل", icon: Truck, tone: "bg-blue-700", view: "work" as const },
  { label: "المتجر", icon: Store, tone: "bg-rose-700", view: "work" as const },
  {
    label: "الموارد البشرية",
    icon: BriefcaseBusiness,
    tone: "bg-indigo-700",
    view: "work" as const,
  },
  {
    label: "التقارير",
    icon: FileText,
    tone: "bg-stone-700",
    view: "work" as const,
  },
];

const workspaceModuleIndexes: Record<UserRole, number[]> = {
  manager: modules.map((_, index) => index),
  sales: [0, 1, 2, 5, 7, 9, 11],
  warehouse: [1, 3, 4, 6, 8, 11],
};

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative grid size-10 place-items-center overflow-hidden rounded-[15px] bg-gradient-to-br from-[#1aa98b] via-[#0f8068] to-[#075342] text-lg font-semibold text-white shadow-[0_10px_20px_rgb(15_128_104_/_25%)] before:absolute before:-right-3 before:-top-3 before:size-7 before:rounded-full before:bg-white/20">
        ر
      </span>
      {!compact && (
        <span className="text-[15px] font-bold tracking-tight text-[#153d33]">
          الرؤية العربية
        </span>
      )}
    </div>
  );
}

function Metric({
  title,
  value,
  note,
  icon: Icon,
}: {
  title: string;
  value: string;
  note: string;
  icon: typeof Wallet;
}) {
  return (
    <article className="group relative overflow-hidden rounded-2xl border border-white/80 bg-white/80 p-3.5 shadow-[0_9px_24px_rgb(24_66_55_/_7%)] backdrop-blur-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_15px_28px_rgb(24_66_55_/_12%)]">
      <span className="absolute -left-4 -top-4 size-14 rounded-full bg-[#d8f1e6]/60 blur-xl" />
      <div className="relative flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium text-[#58736a]">{title}</span>
        <span className="grid size-7 place-items-center rounded-xl bg-[#e5f5ee] text-[#17816a]">
          <Icon className="size-3.5" />
        </span>
      </div>
      <b
        className="mt-3 block text-[18px] font-bold tracking-tight text-[#163e34]"
        dir="ltr"
      >
        {value}
      </b>
      <span className="mt-1 block text-[10px] text-[#668179]">{note}</span>
    </article>
  );
}

function BottomNav({
  active,
  onChange,
  onQuickAction,
}: {
  active: View;
  onChange: (view: View) => void;
  onQuickAction: () => void;
}) {
  const items: Array<{
    id: View;
    label: string;
    icon: typeof LayoutDashboard;
  }> = [
    { id: "home", label: "الرئيسية", icon: LayoutDashboard },
    { id: "work", label: "العمل", icon: ClipboardList },
    { id: "activity", label: "التنبيهات", icon: Bell },
    { id: "profile", label: "حسابي", icon: UserRound },
  ];
  return (
    <nav
      className="neo-bottom-nav absolute inset-x-0 bottom-0 flex h-[76px] items-center justify-around px-5"
      aria-label="التنقل الرئيسي"
    >
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`grid min-w-14 place-items-center gap-1 text-[10px] transition-colors ${active === id ? "font-bold text-[#0d7c64]" : "text-[#7a928a]"}`}
        >
          <Icon className="size-5" aria-hidden />
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={onQuickAction}
        aria-label="إجراء سريع جديد"
        className="neo-fab"
      >
        <Plus className="size-6" />
      </button>
    </nav>
  );
}

function QuickActionSheet({
  onClose,
  onView,
  role,
}: {
  onClose: () => void;
  onView: (view: View) => void;
  role: UserRole;
}) {
  const actions = [
    {
      label: "بيع سريع",
      note: "فاتورة أو مسح صنف",
      icon: ShoppingCart,
      tone: "bg-[#0f8068]",
      view: "sales" as const,
      roles: ["manager", "sales"] as UserRole[],
    },
    {
      label: "مسح باركود",
      note: "تحقق من صنف أو سعر",
      icon: ScanLine,
      tone: "bg-[#216e80]",
      view: "work" as const,
      roles: ["manager", "sales", "warehouse"] as UserRole[],
    },
    {
      label: "استلام توريد",
      note: "تحديث المخزون",
      icon: Package,
      tone: "bg-[#c56a22]",
      view: "work" as const,
      roles: ["manager", "warehouse"] as UserRole[],
    },
    {
      label: "طلب تحويل",
      note: "بين الفروع",
      icon: Truck,
      tone: "bg-[#5b56a8]",
      view: "work" as const,
      roles: ["manager", "warehouse"] as UserRole[],
    },
  ];

  return (
    <div
      className="absolute inset-0 z-30 flex items-end bg-[#092d25]/35 p-3 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="إجراء سريع"
    >
      <section className="neo-action-sheet w-full rounded-[28px] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-[#193f35]">ابدأ عملية</h2>
            <p className="mt-0.5 text-[10px] text-[#6c837b]">
              اختصارات مصممة للعمل أثناء الوردية
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-xl bg-[#edf4f0] text-xs font-bold text-[#58736a]"
          >
            ×
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {actions
            .filter((action) => action.roles.includes(role))
            .map(({ label, note, icon: Icon, tone, view }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  onView(view);
                  onClose();
                }}
                className="neo-action-option flex items-center gap-2.5 rounded-2xl p-3 text-right transition hover:-translate-y-0.5"
              >
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-[14px] ${tone} text-white`}
                >
                  <Icon className="size-[18px]" />
                </span>
                <span>
                  <b className="block text-[11px] text-[#24483e]">{label}</b>
                  <small className="mt-0.5 block text-[9px] text-[#71877f]">
                    {note}
                  </small>
                </span>
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}

function TopBar({
  tablet = false,
  title,
  onMenu,
}: {
  tablet?: boolean;
  title?: string;
  onMenu?: () => void;
}) {
  if (tablet) {
    return (
      <header className="neo-topbar relative z-10 flex h-[72px] items-center justify-between px-5">
        <div className="flex items-center gap-2">
          <span className="neo-branch-tag rounded-full px-2.5 py-1 text-[10px] font-bold">
            فرع المنصور
          </span>
          {title && (
            <h1 className="neo-topbar-title text-base font-bold">{title}</h1>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="بحث"
            className="neo-topbar-button grid size-10 place-items-center rounded-xl transition"
          >
            <Search className="size-4" />
          </button>
          <button
            type="button"
            aria-label="التنبيهات"
            className="neo-topbar-button relative grid size-10 place-items-center rounded-xl transition"
          >
            <Bell className="size-4" />
            <span className="neo-alert-dot absolute left-2 top-2 size-1.5 rounded-full" />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="neo-topbar neo-topbar-mobile relative z-10 h-[68px]">
      <button
        type="button"
        aria-label="السحابة"
        className="neo-topbar-button neo-cloud-button absolute left-4 top-3 grid size-10 place-items-center rounded-2xl transition"
      >
        <Cloud className="size-5" />
      </button>
      <div className="neo-profile-dock absolute left-1/2 top-0 grid h-[58px] w-[76px] -translate-x-1/2 place-items-center">
        <span className="neo-profile-button grid size-10 place-items-center rounded-full text-sm font-bold">
          أ
        </span>
      </div>
      {title && (
        <h1 className="neo-topbar-title absolute right-16 top-[23px] text-sm font-bold">
          {title}
        </h1>
      )}
      <button
        type="button"
        aria-label="القائمة"
        onClick={onMenu}
        className="neo-topbar-button absolute right-4 top-3 grid size-10 place-items-center rounded-2xl transition"
      >
        <Menu className="size-5" />
      </button>
    </header>
  );
}

function HomeContent({
  tablet,
  onView,
  role,
  onNextRole,
}: {
  tablet: boolean;
  onView: (view: View) => void;
  role: UserRole;
  onNextRole: () => void;
}) {
  const roleInfo = roleDetails[role];
  const dashboard = roleDashboard[role];
  return (
    <div
      className={`neo-home relative ${tablet ? "p-6" : "p-4 pb-28"} space-y-4`}
    >
      <div className="neo-home-dark-layer" aria-hidden />
      <section className="neo-greeting relative flex items-end justify-between">
        <div>
          <span className="text-[11px] font-medium">الثلاثاء، 4 آب</span>
          <h2 className="mt-1 text-[22px] font-bold tracking-tight">
            أهلاً أحمد
          </h2>
          <button
            type="button"
            onClick={onNextRole}
            className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[10px] transition hover:bg-white/15"
          >
            <UserRound className="size-3" />
            {roleInfo.label}
            <ChevronLeft className="size-3" />
          </button>
        </div>
        <span className="neo-avatar grid size-11 place-items-center rounded-2xl text-base font-bold">
          أ
        </span>
      </section>
      <label className="neo-search relative flex h-11 items-center gap-2 rounded-2xl px-3">
        <Search className="size-4" />
        <input
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-white/55"
          placeholder="ابحث عن فاتورة، عميل، أو صنف"
        />
        <Cloud className="size-4 text-white/65" />
      </label>
      <section className="neo-hero-card relative isolate overflow-hidden rounded-[25px] p-5">
        <div className="absolute -left-10 -top-12 size-36 rounded-full border-[18px] border-white/10" />
        <div className="absolute -bottom-16 -right-10 size-44 rounded-full bg-[#b5f3d6]/25 blur-2xl animate-[hero-glow_5s_ease-in-out_infinite]" />
        <div className="absolute right-1/3 top-0 h-full w-px bg-gradient-to-b from-transparent via-white/15 to-transparent" />
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-emerald-50">
              {dashboard.title}
            </span>
            <span className="rounded-lg border border-white/15 bg-white/12 px-2 py-1 text-[10px] backdrop-blur">
              حتى الآن
            </span>
          </div>
          <b
            className="mt-3 block text-[28px] font-bold tracking-tight text-white"
            dir="ltr"
          >
            {dashboard.value}{" "}
            <small className="text-xs font-medium">{dashboard.unit}</small>
          </b>
          <div className="neo-progress mt-3 h-1.5 overflow-hidden rounded-full">
            <span
              className="block h-full rounded-full"
              style={{ width: dashboard.progress }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-white/15 pt-3 text-[11px] text-emerald-50">
            <span>38 فاتورة مكتملة</span>
            <span>↑ 12% عن الأمس</span>
          </div>
        </div>
      </section>
      <section className="neo-quick-panel relative">
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#193f35]">إجراء سريع</h3>
          <button
            type="button"
            onClick={() => onView("work")}
            className="flex items-center gap-1 text-[11px] font-bold text-[#0e7a63]"
          >
            كل الوحدات <ChevronLeft className="size-3.5" />
          </button>
        </div>
        <div
          className={`grid ${tablet ? "grid-cols-6" : "grid-cols-4"} gap-2.5`}
        >
          {dashboard.moduleIndexes
            .map((index) => modules[index])
            .slice(0, tablet ? 6 : 4)
            .map(({ label, icon: Icon, tone, view }) => (
              <button
                key={label}
                type="button"
                onClick={() => onView(view)}
                className="group text-center"
              >
                <span className="neo-shortcut mx-auto grid size-[58px] place-items-center rounded-[21px] transition duration-300 group-hover:-translate-y-1 group-hover:scale-105">
                  <span
                    className={`relative grid size-10 place-items-center overflow-hidden rounded-[15px] ${tone} text-white`}
                  >
                    <span className="absolute -right-3 -top-3 size-7 rounded-full bg-white/20" />
                    <Icon className="relative size-[18px]" />
                  </span>
                </span>
                <span className="mt-1.5 block text-[10px] font-medium leading-4 text-[#3d6055] transition group-hover:text-[#0e765f]">
                  {label}
                </span>
              </button>
            ))}
        </div>
      </section>
      <section
        className={`grid ${tablet ? "grid-cols-3" : "grid-cols-2"} gap-2.5`}
      >
        <Metric
          title="طلبات تنتظر الإجراء"
          value="12"
          note="4 طلبات متجر جديدة"
          icon={ClipboardList}
        />
        <Metric
          title="أصناف منخفضة"
          value="7"
          note="بحاجة إلى توريد"
          icon={Boxes}
        />
        {tablet && (
          <Metric
            title="التحصيل النقدي"
            value="1,210,000"
            note="ضمن الوردية الحالية"
            icon={CircleDollarSign}
          />
        )}
      </section>
      <section className="rounded-2xl border border-white bg-white/80 px-4 py-3 shadow-[0_9px_24px_rgb(24_66_55_/_6%)] backdrop-blur-sm">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#193f35]">يحتاج انتباهك</h3>
          <span className="rounded-lg bg-[#fff0e5] px-2 py-1 text-[10px] font-bold text-[#b95016] shadow-[0_4px_10px_rgb(189_91_28_/_12%)]">
            3
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-[#edf3ef] pt-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-[#fff6e8] to-[#ffe7d1] text-[#bd5b1c]">
            <Package className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <b className="block text-xs text-[#25483e]">طلب توريد #PO-284</b>
            <span className="text-[10px] text-[#71877f]">
              بانتظار اعتماد المدير
            </span>
          </div>
          <button
            type="button"
            onClick={() => onView("work")}
            className="rounded-lg bg-[#e7f4ed] px-2 py-1 text-[9px] font-bold text-[#0f745e]"
          >
            اعتماد
          </button>
        </div>
      </section>
    </div>
  );
}

function WorkContent({
  tablet,
  onView,
  role,
}: {
  tablet: boolean;
  onView: (view: View) => void;
  role: UserRole;
}) {
  const visibleModules = workspaceModuleIndexes[role].map(
    (index) => modules[index],
  );
  return (
    <div className={`${tablet ? "p-6" : "p-4 pb-24"}`}>
      <div className="mb-4">
        <span className="inline-flex rounded-full bg-[#e3f4ec] px-2.5 py-1 text-[10px] font-bold text-[#0d765f]">
          بوابة ذكية حسب الصلاحيات
        </span>
        <h2 className="mt-2 text-[21px] font-bold tracking-tight text-[#173e34]">
          مساحة العمل
        </h2>
        <p className="mt-1 text-xs text-[#647c74]">
          وحداتك المصرّح بها مرتبة حسب الاستخدام
        </p>
      </div>
      <label className="mb-4 flex h-11 items-center gap-2 rounded-xl border border-white bg-white/80 px-3 text-[#6c837b] shadow-[0_7px_18px_rgb(24_66_55_/_5%)] backdrop-blur">
        <Search className="size-4" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#849991]"
          placeholder="ابحث عن وحدة أو عملية"
        />
      </label>
      <div
        className={`grid ${tablet ? "grid-cols-3 gap-4" : "grid-cols-2 gap-3"}`}
      >
        {visibleModules.map(({ label, icon: Icon, tone, view }) => (
          <button
            type="button"
            key={label}
            onClick={() => onView(view)}
            className="group relative flex min-h-[96px] items-center gap-3 overflow-hidden rounded-2xl border border-white bg-white/80 p-3 text-right shadow-[0_8px_22px_rgb(24_66_55_/_5%)] backdrop-blur-sm transition duration-300 hover:-translate-y-1 hover:border-[#9ecfc0] hover:shadow-[0_14px_28px_rgb(24_66_55_/_12%)]"
          >
            <span className="absolute -left-5 -top-5 size-16 rounded-full bg-[#dff3eb]/65 blur-xl" />
            <span
              className={`relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-[15px] ${tone} text-white shadow-[0_8px_14px_rgb(22_64_53_/_16%)]`}
            >
              <span className="absolute -right-2 -top-2 size-5 rounded-full bg-white/25" />
              <Icon className="relative size-5" />
            </span>
            <span className="relative">
              <b className="block text-[13px] text-[#21483d]">{label}</b>
              <small className="mt-1 block text-[10px] text-[#748a82]">
                فتح الوحدة
              </small>
            </span>
            <ChevronLeft className="relative mr-auto size-4 text-[#9aacA5] transition-transform group-hover:-translate-x-1" />
          </button>
        ))}
      </div>
    </div>
  );
}

function SalesContent({ tablet }: { tablet: boolean }) {
  const invoices = [
    ["#10482", "عميل نقدي", "85,000", "مكتملة"],
    ["#10481", "مكتبة المعرفة", "240,000", "مكتملة"],
    ["#10480", "شركة الأفق", "650,000", "قيد التجهيز"],
  ];
  return (
    <div className={`${tablet ? "p-6" : "p-4 pb-24"}`}>
      <div className="flex items-start justify-between">
        <div>
          <span className="inline-flex rounded-full bg-[#fff0e5] px-2.5 py-1 text-[10px] font-bold text-[#b95319]">
            مباشر الآن
          </span>
          <h2 className="mt-2 text-[21px] font-bold tracking-tight text-[#173e34]">
            المبيعات
          </h2>
          <p className="mt-1 text-xs text-[#647c74]">فواتير وطلبات اليوم</p>
        </div>
        <button
          type="button"
          className="flex h-10 items-center gap-1.5 rounded-xl bg-gradient-to-br from-[#e28939] to-[#c7541a] px-3 text-xs font-bold text-white shadow-[0_10px_18px_rgb(210_108_35_/_26%)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_22px_rgb(210_108_35_/_33%)]"
        >
          <Plus className="size-4" />
          بيع جديد
        </button>
      </div>
      <div className="mt-4 flex gap-2 overflow-hidden">
        <button className="rounded-xl bg-[#e5f3ed] px-3 py-2 text-[11px] font-bold text-[#0d775f] shadow-[0_3px_8px_rgb(13_119_95_/_10%)]">
          اليوم
        </button>
        <button className="rounded-xl border border-white bg-white/75 px-3 py-2 text-[11px] text-[#56716a] shadow-[0_3px_8px_rgb(24_66_55_/_4%)]">
          كل الحالات
        </button>
        <button className="rounded-xl border border-white bg-white/75 px-3 py-2 text-[11px] text-[#56716a] shadow-[0_3px_8px_rgb(24_66_55_/_4%)]">
          فرع المنصور
        </button>
      </div>
      <section
        className={`mt-4 grid ${tablet ? "grid-cols-3" : "grid-cols-2"} gap-2.5`}
      >
        <Metric
          title="صافي المبيعات"
          value="1,850,000"
          note="دينار عراقي"
          icon={Receipt}
        />
        <Metric
          title="عدد الفواتير"
          value="38"
          note="متوسط 48,684 د.ع"
          icon={ShoppingBag}
        />
        {tablet && (
          <Metric
            title="طلبات مفتوحة"
            value="12"
            note="بانتظار الإجراء"
            icon={CalendarClock}
          />
        )}
      </section>
      <section className="mt-5">
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#193f35]">الفواتير الأخيرة</h3>
          <button
            type="button"
            className="text-[11px] font-bold text-[#0e7a63]"
          >
            عرض الكل
          </button>
        </div>
        <div className="space-y-2">
          {invoices.map(([id, customer, amount, status]) => (
            <article
              key={id}
              className="group flex items-center gap-3 rounded-2xl border border-white bg-white/80 p-3.5 shadow-[0_7px_18px_rgb(24_66_55_/_5%)] backdrop-blur-sm transition hover:-translate-y-0.5 hover:shadow-[0_12px_24px_rgb(24_66_55_/_10%)]"
            >
              <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-[#ebf8f1] to-[#d6f0e5] text-[#117a63]">
                <Receipt className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <b className="text-[12px] text-[#23483e]">{id}</b>
                  <span
                    className={`rounded-md px-2 py-1 text-[9px] font-bold ${status === "مكتملة" ? "bg-[#e7f4ed] text-[#0f745e]" : "bg-[#fff0e5] text-[#b95319]"}`}
                  >
                    {status}
                  </span>
                </div>
                <span className="mt-1 block text-[10px] text-[#71877f]">
                  {customer} · 3 أصناف
                </span>
              </div>
              <b className="text-[12px] text-[#1d4439]" dir="ltr">
                {amount}
                <small className="mr-1 text-[9px] font-medium">د.ع</small>
              </b>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ActivityContent({
  tablet,
  onView,
}: {
  tablet: boolean;
  onView: (view: View) => void;
}) {
  const notifications = [
    {
      title: "تم تسجيل حضورك · 08:02 ص",
      detail: "بوابة المنصور 01 · سجل الدوام",
      tone: "bg-[#e5f3ed] text-[#0f745e]",
      action: "عرض ملفي",
      view: "profile" as const,
      icon: CalendarClock,
    },
    {
      title: "طلب توريد يحتاج اعتمادك",
      detail: "PO-284 · منذ 12 دقيقة",
      tone: "bg-[#fff0e5] text-[#b95319]",
      action: "اعتماد",
      view: "work" as const,
      icon: Package,
    },
    {
      title: "فرق صندوق يحتاج مراجعة",
      detail: "وردية المساء · 15,000 د.ع",
      tone: "bg-[#fde8e7] text-[#b84842]",
      action: "مراجعة",
      view: "sales" as const,
      icon: CircleDollarSign,
    },
    {
      title: "مهمة جديدة مخصصة لك",
      detail: "متابعة عميل · قبل الساعة 7:00",
      tone: "bg-[#e5f3ed] text-[#0f745e]",
      action: "فتح المهمة",
      view: "work" as const,
      icon: ClipboardList,
    },
  ];
  return (
    <div className={`${tablet ? "p-6" : "p-4 pb-24"}`}>
      <div className="flex items-start justify-between">
        <div>
          <span className="inline-flex rounded-full bg-[#fff0e5] px-2.5 py-1 text-[10px] font-bold text-[#b95319]">
            4 تحتاج إجراء
          </span>
          <h2 className="mt-2 text-[21px] font-bold tracking-tight text-[#173e34]">
            مركز التنبيهات
          </h2>
          <p className="mt-1 text-xs text-[#647c74]">
            تنبيهاتك التشغيلية والشخصية في مكان واحد
          </p>
        </div>
        <button
          type="button"
          className="rounded-xl bg-white px-3 py-2 text-[10px] font-bold text-[#0d775f] shadow-[0_5px_12px_rgb(24_66_55_/_8%)]"
        >
          تحديد كمقروء
        </button>
      </div>
      <div className="mt-5 space-y-2.5">
        {notifications.map(
          ({ title, detail, tone, action, view, icon: Icon }) => (
            <article
              key={title}
              className="relative overflow-hidden rounded-2xl border border-white bg-white/85 p-3.5 shadow-[0_8px_20px_rgb(24_66_55_/_6%)]"
            >
              <span className="absolute -left-5 -top-5 size-16 rounded-full bg-[#dff3eb]/55 blur-xl" />
              <div className="relative flex gap-3">
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-xl ${tone}`}
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block text-[12px] text-[#24483e]">{title}</b>
                  <span className="mt-1 block text-[10px] text-[#71877f]">
                    {detail}
                  </span>
                  <button
                    type="button"
                    onClick={() => onView(view)}
                    className="mt-2 rounded-lg bg-[#e7f4ed] px-2 py-1 text-[9px] font-bold text-[#0f745e]"
                  >
                    {action}
                  </button>
                </div>
              </div>
            </article>
          ),
        )}
      </div>
    </div>
  );
}

function ProfileContent({ tablet }: { tablet: boolean }) {
  return (
    <div className={`${tablet ? "p-6" : "p-4 pb-24"}`}>
      <section className="relative overflow-hidden rounded-[24px] bg-gradient-to-br from-[#113d34] to-[#0b6755] p-4 text-white shadow-[0_14px_28px_rgb(8_66_53_/_24%)]">
        <span className="absolute -left-8 -top-10 size-28 rounded-full border-[16px] border-white/10" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-12 place-items-center rounded-2xl border border-white/15 bg-white/10 text-lg font-bold">
            أ
          </span>
          <div>
            <span className="text-[10px] text-emerald-100">ملفي الوظيفي</span>
            <h2 className="mt-1 text-lg font-bold">أحمد فرع المنصور</h2>
            <p className="text-[10px] text-emerald-100">
              موظف مبيعات · الوردية المسائية
            </p>
          </div>
        </div>
      </section>
      <section className="neo-attendance-card mt-3 overflow-hidden rounded-[22px] p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-xl bg-[#e4f4ed] text-[#0f745e]">
              <CalendarClock className="size-4" />
            </span>
            <div>
              <b className="block text-xs text-[#24483e]">دوام اليوم</b>
              <small className="text-[10px] text-[#71877f]">
                بوابة المنصور 01
              </small>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e5f3ed] px-2.5 py-1 text-[9px] font-bold text-[#0f745e]">
            <i className="size-1.5 rounded-full bg-[#16a276]" />
            نشط
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-2xl border border-[#e4eee9] bg-white/70 text-center">
          <div className="border-l border-[#e4eee9] px-2 py-2.5">
            <small className="block text-[9px] text-[#81958d]">دخول</small>
            <b className="mt-1 block text-[11px] text-[#24483e]" dir="ltr">
              08:02 ص
            </b>
          </div>
          <div className="border-l border-[#e4eee9] px-2 py-2.5">
            <small className="block text-[9px] text-[#81958d]">الآن</small>
            <b className="mt-1 block text-[11px] text-[#24483e]" dir="ltr">
              06:17 م
            </b>
          </div>
          <div className="px-2 py-2.5">
            <small className="block text-[9px] text-[#81958d]">الإجمالي</small>
            <b className="mt-1 block text-[11px] text-[#0e765f]" dir="ltr">
              10:15
            </b>
          </div>
        </div>
      </section>
      <section
        className={`mt-3 grid ${tablet ? "grid-cols-3" : "grid-cols-2"} gap-2.5`}
      >
        <Metric
          title="الراتب المتوقع"
          value="850,000"
          note="عن شهر آب"
          icon={Wallet}
        />
        <Metric
          title="إجازاتي المتبقية"
          value="8"
          note="أيام سنوية"
          icon={CalendarClock}
        />
        {tablet && (
          <Metric
            title="عمولة الشهر"
            value="120,000"
            note="قيد الاعتماد"
            icon={CircleDollarSign}
          />
        )}
      </section>
      <section className="mt-4 rounded-2xl border border-white bg-white/85 p-3.5 shadow-[0_8px_20px_rgb(24_66_55_/_6%)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#193f35]">مهامي الموكلة</h3>
          <span className="rounded-lg bg-[#fff0e5] px-2 py-1 text-[9px] font-bold text-[#b95319]">
            2 اليوم
          </span>
        </div>
        <div className="space-y-2 border-t border-[#edf3ef] pt-2.5">
          <button
            type="button"
            className="flex w-full items-center gap-3 text-right"
          >
            <span className="grid size-8 place-items-center rounded-lg bg-[#e5f3ed] text-[#0f745e]">
              <ClipboardList className="size-3.5" />
            </span>
            <span className="flex-1">
              <b className="block text-[11px] text-[#24483e]">
                متابعة عميل طلب عرض سعر
              </b>
              <small className="text-[9px] text-[#71877f]">
                ينتهي اليوم · 06:30 م
              </small>
            </span>
            <ChevronLeft className="size-4 text-[#8ba098]" />
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-3 text-right"
          >
            <span className="grid size-8 place-items-center rounded-lg bg-[#e8eefb] text-[#485c9a]">
              <Package className="size-3.5" />
            </span>
            <span className="flex-1">
              <b className="block text-[11px] text-[#24483e]">
                تأكيد استلام شحنة الفرع
              </b>
              <small className="text-[9px] text-[#71877f]">مهمة تشغيلية</small>
            </span>
            <ChevronLeft className="size-4 text-[#8ba098]" />
          </button>
        </div>
      </section>
    </div>
  );
}

function TabletRail({
  active,
  onChange,
}: {
  active: View;
  onChange: (view: View) => void;
}) {
  const links: Array<{
    id: View;
    label: string;
    icon: typeof LayoutDashboard;
  }> = [
    { id: "home", label: "الرئيسية", icon: LayoutDashboard },
    { id: "work", label: "مساحة العمل", icon: ClipboardList },
    { id: "sales", label: "المبيعات", icon: Receipt },
    { id: "activity", label: "مركز التنبيهات", icon: Bell },
    { id: "profile", label: "ملفي الوظيفي", icon: UserRound },
  ];
  return (
    <aside className="relative flex w-[190px] shrink-0 flex-col overflow-hidden border-l border-white/80 bg-white/80 p-4 backdrop-blur-xl">
      <span className="absolute -right-12 -top-12 size-36 rounded-full bg-[#ccf0df]/55 blur-3xl" />
      <div className="relative">
        <BrandMark />
      </div>
      <div className="relative mt-8 space-y-1">
        {links.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-right text-xs transition ${active === id ? "bg-gradient-to-l from-[#d9f2e7] to-[#eef9f4] font-bold text-[#0c775f] shadow-[0_5px_12px_rgb(15_128_104_/_9%)]" : "text-[#557269] hover:bg-[#f1f7f3]"}`}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="relative mt-7">
        <span className="px-3 text-[10px] font-bold text-[#92a39d]">
          وحدات سريعة
        </span>
        <button
          type="button"
          className="mt-2 flex h-10 w-full items-center gap-3 rounded-xl px-3 text-xs text-[#557269] transition hover:bg-white"
        >
          <Boxes className="size-4" />
          المخزون
        </button>
        <button
          type="button"
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-xs text-[#557269] transition hover:bg-white"
        >
          <Truck className="size-4" />
          التوصيل
        </button>
        <button
          type="button"
          className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-xs text-[#557269] transition hover:bg-white"
        >
          <Building2 className="size-4" />
          الموردون
        </button>
      </div>
      <button
        type="button"
        className="relative mt-auto flex h-10 items-center gap-3 px-3 text-xs text-[#557269]"
      >
        <Settings className="size-4" />
        الإعدادات
      </button>
    </aside>
  );
}

function AttendanceToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-x-3 top-3 z-40 flex items-center gap-2.5 rounded-2xl border border-white/20 bg-[#0d5d4d] px-3 py-2.5 text-white shadow-[0_14px_28px_rgb(3_45_37_/_30%)]"
      role="status"
      aria-live="polite"
    >
      <span className="grid size-8 place-items-center rounded-xl bg-white/15">
        <CalendarClock className="size-4" />
      </span>
      <span className="min-w-0 flex-1 text-[11px] font-bold">{message}</span>
      <button
        type="button"
        onClick={onClose}
        className="grid size-7 place-items-center rounded-lg bg-white/10 text-sm"
      >
        ×
      </button>
    </div>
  );
}

function AppSurface({ device }: { device: Device }) {
  const [view, setView] = useState<View>("home");
  const [role, setRole] = useState<UserRole>("manager");
  const [quickActionOpen, setQuickActionOpen] = useState(false);
  const tablet = device === "tablet";
  const nextRole = () =>
    setRole((current) =>
      current === "manager"
        ? "sales"
        : current === "sales"
          ? "warehouse"
          : "manager",
    );
  const content =
    view === "home" ? (
      <HomeContent
        tablet={tablet}
        onView={setView}
        role={role}
        onNextRole={nextRole}
      />
    ) : view === "work" ? (
      <WorkContent tablet={tablet} onView={setView} role={role} />
    ) : view === "activity" ? (
      <ActivityContent tablet={tablet} onView={setView} />
    ) : view === "profile" ? (
      <ProfileContent tablet={tablet} />
    ) : (
      <SalesContent tablet={tablet} />
    );
  const viewTitle: Record<View, string> = {
    home: "لوحة اليوم",
    work: "مساحة العمل",
    sales: "المبيعات",
    activity: "مركز التنبيهات",
    profile: "ملفي الوظيفي",
  };
  return (
    <div
      className={`mobile-preview-surface relative isolate overflow-hidden text-right ${tablet ? "min-h-[900px] w-full" : "min-h-[844px] w-full"}`}
      dir="rtl"
    >
      {tablet ? (
        <div className="flex min-h-[900px]">
          <TabletRail active={view} onChange={setView} />
          <div className="min-w-0 flex-1">
            <TopBar tablet title={viewTitle[view]} />
            {content}
          </div>
        </div>
      ) : (
        <>
          <TopBar title={view === "home" ? undefined : viewTitle[view]} />
          {content}
          <BottomNav
            active={view}
            onChange={setView}
            onQuickAction={() => setQuickActionOpen(true)}
          />
          {quickActionOpen && (
            <QuickActionSheet
              onClose={() => setQuickActionOpen(false)}
              onView={setView}
              role={role}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function MobileDesignPreview() {
  const [device, setDevice] = useState<Device>("phone");
  return (
    <main
      className="mobile-preview-canvas min-h-screen overflow-hidden p-4 font-[Cairo] text-[#183f35] md:p-8"
      dir="rtl"
    >
      <style>{`@keyframes hero-glow { 0%,100% { transform: translate3d(0,0,0) scale(1); opacity:.55 } 50% { transform: translate3d(-14px,-8px,0) scale(1.18); opacity:.9 } } @keyframes neon-breathe { 0%,100% { box-shadow: 0 9px 18px rgb(13 105 86 / .24), inset 0 1px 0 rgb(255 255 255 / .33); } 50% { box-shadow: 0 13px 26px rgb(13 105 86 / .36), inset 0 1px 0 rgb(255 255 255 / .48); } } .mobile-preview-canvas { background: radial-gradient(circle at 8% 8%, #d7f2e5 0, transparent 24%), radial-gradient(circle at 93% 85%, #fce5cf 0, transparent 22%), linear-gradient(135deg, #eff7f2, #dfece6); } .mobile-preview-surface { background: #eef4f1; } .neo-topbar { background: linear-gradient(135deg, #102f2a, #0a4b3f); color: #f4fbf8; border-bottom: 1px solid rgb(255 255 255 / .08); box-shadow: inset 0 -1px 0 rgb(0 0 0 / .16); } .neo-topbar-title { color: #f8fffc; } .neo-topbar-button { color: #eafff7; background: linear-gradient(145deg, rgb(255 255 255 / .12), rgb(255 255 255 / .04)); border: 1px solid rgb(255 255 255 / .09); box-shadow: 4px 4px 9px rgb(0 0 0 / .18), -2px -2px 5px rgb(255 255 255 / .05); } .neo-topbar-button:hover { transform: translateY(-1px); background: rgb(255 255 255 / .16); } .neo-alert-dot { background: #e88a37; box-shadow: 0 0 0 3px #0e3b33; } .neo-branch-tag { color: #d9f9ed; background: rgb(224 255 241 / .12); border: 1px solid rgb(224 255 241 / .12); } .neo-home { isolation: isolate; } .neo-home-dark-layer { position: absolute; z-index: -1; inset: -65px -24px auto; height: 394px; background: radial-gradient(circle at 76% 25%, rgb(35 144 115 / .32), transparent 20%), linear-gradient(145deg, #102e29, #0a4b3f 62%, #063d34); border-radius: 0 0 52% 14% / 0 0 17% 8%; box-shadow: inset 0 -18px 42px rgb(0 0 0 / .17); } .neo-home-dark-layer::after { display: none; } .neo-greeting { color: #edf8f3; } .neo-greeting p, .neo-greeting span { color: #b9d9ce; } .neo-avatar { color: #e9fff6; background: linear-gradient(145deg, rgb(255 255 255 / .17), rgb(255 255 255 / .06)); border: 1px solid rgb(255 255 255 / .14); box-shadow: 5px 7px 14px rgb(0 0 0 / .18), -2px -2px 6px rgb(255 255 255 / .08); } .neo-search { color: #eafff7; background: linear-gradient(145deg, rgb(7 40 34 / .72), rgb(23 103 84 / .42)); border: 1px solid rgb(255 255 255 / .11); box-shadow: inset 3px 3px 7px rgb(0 0 0 / .23), inset -1px -1px 4px rgb(255 255 255 / .06); } .neo-hero-card { color: #fff; background: linear-gradient(140deg, #102c29, #174f44 60%, #0f5f50); border: 1px solid rgb(255 255 255 / .12); box-shadow: 11px 14px 28px rgb(3 31 26 / .32), -2px -2px 5px rgb(255 255 255 / .08), inset 1px 1px 0 rgb(255 255 255 / .08); } .neo-progress { background: rgb(0 0 0 / .3); box-shadow: inset 2px 2px 5px rgb(0 0 0 / .27); } .neo-progress span { background: linear-gradient(90deg, #69dbbe, #e5fff7 64%, #efae65); box-shadow: 0 0 14px rgb(149 255 222 / .8); } .neo-quick-panel { margin-top: 6px; padding: 16px 14px 2px; border-radius: 30px 30px 0 0; background: linear-gradient(180deg, rgb(255 255 255 / .45), transparent); } .neo-shortcut { background: linear-gradient(145deg, #f8fcfa, #dce8e2); box-shadow: 7px 8px 15px rgb(33 78 65 / .16), -4px -4px 9px #fff, inset 1px 1px 0 rgb(255 255 255 / .85); } .neo-bottom-nav { background: linear-gradient(145deg, #f7fbf9, #e2ece7); box-shadow: 0 -10px 26px rgb(11 62 49 / .1), inset 0 1px 0 #fff; border-top: 1px solid rgb(255 255 255 / .9); } .neo-fab { position: absolute; left: 50%; top: -25px; display: grid; width: 58px; height: 58px; place-items: center; transform: translateX(-50%); border-radius: 50%; color: #fff; background: linear-gradient(145deg, #1aa98b, #0b6a57); border: 5px solid #e9f2ed; animation: neon-breathe 4s ease-in-out infinite; } .neo-fab:hover { transform: translateX(-50%) translateY(-2px) scale(1.04); } @media (min-width: 768px) { .neo-home-dark-layer { height: 368px; border-radius: 0 0 38% 10% / 0 0 18% 7%; } .neo-quick-panel { padding-inline: 18px; } } @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`}</style>
      <style>{`.neo-topbar-mobile { overflow: visible; border-radius: 0 0 34px 34px; box-shadow: inset 0 -1px 0 rgb(0 0 0 / .16), 0 10px 20px rgb(3 40 32 / .14); } .neo-topbar-mobile::after { position: absolute; z-index: -1; right: 18%; bottom: -22px; left: 18%; height: 37px; content: ''; border-radius: 0 0 46px 46px; background: linear-gradient(145deg, #0e392f, #0a4b3f); box-shadow: 0 9px 18px rgb(3 40 32 / .16); } .neo-cloud-button { color: #d5f5e9; } .neo-profile-dock { border-radius: 0 0 34px 34px; background: linear-gradient(145deg, #0e392f, #0a4b3f); box-shadow: 0 9px 18px rgb(3 40 32 / .24), inset 1px 0 0 rgb(255 255 255 / .07); } .neo-profile-button { color: #ecfff7; background: linear-gradient(145deg, rgb(255 255 255 / .18), rgb(255 255 255 / .06)); border: 1px solid rgb(255 255 255 / .17); box-shadow: 4px 5px 10px rgb(0 0 0 / .2), -2px -2px 5px rgb(255 255 255 / .08), inset 0 1px 0 rgb(255 255 255 / .2); }`}</style>
      <style>{`.neo-action-sheet { background: linear-gradient(145deg, #f9fcfa, #e6efea); border: 1px solid rgb(255 255 255 / .9); box-shadow: 0 -14px 38px rgb(4 47 38 / .25), inset 0 1px 0 #fff; } .neo-action-option { background: linear-gradient(145deg, #fff, #e8f0ec); box-shadow: 5px 6px 13px rgb(26 73 59 / .12), -3px -3px 7px #fff, inset 1px 1px 0 rgb(255 255 255 / .9); } .neo-action-option:active { transform: translateY(1px); box-shadow: inset 3px 3px 7px rgb(26 73 59 / .12), inset -2px -2px 5px #fff; }`}</style>
      <style>{`.neo-attendance-card { background: radial-gradient(circle at 88% 15%, rgb(30 164 120 / .13), transparent 31%), linear-gradient(145deg, #f9fcfa, #e4eee9); border: 1px solid rgb(255 255 255 / .95); box-shadow: 8px 9px 20px rgb(27 75 61 / .1), -4px -4px 10px #fff, inset 1px 1px 0 rgb(255 255 255 / .88); }`}</style>
      <div className="mx-auto max-w-[1280px]">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <span className="inline-flex rounded-full border border-[#f4d1b7] bg-[#fff3e9]/80 px-2.5 py-1 text-xs font-bold text-[#bd5d1d] shadow-sm">
              تصميم أولي — تجربة مستقلة
            </span>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">
              نموذج تطبيق الرؤية العربية
            </h1>
            <p className="mt-1 text-sm text-[#5f7970]">
              شاهد الواجهة كما ستتكيّف على الهاتف أو الجهاز اللوحي.
            </p>
          </div>
          <div className="rounded-2xl border border-white/80 bg-white/75 p-1.5 shadow-[0_9px_22px_rgb(24_66_55_/_8%)] backdrop-blur">
            <button
              type="button"
              onClick={() => setDevice("phone")}
              className={`rounded-xl px-3 py-2 text-xs font-bold transition ${device === "phone" ? "bg-gradient-to-br from-[#11947a] to-[#0a6956] text-white shadow-[0_7px_14px_rgb(15_128_104_/_23%)]" : "text-[#56736a] hover:bg-[#eef7f2]"}`}
            >
              هاتف 390 × 844
            </button>
            <button
              type="button"
              onClick={() => setDevice("tablet")}
              className={`rounded-xl px-3 py-2 text-xs font-bold transition ${device === "tablet" ? "bg-gradient-to-br from-[#11947a] to-[#0a6956] text-white shadow-[0_7px_14px_rgb(15_128_104_/_23%)]" : "text-[#56736a] hover:bg-[#eef7f2]"}`}
            >
              تابلت 1024 × 900
            </button>
          </div>
        </header>
        <section
          className={`relative overflow-hidden rounded-[30px] border-[9px] border-[#123d32] bg-gradient-to-br from-[#0b5e4d] via-[#173e34] to-[#092f28] p-[1px] shadow-[0_34px_80px_rgb(20_60_48_/_30%)] ${device === "phone" ? "mx-auto max-w-[390px] rounded-[40px]" : "mx-auto max-w-[1024px]"}`}
        >
          <span className="pointer-events-none absolute inset-x-8 top-0 z-10 h-px bg-white/35" />
          <AppSurface device={device} />
        </section>
        <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-[#607a71]">
          <ArrowRight className="size-3.5" />
          اضغط تنقّل التطبيق أو بطاقات الوحدات لتبديل الشاشة المعروضة
        </div>
      </div>
    </main>
  );
}

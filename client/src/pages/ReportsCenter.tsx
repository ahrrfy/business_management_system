// مركز التقارير الموحّد — المدخل الواحد لكل تقارير النظام (شامل الأنماط).
// يعرض مؤشّرات حيّة + بطاقات مصنّفة محجوبة بالأدوار + بحث + مفضّلة (localStorage).
// البطاقات الجاهزة تربط الصفحة الفعلية؛ بطاقات «قريباً» تُظهر الرؤية الشاملة وتُفعَّل مرحلةً بمرحلة.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { formatIqd } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  Home, BarChart3, TrendingUp, Scale, BookOpen, Landmark, Droplet,
  ScrollText, Search, Ruler, FileText, Hourglass, SearchCheck, CreditCard,
  Package, RefreshCw, ClipboardList, AlertTriangle, FolderOpen, ListOrdered,
  Calculator, Receipt, Banknote, Clock, Clock8, Palmtree, User, Archive,
  Handshake, Recycle, Microscope, ShoppingCart, Users, Truck, Boxes,
  Wallet, Printer, Briefcase, Server, ShieldCheck, Factory, FileStack,
  LayoutDashboard, Star, type LucideIcon,
} from "lucide-react";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import type { RoleKey } from "@shared/permissions";

type Gate = "all" | "manager" | "admin";
type Status = "ready" | "soon";

interface ReportItem {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon;
  gate: Gate;
  status: Status;
}
interface Section {
  key: string;
  label: string;
  icon: LucideIcon;
  items: ReportItem[];
}

// كتالوج المركز — يُحدَّث «soon→ready» مع تسليم كل مرحلة.
const SECTIONS: Section[] = [
  {
    key: "exec",
    label: "النظرة التنفيذية",
    icon: TrendingUp,
    items: [
      { title: "لوحة التحكم", desc: "مؤشّرات اليوم والوردية والتنبيهات", href: "/", icon: Home, gate: "all", status: "ready" },
      { title: "لوحة المؤشّرات التنفيذية", desc: "إيراد/ربح/هامش/نقد + اتّجاهات ومقارنة فترات", href: "/reports/executive", icon: BarChart3, gate: "manager", status: "ready" },
      { title: "رقيب الشذوذ", desc: "كواشف تسرّب الأموال: دون الكلفة/خصومات/مرتجعات/عجوزات/عكوس/تسلسل", href: "/reports/anomaly-watch", icon: ShieldCheck, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "financial",
    label: "القوائم المالية",
    icon: ScrollText,
    items: [
      { title: "الأرباح والخسائر", desc: "إيراد − تكلفة المبيعات − مصروفات (مبسّطة، مع مقارنة)", href: "/reports/profit-loss", icon: TrendingUp, gate: "manager", status: "ready" },
      { title: "ميزان المراجعة", desc: "تجميع أرصدة النقد/المدينين/الدائنين/المخزون", href: "/reports/trial-balance", icon: Scale, gate: "manager", status: "ready" },
      { title: "دفتر اليومية / الأستاذ", desc: "تصفّح قيود الدفتر مع التنقّل لمستند المصدر", href: "/reports/general-ledger", icon: BookOpen, gate: "manager", status: "ready" },
      { title: "الميزانية العمومية", desc: "أصول/خصوم/حقوق ملكية (مبسّطة مشتقّة)", href: "/reports/balance-sheet", icon: Landmark, gate: "manager", status: "ready" },
      { title: "التدفّقات النقدية", desc: "مقبوضات/مدفوعات (أساس نقدي)", href: "/reports/cash-flow", icon: Droplet, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "sales",
    label: "المبيعات والإيرادات",
    icon: ShoppingCart,
    items: [
      { title: "تقارير المبيعات المُوحَّدة", desc: "٣ زَوايا في صَفحة واحدة (مُلخّص/تَفصيلي/حَسَب البُعد)", href: "/reports/sales-hub", icon: LayoutDashboard, gate: "manager", status: "ready" },
      { title: "تقرير المبيعات (مُلخّص)", desc: "فواتير + أكثر مبيعاً + بطيئة + ربح حسب الفئة", href: "/sales-report", icon: Receipt, gate: "manager", status: "ready" },
      { title: "سجلّ المبيعات المفصّل", desc: "بمستوى بنود الفاتورة (drill-down)", href: "/reports/sales-register", icon: Search, gate: "manager", status: "ready" },
      { title: "المبيعات حسب البُعد", desc: "عميل/فرع/كاشير/طريقة دفع", href: "/reports/sales-by-dimension", icon: Ruler, gate: "manager", status: "ready" },
      { title: "تحليل الربحية الحقيقي", desc: "ربح وهامش حسب منتج/فئة/عميل/فرع/كاشير + كشف تآكل الهامش", href: "/reports/profitability", icon: TrendingUp, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "ar",
    label: "ذمم العملاء (مدين)",
    icon: Users,
    items: [
      { title: "كشف حساب عميل", desc: "فواتير + دفعات + الرصيد الحالي", href: "/customers-statement", icon: FileText, gate: "manager", status: "ready" },
      { title: "أعمار الذمم المُوحَّدة (مدينة/دائنة)", desc: "مَدينة ودائنة + مُلخَّص/تَفصيل في صَفحة واحدة", href: "/reports/aging-hub", icon: LayoutDashboard, gate: "manager", status: "ready" },
      { title: "أعمار الذمم المدينة (مُلخَّص)", desc: "0-30 / 31-60 / 61-90 / +90 يوم", href: "/ar-aging", icon: Hourglass, gate: "manager", status: "ready" },
      { title: "تفصيل أعمار الذمم (AR/AP)", desc: "مستندٌ بمستند مع المتبقّي والتأخّر", href: "/reports/aging-detail", icon: SearchCheck, gate: "manager", status: "ready" },
      { title: "التعرّض الائتماني للعملاء", desc: "أرصدة ومخاطر التحصيل + تصنيف خطر + تذكير واتساب", href: "/reports/credit-exposure", icon: CreditCard, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "ap",
    label: "ذمم الموردين (دائن)",
    icon: Truck,
    items: [
      { title: "كشف حساب مورد", desc: "أوامر شراء + مدفوعات + الرصيد الحالي", href: "/suppliers-statement", icon: FileText, gate: "manager", status: "ready" },
      { title: "أعمار الذمم الدائنة", desc: "0-30 / 31-60 / 61-90 / +90 يوم", href: "/ap-aging", icon: Hourglass, gate: "manager", status: "ready" },
      { title: "تقرير المشتريات", desc: "بالفترة/المورد + أكبر الموردين", href: "/reports/purchases", icon: Package, gate: "manager", status: "ready" },
      { title: "سجلّ المشتريات المفصّل", desc: "بنود أوامر الشراء سطر-سطر", href: "/reports/purchase-register", icon: Search, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "inventory",
    label: "المخزون والجرد",
    icon: Boxes,
    items: [
      { title: "حركات المخزون", desc: "سجلّ الإدخال/الإخراج/التحويل/التسوية", href: "/inventory-movements", icon: RefreshCw, gate: "all", status: "ready" },
      { title: "الجرد والتسوية", desc: "محاضر الجرد ودقّة السجلّ", href: "/stocktakes", icon: ClipboardList, gate: "manager", status: "ready" },
      { title: "تقييم المخزون", desc: "كمية × كلفة بالفرع/الفئة", href: "/reports/inventory-valuation", icon: Wallet, gate: "manager", status: "ready" },
      { title: "حالة المخزون وإعادة الطلب", desc: "منخفض/نفد مقابل حدّ الطلب", href: "/reports/stock-status", icon: AlertTriangle, gate: "manager", status: "ready" },
      { title: "المخزون التشغيلي (قرارات)", desc: "إعادة طلب · راكد · خطر نفاد · فروقات جرد · السوالب (وضع الافتتاح)", href: "/reports/inventory-ops", icon: ClipboardList, gate: "manager", status: "ready" },
      { title: "بطاقة المنتج (Kardex)", desc: "حركة منتج زمنياً بالرصيد الحالي", href: "/reports/item-ledger", icon: FolderOpen, gate: "manager", status: "ready" },
      { title: "تحليل ABC", desc: "تصنيف المنتجات بالقيمة (باريتو)", href: "/reports/abc", icon: ListOrdered, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "treasury",
    label: "الخزينة والصندوق",
    icon: Wallet,
    items: [
      { title: "ملخّص الصندوق اليومي", desc: "قبض/صرف + توزيع طرق الدفع + فروقات الورديات", href: "/reports/treasury", icon: Calculator, gate: "manager", status: "ready" },
      { title: "تقرير المصروفات", desc: "بالفئة/المستفيد/الفترة", href: "/reports/expenses", icon: Receipt, gate: "manager", status: "ready" },
      { title: "المصروفات اليومية", desc: "سجلّ المصروفات وإدخالها", href: "/expenses", icon: Banknote, gate: "all", status: "ready" },
      { title: "سندات القبض والصرف", desc: "سجلّ السندات المستقلّة", href: "/vouchers", icon: Receipt, gate: "all", status: "ready" },
      { title: "سجلّ الورديات (تقرير Z)", desc: "افتتاح/إغلاق + فروقات الصندوق", href: "/shifts", icon: Clock, gate: "all", status: "ready" },
    ],
  },
  {
    key: "production",
    label: "الإنتاج وخدمة العملاء",
    icon: Printer,
    items: [
      { title: "تقرير الإنتاج", desc: "بالفترة + تفصيل التكلفة + الهدر/المردود", href: "/reports/production", icon: Factory, gate: "manager", status: "ready" },
      { title: "تقرير طلبات خدمة العملاء", desc: "توزيع الحالات + الربحية + أعمار التسليم", href: "/reports/work-orders", icon: FileStack, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "hr",
    label: "الموارد البشرية",
    icon: Briefcase,
    items: [
      { title: "ملخّص الرواتب", desc: "إجمالي/بدلات/خصومات/صافٍ بالفترة", href: "/reports/payroll", icon: Banknote, gate: "manager", status: "ready" },
      { title: "تقرير الحضور", desc: "بالموظف/الفترة + الساعات", href: "/reports/attendance", icon: Clock8, gate: "manager", status: "ready" },
      { title: "أرصدة الإجازات", desc: "المستحقّ/المستخدَم/المتبقّي", href: "/reports/leaves", icon: Palmtree, gate: "manager", status: "ready" },
      { title: "الترقيات وإنهاء الخدمات", desc: "سجلّ التغييرات الوظيفية", href: "/reports/hr-changes", icon: TrendingUp, gate: "manager", status: "ready" },
      { title: "كادر الموظفين", desc: "دليل الموظفين مع تصدير", href: "/hr/employees", icon: User, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "assets",
    label: "الأصول الثابتة",
    icon: Server,
    items: [
      { title: "سجلّ الأصول", desc: "الأصول الثابتة وقيمها", href: "/assets/register", icon: Archive, gate: "manager", status: "ready" },
      { title: "تقرير العهد", desc: "الأصول بعهدة الموظفين", href: "/assets/custody-report", icon: Handshake, gate: "manager", status: "ready" },
      { title: "سجلّ الاستبعاد", desc: "الأصول المُستبعَدة/المتقاعدة", href: "/assets/disposal-log", icon: Recycle, gate: "manager", status: "ready" },
    ],
  },
  {
    key: "audit",
    label: "التدقيق والامتثال",
    icon: ShieldCheck,
    items: [
      { title: "سجلّ التدقيق", desc: "كل العمليات الحسّاسة (من/ماذا/متى)", href: "/audit", icon: ScrollText, gate: "admin", status: "ready" },
      { title: "تدقيق التوافق المالي", desc: "كشف الانجراف في الأرصدة/المخزون/الدفتر", href: "/reconcile", icon: Microscope, gate: "admin", status: "ready" },
    ],
  },
];

// أدوار بنود «manager» حسب القسم — يحترم الأدوار العشرة (محاسب يرى المالية، أمين مخزن يرى المخزون،
// مسؤول مشتريات يرى المشتريات…) بدل تبسيط manager/admin. الإنفاذ الأمني الحقيقي خادمي + RequireRole.
const SECTION_ROLES: Record<string, RoleKey[]> = {
  exec:       ["admin", "manager", "accountant", "auditor"],
  financial:  ["admin", "manager", "accountant", "auditor"],
  sales:      ["admin", "manager", "accountant", "auditor"],
  ar:         ["admin", "manager", "accountant", "auditor"],
  ap:         ["admin", "manager", "accountant", "purchasing", "auditor"],
  inventory:  ["admin", "manager", "accountant", "warehouse", "purchasing", "auditor"],
  treasury:   ["admin", "manager", "accountant", "auditor"],
  production: ["admin", "manager", "auditor"],
  hr:         ["admin", "manager", "auditor"],
  assets:     ["admin", "manager", "accountant", "auditor"],
  audit:      ["admin"],
};

/** يحوّل gate الخشن (all/manager/admin) + قسمه إلى RoleGate دقيق. all⇒مرئي للكل، admin⇒adminOnly.
 *  مقصور على الأدوار (SECTION_ROLES) بلا بُعد وحدة: بنود هذا المركز تقصد وجهاتٍ مختلطةً (تقارير
 *  reportViewer + صفحات hr/assets/stocktake بوحداتها الخاصة)، فمنحُ «reports» عليها كلها كان
 *  يُعلن روابط يحجبها الخادم فوراً (مراجعة Codex). الوصول المباشر لكل تقرير يحترم منحه في App.tsx. */
function resolveGate(gate: Gate, sectionKey: string): RoleGate | undefined {
  if (gate === "all") return undefined;
  if (gate === "admin") return { adminOnly: true };
  return { roles: SECTION_ROLES[sectionKey] ?? ["admin", "manager"] };
}

// قائمة مسطّحة بمفتاح القسم — تحفظ سياق القسم للمفضّلة (التي تفقده عند flatMap).
const ALL_ITEMS = SECTIONS.flatMap((s) => s.items.map((it) => ({ ...it, sectionKey: s.key })));

const FAV_KEY = "reports.favorites";

function loadFavs(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}
function saveFavs(s: Set<string>) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(s))); } catch { /* ignore */ }
}

export default function ReportsCenter() {
  const me = trpc.auth.me.useQuery();
  const metrics = trpc.reports.dashboardMetrics.useQuery(undefined, { staleTime: 60_000 });
  const [q, setQ] = useState("");
  const [favs, setFavs] = useState<Set<string>>(() => loadFavs());

  const role = me.data?.role;
  const permsOverride = (me.data?.permissionsOverride ?? null) as
    | import("@shared/permissions").PermissionMap
    | null;

  function toggleFav(href: string) {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(href)) next.delete(href); else next.add(href);
      saveFavs(next);
      return next;
    });
  }

  const needle = q.trim();
  const match = (it: ReportItem) =>
    !needle || it.title.includes(needle) || it.desc.includes(needle);

  // الأقسام المرئية بعد الأدوار + البحث
  const visibleSections = useMemo(
    () =>
      SECTIONS.map((s) => ({
        ...s,
        items: s.items.filter((it) => canSeeGate(resolveGate(it.gate, s.key), role, permsOverride) && match(it)),
      })).filter((s) => s.items.length > 0),
    [needle, role, permsOverride],
  );

  // المفضّلة (الجاهزة فقط ومرئية)
  const favItems = useMemo(
    () =>
      ALL_ITEMS.filter(
        (it) => favs.has(it.href) && canSeeGate(resolveGate(it.gate, it.sectionKey), role, permsOverride) && it.status === "ready" && match(it),
      ),
    [favs, needle, role, permsOverride],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="مركز التقارير والكشوفات"
        description="كل تقارير النظام في مكان واحد — عرض وتصدير Excel وطباعة A4."
        actions={
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ابحث في التقارير…"
            className="h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      />

      {/* مؤشّرات حيّة */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground">المخزون المنخفض</p>
            <p className="text-2xl font-bold tabular-nums text-[var(--stock-low)]" dir="ltr">
              {metrics.isLoading ? "…" : (metrics.data?.lowStockCount ?? 0)}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">منتجات تحت حدّ الطلب</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground">الذمم المتأخّرة (+٣٠ يوم)</p>
            <p className="text-xl font-bold tabular-nums text-money-negative" dir="ltr">
              {metrics.isLoading ? "…" : formatIqd(metrics.data?.overdueAR.total ?? 0)}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{metrics.data?.overdueAR.count ?? 0} فاتورة</p>
          </CardContent>
        </Card>
      </div>

      {/* المفضّلة */}
      {favItems.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Star aria-hidden className="size-4 fill-amber-400 text-amber-500" />
            <span>المفضّلة</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {favItems.map((it) => (
              <ReportCard key={`fav-${it.href}`} item={it} fav onToggleFav={toggleFav} />
            ))}
          </div>
        </section>
      )}

      {/* الأقسام */}
      {visibleSections.map((s) => {
        const SectionIcon = s.icon;
        return (
          <section key={s.key} className="space-y-2">
            <h2 className="flex items-center gap-2 border-b pb-1.5 text-sm font-semibold text-muted-foreground">
              <span className="inline-flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                <SectionIcon aria-hidden className="size-4" />
              </span>
              <span>{s.label}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{s.items.length}</span>
            </h2>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {s.items.map((it) => (
                <ReportCard key={it.href} item={it} fav={favs.has(it.href)} onToggleFav={toggleFav} />
              ))}
            </div>
          </section>
        );
      })}

      {visibleSections.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">لا تقارير مطابقة لبحثك.</p>
      )}
    </div>
  );
}

function ReportCard({
  item,
  fav,
  onToggleFav,
}: {
  item: ReportItem;
  fav: boolean;
  onToggleFav: (href: string) => void;
}) {
  const soon = item.status === "soon";
  const ItemIcon = item.icon;
  const body = (
    <Card
      className={cn(
        // أكثف وأخفّ: نُلغي حشوة Card الافتراضية (py-6/gap-6) ⇒ الارتفاع من CardContent p-3 وحده.
        // حركة ناعمة بالـtransform فقط (تحترم reduced-motion)، وارتفاع موحَّد.
        "group relative h-full gap-0 overflow-hidden py-0 transition-all duration-200 ease-out motion-reduce:transition-none",
        soon
          ? "opacity-55"
          : "cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:hover:translate-y-0",
      )}
    >
      {/* اللمسة الإبداعية: شريط لوني على الحافة الأمامية (يمين RTL) يتوهّج عند المرور — يميّز البطاقة بلا صخب */}
      {!soon && (
        <span
          aria-hidden
          className="absolute inset-y-0 start-0 w-[3px] bg-primary/0 transition-colors duration-200 group-hover:bg-primary/60"
        />
      )}
      <CardContent className="flex items-center gap-2.5 p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-primary ring-1 ring-inset ring-primary/10 transition-transform duration-200 group-hover:scale-[1.04] motion-reduce:group-hover:scale-100">
          <ItemIcon aria-hidden className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold leading-tight" title={item.title}>{item.title}</span>
            {soon && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">قريباً</span>}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground" title={item.desc}>{item.desc}</p>
        </div>
        {!soon && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFav(item.href); }}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
              fav ? "text-amber-500" : "text-muted-foreground/30 hover:text-amber-500",
            )}
            aria-label={fav ? "إزالة من المفضّلة" : "إضافة للمفضّلة"}
            title={fav ? "إزالة من المفضّلة" : "إضافة للمفضّلة"}
          >
            <Star aria-hidden className={cn("size-3.5", fav && "fill-current")} />
          </button>
        )}
      </CardContent>
    </Card>
  );

  if (soon) return body;
  return <Link href={item.href}>{body}</Link>;
}

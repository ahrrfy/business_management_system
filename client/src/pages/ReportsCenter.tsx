// مركز التقارير الموحّد — المدخل الواحد لكل تقارير النظام (شامل الأنماط).
// يعرض مؤشّرات حيّة + بطاقات مصنّفة محجوبة بالأدوار + بحث + مفضّلة (localStorage).
// البطاقات الجاهزة تربط الصفحة الفعلية؛ بطاقات «قريباً» تُظهر الرؤية الشاملة وتُفعَّل مرحلةً بمرحلة.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { formatIqd } from "@/lib/money";
import { cn } from "@/lib/utils";

type Gate = "all" | "manager" | "admin";
type Status = "ready" | "soon";

interface ReportItem {
  title: string;
  desc: string;
  href: string;
  icon: string;
  gate: Gate;
  status: Status;
}
interface Section {
  key: string;
  label: string;
  icon: string;
  items: ReportItem[];
}

// كتالوج المركز — يُحدَّث «soon→ready» مع تسليم كل مرحلة.
const SECTIONS: Section[] = [
  {
    key: "exec",
    label: "النظرة التنفيذية",
    icon: "📈",
    items: [
      { title: "لوحة التحكم", desc: "مؤشّرات اليوم والوردية والتنبيهات", href: "/", icon: "🏠", gate: "all", status: "ready" },
      { title: "لوحة المؤشّرات التنفيذية", desc: "إيراد/ربح/هامش/نقد + اتّجاهات ومقارنة فترات", href: "/reports/executive", icon: "📊", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "financial",
    label: "القوائم المالية",
    icon: "🧾",
    items: [
      { title: "الأرباح والخسائر", desc: "إيراد − تكلفة المبيعات − مصروفات (مبسّطة، مع مقارنة)", href: "/reports/profit-loss", icon: "💹", gate: "manager", status: "ready" },
      { title: "ميزان المراجعة", desc: "تجميع أرصدة النقد/المدينين/الدائنين/المخزون", href: "/reports/trial-balance", icon: "⚖️", gate: "manager", status: "ready" },
      { title: "دفتر اليومية / الأستاذ", desc: "تصفّح قيود الدفتر مع التنقّل لمستند المصدر", href: "/reports/general-ledger", icon: "📚", gate: "manager", status: "ready" },
      { title: "الميزانية العمومية", desc: "أصول/خصوم/حقوق ملكية (مبسّطة مشتقّة)", href: "/reports/balance-sheet", icon: "🏛️", gate: "manager", status: "ready" },
      { title: "التدفّقات النقدية", desc: "مقبوضات/مدفوعات (أساس نقدي)", href: "/reports/cash-flow", icon: "💧", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "sales",
    label: "المبيعات والإيرادات",
    icon: "🛒",
    items: [
      { title: "تقرير المبيعات", desc: "فواتير + أكثر مبيعاً + بطيئة + ربح حسب الفئة", href: "/sales-report", icon: "🧾", gate: "manager", status: "ready" },
      { title: "سجلّ المبيعات المفصّل", desc: "بمستوى بنود الفاتورة (drill-down)", href: "/reports/sales-register", icon: "🔍", gate: "manager", status: "ready" },
      { title: "المبيعات حسب البُعد", desc: "عميل/فرع/كاشير/طريقة دفع", href: "/reports/sales-by-dimension", icon: "📐", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "ar",
    label: "ذمم العملاء (مدين)",
    icon: "👥",
    items: [
      { title: "كشف حساب عميل", desc: "فواتير + دفعات + رصيد جارٍ", href: "/customers-statement", icon: "📄", gate: "manager", status: "ready" },
      { title: "أعمار الذمم المدينة", desc: "0-30 / 31-60 / 61-90 / +90 يوم", href: "/ar-aging", icon: "⏳", gate: "manager", status: "ready" },
      { title: "تفصيل أعمار الذمم (AR/AP)", desc: "مستندٌ بمستند مع المتبقّي والتأخّر", href: "/reports/aging-detail", icon: "🔎", gate: "manager", status: "ready" },
      { title: "التعرّض الائتماني للعملاء", desc: "أرصدة ومخاطر التحصيل", href: "/reports/customer-balances", icon: "💳", gate: "manager", status: "soon" },
    ],
  },
  {
    key: "ap",
    label: "ذمم الموردين (دائن)",
    icon: "🚚",
    items: [
      { title: "كشف حساب مورد", desc: "أوامر شراء + مدفوعات + رصيد جارٍ", href: "/suppliers-statement", icon: "📄", gate: "manager", status: "ready" },
      { title: "أعمار الذمم الدائنة", desc: "0-30 / 31-60 / 61-90 / +90 يوم", href: "/ap-aging", icon: "⏳", gate: "manager", status: "ready" },
      { title: "تقرير المشتريات", desc: "بالفترة/المورد + أكبر الموردين", href: "/reports/purchases", icon: "📦", gate: "manager", status: "ready" },
      { title: "سجلّ المشتريات المفصّل", desc: "بنود أوامر الشراء سطر-سطر", href: "/reports/purchase-register", icon: "🔍", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "inventory",
    label: "المخزون والجرد",
    icon: "🗃️",
    items: [
      { title: "حركات المخزون", desc: "سجلّ الإدخال/الإخراج/التحويل/التسوية", href: "/inventory-movements", icon: "🔄", gate: "all", status: "ready" },
      { title: "الجرد والتسوية", desc: "محاضر الجرد ودقّة السجلّ", href: "/stocktakes", icon: "📋", gate: "manager", status: "ready" },
      { title: "تقييم المخزون", desc: "كمية × كلفة بالفرع/الفئة", href: "/reports/inventory-valuation", icon: "💰", gate: "manager", status: "ready" },
      { title: "حالة المخزون وإعادة الطلب", desc: "منخفض/نفد مقابل حدّ الطلب", href: "/reports/stock-status", icon: "⚠️", gate: "manager", status: "ready" },
      { title: "بطاقة الصنف (Kardex)", desc: "حركة صنف زمنياً برصيد جارٍ", href: "/reports/item-ledger", icon: "🗂️", gate: "manager", status: "ready" },
      { title: "تحليل ABC", desc: "تصنيف الأصناف بالقيمة (باريتو)", href: "/reports/abc", icon: "🔠", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "treasury",
    label: "الخزينة والصندوق",
    icon: "💰",
    items: [
      { title: "ملخّص الصندوق اليومي", desc: "قبض/صرف + توزيع طرق الدفع + فروقات الورديات", href: "/reports/treasury", icon: "🧮", gate: "manager", status: "ready" },
      { title: "تقرير المصروفات", desc: "بالفئة/المستفيد/الفترة", href: "/reports/expenses", icon: "🧾", gate: "manager", status: "ready" },
      { title: "المصروفات اليومية", desc: "سجلّ المصروفات وإدخالها", href: "/expenses", icon: "💸", gate: "all", status: "ready" },
      { title: "سندات القبض والصرف", desc: "سجلّ السندات المستقلّة", href: "/vouchers", icon: "🧾", gate: "all", status: "ready" },
      { title: "سجلّ الورديات (تقرير Z)", desc: "افتتاح/إغلاق + فروقات الصندوق", href: "/shifts", icon: "🕐", gate: "all", status: "ready" },
    ],
  },
  {
    key: "production",
    label: "الإنتاج وأوامر الشغل",
    icon: "🖨️",
    items: [
      { title: "تقرير الإنتاج", desc: "بالفترة + تفصيل التكلفة + الهدر/المردود", href: "/reports/production", icon: "🏭", gate: "manager", status: "ready" },
      { title: "تقرير أوامر الشغل", desc: "توزيع الحالات + الربحية + أعمار التسليم", href: "/reports/work-orders", icon: "📑", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "hr",
    label: "الموارد البشرية",
    icon: "💼",
    items: [
      { title: "ملخّص الرواتب", desc: "إجمالي/بدلات/خصومات/صافٍ بالفترة", href: "/reports/payroll", icon: "💵", gate: "manager", status: "ready" },
      { title: "تقرير الحضور", desc: "بالموظف/الفترة + الساعات", href: "/reports/attendance", icon: "🕗", gate: "manager", status: "ready" },
      { title: "أرصدة الإجازات", desc: "المستحقّ/المستخدَم/المتبقّي", href: "/reports/leaves", icon: "🌴", gate: "manager", status: "ready" },
      { title: "الترقيات وإنهاء الخدمات", desc: "سجلّ التغييرات الوظيفية", href: "/reports/hr-changes", icon: "📈", gate: "manager", status: "ready" },
      { title: "كادر الموظفين", desc: "دليل الموظفين مع تصدير", href: "/hr/employees", icon: "👤", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "assets",
    label: "الأصول الثابتة",
    icon: "🖥️",
    items: [
      { title: "سجلّ الأصول", desc: "الأصول الثابتة وقيمها", href: "/assets/register", icon: "🗄️", gate: "manager", status: "ready" },
      { title: "تقرير العهد", desc: "الأصول بعهدة الموظفين", href: "/assets/custody-report", icon: "🤝", gate: "manager", status: "ready" },
      { title: "سجلّ الاستبعاد", desc: "الأصول المُستبعَدة/المتقاعدة", href: "/assets/disposal-log", icon: "♻️", gate: "manager", status: "ready" },
    ],
  },
  {
    key: "audit",
    label: "التدقيق والامتثال",
    icon: "🛡️",
    items: [
      { title: "سجلّ التدقيق", desc: "كل العمليات الحسّاسة (من/ماذا/متى)", href: "/audit", icon: "📜", gate: "admin", status: "ready" },
      { title: "تدقيق التوافق المالي", desc: "كشف الانجراف في الأرصدة/المخزون/الدفتر", href: "/reconcile", icon: "🔬", gate: "admin", status: "ready" },
    ],
  },
];

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

  const isAdmin = me.data?.role === "admin";
  const isManager = isAdmin || me.data?.role === "manager";
  const canSee = (g: Gate) => g === "all" || (g === "manager" && isManager) || (g === "admin" && isAdmin);

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
        items: s.items.filter((it) => canSee(it.gate) && match(it)),
      })).filter((s) => s.items.length > 0),
    [needle, isManager, isAdmin],
  );

  // المفضّلة (الجاهزة فقط ومرئية)
  const favItems = useMemo(() => {
    const all = SECTIONS.flatMap((s) => s.items);
    return all.filter((it) => favs.has(it.href) && canSee(it.gate) && it.status === "ready" && match(it));
  }, [favs, needle, isManager, isAdmin]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">مركز التقارير والكشوفات</h1>
          <p className="text-sm text-muted-foreground">كل تقارير النظام في مكان واحد — عرض وتصدير Excel وطباعة A4.</p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث في التقارير…"
          className="h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {/* مؤشّرات حيّة */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground">المخزون المنخفض</p>
            <p className="text-2xl font-bold tabular-nums text-amber-600" dir="ltr">
              {metrics.isLoading ? "…" : (metrics.data?.lowStockCount ?? 0)}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">أصناف تحت حدّ الطلب</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground">الذمم المتأخّرة (+٣٠ يوم)</p>
            <p className="text-xl font-bold tabular-nums text-rose-600" dir="ltr">
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
            <span>⭐</span><span>المفضّلة</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {favItems.map((it) => (
              <ReportCard key={`fav-${it.href}`} item={it} fav onToggleFav={toggleFav} />
            ))}
          </div>
        </section>
      )}

      {/* الأقسام */}
      {visibleSections.map((s) => (
        <section key={s.key} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <span>{s.icon}</span><span>{s.label}</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.items.map((it) => (
              <ReportCard key={it.href} item={it} fav={favs.has(it.href)} onToggleFav={toggleFav} />
            ))}
          </div>
        </section>
      ))}

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
  const body = (
    <Card
      className={cn(
        "h-full transition",
        soon ? "opacity-60" : "hover:border-primary/50 hover:shadow-sm cursor-pointer",
      )}
    >
      <CardContent className="flex items-start gap-3 p-4">
        <span className="text-2xl leading-none">{item.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{item.title}</span>
            {soon && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">قريباً</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{item.desc}</p>
        </div>
        {!soon && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFav(item.href); }}
            className={cn("shrink-0 text-lg leading-none", fav ? "text-amber-500" : "text-muted-foreground/40 hover:text-amber-500")}
            aria-label={fav ? "إزالة من المفضّلة" : "إضافة للمفضّلة"}
            title={fav ? "إزالة من المفضّلة" : "إضافة للمفضّلة"}
          >
            {fav ? "★" : "☆"}
          </button>
        )}
      </CardContent>
    </Card>
  );

  if (soon) return body;
  return <Link href={item.href}>{body}</Link>;
}

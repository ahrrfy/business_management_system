import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { exportRows } from "@/lib/export";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Download, LineChart as LineChartIcon } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Link } from "wouter";

const fmt = (n: number) => n.toLocaleString("ar-IQ", { maximumFractionDigits: 2 });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("ar-IQ", { day: "numeric", month: "numeric" });

const STATUS_AR: Record<string, string> = {
  PENDING: "معلّقة", PARTIALLY_PAID: "مدفوعة جزئياً", PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة", CANCELLED: "ملغاة", RETURNED: "مرتجعة",
};
const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground font-normal">{title}</CardTitle></CardHeader>
      <CardContent className="text-2xl font-bold">{value}</CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const sales = trpc.sales.list.useQuery({ limit: 500 });
  const shift = trpc.shifts.current.useQuery({ branchId });

  const list = sales.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const todays = list.filter((i) => new Date(i.invoiceDate).toISOString().slice(0, 10) === today);
  const todaysTotal = todays.reduce((s, i) => s + Number(i.total), 0);

  // مبيعات آخر ١٤ يوماً (مجمَّعة باليوم).
  const byDay = new Map<string, { total: number; count: number }>();
  for (let d = 13; d >= 0; d--) {
    const key = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    byDay.set(key, { total: 0, count: 0 });
  }
  for (const inv of list) {
    const key = new Date(inv.invoiceDate).toISOString().slice(0, 10);
    const cell = byDay.get(key);
    if (cell) { cell.total += Number(inv.total); cell.count += 1; }
  }
  const trend = Array.from(byDay.entries()).map(([date, v]) => ({ date, label: dayLabel(date), total: Math.round(v.total), count: v.count }));

  // توزيع حالات الفواتير.
  const statusCounts = new Map<string, number>();
  for (const inv of list) statusCounts.set(inv.status, (statusCounts.get(inv.status) ?? 0) + 1);
  const statusData = Array.from(statusCounts.entries()).map(([status, value]) => ({ name: STATUS_AR[status] ?? status, value }));

  function exportTrend() {
    if (trend.length === 0) return notify.info("لا بيانات للتصدير.");
    exportRows(trend, {
      filename: "مبيعات-آخر-14-يوم",
      sheetName: "المبيعات",
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "count", header: "عدد الفواتير" },
        { key: "total", header: "إجمالي المبيعات" },
      ],
    });
    notify.ok("تم تصدير ملف Excel");
  }

  const cards = [
    { href: "/pos", label: "نقطة البيع", desc: "بيع وفواتير وورديات وطباعة" },
    { href: "/products", label: "المنتجات", desc: "الأصناف والوحدات والأسعار والمخزون" },
    { href: "/invoices", label: "المبيعات", desc: "الفواتير والمدفوعات والحالات" },
    { href: "/purchases", label: "المشتريات", desc: "أوامر الشراء والاستلام" },
    { href: "/inventory", label: "حركات المخزون", desc: "الوارد والصادر والتحويلات والتسويات" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">لوحة التحكم — الرؤية العربية</h1>
        <Button variant="outline" size="sm" onClick={exportTrend}>
          <Download className="size-4" /> تصدير المبيعات
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat title="فواتير اليوم" value={String(todays.length)} />
        <Stat title="مبيعات اليوم" value={fmt(todaysTotal)} />
        <Stat title="إجمالي الفواتير" value={String(list.length)} />
        <Stat title="الوردية الحالية" value={shift.data ? `#${shift.data.id} مفتوحة` : "لا وردية مفتوحة"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">مبيعات آخر ١٤ يوماً</CardTitle></CardHeader>
          <CardContent className="h-64">
            {list.length === 0 ? (
              <EmptyState icon={LineChartIcon} title="لا مبيعات بعد" description="ستظهر هنا حركة المبيعات اليومية بمجرّد إصدار أوّل فاتورة." actionLabel="افتح نقطة البيع" actionHref="/pos" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} reversed />
                  <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v) => fmt(Number(v))} orientation="right" />
                  <Tooltip formatter={(v) => fmt(Number(v))} labelFormatter={(l) => `يوم ${l}`} />
                  <Area type="monotone" dataKey="total" name="المبيعات" stroke="var(--chart-1)" fill="url(#salesFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">حالة الفواتير</CardTitle></CardHeader>
          <CardContent className="h-64">
            {statusData.length === 0 ? (
              <EmptyState title="لا فواتير بعد" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e) => `${e.name}: ${e.value}`} labelLine={false}>
                    {statusData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">عدد الفواتير يومياً (آخر ١٤ يوماً)</CardTitle></CardHeader>
        <CardContent className="h-56">
          {list.length === 0 ? (
            <EmptyState title="لا بيانات بعد" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} reversed />
                <YAxis tick={{ fontSize: 11 }} width={32} allowDecimals={false} orientation="right" />
                <Tooltip labelFormatter={(l) => `يوم ${l}`} />
                <Bar dataKey="count" name="عدد الفواتير" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <Link key={c.href} href={c.href}>
            <Card className="hover:bg-accent transition cursor-pointer h-full">
              <CardHeader><CardTitle className="text-base">{c.label}</CardTitle></CardHeader>
              <CardContent className="text-sm text-muted-foreground">{c.desc}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

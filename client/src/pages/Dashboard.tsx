import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

const fmt = (n: number) => n.toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

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
  const sales = trpc.sales.list.useQuery({ limit: 200 });
  const shift = trpc.shifts.current.useQuery({ branchId });

  const today = new Date().toISOString().slice(0, 10);
  const list = sales.data ?? [];
  const todays = list.filter((i) => new Date(i.invoiceDate).toISOString().slice(0, 10) === today);
  const todaysTotal = todays.reduce((s, i) => s + Number(i.total), 0);

  const cards = [
    { href: "/pos", label: "نقطة البيع", desc: "بيع وفواتير وورديات وطباعة" },
    { href: "/products", label: "المنتجات", desc: "الأصناف والوحدات والأسعار والمخزون" },
    { href: "/invoices", label: "المبيعات", desc: "الفواتير والمدفوعات والحالات" },
    { href: "/purchases", label: "المشتريات", desc: "أوامر الشراء والاستلام" },
    { href: "/inventory", label: "حركات المخزون", desc: "الوارد والصادر والتحويلات والتسويات" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">لوحة التحكم — الرؤية العربية</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat title="فواتير اليوم" value={String(todays.length)} />
        <Stat title="مبيعات اليوم" value={fmt(todaysTotal)} />
        <Stat title="إجمالي الفواتير" value={String(list.length)} />
        <Stat title="الوردية الحالية" value={shift.data ? `#${shift.data.id} مفتوحة` : "لا وردية مفتوحة"} />
      </div>
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

import { Activity, BadgePercent, MessagesSquare, TicketCheck, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";

export default function CrmOverview() {
  const stats = trpc.crm.dashboard.useQuery();
  const items = [
    { label: "الحملات", value: stats.data?.campaigns.total ?? 0, sub: `${stats.data?.campaigns.active ?? 0} نشطة`, icon: Activity },
    { label: "برامج الكوبونات", value: stats.data?.couponPrograms.total ?? 0, sub: `${stats.data?.couponPrograms.active ?? 0} نشطة`, icon: BadgePercent },
    { label: "مرات الاسترداد", value: stats.data?.redemptions.total ?? 0, sub: `${Number(stats.data?.redemptions.discount ?? 0).toLocaleString("en-US")} د.ع خصومات`, icon: TicketCheck },
  ];
  return <div className="max-w-7xl mx-auto space-y-5 pb-8">
    <PageHeader title="إدارة علاقات العملاء CRM" description="ملكية موحّدة لرحلة العميل والحملات والعروض والكوبونات والتواصل والتحصيل، مع تغذية من المبيعات والمتجر دون تكرار البيانات." />
    <div className="grid gap-4 md:grid-cols-3">{items.map(({ label, value, sub, icon: Icon }) => <Card key={label}><CardContent className="p-5 flex items-center gap-4"><div className="rounded-xl bg-primary/10 text-primary p-3"><Icon className="size-6" /></div><div><div className="text-sm text-muted-foreground">{label}</div><div className="text-2xl font-black">{value}</div><div className="text-xs text-muted-foreground">{sub}</div></div></CardContent></Card>)}</div>
    <Card><CardHeader><CardTitle className="text-base">حدود الملكية الوظيفية</CardTitle></CardHeader><CardContent className="grid md:grid-cols-3 gap-4 text-sm">
      <div className="rounded-lg border p-4"><Users className="size-5 text-primary mb-2"/><b>CRM يملك</b><p className="text-muted-foreground mt-1">ملف العميل، المتابعات، المحادثات، الحملات، العروض، الكوبونات والفرص.</p></div>
      <div className="rounded-lg border p-4"><MessagesSquare className="size-5 text-primary mb-2"/><b>الوحدات تغذّي</b><p className="text-muted-foreground mt-1">المبيعات والمتجر والتحصيل ترسل أحداثاً ونتائج، ولا تنشئ نسخاً أخرى من العميل أو العرض.</p></div>
      <div className="rounded-lg border p-4"><TicketCheck className="size-5 text-primary mb-2"/><b>محرك واحد</b><p className="text-muted-foreground mt-1">العرض يُعرّف مرة، ثم يُطبّق تلقائياً أو بكوبون وفق القناة والفرع والعميل.</p></div>
    </CardContent></Card>
  </div>;
}

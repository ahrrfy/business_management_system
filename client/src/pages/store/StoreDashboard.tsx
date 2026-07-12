/**
 * StoreDashboard — لوحة المتجر (hPanel، تبويب افتراضي): نظرة موحّدة (Single Pane of Glass)
 * على حالة الطلبات + أحدث الطلبات + مؤشّرات سريعة. يغذّيها نفس نقاط storeAdmin القائمة.
 */
import { ClipboardList, Image as ImageIcon, PackageCheck, ShoppingBag, Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { StatCard } from "@/components/StatCard";
import { PageHeader } from "@/components/PageHeader";

const ST_LABEL: Record<string, string> = {
  PENDING: "وارد", CONFIRMED: "مثبَّت", PROCESSING: "قيد التجهيز",
  SHIPPED: "مع المندوب", DELIVERED: "سُلّم", CANCELLED: "ملغى",
};

export default function StoreDashboard() {
  const countsQ = trpc.storeAdmin.orders.counts.useQuery();
  const recentQ = trpc.storeAdmin.orders.list.useQuery({ status: null, limit: 6 });
  const bannersQ = trpc.storeAdmin.banners.list.useQuery();

  const counts = countsQ.data ?? {};
  const recent = recentQ.data ?? [];
  const activeBanners = (bannersQ.data ?? []).filter((b) => b.isActive).length;
  const totalOrders = Object.values(counts).reduce((s, n) => s + n, 0);
  const openOrders = (counts.PENDING ?? 0) + (counts.CONFIRMED ?? 0) + (counts.PROCESSING ?? 0);

  return (
    <div className="space-y-4">
      <PageHeader title="لوحة المتجر" description="نظرة موحّدة على الطلبات والعروض" icon={<ShoppingBag aria-hidden className="size-5" />} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatCard label="إجمالي الطلبات" value={totalOrders} icon={ShoppingBag} />
        <StatCard label="طلبات مفتوحة" value={openOrders} icon={ClipboardList} tone="warning" />
        <StatCard label="مع المندوب" value={counts.SHIPPED ?? 0} icon={Truck} tone="info" />
        <StatCard label="سُلّم" value={counts.DELIVERED ?? 0} icon={PackageCheck} tone="positive" />
        <StatCard label="بنرات فعّالة" value={activeBanners} icon={ImageIcon} />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h3 className="mb-3 text-sm font-bold text-muted-foreground">أحدث الطلبات</h3>
        {recent.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">لا توجد طلبات بعد</p>
        ) : (
          <div className="divide-y divide-border">
            {recent.map((o) => (
              <div key={o.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-bold tracking-wider" dir="ltr">{o.orderNumber}</span>
                  <span className="mr-2 text-muted-foreground">{o.customerName ?? "—"}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums font-bold" dir="ltr">{fmtInt(o.total)} د.ع</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{ST_LABEL[o.status] ?? o.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

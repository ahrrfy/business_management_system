/**
 * StoreCustomers — «العملاء» في لوحة hPanel (تبويب مديري، للقراءة).
 * عملاء المتجر الإلكترونيّ (من لهم طلبٌ أونلاين) + مؤشّراتهم: عدد الطلبات، المُسلَّم، الإنفاق، آخر طلب،
 * آخر محافظة — مع بحث وفرز (أعلى إنفاقاً/أحدث/أكثر طلباً). إيرادٌ فقط بلا تكلفة/ربح (خطّ §٦).
 */
import { useState } from "react";
import { Loader2, MapPin, MessageCircle, PackageCheck, Repeat, Search, TrendingUp, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmt, fmtInt } from "@/lib/money";

type Sort = "spend" | "recent" | "orders";
const SORTS: { key: Sort; label: string }[] = [
  { key: "spend", label: "الأعلى إنفاقاً" },
  { key: "recent", label: "الأحدث" },
  { key: "orders", label: "الأكثر طلباً" },
];
const PAGE = 30;

/** ينظّف الهاتف لرابط wa.me (أرقام فقط، بلا +/مسافات). */
function waDigits(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export default function StoreCustomers() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("spend");
  const [limit, setLimit] = useState(PAGE);
  const listQ = trpc.storeAdmin.customers.list.useQuery({ q: q.trim() || undefined, sort, limit });

  const d = listQ.data;
  const rows = d?.rows ?? [];
  const summary = d?.summary;
  const total = d?.total ?? 0;
  const pct = (v: number) => `${Math.round(v * 100)}٪`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Users aria-hidden className="size-5 text-primary" /> عملاء المتجر</h2>
        <span className="text-xs text-muted-foreground">{fmtInt(total)} عميل</span>
      </div>

      {/* المؤشّرات */}
      {summary && summary.totalCustomers > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi icon={Users} label="عملاء المتجر" value={fmtInt(summary.totalCustomers)} unit="عميل" />
          <Kpi icon={Repeat} label="عملاء متكرّرون" value={fmtInt(summary.repeatCustomers)} unit={`(${pct(summary.repeatRate)})`} tone="positive" />
          <Kpi icon={TrendingUp} label="متوسّط الإنفاق" value={fmt(summary.avgSpend)} unit="د.ع" />
          <Kpi icon={TrendingUp} label="إجمالي الإيراد" value={fmt(summary.totalRevenue)} unit="د.ع" tone="primary" />
        </div>
      )}

      {/* بحث + فرز */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="ابحث بالاسم أو الهاتف…" className="w-full rounded-lg border border-border bg-background py-2 pr-10 pl-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
        </div>
        <div className="flex gap-1.5">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => { setSort(s.key); setLimit(PAGE); }} className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${sort === s.key ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-accent"}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* القائمة */}
      {listQ.isLoading ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <Users aria-hidden className="mx-auto mb-2 size-8 opacity-40" />
          {q ? "لا عميل مطابق." : "لا عملاء بعد — سيظهرون مع أوّل طلب في المتجر."}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <div key={c.customerId} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                {c.name.trim().charAt(0) || "؟"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-sm font-bold">{c.name}</p>
                  {c.lastGovernorate && <span className="flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"><MapPin aria-hidden className="size-2.5" /> {c.lastGovernorate}</span>}
                </div>
                <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  {c.phone ? (
                    <a href={`https://wa.me/${waDigits(c.phone)}`} target="_blank" rel="noopener noreferrer" dir="ltr" className="inline-flex items-center gap-1 font-medium text-emerald-600 hover:underline">
                      <MessageCircle aria-hidden className="size-3" /> {c.phone}
                    </a>
                  ) : <span>بلا هاتف</span>}
                  {c.lastOrderYmd && <span>· آخر طلب {c.lastOrderYmd}</span>}
                </p>
              </div>
              <div className="shrink-0 text-left">
                <div className="text-sm font-bold tabular-nums">{fmt(c.spend)} <span className="text-[10px] font-medium text-muted-foreground">د.ع</span></div>
                <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                  <PackageCheck aria-hidden className="size-3" /> {fmtInt(c.deliveredOrders)}/{fmtInt(c.orders)} طلب
                </div>
              </div>
            </div>
          ))}

          {rows.length < total && (
            <button onClick={() => setLimit((n) => n + PAGE)} disabled={listQ.isFetching} className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card py-3 text-sm font-bold text-muted-foreground transition hover:bg-accent disabled:opacity-50">
              {listQ.isFetching ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null} عرض المزيد ({fmtInt(total - rows.length)} متبقٍّ)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, unit, tone = "muted" }: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; label: string; value: string; unit?: string; tone?: "primary" | "positive" | "muted" }) {
  const toneCls = tone === "primary" ? "text-primary" : tone === "positive" ? "text-emerald-600" : "text-foreground";
  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon aria-hidden className="size-3.5" /> {label}
      </div>
      <div className={`flex items-baseline gap-1 ${toneCls}`}>
        <span className="text-xl font-bold tabular-nums">{value}</span>
        {unit && <span className="text-[11px] font-medium opacity-70">{unit}</span>}
      </div>
    </div>
  );
}

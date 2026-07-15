/**
 * StoreAnalytics — «التحليلات» في لوحة hPanel (تبويب مديري، للقراءة).
 * أداء المتجر الإلكترونيّ على مدى فترة: مؤشّرات (إيراد/عدد/متوسّط/تسليم/إلغاء) + اتّجاه يوميّ +
 * قُمع الحالات + أعلى المنتجات + التوزيع الجغرافيّ. إيرادٌ فقط — بلا تكلفة/ربح (خطّ §٦).
 */
import { useMemo, useState } from "react";
import { BarChart3, Eye, Loader2, MapPin, PackageCheck, ShoppingBag, ShoppingCart, TrendingUp, Trophy, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmt, fmtInt } from "@/lib/money";

const ST_LABEL: Record<string, string> = {
  PENDING: "وارد", CONFIRMED: "مثبَّت", PROCESSING: "قيد التجهيز",
  SHIPPED: "مع المندوب", DELIVERED: "سُلّم", CANCELLED: "ملغى",
};
const ST_ORDER = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"];
const ST_COLOR: Record<string, string> = {
  PENDING: "bg-amber-400", CONFIRMED: "bg-sky-400", PROCESSING: "bg-violet-400",
  SHIPPED: "bg-indigo-400", DELIVERED: "bg-emerald-500", CANCELLED: "bg-rose-400",
};

// النطاقات بحبيبة يوم بغداد (UTC+3) لتطابق تفسير الخادم — لا بمنطقة المتصفّح (قد تنزلق يوماً على جهازٍ
// بمنطقةٍ أخرى). نأخذ مكوّنات UTC للحظة (الآن + ٣ ساعات) فتكون التاريخَ التقويميّ ببغداد أياً كان المتصفّح.
const pad = (n: number) => String(n).padStart(2, "0");
function baghdadNow(offsetDays = 0): Date {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
}
function ymdBaghdad(offsetDays = 0): string {
  const t = baghdadNow(offsetDays);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function firstOfMonthBaghdad(): string {
  const t = baghdadNow();
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-01`;
}

type Preset = "7" | "30" | "month";
const PRESETS: { key: Preset; label: string; range: () => { fromYmd: string; toYmd: string } }[] = [
  { key: "7", label: "آخر ٧ أيام", range: () => ({ fromYmd: ymdBaghdad(-6), toYmd: ymdBaghdad() }) },
  { key: "30", label: "آخر ٣٠ يوماً", range: () => ({ fromYmd: ymdBaghdad(-29), toYmd: ymdBaghdad() }) },
  { key: "month", label: "هذا الشهر", range: () => ({ fromYmd: firstOfMonthBaghdad(), toYmd: ymdBaghdad() }) },
];

export default function StoreAnalytics() {
  const [preset, setPreset] = useState<Preset>("30");
  const range = useMemo(() => PRESETS.find((p) => p.key === preset)!.range(), [preset]);
  const q = trpc.storeAdmin.analytics.summary.useQuery(range);
  const d = q.data;
  const pct = (v: number) => `${Math.round(v * 100)}٪`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><BarChart3 aria-hidden className="size-5 text-primary" /> تحليلات المتجر</h2>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => setPreset(p.key)} className={`rounded-full px-3 py-1 text-xs font-bold transition ${preset === p.key ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-accent"}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-20 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
      ) : !d || (d.kpis.totalOrders === 0 && d.conversionFunnel.productViews === 0 && d.conversionFunnel.cartAdds === 0 && d.conversionFunnel.checkoutStarts === 0) ? (
        <div className="rounded-2xl border border-dashed border-border py-20 text-center text-sm text-muted-foreground">
          <BarChart3 aria-hidden className="mx-auto mb-2 size-8 opacity-40" />
          لا طلبات في هذه الفترة — ستظهر التحليلات مع أوّل طلب.
        </div>
      ) : (
        <>
          {/* المؤشّرات */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Kpi icon={TrendingUp} label="قيمة الطلبات" value={`${fmt(d.kpis.revenue)}`} unit="د.ع" tone="primary" hint={`المُسلَّم: ${fmt(d.kpis.deliveredRevenue)}`} />
            <Kpi icon={ShoppingBag} label="عدد الطلبات" value={fmtInt(d.kpis.activeOrders)} unit="طلب" hint={`إجمالي: ${fmtInt(d.kpis.totalOrders)}`} />
            <Kpi icon={BarChart3} label="متوسّط الطلب" value={fmt(d.kpis.aov)} unit="د.ع" />
            <Kpi icon={PackageCheck} label="نسبة التسليم" value={pct(d.kpis.fulfillmentRate)} tone="positive" hint={`${fmtInt(d.kpis.deliveredOrders)} مُسلَّم`} />
            <Kpi icon={XCircle} label="نسبة الإلغاء" value={pct(d.kpis.cancellationRate)} tone={d.kpis.cancellationRate > 0.2 ? "danger" : "muted"} hint={`${fmtInt(d.kpis.cancelledOrders)} ملغى`} />
          </div>

          <ConversionFunnel funnel={d.conversionFunnel} pct={pct} />

          {/* الاتّجاه اليوميّ */}
          <TrendChart trend={d.trend} />

          <div className="grid gap-4 lg:grid-cols-2">
            {/* قُمع الحالات */}
            <div className="rounded-2xl border border-border bg-card p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-muted-foreground"><ShoppingBag aria-hidden className="size-4" /> حالات الطلبات</h3>
              <div className="space-y-2">
                {ST_ORDER.filter((s) => (d.statusBreakdown[s] ?? 0) > 0).map((s) => {
                  const n = d.statusBreakdown[s] ?? 0;
                  const w = d.kpis.totalOrders > 0 ? Math.max((n / d.kpis.totalOrders) * 100, 3) : 0;
                  return (
                    <div key={s} className="flex items-center gap-2 text-xs">
                      <span className="w-20 shrink-0 text-muted-foreground">{ST_LABEL[s]}</span>
                      <div className="h-5 flex-1 overflow-hidden rounded-md bg-muted">
                        <div className={`h-full ${ST_COLOR[s]} rounded-md transition-all`} style={{ width: `${w}%` }} />
                      </div>
                      <span className="w-8 shrink-0 text-left font-bold tabular-nums">{fmtInt(n)}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* أعلى المنتجات */}
            <div className="rounded-2xl border border-border bg-card p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-muted-foreground"><Trophy aria-hidden className="size-4" /> الأكثر مبيعاً</h3>
              {d.topProducts.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">لا بيانات</p>
              ) : (
                <div className="space-y-1.5">
                  {d.topProducts.map((p, i) => (
                    <div key={p.productId} className="flex items-center gap-2 text-sm">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{fmtInt(p.qty)} قطعة</span>
                      <span className="w-24 shrink-0 text-left font-bold tabular-nums text-xs">{fmt(p.revenue)} د.ع</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* التوزيع الجغرافيّ */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-muted-foreground"><MapPin aria-hidden className="size-4" /> التوزيع حسب المحافظة</h3>
            {d.byGovernorate.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">لا بيانات</p>
            ) : (
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {d.byGovernorate.map((g) => {
                  const maxOrders = Math.max(...d.byGovernorate.map((x) => x.orders), 1);
                  return (
                    <div key={g.governorate} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 truncate text-muted-foreground">{g.governorate}</span>
                      <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                        <div className="h-full rounded bg-primary/60" style={{ width: `${(g.orders / maxOrders) * 100}%` }} />
                      </div>
                      <span className="w-8 shrink-0 text-left font-bold tabular-nums">{fmtInt(g.orders)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ConversionFunnel({ funnel, pct }: { funnel: { productViews: number; cartAdds: number; checkoutStarts: number; completedOrders: number; viewToCartRate: number; cartToCheckoutRate: number; checkoutToOrderRate: number }; pct: (v: number) => string }) {
  const steps = [
    { label: "مشاهدات المنتج", value: funnel.productViews, icon: Eye, hint: "حدث مجمّع بلا هوية زائر" },
    { label: "إضافة للسلة", value: funnel.cartAdds, icon: ShoppingCart, hint: `من المشاهدة: ${pct(funnel.viewToCartRate)}` },
    { label: "بدء الدفع", value: funnel.checkoutStarts, icon: ShoppingBag, hint: `من السلة: ${pct(funnel.cartToCheckoutRate)}` },
    { label: "طلبات مكتملة", value: funnel.completedOrders, icon: PackageCheck, hint: `من الدفع: ${pct(funnel.checkoutToOrderRate)}` },
  ];
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-bold text-muted-foreground"><TrendingUp aria-hidden className="size-4" /> قمع التحويل</div>
      <div className="grid gap-2 sm:grid-cols-4">
        {steps.map(({ label, value, icon: Icon, hint }) => (
          <div key={label} className="rounded-xl bg-muted/50 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Icon aria-hidden className="size-3.5" /> {label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{fmtInt(value)}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Kpi({ icon: Icon, label, value, unit, hint, tone = "muted" }: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; label: string; value: string; unit?: string; hint?: string; tone?: "primary" | "positive" | "danger" | "muted" }) {
  const toneCls = tone === "primary" ? "text-primary" : tone === "positive" ? "text-emerald-600" : tone === "danger" ? "text-rose-600" : "text-foreground";
  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon aria-hidden className="size-3.5" /> {label}
      </div>
      <div className={`flex items-baseline gap-1 ${toneCls}`}>
        <span className="text-xl font-bold tabular-nums">{value}</span>
        {unit && <span className="text-[11px] font-medium opacity-70">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function TrendChart({ trend }: { trend: { ymd: string; orders: number; revenue: string }[] }) {
  const maxRev = Math.max(...trend.map((t) => Number(t.revenue)), 1);
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold text-muted-foreground"><TrendingUp aria-hidden className="size-4" /> إيراد الطلبات اليوميّ</h3>
      <div className="flex h-32 items-end gap-0.5 overflow-x-auto" dir="ltr">
        {trend.map((t) => {
          const h = Math.max((Number(t.revenue) / maxRev) * 100, t.revenue !== "0.00" ? 4 : 0);
          return (
            <div key={t.ymd} className="group relative flex min-w-[6px] flex-1 flex-col items-center justify-end" title={`${t.ymd}: ${fmt(t.revenue)} د.ع · ${t.orders} طلب`}>
              <div className="w-full rounded-t bg-primary/70 transition-all group-hover:bg-primary" style={{ height: `${h}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground" dir="ltr">
        <span>{trend[0]?.ymd}</span>
        <span>{trend[trend.length - 1]?.ymd}</span>
      </div>
    </div>
  );
}

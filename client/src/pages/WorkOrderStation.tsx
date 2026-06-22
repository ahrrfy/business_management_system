import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { fmtInt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

/**
 * محطة فني التنفيذ — `/work-orders/station` (دور print_operator + الكاشير/المدير).
 *
 * الغرض: ينفّذ الفني أوامره المُسنَدة إليه فقط، ويسحب من الطابور العام المشترك. لا تسعير ولا تكلفة
 * (إخفاءٌ متّسق مع canSeeCost — الخادم يُخفي materialsCost/laborCost/unitCost عن الفني أصلاً).
 *
 * السلامة: الإجراء النهائي هنا = «جاهز للتسليم» (markReady). التسليم وإصدار الفاتورة وقبض النقد
 * يبقيان للكاشير/المدير (cashierProcedure) — أقلّ امتياز، فلا يُصدر الفني فواتير ولا يمسّ الصندوق.
 *
 * المؤقّت: مشتقّ من سجلّ التدقيق (حدث workOrder.start → workOrder.markReady) بلا عمود جديد ولا هجرة.
 */

type WO = RouterOutputs["workOrders"]["list"][number];

const CHANNELS: Record<string, { label: string; icon: string }> = {
  WHATSAPP: { label: "واتساب", icon: "💬" },
  INSTAGRAM: { label: "انستغرام", icon: "📷" },
  TIKTOK: { label: "تيك توك", icon: "🎵" },
  PHONE: { label: "اتصال", icon: "📞" },
  WALK_IN: { label: "عميل نقدي", icon: "🏪" },
  OTHER: { label: "أخرى", icon: "✳️" },
};
const PRIORITIES: Record<string, { label: string; cls: string }> = {
  URGENT: { label: "عاجل", cls: "bg-destructive/10 text-destructive border-destructive/30" },
  NORMAL: { label: "عادي", cls: "bg-sky-500/10 text-sky-700 border-sky-500/30" },
  LOW: { label: "منخفض", cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30" },
};
const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "بانتظار البدء", IN_PROGRESS: "قيد التنفيذ", READY: "جاهز للتسليم", DELIVERED: "مُسلَّم", CANCELLED: "ملغى",
};
const STAGES: { key: string; label: string }[] = [
  { key: "RECEIVED", label: "مسحوب" },
  { key: "IN_PROGRESS", label: "قيد التنفيذ" },
  { key: "READY", label: "جاهز للتسليم" },
];
const STAGE_INDEX: Record<string, number> = { RECEIVED: 0, IN_PROGRESS: 1, READY: 2, DELIVERED: 3 };

function pad2(n: number) { return String(n).padStart(2, "0"); }
function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** مؤقّت تنفيذ حيّ — يدقّ كل ثانية أثناء التنفيذ، ويتجمّد عند «جاهز». */
function ElapsedTimer({ startAt, endAt }: { startAt: Date | null; endAt: Date | null }) {
  const live = startAt != null && endAt == null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!startAt) {
    return <div className="text-2xl font-bold tabular-nums text-muted-foreground" dir="ltr">--:--:--</div>;
  }
  const ms = (endAt ? endAt.getTime() : now) - startAt.getTime();
  return (
    <div className="flex items-center gap-2">
      {live && <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />}
      <div className={`text-2xl font-bold tabular-nums ${live ? "text-emerald-700" : ""}`} dir="ltr">{fmtElapsed(ms)}</div>
    </div>
  );
}

function OrderRow({ o, active, onClick, mine }: { o: WO; active: boolean; onClick: () => void; mine?: boolean }) {
  const ch = CHANNELS[o.receptionChannel ?? "WALK_IN"] ?? CHANNELS.OTHER;
  const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-right rounded-lg border p-2.5 transition-colors ${active ? "border-primary bg-primary/5" : "hover:bg-accent"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">{o.orderNumber}</span>
        <Badge variant="outline" className={`text-[10px] ${pri.cls}`}>{pri.label}</Badge>
      </div>
      <div className="font-medium text-sm mt-0.5 line-clamp-1">{o.title}</div>
      <div className="flex items-center justify-between mt-1 text-[11px] text-muted-foreground">
        <span title={ch.label}><span role="img" aria-label={ch.label}>{ch.icon}</span> {o.customerName ?? "عميل نقدي"}</span>
        {mine ? <span>{STATUS_LABEL[o.status]}</span> : <span className="text-amber-600">سحب ←</span>}
      </div>
    </button>
  );
}

function StationDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const detail = trpc.workOrders.get.useQuery({ workOrderId: id });
  const timeline = trpc.workOrders.timeline.useQuery({ workOrderId: id });
  const utils = trpc.useUtils();
  const [lightbox, setLightbox] = useState<string | null>(null);

  const invalidate = () => Promise.all([
    utils.workOrders.list.invalidate(),
    utils.workOrders.get.invalidate({ workOrderId: id }),
    utils.workOrders.timeline.invalidate({ workOrderId: id }),
    utils.inventory.movements.invalidate(),
  ]).then(onChanged);

  const start = trpc.workOrders.start.useMutation({
    onSuccess: () => { notify.warn("بدأ التنفيذ", "خُصمت المواد المطلوبة من المخزون."); invalidate(); },
    onError: (e) => notify.err(e),
  });
  const markReady = trpc.workOrders.markReady.useMutation({
    onSuccess: () => { notify.ok("جاهز للتسليم", "سلّمه للكاشير للتسليم وإصدار الفاتورة."); invalidate(); },
    onError: (e) => notify.err(e),
  });
  const busy = start.isPending || markReady.isPending;

  const d = detail.data ?? null;

  // المؤقّت من سجلّ التدقيق: حدث البدء → حدث الجاهزية.
  const { startAt, endAt } = useMemo(() => {
    const rows = timeline.data ?? [];
    const s = rows.find((r) => r.action === "workOrder.start");
    const e = rows.find((r) => r.action === "workOrder.markReady" || r.action === "workOrder.deliver");
    const startAt = s?.createdAt ? new Date(s.createdAt as unknown as string) : null;
    let endAt: Date | null = e?.createdAt ? new Date(e.createdAt as unknown as string) : null;
    // قيد التنفيذ بلا حدث جاهزية ⇒ حيّ (endAt = null).
    if (d?.status === "IN_PROGRESS") endAt = null;
    return { startAt, endAt };
  }, [timeline.data, d?.status]);

  if (!d) {
    return <div className="grid place-items-center h-full text-muted-foreground">{detail.isLoading ? "جارٍ التحميل…" : "اختر أمراً من القائمة."}</div>;
  }

  const ch = CHANNELS[d.receptionChannel ?? "WALK_IN"] ?? CHANNELS.OTHER;
  const pri = PRIORITIES[d.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
  const cur = STAGE_INDEX[d.status] ?? 0;

  async function doStart() {
    if (!(await confirm({ variant: "warning", title: "بدء التنفيذ", description: `بدء تنفيذ «${d!.title}» يخصم المواد المطلوبة من المخزون تلقائياً. متابعة؟`, confirmText: "بدء التنفيذ", cancelText: "تراجع" }))) return;
    start.mutate({ workOrderId: d!.id });
  }
  async function doReady() {
    if (!(await confirm({ variant: "info", title: "وضع علامة: جاهز للتسليم", description: `وضع «${d!.title}» جاهزاً للتسليم. سيُسلّمه الكاشير ويُصدر الفاتورة. متابعة؟`, confirmText: "جاهز للتسليم", cancelText: "تراجع" }))) return;
    markReady.mutate({ workOrderId: d!.id });
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* رأس */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-mono text-[11px] text-muted-foreground" dir="ltr">{d.orderNumber}</div>
          <h2 className="text-xl font-bold"><span role="img" aria-label={ch.label}>{ch.icon}</span> {d.title}</h2>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            <Badge variant="outline" className={pri.cls}>{pri.label}</Badge>
            <span>{ch.label}{d.channelHandle ? ` · ${d.channelHandle}` : ""}</span>
            <span>· {d.customerName ?? "عميل نقدي"}</span>
          </div>
        </div>
        <div className="text-left">
          <div className="text-[11px] text-muted-foreground">الاستحقاق</div>
          <div className="font-medium" dir="ltr">{fmtDate(d.dueDate)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* المحتوى */}
        <div className="lg:col-span-2 space-y-4">
          {/* مواصفات التنفيذ */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">مواصفات التنفيذ</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="text-[11px] text-muted-foreground">الكمية</div><div className="font-medium">{fmtInt(d.quantity)}</div></div>
              <div><div className="text-[11px] text-muted-foreground">الحالة</div><div className="font-medium">{STATUS_LABEL[d.status]}</div></div>
              {d.customizationText && (
                <div className="col-span-2">
                  <div className="text-[11px] text-muted-foreground">نصّ التخصيص</div>
                  <div className="rounded-md border bg-muted/30 p-2 mt-0.5 whitespace-pre-wrap">{d.customizationText}</div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* صور نموذج العمل */}
          {d.images && d.images.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">نموذج العمل — صور العميل ({d.images.length})</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {d.images.map((im) => (
                    <button key={im.id} type="button" onClick={() => setLightbox(im.url)} className="aspect-square rounded-md overflow-hidden border hover:ring-2 hover:ring-primary">
                      <img src={im.url} alt={im.caption ?? ""} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* المواد المطلوبة من المخزون (بلا تكلفة — مُخفاة عن الفني) */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">المواد المطلوبة من المخزون</CardTitle></CardHeader>
            <CardContent className="p-0">
              {d.materials && d.materials.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="bg-muted/50"><tr className="text-right">
                    <th className="p-2">المادة</th><th className="p-2">SKU</th><th className="p-2 text-center">الكمية (أساس)</th>
                  </tr></thead>
                  <tbody>
                    {d.materials.map((m) => (
                      <tr key={m.id} className="border-t">
                        <td className="p-2">{m.productName ?? "—"}{m.variantName ? ` · ${m.variantName}` : ""}</td>
                        <td className="p-2 font-mono text-xs" dir="ltr">{m.sku ?? "—"}</td>
                        <td className="p-2 text-center tabular-nums">{fmtInt(m.baseQuantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-4 text-center text-muted-foreground text-sm">لا مواد محدّدة — خدمة تخصيص بلا استهلاك مخزون.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* العمود الجانبي: المؤقّت + المراحل + الإجراء */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">مؤقّت التنفيذ</CardTitle></CardHeader>
            <CardContent>
              <ElapsedTimer startAt={startAt} endAt={endAt} />
              <div className="text-[11px] text-muted-foreground mt-1">
                {d.status === "IN_PROGRESS" ? "يعمل الآن" : startAt ? "زمن التنفيذ الإجمالي" : "لم يبدأ بعد"}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">المراحل</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {STAGES.map((s, i) => (
                <div key={s.key} className="flex items-center gap-2">
                  <div className={`w-5 h-5 rounded-md grid place-items-center text-[11px] text-white ${i < cur ? "bg-emerald-500" : i === cur ? "bg-primary" : "bg-muted-foreground/30"}`}>{i < cur ? "✓" : i + 1}</div>
                  <span className={`text-sm ${i === cur ? "font-semibold" : "text-muted-foreground"}`}>{s.label}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* زر الإجراء المتدرّج */}
          {d.status === "RECEIVED" && (
            <Button className="w-full h-12 text-base" disabled={busy} onClick={doStart}>▶ بدء التنفيذ (خصم المواد)</Button>
          )}
          {d.status === "IN_PROGRESS" && (
            <Button className="w-full h-12 text-base bg-violet-600 hover:bg-violet-700" disabled={busy} onClick={doReady}>✓ وضع علامة: جاهز</Button>
          )}
          {d.status === "READY" && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-center text-sm">
              ✅ جاهز للتسليم — سلّمه للكاشير للتسليم وإصدار الفاتورة.
            </div>
          )}
          {(d.status === "DELIVERED" || d.status === "CANCELLED") && (
            <div className="rounded-lg border bg-muted/30 p-3 text-center text-sm text-muted-foreground">{STATUS_LABEL[d.status]}</div>
          )}
        </div>
      </div>

      {/* lightbox الصورة */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 grid place-items-center p-6" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}

export default function WorkOrderStation() {
  const me = trpc.auth.me.useQuery();
  const list = trpc.workOrders.list.useQuery({ limit: 200 });
  const utils = trpc.useUtils();
  const [selId, setSelId] = useState<number | null>(null);

  const myId = me.data?.id ? Number(me.data.id) : null;
  const all = list.data ?? [];

  const mine = useMemo(
    () => all.filter((o) => o.assignedTo && myId != null && Number(o.assignedTo) === myId && o.status !== "DELIVERED" && o.status !== "CANCELLED"),
    [all, myId],
  );
  const queue = useMemo(() => all.filter((o) => o.status === "RECEIVED" && !o.assignedTo), [all]);

  useEffect(() => {
    if (selId == null && mine.length) setSelId(mine[0].id);
  }, [mine, selId]);

  const claim = trpc.workOrders.claim.useMutation({
    onSuccess: (r) => { notify.ok("سُحب الأمر إلى قائمتك"); setSelId(r.workOrderId); utils.workOrders.list.invalidate(); },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-7rem)]">
      {/* القائمة الجانبية */}
      <div className="lg:w-[300px] lg:flex-none flex flex-col gap-3 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">محطة التنفيذ</h1>
          <Link href="/work-orders" className="text-xs text-muted-foreground">اللوحة ←</Link>
        </div>

        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">أوامري ({mine.length})</div>
          <div className="space-y-2">
            {mine.map((o) => <OrderRow key={o.id} o={o} mine active={selId === o.id} onClick={() => setSelId(o.id)} />)}
            {mine.length === 0 && <div className="text-xs text-muted-foreground border rounded-lg p-3 text-center">لا أوامر مُسنَدة إليك — اسحب من الطابور العام أدناه.</div>}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">⤵ الطابور العام — مشترك للجميع ({queue.length})</div>
          <div className="space-y-2">
            {queue.map((o) => (
              <div key={o.id} className="relative">
                <OrderRow o={o} active={selId === o.id} onClick={() => setSelId(o.id)} />
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute bottom-2 left-2 h-6 text-[11px]"
                  disabled={claim.isPending}
                  onClick={(e) => { e.stopPropagation(); claim.mutate({ workOrderId: o.id }); }}
                >سحب</Button>
              </div>
            ))}
            {queue.length === 0 && <div className="text-xs text-muted-foreground border rounded-lg p-3 text-center">الطابور فارغ.</div>}
          </div>
        </div>
      </div>

      {/* لوحة التفاصيل */}
      <div className="flex-1 min-w-0 border rounded-xl bg-card overflow-hidden">
        {selId != null ? (
          <StationDetail id={selId} onChanged={() => { /* القوائم تُبطَّل داخلياً */ }} />
        ) : (
          <div className="grid place-items-center h-full text-muted-foreground">اختر أمراً من القائمة لبدء التنفيذ.</div>
        )}
      </div>
    </div>
  );
}

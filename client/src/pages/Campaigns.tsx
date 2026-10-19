import { useMemo, useState } from "react";
import { FILTER_LABELS } from "@shared/uiContracts";
import { ACTION_LABELS } from "@shared/actionLabels";
import { CalendarClock, Download, Plus, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { Field } from "@/components/product/variantBits";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { canSeeGate } from "@/lib/navVisibility";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { exportRows } from "@/lib/export";

const NEXT: Record<string, string[]> = { DRAFT:["REVIEW","ENDED"], REVIEW:["DRAFT","APPROVED","ENDED"], APPROVED:["SCHEDULED","ACTIVE","ENDED"], SCHEDULED:["ACTIVE","PAUSED","ENDED"], ACTIVE:["PAUSED","ENDED"], PAUSED:["ACTIVE","ENDED"], ENDED:[] };
const LABEL: Record<string,string> = { DRAFT:"مسوّدة", REVIEW:"للمراجعة", APPROVED:"معتمدة", SCHEDULED:"مجدولة", ACTIVE:"نشطة", PAUSED:"موقوفة", ENDED:"منتهية" };

function campaignStatusBadgeClass(status: string) {
  switch (status) {
    case "ACTIVE":
      return "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30";
    case "APPROVED":
    case "SCHEDULED":
      return "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30";
    case "PAUSED":
    case "REVIEW":
      return "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/30";
    case "ENDED":
    case "DRAFT":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function todayYmd() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function toYmd(value: unknown) { return value == null ? "" : value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10); }
function transitionLabel(status: string) {
  return status === "REVIEW" ? "إرسال للمراجعة" : status === "DRAFT" ? "إعادة للمسوّدة" : status === "APPROVED" ? "اعتماد الحملة" : status === "SCHEDULED" ? "وضع في الجدولة" : status === "ACTIVE" ? "تشغيل الحملة" : status === "PAUSED" ? "إيقاف مؤقت" : status === "ENDED" ? "إنهاء الحملة" : LABEL[status] ?? status;
}
function campaignWindow(startsOn: unknown, endsOn: unknown, today: string) {
  const starts = toYmd(startsOn); const ends = toYmd(endsOn);
  if (ends && ends < today) return { label:"انتهت نافذتها", detail:`انتهت في ${ends}`, className:"bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30" };
  if (starts && starts > today) return { label:"تبدأ لاحقاً", detail:`تبدأ في ${starts}`, className:"bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30" };
  if (!starts && !ends) return { label:"بلا مدة", detail:"لا توجد نافذة تاريخية محددة", className:"bg-muted text-muted-foreground border-border" };
  return { label:"ضمن نافذتها", detail:`${starts || "بلا بداية"} — ${ends || "مستمرة"}`, className:"bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30" };
}

export default function Campaigns() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canManage = canSeeGate({ roles:["manager"], module:"campaigns", level:"FULL" }, me.data?.role, (me.data?.permissionsOverride??null) as any);
  const list = trpc.crm.campaigns.list.useQuery();
  const offers = trpc.salesPromotions.list.useQuery({ includeInactive: true });
  const [f, setF, resetF] = useUrlFilters({ q: "", status: "" });
  const [show, setShow] = useState(false);
  const [name,setName]=useState(""); const [objective,setObjective]=useState(""); const [startsOn,setStarts]=useState(""); const [endsOn,setEnds]=useState("");
  // حارس فقد بيانات: النموذج يظهر بأزرار «حملة جديدة»، وأيّ حقل مكتوب يستحقّ التحذير قبل مغادرة الصفحة.
  const isFormDirty = show && (name.trim() !== "" || objective.trim() !== "" || startsOn !== "" || endsOn !== "");
  useUnsavedGuard(isFormDirty);
  const create = trpc.crm.campaigns.create.useMutation({ onSuccess: async()=>{await utils.crm.campaigns.list.invalidate();await utils.crm.dashboard.invalidate();setShow(false);setName("");setObjective("");setStarts("");setEnds("");notify.ok("تم إنشاء الحملة");}, onError:e=>notify.err(e) });
  const transition = trpc.crm.campaigns.transition.useMutation({ onSuccess: async()=>{await utils.crm.campaigns.list.invalidate();await utils.crm.dashboard.invalidate();}, onError:e=>notify.err(e) });

  const rows = useMemo(() => {
    const needle = f.q.trim().toLowerCase();
    return (list.data ?? []).filter((c) => {
      if (f.status && c.status !== f.status) return false;
      if (!needle) return true;
      return c.name.toLowerCase().includes(needle) || (c.objective ?? "").toLowerCase().includes(needle);
    });
  }, [list.data, f.q, f.status]);
  const filtersActive = f.q.trim() !== "" || f.status !== "";
  const today = todayYmd();
  const offersByCampaign = useMemo(() => {
    const result = new Map<number, { total:number; active:number; live:number }>();
    for (const offer of offers.data ?? []) { if (offer.campaignId != null) { const summary = result.get(Number(offer.campaignId)) ?? { total:0, active:0, live:0 }; summary.total += 1; if (offer.isActive) { summary.active += 1; if (toYmd(offer.effectiveFrom) <= today && (!offer.effectiveTo || toYmd(offer.effectiveTo) >= today)) summary.live += 1; } result.set(Number(offer.campaignId), summary); } }
    return result;
  }, [offers.data, today]);
  const operations = useMemo(() => {
    const campaigns = list.data ?? [];
    return { active: campaigns.filter(c=>c.status === "ACTIVE").length, awaitingDecision: campaigns.filter(c=>c.status === "REVIEW" || c.status === "APPROVED").length, scheduled: campaigns.filter(c=>c.status === "SCHEDULED").length, withoutLiveOffers: campaigns.filter(c=>(c.status === "SCHEDULED" || c.status === "ACTIVE") && (offersByCampaign.get(c.id)?.live ?? 0) === 0).length };
  }, [list.data, offersByCampaign]);

  const handleExport = (format: "xlsx" | "csv") => {
    exportRows(rows, {
      filename: `الحملات_الإعلانية_${today}`,
      format,
      title: "سجل الحملات الإعلانية والترويجية",
      columns: [
        { key: "name", header: "اسم الحملة" },
        { key: "status", header: "الحالة", map: (r) => LABEL[r.status] ?? r.status },
        { key: "objective", header: "الهدف", map: (r) => r.objective ?? "—" },
        { key: "startsOn", header: "تاريخ البدء", map: (r) => toYmd(r.startsOn) || "—" },
        { key: "endsOn", header: "تاريخ الانتهاء", map: (r) => toYmd(r.endsOn) || "—" },
        { key: "window", header: "نافذة التخطيط", map: (r) => campaignWindow(r.startsOn, r.endsOn, today).label },
        { key: "linkedOffers", header: "العروض المرتبطة", map: (r) => offersByCampaign.get(r.id)?.total ?? 0 },
        { key: "liveOffers", header: "العروض السارية", map: (r) => offersByCampaign.get(r.id)?.live ?? 0 },
      ],
    });
  };

  return <div className="max-w-6xl mx-auto space-y-4 pb-8"><PageHeader title="الحملات الإعلانية" description="سجلّ الهدف والاعتماد والجدولة الذي يربط العروض والكوبونات والنتائج." actions={canManage?<Button onClick={()=>setShow(v=>!v)}><Plus className="size-4"/> حملة جديدة</Button>:undefined}/>
    <Card><CardContent className="flex items-start gap-3 p-4 text-sm"><CalendarClock aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground"/><div><div className="font-medium">الجدولة وقرار التشغيل منفصلان</div><p className="mt-1 text-muted-foreground">تاريخا الحملة يحددان نافذة التخطيط، أمّا الاعتماد والتشغيل والإيقاف فتُدار من أزرار الحالة. الحملة لا تفعّل أو توقف العروض المرتبطة تلقائياً؛ لكل عرض نافذته وتفعيله الخاصان.</p></div></CardContent></Card>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="حملات نشطة" value={operations.active} note="قرار التشغيل الحالي"/><Metric label="بانتظار قرار" value={operations.awaitingDecision} note="مراجعة أو اعتماد"/><Metric label="مجدولة" value={operations.scheduled} note="جاهزة لقرار التشغيل"/><Metric label="بلا عرض سارٍ الآن" value={operations.withoutLiveOffers} note="لن تنتج خصماً الآن"/></div>
    {show&&<Card><CardHeader><CardTitle className="text-base">حملة جديدة</CardTitle></CardHeader><CardContent className="grid md:grid-cols-2 gap-4"><Field label="اسم الحملة" required className="md:col-span-2"><Input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="الهدف" className="md:col-span-2"><Textarea value={objective} onChange={e=>setObjective(e.target.value)} rows={3}/></Field><Field label="تبدأ" hint="نافذة تخطيط؛ لا تشغّل الحملة تلقائياً"><Input type="date" value={startsOn} onChange={e=>setStarts(e.target.value)}/></Field><Field label="تنتهي" hint="راجع قرار الإنهاء عند بلوغ التاريخ"><Input type="date" value={endsOn} onChange={e=>setEnds(e.target.value)}/></Field><div className="md:col-span-2 flex justify-end"><Button disabled={!name.trim()||create.isPending} onClick={()=>create.mutate({name,objective:objective||null,startsOn:startsOn||null,endsOn:endsOn||null})}>حفظ المسوّدة</Button></div></CardContent></Card>}

    <Card><CardContent className="p-3 flex flex-wrap items-center gap-2">
      <UnifiedSearchInput value={f.q} onChange={(val)=>setF({q:val})} placeholder="بحث بالاسم أو الهدف…" aria-label="بحث في الحملات" className="h-9 w-full sm:w-64" wrapperClassName="min-w-48 flex-1 sm:flex-none" barcode={false} />
      <AppSelect value={f.status} onValueChange={(v)=>setF({status:v})} className="h-9 w-40" placeholder="كل الحالات">
        <option value="">كل الحالات</option>
        {Object.entries(LABEL).map(([k,l])=><option key={k} value={k}>{l}</option>)}
      </AppSelect>
      {filtersActive && <Button variant="ghost" size="sm" onClick={resetF} className="text-muted-foreground"><X aria-hidden className="size-4"/> {FILTER_LABELS.reset}</Button>}
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => handleExport("xlsx")} className="gap-1.5 h-9">
          <Download aria-hidden className="size-3.5" /> Excel
        </Button>
        <Button variant="outline" size="sm" onClick={() => handleExport("csv")} className="gap-1.5 h-9">
          <Download aria-hidden className="size-3.5" /> CSV
        </Button>
      </div>
      <span className="text-xs text-muted-foreground ms-auto">{list.isLoading ? ACTION_LABELS.loading : `${rows.length.toLocaleString("ar-IQ-u-nu-latn")} حملة`}</span>
    </CardContent></Card>

    <div className="grid gap-3">{rows.map(c=>{ const window = campaignWindow(c.startsOn,c.endsOn,today); const linkedOffers = offersByCampaign.get(c.id) ?? { total:0, active:0, live:0 }; const needsOffer = (c.status === "SCHEDULED" || c.status === "ACTIVE") && linkedOffers.live === 0; return <Card key={c.id}><CardContent className="p-4 flex flex-col md:flex-row md:items-center gap-3"><div className="flex-1"><div className="flex flex-wrap items-center gap-2"><b>{c.name}</b><Badge variant="outline" className={campaignStatusBadgeClass(c.status)}>{LABEL[c.status]}</Badge><Badge variant="outline" className={window.className}>{window.label}</Badge></div>{c.objective&&<p className="text-sm text-muted-foreground mt-1">{c.objective}</p>}<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>نافذة التخطيط: {window.detail}</span><span>العروض المرتبطة: {linkedOffers.total}، النشطة: {linkedOffers.active}، السارية: {linkedOffers.live}</span></div>{needsOffer&&<p className="mt-2 text-xs text-[var(--sem-warn)]">لا يوجد عرض مرتبط سارٍ الآن؛ تشغيل الحملة وحده لا يطبّق خصماً على المبيعات.</p>}</div>{canManage&&<div className="flex flex-wrap gap-2">{(NEXT[c.status]??[]).map(status=><Button key={status} size="sm" variant={status==="ENDED"?"destructive":"outline"} disabled={transition.isPending} onClick={()=>transition.mutate({id:c.id,status:status as any})}>{transitionLabel(status)}</Button>)}</div>}</CardContent></Card>; })}{rows.length===0&&<div className="text-center py-16 text-muted-foreground">{list.data?.length?"لا حملات مطابقة للفلاتر.":"لا حملات بعد."}</div>}</div>
  </div>;
}

function Metric({ label, value, note }: { label:string; value:number; note:string }) { return <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-bold tabular-nums">{value.toLocaleString("ar-IQ-u-nu-latn")}</div><div className="mt-1 text-xs text-muted-foreground">{note}</div></CardContent></Card>; }

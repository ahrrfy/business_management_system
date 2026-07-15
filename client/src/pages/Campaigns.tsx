import { useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/product/variantBits";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { canSeeGate } from "@/lib/navVisibility";

const NEXT: Record<string, string[]> = { DRAFT:["REVIEW","ENDED"], REVIEW:["DRAFT","APPROVED","ENDED"], APPROVED:["SCHEDULED","ACTIVE","ENDED"], SCHEDULED:["ACTIVE","PAUSED","ENDED"], ACTIVE:["PAUSED","ENDED"], PAUSED:["ACTIVE","ENDED"], ENDED:[] };
const LABEL: Record<string,string> = { DRAFT:"مسودة", REVIEW:"للمراجعة", APPROVED:"معتمدة", SCHEDULED:"مجدولة", ACTIVE:"نشطة", PAUSED:"موقوفة", ENDED:"منتهية" };

export default function Campaigns() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canManage = canSeeGate({ roles:["manager"], module:"campaigns", level:"FULL" }, me.data?.role, (me.data?.permissionsOverride??null) as any);
  const list = trpc.crm.campaigns.list.useQuery();
  const [show, setShow] = useState(false);
  const [name,setName]=useState(""); const [objective,setObjective]=useState(""); const [startsOn,setStarts]=useState(""); const [endsOn,setEnds]=useState("");
  const create = trpc.crm.campaigns.create.useMutation({ onSuccess: async()=>{await utils.crm.campaigns.list.invalidate();await utils.crm.dashboard.invalidate();setShow(false);setName("");setObjective("");setStarts("");setEnds("");notify.ok("تم إنشاء الحملة");}, onError:e=>notify.err(e) });
  const transition = trpc.crm.campaigns.transition.useMutation({ onSuccess: async()=>{await utils.crm.campaigns.list.invalidate();await utils.crm.dashboard.invalidate();}, onError:e=>notify.err(e) });
  return <div className="max-w-6xl mx-auto space-y-4 pb-8"><PageHeader title="الحملات" description="مظلّة الهدف والمدة والاعتماد التي تربط العروض والكوبونات والنتائج." actions={canManage?<Button onClick={()=>setShow(v=>!v)}><Plus className="size-4"/> حملة جديدة</Button>:undefined}/>
    {show&&<Card><CardHeader><CardTitle className="text-base">حملة جديدة</CardTitle></CardHeader><CardContent className="grid md:grid-cols-2 gap-4"><Field label="اسم الحملة" required className="md:col-span-2"><Input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="الهدف" className="md:col-span-2"><Textarea value={objective} onChange={e=>setObjective(e.target.value)} rows={3}/></Field><Field label="تبدأ"><Input type="date" value={startsOn} onChange={e=>setStarts(e.target.value)}/></Field><Field label="تنتهي"><Input type="date" value={endsOn} onChange={e=>setEnds(e.target.value)}/></Field><div className="md:col-span-2 flex justify-end"><Button disabled={!name.trim()||create.isPending} onClick={()=>create.mutate({name,objective:objective||null,startsOn:startsOn||null,endsOn:endsOn||null})}>حفظ المسودة</Button></div></CardContent></Card>}
    <div className="grid gap-3">{(list.data??[]).map(c=><Card key={c.id}><CardContent className="p-4 flex flex-col md:flex-row md:items-center gap-3"><div className="flex-1"><div className="flex items-center gap-2"><b>{c.name}</b><Badge variant={c.status==="ACTIVE"?"default":"secondary"}>{LABEL[c.status]}</Badge></div>{c.objective&&<p className="text-sm text-muted-foreground mt-1">{c.objective}</p>}<div className="text-xs text-muted-foreground mt-2">{c.startsOn?String(c.startsOn).slice(0,10):"بلا بداية"} — {c.endsOn?String(c.endsOn).slice(0,10):"مستمرة"}</div></div><div className="flex flex-wrap gap-2">{(NEXT[c.status]??[]).map(status=><Button key={status} size="sm" variant={status==="ENDED"?"destructive":"outline"} disabled={transition.isPending} onClick={()=>transition.mutate({id:c.id,status:status as any})}>{LABEL[status]}</Button>)}</div></CardContent></Card>)}{list.data?.length===0&&<div className="text-center py-16 text-muted-foreground">لا حملات بعد.</div>}</div>
  </div>;
}

import { useEffect, useMemo, useState } from "react";
import { Plus, Printer, Ticket, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/product/variantBits";
import { Badge } from "@/components/ui/badge";
import { notify } from "@/lib/notify";
import { printCouponCards } from "@/lib/printing/couponCard";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { TablePager } from "@/components/table/TablePager";

type IssuedCoupon=RouterOutputs["crm"]["coupons"]["listIssued"]["rows"][number];
/** حجم صفحة الإصدارات — سقف الخادم ٥٠٠. */
const PAGE_SIZE=50;
function today(){return new Date().toISOString().slice(0,10)}
export default function Coupons(){
  const utils=trpc.useUtils(); const programs=trpc.crm.coupons.programs.useQuery(); const campaigns=trpc.crm.campaigns.list.useQuery(); const offers=trpc.salesPromotions.list.useQuery({includeInactive:false});
  const couponOffers=useMemo(()=>(offers.data??[]).filter(o=>o.applicationMode==="COUPON"),[offers.data]);
  const [show,setShow]=useState(false); const [promotionId,setPromotionId]=useState(""); const [campaignId,setCampaignId]=useState(""); const [name,setName]=useState(""); const [validFrom,setFrom]=useState(today()); const [validTo,setTo]=useState(""); const [prefix,setPrefix]=useState("CRM"); const [title,setTitle]=useState("هدية خاصة لك"); const [subtitle,setSubtitle]=useState(""); const [terms,setTerms]=useState(""); const [color,setColor]=useState("#0D6B52"); const [selected,setSelected]=useState<number|null>(null); const [count,setCount]=useState("10"); const [printing,setPrinting]=useState(false);
  // ترقيم خادميّ: كان يُحمّل كل إصدارات البرنامج دفعةً (كوبون لكل عميل × حملة ⇒ بلا سقف).
  const [page,setPage]=useState(0);
  useEffect(()=>{setPage(0)},[selected]);
  const issued=trpc.crm.coupons.listIssued.useQuery({programId:selected!,limit:PAGE_SIZE,offset:page*PAGE_SIZE},{enabled:selected!=null});
  const issuedRows=issued.data?.rows??[]; const issuedTotal=issued.data?.total??0; const activeCount=issued.data?.activeCount??0;
  const create=trpc.crm.coupons.createProgram.useMutation({onSuccess:async()=>{await utils.crm.coupons.programs.invalidate();setShow(false);notify.ok("تم إنشاء برنامج الكوبونات");},onError:e=>notify.err(e)});
  const status=trpc.crm.coupons.setProgramStatus.useMutation({onSuccess:async()=>{await utils.crm.coupons.programs.invalidate();await utils.crm.dashboard.invalidate();},onError:e=>notify.err(e)});
  const issue=trpc.crm.coupons.issue.useMutation({onSuccess:async r=>{await utils.crm.coupons.listIssued.invalidate();await utils.crm.coupons.programs.invalidate();const p=programs.data?.find(x=>x.id===selected);const design=(p?.designJson??{}) as any;await printCouponCards(r.codes.map(code=>({code,title:design.title??p?.name,subtitle:design.subtitle,terms:design.terms,validTo:p?.validTo,color:design.color})));},onError:e=>notify.err(e)});
  const voidM=trpc.crm.coupons.void.useMutation({onSuccess:()=>issued.refetch(),onError:e=>notify.err(e)});
  /**
   * يطبع **كل** الكوبونات النشطة للبرنامج لا الصفحة المعروضة: كان يُمرَّر `issued.data` كاملاً
   * (القائمة غير المرقّمة)، فبعد الترقيم كان سيطبع أوّل صفحة فقط **بصمت** — وورقةُ كوبوناتٍ
   * ناقصة عطلٌ صامت لا يُكتشف إلا بعد الطباعة. fetchAllPaged يمرّ على الصفحات بنفس البرنامج.
   */
  async function printActive(){
    if(!selected)return;
    setPrinting(true);
    try{
      const all=await fetchAllPaged<IssuedCoupon>((offset,limit)=>utils.crm.coupons.listIssued.fetch({programId:selected,limit,offset}).then(r=>({rows:r.rows as IssuedCoupon[],total:r.total})),{pageSize:500});
      const p=programs.data?.find(x=>x.id===selected);const d=(p?.designJson??{}) as any;
      const ok=await printCouponCards(all.filter(x=>x.status==="ACTIVE").map(x=>({code:x.code,title:d.title??p?.name,subtitle:d.subtitle,terms:d.terms,validTo:p?.validTo,color:d.color})));
      if(!ok)notify.err("اسمح بالنوافذ المنبثقة للطباعة");
    }catch(e){notify.err(e)}finally{setPrinting(false)}
  }
  return <div className="max-w-7xl mx-auto space-y-4 pb-8"><PageHeader title="الكوبونات" description="إنشاء وإصدار وتتبع كوبونات مرتبطة بعرض معتمد، مع طباعة أو حفظ PDF بقياس 54×84 مم." actions={<Button onClick={()=>setShow(v=>!v)}><Plus className="size-4"/> برنامج جديد</Button>}/>
    {show&&<Card><CardHeader><CardTitle className="text-base">برنامج كوبونات</CardTitle></CardHeader><CardContent className="grid md:grid-cols-3 gap-4"><Field label="الاسم" required><Input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="عرض بنمط كوبون" required><select className="h-9 w-full rounded-md border bg-transparent px-3" value={promotionId} onChange={e=>setPromotionId(e.target.value)}><option value="">اختر</option>{couponOffers.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></Field><Field label="الحملة"><select className="h-9 w-full rounded-md border bg-transparent px-3" value={campaignId} onChange={e=>setCampaignId(e.target.value)}><option value="">من العرض/بلا حملة</option>{(campaigns.data??[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="من"><Input type="date" value={validFrom} onChange={e=>setFrom(e.target.value)}/></Field><Field label="إلى"><Input type="date" value={validTo} onChange={e=>setTo(e.target.value)}/></Field><Field label="بادئة الرمز"><Input dir="ltr" value={prefix} onChange={e=>setPrefix(e.target.value.toUpperCase())}/></Field><Field label="عنوان التصميم"><Input value={title} onChange={e=>setTitle(e.target.value)}/></Field><Field label="عبارة قصيرة"><Input value={subtitle} onChange={e=>setSubtitle(e.target.value)}/></Field><Field label="لون الهوية"><Input type="color" value={color} onChange={e=>setColor(e.target.value)}/></Field><Field label="الشروط" className="md:col-span-3"><Input value={terms} onChange={e=>setTerms(e.target.value)}/></Field><div className="md:col-span-3 flex justify-end"><Button disabled={!name||!promotionId||create.isPending} onClick={()=>create.mutate({name,promotionId:Number(promotionId),campaignId:campaignId?Number(campaignId):null,validFrom,validTo:validTo||null,codePrefix:prefix,perCouponLimit:1,perCustomerLimit:1,design:{title,subtitle:subtitle||undefined,terms:terms||undefined,color}})}>حفظ البرنامج</Button></div></CardContent></Card>}
    <div className="grid lg:grid-cols-[1fr_1.2fr] gap-4"><Card><CardHeader><CardTitle className="text-base">البرامج</CardTitle></CardHeader><CardContent className="space-y-2">{(programs.data??[]).map(p=><button key={p.id} onClick={()=>setSelected(p.id)} className={`w-full text-right rounded-lg border p-3 ${selected===p.id?"border-primary bg-primary/5":""}`}><div className="flex justify-between gap-2"><b>{p.name}</b><Badge>{p.status}</Badge></div><div className="text-xs text-muted-foreground mt-1">صادر: {p.issued} · مستخدم: {p.redeemed}</div><div className="flex gap-2 mt-2" onClick={e=>e.stopPropagation()}>{p.status==="DRAFT"&&<Button size="sm" onClick={()=>status.mutate({programId:p.id,status:"ACTIVE"})}>تفعيل</Button>}{p.status==="ACTIVE"&&<Button size="sm" variant="outline" onClick={()=>status.mutate({programId:p.id,status:"PAUSED"})}>إيقاف</Button>}{p.status==="PAUSED"&&<Button size="sm" onClick={()=>status.mutate({programId:p.id,status:"ACTIVE"})}>استئناف</Button>}</div></button>)}</CardContent></Card>
      <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-base">الإصدارات</CardTitle>{selected&&<div className="flex gap-2"><Input className="w-20" type="number" min="1" max="500" value={count} onChange={e=>setCount(e.target.value)}/><Button size="sm" disabled={issue.isPending} onClick={()=>issue.mutate({programId:selected,count:Math.max(1,Number(count)||1)})}><Ticket className="size-4"/> إصدار وطباعة</Button></div>}</CardHeader><CardContent>{!selected?<div className="text-center py-14 text-muted-foreground">اختر برنامجاً</div>:<><div className="flex justify-end mb-3"><Button size="sm" variant="outline" disabled={activeCount===0||printing} onClick={()=>void printActive()}><Printer className="size-4"/> {printing?"جارٍ التحضير…":`طباعة النشطة 54×84 (${activeCount})`}</Button></div><div className="max-h-[520px] overflow-auto rounded-md border"><table className="w-full text-sm"><thead className="bg-muted"><tr><th className="p-2 text-right">الرمز</th><th>الحالة</th><th></th></tr></thead><tbody>{issuedRows.map(c=><tr key={c.id} className="border-t"><td className="p-2 font-mono font-bold" dir="ltr">{c.code}</td><td className="text-center">{c.status}</td><td className="p-1">{c.status==="ACTIVE"&&<Button size="sm" variant="ghost" onClick={()=>voidM.mutate({couponId:c.id})}><XCircle className="size-4 text-destructive"/></Button>}</td></tr>)}</tbody></table></div><TablePager page={page} onPageChange={setPage} pageSize={PAGE_SIZE} rowsOnPage={issuedRows.length} total={issuedTotal} isLoading={issued.isFetching}/></>}</CardContent></Card></div>
  </div>;
}

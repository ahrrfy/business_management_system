import { confirm as confirmDialog } from "@/lib/confirm";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { digitalWorkspaceScopes, financialIntentScopeKey, loadFinancialIntent, reserveFinancialIntent, resolveFinancialIntent,
  type FinancialIntent, type FinancialIntentScope } from "@/lib/persistedFinancialIntent";

type Prepare = RouterInputs["digitalCards"]["sales"]["prepare"];
type Finalized = RouterOutputs["digitalCards"]["sales"]["finalize"];
export type DigitalWorkspaceCommand = {
  prepare: Omit<Prepare,"managerApproval">; amount:string; received:string; customerName?:string;
  proof?: { requestId:string; reference:string; deviceId:string };
};
type Active = { scope:FinancialIntentScope; envelope:FinancialIntent<DigitalWorkspaceCommand> };
export function useDurableDigitalSale(scope:FinancialIntentScope | null, callbacks:{
  onCompleted:(sale:Finalized, command:DigitalWorkspaceCommand)=>void;
  onRefunded?:()=>void;
  onNotAdmitted?:()=>void;
  onPrepared?:()=>void;
  onError?:(error:unknown)=>void;
}) {
  const key=scope ? financialIntentScopeKey(scope) : "";
  const scopeKey=useRef(key); scopeKey.current=key;
  const cb=useRef(callbacks); cb.current=callbacks;
  const held=useRef<Active|null>(null); const running=useRef(false);
  const [readyKey,setReadyKey]=useState<string|null>(null);
  const [pending,setPending]=useState(false); const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null); const [intentId,setIntentId]=useState<number|null>(null);
  const prepare=trpc.digitalCards.sales.prepare.useMutation(); const finalize=trpc.digitalCards.sales.finalize.useMutation();
  const initiate=trpc.sales.initiateExternalPayment.useMutation(); const confirm=trpc.sales.confirmExternalPayment.useMutation();
  const utils=trpc.useUtils();
  useEffect(()=>{
    let cancelled=false; held.current=null; setPending(false); setIntentId(null); setError(null); setReadyKey(null);
    if(scope) void (async()=>{
      try {
        const matches=scope.operation==="DIGITAL_INVOICE" ? await digitalWorkspaceScopes(scope) : [];
        if(matches.length>1) throw Error("توجد أكثر من عملية محفوظة لهذا التبويب؛ راجع الفرع قبل الاستمرار");
        const original=matches[0]??scope; const envelope=await loadFinancialIntent<DigitalWorkspaceCommand>(original);
        if(cancelled) return;
        if(envelope) { held.current={scope:original,envelope}; setPending(true); }
        setReadyKey(key);
      }catch(err){if(!cancelled)setError(err instanceof Error?err.message:"تعذّرت قراءة أمر البيع المحفوظ");}
    })();
    return ()=>{cancelled=true;};
  },[key]);
  async function complete(saved:Active,id:number) {
    const c=saved.envelope.payload;
    const sale=await finalize.mutateAsync({intentId:id,clientRequestId:saved.envelope.id,paymentAmount:c.amount,
      paymentMethod:c.prepare.paymentMethod as "CASH"|"CREDIT"|"CARD",customerId:c.prepare.customerId});
    if(sale.intentId!==id || !sale.invoiceId || !await resolveFinancialIntent(saved.scope,saved.envelope.id)) throw Error("لم تتطابق الفاتورة مع أمر البيع المحفوظ");
    if(held.current===saved){held.current=null;setIntentId(null);setPending(false);cb.current.onCompleted(sale,c);}
  }
  async function resume(saved:Active,approval?:Prepare["managerApproval"],closeRejectedWithoutPayment?:true) {
    const c=saved.envelope.payload;
    const invoice=saved.scope.operation==="DIGITAL_INVOICE";
    if(c.prepare.clientRequestId!==saved.envelope.id || c.prepare.branchId!==saved.scope.branchId ||
      c.prepare.sourceType!==(invoice?"INVOICE":"POS") || !(invoice?["CASH","CREDIT"]:["CASH","CARD"]).includes(c.prepare.paymentMethod))
      throw Error("طريقة الدفع أو هوية أمر البيع المحفوظ غير مدعومة");
    let attemptId=c.prepare.externalPaymentAttemptId;
    if(c.prepare.paymentMethod==="CARD"){
      const p=c.proof;
      if(invoice || !p || p.requestId!==saved.envelope.id+":card") throw Error("إثبات قبض البطاقة غير مطابق للأمر");
      const proof=await initiate.mutateAsync({branchId:saved.scope.branchId,channel:"POS",method:"CARD",amount:c.amount,...p});
      if(proof.state==="INITIATED") await confirm.mutateAsync({branchId:saved.scope.branchId,channel:"POS",attemptId:proof.attemptId,deviceId:p.deviceId});
      else if(proof.state!=="CONFIRMED") throw Error("إثبات البطاقة غير محسوم؛ لا تُعد القبض");
      attemptId=proof.attemptId;
    }
    const r=await prepare.mutateAsync({...c.prepare,closeRejectedWithoutPayment,externalPaymentAttemptId:attemptId,externalPaymentDeviceId:c.proof?.deviceId,
      ...(c.proof?{capturedDigitalPayment:{confirmed:true as const,amount:c.amount,deviceId:c.proof.deviceId}}:{}),
      ...(approval?{managerApproval:approval}:{})});
    const view=await utils.digitalCards.sales.getIntent.fetch({intentId:r.intentId});
    if(view.intent.status==="CANCELLED" && view.noAdmissionClosed){
      if(!await resolveFinancialIntent(saved.scope,saved.envelope.id))throw Error("تعذّر تحرير الطلب المغلق");
      if(held.current===saved){held.current=null;setPending(false);setIntentId(null);cb.current.onNotAdmitted?.();}return;
    }
    if(view.intent.status==="FINALIZED"){await complete(saved,r.intentId);return;}
    if(view.intent.status==="CANCELLED" && view.financialSettlement?.status==="COMPLETED" && view.financialSettlement.saleAmount==="0.00" && view.financialSettlement.refundAmount===c.amount){
      if(!await resolveFinancialIntent(saved.scope,saved.envelope.id)) throw Error("تعذّر تحرير الأمر الأصلي");
      if(held.current===saved){held.current=null;setPending(false);setIntentId(null);cb.current.onRefunded?.();} return;
    }
    if(!["PREPARED","EXECUTING","EXECUTED"].includes(view.intent.status))throw Error("العملية تحتاج مراجعة المدير؛ لا تُعد الإصدار أو القبض");
    if(held.current===saved){cb.current.onPrepared?.();setIntentId(r.intentId);}
  }
  async function perform(fn:()=>Promise<void>) {
    if(running.current)return;
    running.current=true;setBusy(true);setError(null);
    try{await fn();}catch(err){setError(err instanceof Error?err.message:"تعذّرت استعادة البيع الرقمي");cb.current.onError?.(err);}
    finally{running.current=false;setBusy(false);}
  }
  async function start(proposed:DigitalWorkspaceCommand,approval?:Prepare["managerApproval"]){
    if(!scope || readyKey!==key)return;
    await perform(async()=>{
      if(held.current){await resume(held.current,approval);return;}
      // Never serialize credentials, including properties passed through structural typing.
      if(scope.operation==="DIGITAL_INVOICE" && sessionStorage.getItem("advanced-sales-payment-session:"+scope.userId)!==proposed.prepare.clientRequestId)
        throw Error("تعذّر حفظ هوية تبويب الفاتورة؛ لا يبدأ إصدار رقمي حتى يتاح التخزين");
      if(scope.operation==="DIGITAL_INVOICE" && !["CASH","CREDIT"].includes(proposed.prepare.paymentMethod))
        throw Error("طريقة دفع غير مدعومة لفاتورة الكروت؛ لم يبدأ قبض خارجي");
      const {managerApproval:_private,...safe}=proposed.prepare as Prepare;
      void _private;
      const envelope=await reserveFinancialIntent(scope,{id:safe.clientRequestId,createdAt:new Date().toISOString(),payload:{...proposed,prepare:safe}});
      if(scopeKey.current!==key)return;
      const saved={scope,envelope};held.current=saved;setPending(true);
      await resume(saved,approval);
    });
  }
  return {start, canCloseRejected:pending && !!error && held.current?.envelope.payload.prepare.paymentMethod!=="CARD",
    closeRejected:()=>perform(async()=>{
      if(!held.current || held.current.envelope.payload.prepare.paymentMethod==="CARD")return;
      if(!await confirmDialog({title:"إغلاق طلب مرفوض بلا قبض",description:"أؤكد أنه لم يُقبض أي نقد أو دفع خارجي لهذا الطلب ولم يصدر أي كرت. يتحقق الخادم من الرفض وعدم وجود نيّة تنفيذ؛ لا تستخدم هذا الخيار إذا قبضت المال.",variant:"warning",confirmText:"أؤكد عدم القبض وأطلب الإغلاق"}))return;
      await resume(held.current,undefined,true);
    }), ready:!!key && readyKey===key, pending, busy,error,intentId,
    retry:(approval?:Prepare["managerApproval"])=>perform(async()=>{if(held.current)await resume(held.current,approval);}),
    finish:(id:number)=>perform(async()=>{if(!held.current || intentId!==id)throw Error("استعد الأمر الأصلي أولاً");await complete(held.current,id);}),
    dismiss:()=>setIntentId(null)};
}

export function DigitalWorkspaceRecovery({message,busy,retry,closeRejected}:{message:string|null;busy:boolean;retry:()=>void;closeRejected?:()=>void}){
  return <div className="m-3 space-y-2 rounded border p-4" dir="rtl">
    <p>توجد عملية بيع رقمي محفوظة في هذا التبويب. استعد العملية الأصلية قبل بدء بيع جديد.</p>
    {message&&<p role="alert">{message}</p>}
    <Button type="button" disabled={busy} onClick={retry}>استعادة عملية البيع</Button>
    {closeRejected&&<Button type="button" variant="outline" disabled={busy} onClick={closeRejected}>طلب إغلاق مرفوض لم يُقبض</Button>}
  </div>;
}

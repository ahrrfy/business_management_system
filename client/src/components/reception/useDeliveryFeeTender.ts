import { useState } from "react";
import { D, round2 } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { getDeviceCode } from "@/lib/offline/outbox";

type Rail = "CASH" | "CARD" | "TRANSFER" | "WALLET";
type Proof = {attemptId:number|null;requestId:string;deviceId:string;fingerprint:string;confirmed:boolean};
export type ReceptionDeliveryFeeTender = {method:Rail;externalPaymentAttemptId?:number;externalPaymentDeviceId?:string;combinedWithPaymentIndex?:number};
const storagePrefix="reception-fee-proof:";
function restore(key:string):Proof|null {try{return JSON.parse(localStorage.getItem(key)??"null");}catch{return null;}}
/** Proof survives a DB rollback/remount; call reset only after the checkout is confirmed saved. */
export function useDeliveryFeeTender(input:{branchId:number;method:string;goodsAmount:string;feeHeld:string;reference:string;clientRequestId:string}) {
  const initiate=trpc.reception.initiateExternalPayment.useMutation();
  const confirmMutation=trpc.reception.confirmExternalPayment.useMutation();
  const [current,setCurrent]=useState<Proof|null>(null);
  const [error,setError]=useState<string|null>(null);
  const goods=round2(D(input.goodsAmount||"0")),fee=round2(D(input.feeHeld||"0"));
  const capturedAmount=goods.plus(fee).toFixed(2);
  const fingerprint=`${input.branchId}|${input.method}|${capturedAmount}|${input.reference.trim().toUpperCase()}`;
  const storageKey=storagePrefix+input.clientRequestId+":"+fingerprint;
  const proof=current?.fingerprint===fingerprint?current:restore(storageKey);
  const enabled=fee.gt(0);
  const supported=input.method==="CASH"||input.method==="CARD"||input.method==="TRANSFER"||input.method==="WALLET";
  const confirmed=!enabled||(supported&&(input.method==="CASH"||!!proof?.confirmed));
  function remember(next:Proof){setCurrent(next);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* Current proof stays usable in memory. */}}
  async function confirm(){
    setError(null);
    if(!enabled||input.method==="CASH")return;
    if(!supported||!input.reference.trim()) {setError("اختر وسيلة قبض متاحة وأدخل مرجع العملية أولاً");return;}
    try{
      const deviceId=proof?.deviceId||await getDeviceCode();
      let next=proof??{attemptId:null,requestId:crypto.randomUUID(),deviceId,fingerprint,confirmed:false};
      remember(next);
      if(!next.attemptId){const attempt=await initiate.mutateAsync({branchId:input.branchId,method:input.method as Exclude<Rail,"CASH">,amount:capturedAmount,reference:input.reference.trim(),requestId:next.requestId,deviceId});next={...next,attemptId:attempt.attemptId};remember(next);}
      await confirmMutation.mutateAsync({branchId:input.branchId,attemptId:next.attemptId!,deviceId});
      remember({...next,confirmed:true});
    }catch(cause){setError(cause instanceof Error?cause.message:"تعذّر تأكيد الدفع؛ راجع العملية المؤكدة قبل إعادة المحاولة");}
  }
  const tender:ReceptionDeliveryFeeTender|null=!enabled||!confirmed||!supported?null:{method:input.method as Rail,
    ...(input.method!=="CASH"?{externalPaymentAttemptId:proof!.attemptId!,externalPaymentDeviceId:proof!.deviceId}:{}),
    ...(goods.gt(0)?{combinedWithPaymentIndex:0}:{}),
  };
  function reset(){try{localStorage.removeItem(storageKey);}catch{}setCurrent(null);setError(null);}
  return {capturedAmount,goodsAmount:goods.toFixed(2),tender,confirmed,error,confirm,reset,pending:initiate.isPending||confirmMutation.isPending};
}

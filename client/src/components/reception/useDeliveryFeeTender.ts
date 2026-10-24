import { useRef, useState } from "react";
import { D, round2 } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { getDeviceCode } from "@/lib/offline/outbox";

type Rail = "CASH" | "CARD" | "TRANSFER" | "WALLET";
type Proof = {attemptId:number|null;requestId:string;deviceId:string;fingerprint:string;confirmed:boolean;reference?:string;amount?:string;method?:string};
export type ReceptionDeliveryFeeTender = {method:Rail;externalPaymentAttemptId?:number;externalPaymentDeviceId?:string;combinedWithPaymentIndex?:number};
const storagePrefix="reception-fee-proof:";
function restore(key:string):Proof|null {try{return JSON.parse(localStorage.getItem(key)??"null");}catch{return null;}}
/** Proof survives a DB rollback/remount; call reset only after the checkout is confirmed saved. */
export function useDeliveryFeeTender(input:{branchId:number;ownerId?:number;method:string;goodsAmount:string;feeHeld:string;reference:string;clientRequestId:string}) {
  const initiate=trpc.reception.initiateExternalPayment.useMutation();
  const confirmMutation=trpc.reception.confirmExternalPayment.useMutation();
  const [current,setCurrent]=useState<Proof|null>(null);
  const [error,setError]=useState<string|null>(null);
  const latest=useRef(input);latest.current=input;
  const goods=round2(D(input.goodsAmount||"0")),fee=round2(D(input.feeHeld||"0"));
  const capturedAmount=goods.plus(fee).toFixed(2);
  const fingerprint=`${input.ownerId??"legacy"}:${input.clientRequestId}|${input.branchId}|${input.method}|${capturedAmount}|${input.reference.trim().toUpperCase()}`;
  const storageKey=storagePrefix+input.clientRequestId+":"+fingerprint;
  const recoveryKey=`${storagePrefix}scope:${input.ownerId??"legacy"}:${input.branchId}:${input.clientRequestId}`;
  const recovered=restore(recoveryKey);
  const restoredReference=!input.reference.trim()&&recovered?.amount===capturedAmount&&recovered.method===input.method?recovered.reference:null;
  const proof=current?.fingerprint===fingerprint?current:restore(storageKey);
  const enabled=fee.gt(0);
  const supported=input.method==="CASH"||input.method==="CARD"||input.method==="TRANSFER"||input.method==="WALLET";
  const confirmed=!enabled||(supported&&(input.method==="CASH"||!!proof?.confirmed));
  function remember(next:Proof){
    const saved={...next,reference:input.reference.trim(),amount:capturedAmount,method:input.method};
    if(latest.current.clientRequestId===input.clientRequestId&&latest.current.branchId===input.branchId&&latest.current.ownerId===input.ownerId&&latest.current.reference===input.reference&&latest.current.goodsAmount===input.goodsAmount&&latest.current.feeHeld===input.feeHeld&&latest.current.method===input.method)setCurrent(saved);
    try{localStorage.setItem(storageKey,JSON.stringify(saved));localStorage.setItem(recoveryKey,JSON.stringify(saved));}catch{/* Current proof stays usable in memory. */}
  }
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
  function reset(){try{localStorage.removeItem(storageKey);localStorage.removeItem(recoveryKey);}catch{}setCurrent(null);setError(null);}
  return {capturedAmount,goodsAmount:goods.toFixed(2),restoredReference,tender,confirmed,error,confirm,reset,pending:initiate.isPending||confirmMutation.isPending};
}

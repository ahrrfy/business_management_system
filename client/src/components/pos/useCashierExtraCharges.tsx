import {trpc} from "@/lib/trpc";
import {useRef} from "react";
import {notify} from "@/lib/notify";
import type {CheckoutChargesInput,CheckoutChargesResult} from "@shared/checkoutCharges";
import type {ExternalPaymentDraft,PaymentMethod,PosPaymentLegDraft} from "./posShared";
import {CheckoutExtraCharges} from "./CheckoutExtraCharges";
import {buildChargeOnlyTender,checkoutExtraPayload,checkoutExtraTotal} from "./checkoutExtraAmounts";
import {computeSplitLegFingerprint} from "./posTotals";
import {releaseReservedPrintWindow,reservePrintWindow} from "@/lib/printing/brand";
import {printCheckoutAllocationReceipt} from "./printChargeReceipt";
export type SavedCheckout={result:CheckoutChargesResult;recoveryToken:string};
export function savedCheckout(result:Partial<CheckoutChargesResult>,token:string):SavedCheckout|undefined{
  return result.checkoutPaymentSummary&&result.checkoutReceipts&&result.chargeAllocations
    ?{recoveryToken:token,result:{checkoutPaymentSummary:result.checkoutPaymentSummary,checkoutReceipts:result.checkoutReceipts,chargeAllocations:result.chargeAllocations}}:undefined;
}
export function useCashierExtraCharges(props:{
  channel:"POS"|"PRINT_POS";branchId:number;shiftId?:number;token:string;
  tab:{id:number;customerId:number|null;method:PaymentMethod;payInput:string;externalPayment:ExternalPaymentDraft|null;extraCharges?:CheckoutChargesInput;lastCheckout?:SavedCheckout};
  enabled:boolean;connected:boolean;confirmed:boolean;cartLength:number;goodsTender:string;busy:boolean;
  splitLegs?:readonly PosPaymentLegDraft[];
  onSplitChargeOnly?:()=>void;
  onChange:(value:CheckoutChargesInput)=>void;onCommitted:(tabId:number,saved:SavedCheckout)=>void;refresh:()=>void;
}){
  const retail=trpc.sales.checkoutCharges.useMutation(),print=trpc.printPos.checkoutCharges.useMutation();
  const latest=useRef(props);latest.current=props;
  const mutation=props.channel==="POS"?retail:print;
  async function submitChargesOnly(){
    if(!props.shiftId||!props.enabled||!props.connected||mutation.isPending||props.busy)return;
    const split=props.splitLegs?.length?props.splitLegs:null;
    if(split?split.some(leg=>leg.method!=="CASH"&&(leg.externalPayment?.state!=="CONFIRMED"||!leg.externalPayment.attemptId||leg.externalPayment.fingerprint!==computeSplitLegFingerprint(leg))):props.tab.method!=="CASH"&&!props.confirmed){notify.err("ثبّت نجاح كل دفعة لدى المزوّد بالمبلغ الحالي أولاً؛ لا تكرر تمرير البطاقة");return;}
    if(split?split.some(leg=>leg.method==="CHECK"):props.tab.method==="CHECK"){notify.err("طريقة القبض غير مفعلة للأجور");return;}
    const snapshot=props.tab,token=props.token,branchId=props.branchId,shiftId=props.shiftId;
    reservePrintWindow();
    try{
      const actual=split?split.map(leg=>({amount:leg.amount,method:leg.method as "CASH"|"CARD"|"TRANSFER"|"WALLET",externalPaymentAttemptId:leg.method!=="CASH"?leg.externalPayment?.attemptId:undefined,externalPaymentDeviceId:leg.method!=="CASH"?leg.externalPayment?.deviceId:undefined})):
        [{amount:snapshot.payInput||checkoutExtraTotal(snapshot.extraCharges).toFixed(2),method:snapshot.method as "CASH"|"CARD"|"TRANSFER"|"WALLET",externalPaymentAttemptId:snapshot.method!=="CASH"?snapshot.externalPayment?.attemptId:undefined,externalPaymentDeviceId:snapshot.method!=="CASH"?snapshot.externalPayment?.deviceId:undefined}];
      const tender=buildChargeOnlyTender(snapshot.extraCharges,actual);
      const result=await mutation.mutateAsync({branchId:props.branchId,shiftId:props.shiftId,customerId:snapshot.customerId,clientRequestId:token,deviceId:actual.find(leg=>leg.method!=="CASH")?.externalPaymentDeviceId??snapshot.externalPayment?.deviceId,
        ...checkoutExtraPayload(snapshot.extraCharges),...tender});
      const current=latest.current,originActive=current.tab.id===snapshot.id;
      if(current.branchId!==branchId||current.shiftId!==shiftId||current.channel!==props.channel||(originActive&&current.token!==token)){releaseReservedPrintWindow();notify.ok("تم قبض الأجور للطلب السابق؛ عُد إليه لاسترجاع إيصالاته");return;}
      props.onCommitted(snapshot.id,{result,recoveryToken:token});props.refresh();
      if(!originActive){releaseReservedPrintWindow();notify.ok("تم قبض الأجور للطلب السابق؛ عُد إليه لاسترجاع إيصالاته");return;}
      notify.ok("تم قبض الأجور وحفظ الإيصال");void Promise.resolve(printCheckoutAllocationReceipt(result,token)).catch(()=>{}).finally(()=>releaseReservedPrintWindow());
    }catch(error){releaseReservedPrintWindow();notify.err(error);}
  }
  const slot=<CheckoutExtraCharges branchId={props.branchId} customerId={props.tab.customerId} channel={props.channel} value={props.tab.extraCharges} onChange={props.onChange}
    disabled={!props.enabled||!props.connected||props.busy||mutation.isPending} chargeOnly={!props.cartLength} onChargeOnly={()=>void submitChargesOnly()} onSplitChargeOnly={props.onSplitChargeOnly} goodsTender={props.cartLength?props.goodsTender:"0"} lastResult={props.tab.lastCheckout}/>;
  return {slot,submitChargesOnly,pending:mutation.isPending};
}

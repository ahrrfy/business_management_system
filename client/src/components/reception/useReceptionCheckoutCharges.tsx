import {useRef,useState} from "react";
import {trpc} from "@/lib/trpc";
import {notify} from "@/lib/notify";
import {CheckoutExtraCharges} from "@/components/pos/CheckoutExtraCharges";
import {buildChargeOnlyTender,checkoutExtraPayload,checkoutExtraTotal} from "@/components/pos/checkoutExtraAmounts";
import {printCheckoutAllocationReceipt} from "@/components/pos/printChargeReceipt";
import {savedCheckout,type SavedCheckout} from "@/components/pos/useCashierExtraCharges";
import type {CheckoutChargesInput,CheckoutChargesResult} from "@shared/checkoutCharges";
import type {TenderPayment} from "@/components/payments/splitTender";
import type {ReceptionDeliveryFeeTender} from "./useDeliveryFeeTender";
export function useReceptionCheckoutCharges(input:{branchId:number;shiftId?:number;customerId:number|null;token:string;value:CheckoutChargesInput;setValue:(value:CheckoutChargesInput)=>void;disabled:boolean;goodsTender:string;cartLength:number;onSubmit:()=>void;onSplit:()=>void;resetCommitted:()=>boolean}){
  const utils=trpc.useUtils();
  const mutation=trpc.reception.checkoutCharges.useMutation();
  const [last,setLast]=useState<SavedCheckout>();
  const current=useRef(input);current.current=input;
  const amount=checkoutExtraTotal(input.value);
  function committed(result:Partial<CheckoutChargesResult>,token:string){const saved=savedCheckout(result,token);if(saved){setLast(saved);printCheckoutAllocationReceipt(saved.result,token);}}
  async function submitOnly(args:{payments?:TenderPayment[];method:string;payInput:string;proof:ReceptionDeliveryFeeTender|null;confirmed:boolean}){
    if(input.disabled||mutation.isPending||!input.shiftId)return;
    if(!args.confirmed){notify.err("أكّد نجاح عملية القبض الحالية لدى المزوّد أولاً");return;}
    const snapshot=input;
    try{
      const actual=args.payments??[{method:args.method as TenderPayment["method"],amount:args.payInput||amount.toFixed(2),externalPaymentAttemptId:args.proof?.externalPaymentAttemptId,externalPaymentDeviceId:args.proof?.externalPaymentDeviceId}];
      const tender=buildChargeOnlyTender(input.value,actual);
      const result=await mutation.mutateAsync({branchId:input.branchId,shiftId:input.shiftId,customerId:input.customerId,clientRequestId:input.token,...checkoutExtraPayload(input.value),...tender});
      if(current.current.token!==snapshot.token||current.current.branchId!==snapshot.branchId||current.current.shiftId!==snapshot.shiftId){notify.ok("تم قبض الأجور للطلب السابق؛ استخدم مفتاحه لاسترجاع الإيصالات");return;}
      committed(result,snapshot.token);input.resetCommitted();notify.ok("تم قبض الأجور وحفظ إيصالها");
    }catch(error){notify.err(error);}
  }
  async function recoverDraft(draftId:number){
    const token=input.token;
    const result=await utils.reception.checkoutRecovery.fetch({draftId,branchId:input.branchId},{staleTime:0});
    if(current.current.token!==token||current.current.branchId!==input.branchId)return false;
    committed(result,result.recoveryToken);input.resetCommitted();notify.ok("استُعيدت إيصالات الطلب المثبت؛ لا حاجة لقبض جديد");return true;
  }
  const slot=<CheckoutExtraCharges channel="RECEPTION" branchId={input.branchId} customerId={input.customerId} value={input.value} onChange={input.setValue} disabled={input.disabled||mutation.isPending} goodsTender={input.cartLength?input.goodsTender:"0"} chargeOnly={false} lastResult={last}/>;
  return {slot,amount,pending:mutation.isPending,submitOnly,committed,recoverDraft};
}

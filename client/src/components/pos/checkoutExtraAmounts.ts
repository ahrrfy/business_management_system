import { D } from "@/lib/money";
import type { CheckoutChargesInput } from "@shared/checkoutCharges";
import type {PosPaymentLegDraft} from "./posShared";

/** Confirmed charge-only tenders are consumed and cannot remain on the next checkout. */
export function clearedChargeOnlyTender(channel:"POS"):{payInput:string;paymentRef:string;externalPayment:null;paymentLegs:PosPaymentLegDraft[]};
export function clearedChargeOnlyTender(channel:"PRINT_POS"):{payInput:string;paymentRef:string;externalPayment:null;splitMode:false;splitLegs:PosPaymentLegDraft[]};
export function clearedChargeOnlyTender(channel:"POS"|"PRINT_POS"):object{
  const common={payInput:"",paymentRef:"",externalPayment:null};
  return channel==="POS"?{...common,paymentLegs:[]}:{...common,splitMode:false as const,splitLegs:[]};
}

/** Extras require a real goods leg even when all COD goods are payable later. */
export function checkoutGoodsTenderAmount(input:{extraCharges?:CheckoutChargesInput;method:string;paidAmount:string;codMode:boolean;fallbackAmount:string}){
  const paid=D(input.paidAmount);
  return checkoutExtraTotal(input.extraCharges).gt(0)&&input.method==="CASH"&&(input.codMode||paid.gt(0))
    ?paid.toFixed(2):input.fallbackAmount;
}
export function checkoutExtraTotal(input?: CheckoutChargesInput) {
  return [
    ...(input?.serviceCharges ?? []),
    ...(input?.approvedChargeAllocations ?? []),
  ].reduce((sum, row) => sum.plus(/^\d+(\.\d{0,2})?$/.test(row.amount)?D(row.amount):D(0)), D(0));
}
export function checkoutExtraPayload(input?: CheckoutChargesInput) {
  const amount = checkoutExtraTotal(input);
  return amount.gt(0)
    ? {
        serviceCharges: input?.serviceCharges ?? [],
        approvedChargeAllocations: input?.approvedChargeAllocations ?? [],
        chargePayments: [{ paymentIndex: 0, amount: amount.toFixed(2) }],
      }
    : {};
}

/** Charge-only split amounts are actual tender, with change restricted to CASH. */
export function buildChargeOnlyTender(input:CheckoutChargesInput|undefined,legs:Array<{method:"CASH"|"CARD"|"TRANSFER"|"WALLET";amount:string;externalPaymentAttemptId?:number|null;externalPaymentDeviceId?:string|null}>){
  const total=checkoutExtraTotal(input);
  if(!total.gt(0)||!legs.length||legs.length>10)throw new Error("حدد أجوراً موجبة ودفعات قبض صحيحة");
  const amounts=legs.map(leg=>{if(!/^\d+(\.\d{1,2})?$/.test(leg.amount)||!D(leg.amount).gt(0))throw new Error("مبلغ كل دفعة قبض يجب أن يكون موجباً");return D(leg.amount);});
  const tendered=amounts.reduce((sum,amount)=>sum.plus(amount),D(0));
  const nonCash=legs.reduce((sum,leg,index)=>leg.method==="CASH"?sum:sum.plus(amounts[index]),D(0));
  if(tendered.lt(total))throw new Error("الأجور الفورية تحتاج قبض قيمتها كاملة؛ أكمل مبلغ القبض أولاً");
  if(nonCash.gt(total))throw new Error("القبض غير النقدي يتجاوز قيمة الأجور؛ الباقي يخرج من النقد فقط");
  let cashLeft=total.minus(nonCash);
  const chargePayments:Array<{paymentIndex:number;amount:string}>=[];
  const payments=legs.map((leg,paymentIndex)=>{
    const raw=amounts[paymentIndex],applied=leg.method==="CASH"?(raw.gt(cashLeft)?cashLeft:raw):raw;
    if(leg.method==="CASH")cashLeft=cashLeft.minus(applied);
    if(applied.gt(0))chargePayments.push({paymentIndex,amount:applied.toFixed(2)});
    return {...leg,amount:raw.minus(applied).toFixed(2)};
  });
  return {payments,chargePayments};
}

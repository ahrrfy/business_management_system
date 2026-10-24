import type {Receipt} from "@/components/pos/posShared";
import type {PaymentMethod} from "./PrintPosCheckout";
import {fmtDate,fmtDateTime,fmtTime} from "@/lib/date";
import {METHOD_LABEL} from "@/lib/paymentMethod";
export type PrintReceiptSnapshot={
  tabId?:number;
  lines:Receipt["lines"];customerName?:string;method:PaymentMethod|"MIXED";paymentLegs?:Receipt["paymentLegs"];
  cashTotal:number;rawTotal:number;cashRounding:number;received:number;change:number;credit:number;isCredit:boolean;
};
export function buildPrintPosReceipt(input:{invoiceId:number;invoiceNumber:string;shiftId?:number|null},snapshot:PrintReceiptSnapshot|null,cashierName:string|undefined,currentShiftId:number|null):Receipt{
  const now=new Date();
  return {
    invoiceId:input.invoiceId,invoiceNumber:input.invoiceNumber,num:input.invoiceNumber,
    date:fmtDateTime(now),printDate:fmtDate(now),printTime:fmtTime(now),cashierName,customerName:snapshot?.customerName,
    shiftId:input.shiftId??currentShiftId,
    lines:(snapshot?.lines??[]).map(line=>({...line,disc:undefined})),subtotal:snapshot?.rawTotal??snapshot?.cashTotal??0,
    cashRounding:snapshot?.cashRounding,total:snapshot?.cashTotal??0,received:snapshot?.received??0,change:snapshot?.change??0,
    credit:snapshot?.credit??0,method:METHOD_LABEL[snapshot?.method??"CASH"],methodCode:snapshot?.method,paymentLegs:snapshot?.paymentLegs,isCredit:snapshot?.isCredit??false,
  };
}

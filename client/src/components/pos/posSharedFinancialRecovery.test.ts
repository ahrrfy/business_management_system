
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ReceiptOverlay} from "./ReceiptOverlay";
import {describe,it,expect,vi,beforeAll,afterAll} from "vitest";
beforeAll(()=>vi.stubGlobal("React",React));
afterAll(()=>vi.unstubAllGlobals());
import {buildBrandedReceipt,digitalRecoveredReceiptMoney} from "./posShared";
function receipt(method:string,overrides:Record<string,unknown>={}) {
 const sale={total:"10000",paidAmount:"10000",paymentMethod:method,returnedTotal:"0",invoiceStatus:"PAID",cashRoundingAdjustment:"0",
   settledCapture:{capturedAmount:"20000",refundAmount:"10000"},...overrides};
 return buildBrandedReceipt({invoiceId:1,invoiceNumber:"DIG-1",date:"2026-11-06",lines:[],...digitalRecoveredReceiptMoney(sale,"20000")});
}
describe("recovered digital receipt actual print contract",()=>{
 it.each(["CASH","CARD"])("does not print another change after a settled %s refund",method=>{
   expect(receipt(method)).toMatchObject({paid:10000,change:null,paymentMethod:method,total:10000,returnedTotal:"0",status:"PAID"});
 });
 it("keeps full-success cash tender and change",()=>expect(receipt("CASH",{settledCapture:null})).toMatchObject({paid:20000,change:10000}));
 it("never prints card tender as change",()=>expect(receipt("CARD",{settledCapture:null})).toMatchObject({paid:10000,change:null}));
 it("carries completed and partial returns through the actual print mapper",()=>{
   expect(receipt("CARD",{paidAmount:"0",returnedTotal:"10000",invoiceStatus:"RETURNED"})).toMatchObject({paid:0,change:null,returnedTotal:"10000",status:"RETURNED",credit:null});
   expect(receipt("CASH",{paidAmount:"1000",returnedTotal:"4000",invoiceStatus:"PARTIALLY_PAID"})).toMatchObject({paid:1000,credit:5000,change:null,returnedTotal:"4000",status:"PARTIALLY_PAID"});
 });
});


it("shows original/returned/current server facts and returned status on screen",()=>{
 const html=renderToStaticMarkup(React.createElement(ReceiptOverlay,{C:{primary:"#000",primaryFg:"#fff"},
   receipt:{invoiceId:1,invoiceNumber:"DIG-1",date:"2026-11-06",lines:[],...digitalRecoveredReceiptMoney({
     total:"10000",paidAmount:"0",paymentMethod:"CARD",returnedTotal:"10000",invoiceStatus:"RETURNED",cashRoundingAdjustment:"0",settledCapture:null},"20000")},
   onDismiss:()=>{},onPrint:()=>{}}));
 expect(html).toContain("المرتجع:");expect(html).toContain("القيمة الحالية للفاتورة:");
 expect(html).not.toContain("مدفوع • PAID");expect(html).not.toContain("الباقي للعميل:");
});

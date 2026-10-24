import {beforeEach,describe,expect,it} from "vitest";
import {eq} from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {getDb} from "../../db";
import {withTx} from "../tx";
import {recordDeliveryFeeHeldInTx} from "../delivery/feeHeld";
import {money} from "../money";
import {consignmentReturnPreflight} from "../workOrder/refundPreflight";
const db=()=>getDb()!;
beforeEach(async()=>{
  await db().insert(s.branches).values({id:1,name:"MAIN",code:"MAIN",type:"MAIN"});
  await db().insert(s.users).values({id:1,openId:"refund-preflight",role:"cashier",branchId:1});
  await db().insert(s.shifts).values({id:1,userId:1,branchId:1,shiftType:"RECEPTION",status:"OPEN",openingBalance:"1000",openGuard:"1:1:RECEPTION"});
  await db().insert(s.deliveryParties).values({id:1,name:"Courier",partyType:"COMPANY",isActive:true});
  await db().insert(s.invoices).values({id:1,invoiceNumber:"RAIL-INV",branchId:1,subtotal:"1000",total:"1000",paidAmount:"1000",createdBy:1});
  await db().insert(s.deliveryConsignments).values({id:1,consignmentNumber:"RAIL-CN",partyId:1,branchId:1,invoiceId:1,sourceId:1,sourceType:"INVOICE",codAmount:"0",deliveryFee:"100",feeCollection:"COUNTER",parcelStatus:"OUT_FOR_DELIVERY",dispatchedBy:1});
});
async function receipt(amount:string,method:"CASH"|"CARD",fee=false){
  if(fee){await withTx(tx=>recordDeliveryFeeHeldInTx(tx,{branchId:1,shiftId:1,invoiceId:1,tender:{method,reference:method==="CARD"?"BANK-FEE":null},amount:money(amount),actorUserId:1,description:"Test actual held fee"}));return;}
  await db().insert(s.receipts).values({receiptNumber:`PREFLIGHT-${method}-${fee}`,direction:"IN",branchId:1,invoiceId:1,amount,paymentMethod:method,cashBucket:method==="CASH"?"TREASURY":null,status:"COMPLETED",approvalStatus:"APPROVED",referenceNumber:fee?"DLV-FEE-INV-1":null,createdBy:1});
}
const preflight=()=>withTx(tx=>consignmentReturnPreflight(tx,1,{exposeCash:true}));
describe("native consignment refund preflight uses original money rails",()=>{
  it("CARD-only paid parcel needs no drawer, including a CARD held fee",async()=>{
    await receipt("1000","CARD");await receipt("100","CARD",true);
    expect(await preflight()).toMatchObject({needsCashDrawer:false,estimatedCashOut:"0.00",drawers:[]});
  });
  it("mixed goods estimates only documented CASH plus the unsettled CASH fee",async()=>{
    await receipt("750","CARD");await receipt("250","CASH");await receipt("100","CASH",true);
    expect(await preflight()).toMatchObject({needsCashDrawer:true,estimatedCashOut:"350.00"});
  });
  it("does not refund a settled fee and caps remaining goods cash by invoice paid amount",async()=>{
    await receipt("1000","CASH");await receipt("100","CASH",true);
    await db().update(s.invoices).set({paidAmount:"200"}).where(eq(s.invoices.id,1));
    await db().update(s.deliveryConsignments).set({feeSettledAt:new Date()}).where(eq(s.deliveryConsignments.id,1));
    expect(await preflight()).toMatchObject({estimatedCashOut:"200.00"});
  });
});

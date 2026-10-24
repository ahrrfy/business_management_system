import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createDeliveryParty } from "../deliveryService";
import { confirmExternalPaymentAttempt, createConfirmedPosSale, initiateExternalPaymentAttempt, type ConfirmedPosSaleInput } from "../posExternalPayment";
import { checkoutReception } from "../receptionCheckoutService";
import { createWorkOrder } from "../workOrderService";
import { approveWorkOrderCancellationRefund } from "../workOrder/cancel";
import { refundWorkOrderDeliveryFeeHeld } from "../workOrder/deliveryFeeRefund";
import { withTx } from "../tx";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const actor = {userId:1, branchId:1, role:"cashier"} as const;
const owner = {userId:2, branchId:1, role:"admin"} as const;
const device = "FEE-TENDER-DEVICE";
const TABLES = ["journalLines","journalEntries","doubleEntrySettings","externalPaymentAttempts","idempotencyKeys","accountingEntries","receipts","deliveryOutbox","deliveryEvents","deliveryLedgerEntries","deliveryRemittanceLines","deliveryConsignments","deliveryRemittances","deliveryPartyMembers","deliveryParties","invoiceItems","invoices","inventoryMovements","workOrderMaterials","workOrderImages","workOrderDesignRevisions","workOrders","branchStock","productPrices","productUnits","productVariants","products","shifts","customers","branches","users"];
function db() { const d=getDb(); if(!d)throw new Error("test database required");return d; }
let partyId:number;
let sequence=0;
const key=()=>`FEE-${Date.now()}-${++sequence}`;
beforeEach(async()=>{
  await truncateTables(TABLES);
  await db().insert(s.branches).values({id:1,name:"MAIN",code:"MAIN",type:"MAIN"});
  await db().insert(s.users).values([
    {id:1,openId:"fee-cashier",name:"Cashier",role:"cashier",loginMethod:"local",branchId:1},
    {id:2,openId:"fee-owner",name:"Owner",role:"admin",loginMethod:"local",branchId:1,isOwner:true},
    {id:3,openId:"fee-courier",name:"Courier",role:"courier",loginMethod:"local",branchId:1},
  ]);
  await db().insert(s.products).values({id:1,name:"Book"});
  await db().insert(s.productVariants).values({id:1,productId:1,sku:"FEE-BOOK",costPrice:"1000.00"});
  await db().insert(s.productUnits).values({id:1,variantId:1,unitName:"piece",conversionFactor:"1",isBaseUnit:true});
  await db().insert(s.productPrices).values({productUnitId:1,priceTier:"RETAIL",price:"50000.00"});
  await db().insert(s.branchStock).values({variantId:1,branchId:1,quantity:20});
  await db().insert(s.shifts).values({id:1,branchId:1,userId:1,shiftType:"RECEPTION",openingBalance:"0",status:"OPEN",openGuard:"1:1:RECEPTION"});
  partyId=(await createDeliveryParty({partyType:"INDIVIDUAL",name:"Courier",defaultFee:"5000",userId:3,branchId:1},owner)).id;
});
async function proof(amount:string,channel:"POS"|"PRINT_POS"="POS",method:"CARD"|"TRANSFER"|"WALLET"="CARD") {
  const p=await initiateExternalPaymentAttempt({branchId:1,channel,method,amount,reference:key(),requestId:key(),deviceId:device},actor);
  await confirmExternalPaymentAttempt({attemptId:p.attemptId,branchId:1,channel,deviceId:device},actor);
  return p.attemptId;
}
function input():ConfirmedPosSaleInput{return {branchId:1,shiftId:1,deviceId:device,sourceType:"POS",clientRequestId:key(),lines:[{variantId:1,productUnitId:1,quantity:"1"}],payment:{method:"CASH",amount:"50000"},deliveryFeeHeld:"5000",delivery:{partyId,assignedUserId:3,fee:"5000",feeCollection:"COUNTER",recipientName:"Buyer",recipientPhone:"07700000000",address:"Baghdad"}};}
async function snapshot(invoiceId:number){
 const inv=(await db().select().from(s.invoices).where(eq(s.invoices.id,invoiceId)))[0];
 const rows=await db().select().from(s.receipts).where(eq(s.receipts.invoiceId,invoiceId));
 const cash=(await db().select({net:sql<string>`COALESCE(SUM(CASE WHEN ${s.receipts.direction}='IN' THEN ${s.receipts.amount} ELSE -${s.receipts.amount} END),0)`}).from(s.receipts).where(and(eq(s.receipts.paymentMethod,"CASH"),eq(s.receipts.cashBucket,"DRAWER"))))[0];
 return {inv,rows,cash:cash.net,fee:rows.find(r=>r.referenceNumber===`DLV-FEE-INV-${invoiceId}`)!};
}
describe("actual tender allocation for held delivery fee",()=>{
 it.each(["CARD","TRANSFER","WALLET"] as const)("one %s proof covers goods plus fee without cash or double collection",async(method)=>{
  const attemptId=await proof("55000","POS",method);const saleInput=input();
  saleInput.payment={method,amount:"50000",externalPaymentAttemptId:attemptId};
  saleInput.deliveryFeeTender={method,combinedWithPaymentIndex:0};
  const sale=await createConfirmedPosSale(saleInput,actor);const snap=await snapshot(sale.invoiceId);
  expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.fee.paymentMethod).toBe(method);
  expect(snap.fee.cashBucket).toBeNull();expect(snap.fee.amount).toBe("5000.00");expect(snap.cash).toBe("0.00");
  expect(snap.rows).toHaveLength(2);expect(snap.fee.internalNote).toContain(`"externalPaymentAttemptId":${attemptId}`);
  const replay=await createConfirmedPosSale(saleInput,actor);expect(replay.invoiceId).toBe(sale.invoiceId);
  expect((await snapshot(sale.invoiceId)).rows).toHaveLength(2);
  await expect(createConfirmedPosSale({...saleInput,clientRequestId:key()},actor)).rejects.toThrow(/استُهلك|مستهل/);
 });
 it("legacy omitted tender remains cash and enters drawer exactly once",async()=>{
  const saleInput=input();const sale=await createConfirmedPosSale(saleInput,actor);
  const snap=await snapshot(sale.invoiceId);expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.cash).toBe("55000.00");expect(snap.fee.paymentMethod).toBe("CASH");
  expect((await createConfirmedPosSale(saleInput,actor)).invoiceId).toBe(sale.invoiceId);
  expect((await snapshot(sale.invoiceId)).cash).toBe("55000.00");
 });
 it("cash goods plus separately confirmed card fee preserves both rails",async()=>{
  const saleInput=input();saleInput.deliveryFeeTender={method:"CARD",externalPaymentAttemptId:await proof("5000"),externalPaymentDeviceId:device};
  const sale=await createConfirmedPosSale(saleInput,actor);const snap=await snapshot(sale.invoiceId);
  expect(snap.cash).toBe("50000.00");expect(snap.fee.paymentMethod).toBe("CARD");expect(snap.inv.paidAmount).toBe("50000.00");
  expect((await createConfirmedPosSale(saleInput,actor)).invoiceId).toBe(sale.invoiceId);
 });
 it("wrong combined amount rolls back DB allocation while confirmed external payment remains recoverable",async()=>{
  const attemptId=await proof("50000");const saleInput=input();saleInput.payment={method:"CARD",amount:"50000",externalPaymentAttemptId:attemptId};saleInput.deliveryFeeTender={method:"CARD",combinedWithPaymentIndex:0};
  await expect(createConfirmedPosSale(saleInput,actor)).rejects.toThrow();
  expect(await db().select().from(s.invoices)).toHaveLength(0);expect(await db().select().from(s.receipts)).toHaveLength(0);
  const attempt=(await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id,attemptId)))[0];expect(attempt.state).toBe("CONFIRMED");expect(attempt.consumedAt).toBeNull();
 });
 it("cannot reuse a combined proof as two independent tender legs",async()=>{
  const attemptId=await proof("55000");const saleInput=input();saleInput.payment={method:"CARD",amount:"50000",externalPaymentAttemptId:attemptId};saleInput.deliveryFeeTender={method:"CARD",externalPaymentAttemptId:attemptId,externalPaymentDeviceId:device};
  await expect(createConfirmedPosSale(saleInput,actor)).rejects.toThrow(/مكرر|مكرّر/);expect(await db().select().from(s.receipts)).toHaveLength(0);
 });
 it("reception combined proof is consumed once over invoice and fee",async()=>{
  const attemptId=await proof("55000","PRINT_POS");const saleInput={branchId:1,shiftId:1,clientRequestId:key(),paymentMethod:"CARD" as const,paidAmount:"50000",regularSale:{amount:"50000",lines:[{variantId:1,productUnitId:1,quantity:"1"}]},deliveryFeeHeld:"5000",deliveryFeeTender:{method:"CARD" as const,externalPaymentAttemptId:attemptId,externalPaymentDeviceId:device,combinedWithPaymentIndex:0},delivery:input().delivery};
  const sale=await checkoutReception(saleInput,actor);const snap=await snapshot(sale.regularSale!.invoiceId);expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.fee.paymentMethod).toBe("CARD");expect(snap.cash).toBe("0.00");
  expect((await checkoutReception(saleInput,actor)).regularSale!.invoiceId).toBe(sale.regularSale!.invoiceId);
 });
 it("split goods rails allocate the fee to one explicit card leg",async()=>{
  const attemptId=await proof("35000");const saleInput=input();saleInput.payment=null;
  saleInput.payments=[{method:"CASH",amount:"20000"},{method:"CARD",amount:"30000",externalPaymentAttemptId:attemptId}];
  saleInput.deliveryFeeTender={method:"CARD",combinedWithPaymentIndex:1};
  const sale=await createConfirmedPosSale(saleInput,actor);const snap=await snapshot(sale.invoiceId);
  expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.cash).toBe("20000.00");expect(snap.rows).toHaveLength(3);
  expect((await createConfirmedPosSale(saleInput,actor)).invoiceId).toBe(sale.invoiceId);
 });
 it.each(["CARD","CASH","LEGACY_CASH"] as const)("split cash change retains only goods cash with %s fee funding and replays once",async(feeFunding)=>{
  const combinedCard=feeFunding==="CARD",attemptId=await proof(combinedCard?"15000":"10000");
  const card={method:"CARD" as const,amount:"10000",externalPaymentAttemptId:attemptId};
  const cash={method:"CASH" as const,amount:"50000"};
  const saleInput=input();saleInput.payment=null;
  saleInput.payments=feeFunding==="CASH"?[cash,card]:[card,cash];
  if(feeFunding!=="LEGACY_CASH")saleInput.deliveryFeeTender={method:feeFunding,combinedWithPaymentIndex:0};
  const sale=await createConfirmedPosSale(saleInput,actor),snap=await snapshot(sale.invoiceId);
  const cashGoods=snap.rows.find(r=>r.paymentMethod==="CASH"&&r.id!==snap.fee.id)!;
  expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.rows).toHaveLength(3);
  expect(cashGoods.amount).toBe("40000.00");
  expect(money(cash.amount).minus(money(cashGoods.amount)).toFixed(2)).toBe("10000.00");
  expect(snap.fee).toMatchObject({paymentMethod:combinedCard?"CARD":"CASH",amount:"5000.00",cashBucket:combinedCard?null:"DRAWER"});
  expect(snap.cash).toBe(combinedCard?"40000.00":"45000.00");
  expect(snap.rows.every(r=>r.direction==="IN")).toBe(true);
  const attempt=(await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id,attemptId)))[0];
  expect(attempt.amount).toBe(combinedCard?"15000.00":"10000.00");expect(attempt.consumedAt).not.toBeNull();
  expect((await createConfirmedPosSale(saleInput,actor)).invoiceId).toBe(sale.invoiceId);
  const replay=await snapshot(sale.invoiceId);expect(replay.rows).toHaveLength(3);expect(replay.cash).toBe(snap.cash);
 });
 it("split cash returned entirely as change creates no goods cash receipt and keeps only the cash fee",async()=>{
  const attemptId=await proof("50000"),saleInput=input();saleInput.payment=null;
  saleInput.payments=[{method:"CASH",amount:"10000"},{method:"CARD",amount:"50000",externalPaymentAttemptId:attemptId}];
  saleInput.deliveryFeeTender={method:"CASH",combinedWithPaymentIndex:0};
  const sale=await createConfirmedPosSale(saleInput,actor),snap=await snapshot(sale.invoiceId);
  expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.rows).toHaveLength(2);expect(snap.cash).toBe("5000.00");
  expect(snap.rows.filter(r=>r.paymentMethod==="CASH")).toEqual([snap.fee]);
  expect(snap.rows.find(r=>r.paymentMethod==="CARD")?.amount).toBe("50000.00");
  expect((await createConfirmedPosSale(saleInput,actor)).invoiceId).toBe(sale.invoiceId);
  expect((await snapshot(sale.invoiceId)).rows).toHaveLength(2);
 });
 it("noncash fee without confirmed proof cannot create business effects",async()=>{
  const saleInput=input();saleInput.deliveryFeeTender={method:"CARD",reference:"UNVERIFIED"};
  await expect(createConfirmedPosSale(saleInput,actor)).rejects.toThrow(/أكّد الدفع الخارجي/);
  expect(await db().select().from(s.invoices)).toHaveLength(0);expect(await db().select().from(s.receipts)).toHaveLength(0);
 });
 it("reception can allocate one card payment to work-order deposit and fee before invoicing",async()=>{
  const attemptId=await proof("55000","PRINT_POS");
  const saleInput={branchId:1,shiftId:1,clientRequestId:key(),paymentMethod:"CARD" as const,paidAmount:"50000",
    workOrders:[{title:"Custom service",salePrice:"50000"}],deliveryFeeHeld:"5000",
    deliveryFeeTender:{method:"CARD" as const,externalPaymentAttemptId:attemptId,externalPaymentDeviceId:device,combinedWithPaymentIndex:0},delivery:input().delivery};
  const sale=await checkoutReception(saleInput,actor);expect(sale.regularSale).toBeNull();expect(sale.workOrders).toHaveLength(1);
  const rows=await db().select().from(s.receipts).where(eq(s.receipts.workOrderId,sale.workOrders[0].workOrderId));
  expect(rows.map(r=>r.amount).sort()).toEqual(["5000.00","50000.00"]);expect(rows.every(r=>r.paymentMethod==="CARD"&&r.cashBucket==null)).toBe(true);
  expect((await checkoutReception(saleInput,actor)).workOrders[0].workOrderId).toBe(sale.workOrders[0].workOrderId);
 });
 it("reception uses separate goods proof when the fee is cash",async()=>{
  const goodsAttemptId=await proof("50000","PRINT_POS");
  const saleInput={branchId:1,shiftId:1,clientRequestId:key(),paymentMethod:"CARD" as const,paidAmount:"50000",
    paymentExternalPaymentAttemptId:goodsAttemptId,paymentExternalPaymentDeviceId:device,
    regularSale:{amount:"50000",lines:[{variantId:1,productUnitId:1,quantity:"1"}]},
    deliveryFeeHeld:"5000",deliveryFeeTender:{method:"CASH" as const},delivery:input().delivery};
  const sale=await checkoutReception(saleInput,actor);const snap=await snapshot(sale.regularSale!.invoiceId);
  expect(snap.inv.paidAmount).toBe("50000.00");expect(snap.cash).toBe("5000.00");expect(snap.fee.paymentMethod).toBe("CASH");
  expect((await checkoutReception(saleInput,actor)).regularSale!.invoiceId).toBe(sale.regularSale!.invoiceId);
 });
 it("one reception proof allocates invoice delivery fee and independent work-order fee on CARD",async()=>{
  const attemptId=await proof("58000","PRINT_POS");
  const sale=await checkoutReception({branchId:1,shiftId:1,clientRequestId:key(),paymentMethod:"CARD",paidAmount:"50000",
    regularSale:{amount:"50000",lines:[{variantId:1,productUnitId:1,quantity:"1"}]},
    workOrders:[{title:"Custom",salePrice:"1000",hasDelivery:true,deliveryCost:"3000",deliveryFeeCollection:"COUNTER"}],
    delivery:input().delivery,deliveryFeeHeld:"8000",deliveryFeeTender:{method:"CARD",externalPaymentAttemptId:attemptId,externalPaymentDeviceId:device,combinedWithPaymentIndex:0}},actor);
  const rows=await db().select().from(s.receipts);const fees=rows.filter(r=>r.referenceNumber?.startsWith("DLV-FEE-"));
  expect(fees.map(r=>r.amount).sort()).toEqual(["3000.00","5000.00"]);expect(fees.every(r=>r.paymentMethod==="CARD"&&r.cashBucket==null)).toBe(true);
  expect((await snapshot(sale.regularSale!.invoiceId)).inv.paidAmount).toBe("50000.00");expect(rows.filter(r=>r.paymentMethod==="CASH")).toHaveLength(0);
 });
 it("a fee-only reception proof funds each work-order fee exactly once",async()=>{
  const attemptId=await proof("5000","PRINT_POS");
  const payload={branchId:1,shiftId:1,clientRequestId:key(),paidAmount:"0",workOrders:[
    {title:"One",salePrice:"1000",hasDelivery:true,deliveryCost:"3000",deliveryFeeCollection:"COUNTER" as const},
    {title:"Two",salePrice:"1000",hasDelivery:true,deliveryCost:"2000",deliveryFeeCollection:"COUNTER" as const}],
    deliveryFeeHeld:"5000",deliveryFeeTender:{method:"CARD" as const,externalPaymentAttemptId:attemptId,externalPaymentDeviceId:device}};
  await checkoutReception(payload,actor);await checkoutReception(payload,actor);
  const fees=(await db().select().from(s.receipts)).filter(r=>r.referenceNumber?.startsWith("DLV-FEE-"));
  expect(fees.map(r=>r.amount).sort()).toEqual(["2000.00","3000.00"]);expect(fees.every(r=>r.paymentMethod==="CARD"&&r.cashBucket==null)).toBe(true);
 });
 it("work-order card fee is linked before invoicing and refunds through owner execution with no drawer effect",async()=>{
  const attemptId=await proof("5000","PRINT_POS");const order=await createWorkOrder({branchId:1,shiftId:1,title:"Custom service",salePrice:"50000",deposit:"0",clientRequestId:key(),hasDelivery:true,deliveryCost:"5000",deliveryFeeCollection:"COUNTER",deliveryFeeTender:{method:"CARD",externalPaymentAttemptId:attemptId,externalPaymentDeviceId:device}},actor);
  const inFee=(await db().select().from(s.receipts).where(eq(s.receipts.workOrderId,order.workOrderId)))[0];expect(inFee.paymentMethod).toBe("CARD");expect(inFee.cashBucket).toBeNull();
  await db().update(s.workOrders).set({status:"READY"}).where(eq(s.workOrders.id,order.workOrderId));
  await withTx(tx=>refundWorkOrderDeliveryFeeHeld(tx,{workOrderId:order.workOrderId,branchId:1,actor,reason:"Pickup instead"}));
  const pending=(await db().select().from(s.receipts).where(and(eq(s.receipts.workOrderId,order.workOrderId),eq(s.receipts.direction,"OUT"))))[0];expect(pending.status).toBe("PENDING");expect(pending.cashBucket).toBeNull();
  await approveWorkOrderCancellationRefund(pending.id,owner,"PROVIDER-REFUND-001",{user:{id:owner.userId,branchId:1} as never,req:undefined as never});
  const entries=await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType,"DELIVERY_FEE_HELD"));expect(entries.map(e=>e.amount).sort()).toEqual(["-5000.00","5000.00"]);
 });
});

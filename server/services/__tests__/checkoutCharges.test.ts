import {beforeEach,describe,expect,it} from "vitest";
import {eq,sql} from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {fulfillmentCharges,fulfillmentChargePayments} from "../../../drizzle/fulfillmentSchema";
import {getDb} from "../../db";
import {createConfirmedPosSale,initiateExternalPaymentAttempt,confirmExternalPaymentAttempt,type ConfirmedPosSaleInput} from "../posExternalPayment";
import {createPrintSale} from "../printSaleService";
import {createChargeOnlyCheckout,listCheckoutChargeOptions} from "../checkoutCharges";
import {createDeliveryParty} from "../deliveryService";
import {createFulfillmentCharge,approveFulfillmentCharge,refundFulfillmentCharge} from "../fulfillment/charges";
import {truncateTables} from "./__testUtils__";
import {money} from "../money";
const actor={userId:1,branchId:1,role:"cashier"} as const;
const manager={userId:2,branchId:1,role:"admin",isOwner:true} as const;
const device="CHECKOUT-CHARGE-DEVICE";
function db(){const value=getDb();if(!value)throw new Error("isolated test DB required");return value;}
let sequence=0,partyId:number;
const key=()=>`CHECKOUT-${Date.now()}-${++sequence}`;
beforeEach(async()=>{
  await truncateTables(["journalLines","journalEntries","doubleEntrySettings","fulfillmentChargePayments","fulfillmentCharges","fulfillmentRequestItems","fulfillmentRequests","externalPaymentAttempts","idempotencyKeys","accountingEntries","auditLogs","receipts","deliveryOutbox","deliveryEvents","deliveryLedgerEntries","deliveryRemittanceLines","deliveryConsignments","deliveryRemittances","deliveryPartyMembers","deliveryParties","invoiceItems","invoices","inventoryMovements","productionRecipeLines","productionRecipes","branchStock","productPrices","productUnits","productVariants","products","shifts","customers","branches","users"]);
  await db().insert(s.branches).values({id:1,name:"MAIN",code:"MAIN",type:"MAIN"});
  await db().insert(s.users).values([
    {id:1,openId:"checkout-cashier",name:"Cashier",role:"cashier",branchId:1,operationalCaps:{maxServiceChargeAmountIqd:"10000"}},
    {id:2,openId:"checkout-owner",name:"Owner",role:"admin",isOwner:true,branchId:1},
    {id:3,openId:"checkout-courier",name:"Courier",role:"courier",branchId:1},
  ]);
  await db().insert(s.customers).values({id:1,name:"Known customer",creditLimit:"0",currentBalance:"0"});
  await db().insert(s.products).values([{id:1,name:"Book"},{id:2,name:"Printed output",isService:true,productType:"PRINT_SERVICE"}]);
  await db().insert(s.productVariants).values([{id:1,productId:1,sku:"CHK-BOOK",costPrice:"1000"},{id:2,productId:2,sku:"CHK-PRINT",costPrice:"0"}]);
  await db().insert(s.productUnits).values([{id:1,variantId:1,unitName:"piece",conversionFactor:"1",isBaseUnit:true},{id:2,variantId:2,unitName:"service",conversionFactor:"1",isBaseUnit:true}]);
  await db().insert(s.productPrices).values([{productUnitId:1,priceTier:"RETAIL",price:"50000"},{productUnitId:2,priceTier:"RETAIL",price:"50000"}]);
  await db().insert(s.branchStock).values({variantId:1,branchId:1,quantity:20});
  await db().insert(s.shifts).values([
    {id:1,branchId:1,userId:1,shiftType:"RETAIL",openingBalance:"100000",status:"OPEN",openGuard:"1:1:RETAIL"},
    {id:2,branchId:1,userId:2,shiftType:"RECEPTION",openingBalance:"100000",status:"OPEN",openGuard:"2:1:RECEPTION"},
    {id:3,branchId:1,userId:1,shiftType:"PRINT_SERVICES",openingBalance:"0",status:"OPEN",openGuard:"1:1:PRINT_SERVICES"},
  ]);
  partyId=(await createDeliveryParty({partyType:"INDIVIDUAL",name:"Courier",defaultFee:"5000",userId:3,branchId:1},manager)).id;
});
async function proof(amount:string,channel:"POS"|"PRINT_POS"="POS"){
  const result=await initiateExternalPaymentAttempt({branchId:1,channel,method:"CARD",amount,reference:key(),requestId:key(),deviceId:device},actor);
  await confirmExternalPaymentAttempt({attemptId:result.attemptId,branchId:1,channel,deviceId:device},actor);return result.attemptId;
}
function input():ConfirmedPosSaleInput{return {branchId:1,shiftId:1,deviceId:device,sourceType:"POS",clientRequestId:key(),lines:[{variantId:1,productUnitId:1,quantity:"1"}],payment:{method:"CASH",amount:"50000"},serviceCharges:[{description:"تغليف",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}],deliveryFeeHeld:"5000",deliveryFeeTender:{method:"CASH",combinedWithPaymentIndex:0},delivery:{partyId,assignedUserId:3,fee:"5000",feeCollection:"COUNTER",recipientName:"Buyer",recipientPhone:"07700000000",address:"Baghdad"}};}
describe("actual cashier checkout charges",()=>{
  it("finds outstanding approved charges after more than 100 settled rows with exact DECIMAL remainder",async()=>{
    const seed=(description:string,amount:string,paidAmount:string)=>({branchId:1,customerId:1,category:"SERVICE" as const,status:"APPROVED" as const,description,amount,paidAmount,createdBy:1,approvedBy:2,clientRequestId:key(),sourceHash:"0".repeat(64)});
    await db().insert(fulfillmentCharges).values(Array.from({length:101},(_,index)=>seed(`Settled ${index}`,"3000.00","3000.00")));
    await db().insert(fulfillmentCharges).values([seed("Open after settled history","3000.00","0.00"),seed("One cent outstanding","123456789012.34","123456789012.33")]);
    const options=await listCheckoutChargeOptions({branchId:1,customerId:1},actor,"sales.create");
    expect(options).toHaveLength(2);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({description:"Open after settled history",remainingAmount:"3000.00"}),
      expect.objectContaining({description:"One cent outstanding",remainingAmount:"0.01"}),
    ]));
  });
  it("50k goods + 3k guest SERVICE + 5k held fee collects 58k once and issues stock once",async()=>{
    const payload=input(),result=await createConfirmedPosSale(payload,actor);
    expect(result.checkoutPaymentSummary).toEqual({tenderedAmount:"58000.00",appliedAmount:"58000.00",changeAmount:"0.00"});
    const [invoice]=await db().select().from(s.invoices).where(eq(s.invoices.id,result.invoiceId));
    expect(invoice.total).toBe("50000.00");expect(invoice.paidAmount).toBe("50000.00");
    const rows=await db().select().from(s.receipts);expect(rows).toHaveLength(3);expect(rows.reduce((sum,row)=>sum.plus(money(row.amount)),money("0")).toFixed(2)).toBe("58000.00");
    const [charge]=await db().select().from(fulfillmentCharges);expect(charge.customerId).toBeNull();expect(charge.paidAmount).toBe("3000.00");
    expect(await db().select().from(s.customers)).toHaveLength(1);
    const movements=await db().select().from(s.inventoryMovements);expect(movements).toHaveLength(1);
    const replay=await createConfirmedPosSale(payload,actor);expect(replay.invoiceId).toBe(result.invoiceId);expect(await db().select().from(s.receipts)).toHaveLength(3);
    const journals=await db().select().from(s.accountingEntries);expect(journals.filter(row=>row.dedupeKey?.startsWith("CHECKOUT_CHARGE:"))).toHaveLength(1);
    expect(journals.find(row=>row.dedupeKey?.startsWith("CHECKOUT_CHARGE:"))?.revenue).toBe("3000.00");
  });
  it("retains cash change once over the whole tender",async()=>{
    const payload=input();payload.payment={method:"CASH",amount:"52000"};
    const result=await createConfirmedPosSale(payload,actor);
    expect(result.checkoutPaymentSummary).toEqual({tenderedAmount:"60000.00",appliedAmount:"58000.00",changeAmount:"2000.00"});
    expect((await db().select({sum:sql<string>`SUM(${s.receipts.amount})`}).from(s.receipts))[0].sum).toBe("58000.00");
  });
  it("one confirmed card operation funds all three allocations and replays without another provider charge",async()=>{
    const attemptId=await proof("58000"),payload=input();payload.payment={method:"CARD",amount:"50000",externalPaymentAttemptId:attemptId};payload.deliveryFeeTender={method:"CARD",combinedWithPaymentIndex:0};
    const result=await createConfirmedPosSale(payload,actor);expect(result.checkoutReceipts).toHaveLength(3);
    const rows=await db().select().from(s.receipts);expect(rows.every(row=>row.paymentMethod==="CARD"&&row.cashBucket==null)).toBe(true);
    expect((await db().select().from(s.externalPaymentAttempts))[0].consumedAt).not.toBeNull();
    expect((await createConfirmedPosSale(payload,actor)).checkoutReceipts).toEqual(result.checkoutReceipts);
    await expect(createConfirmedPosSale({...payload,clientRequestId:key()},actor)).rejects.toThrow();
    expect(await db().select().from(s.receipts)).toHaveLength(3);
  });
  it("mixed tender preserves separate rails and no noncash drawer effect",async()=>{
    const payload=input();delete payload.payment;
    payload.payments=[{method:"CARD",amount:"30000",externalPaymentAttemptId:await proof("33000")},{method:"CASH",amount:"20000"}];payload.deliveryFeeTender={method:"CASH",combinedWithPaymentIndex:1};
    const result=await createConfirmedPosSale(payload,actor);expect(result.checkoutPaymentSummary?.appliedAmount).toBe("58000.00");
    const rows=await db().select().from(s.receipts);expect(rows.filter(row=>row.paymentMethod==="CARD").every(row=>row.cashBucket==null)).toBe(true);
    expect(rows.filter(row=>row.paymentMethod==="CASH").reduce((sum,row)=>sum.plus(money(row.amount)),money("0")).toFixed(2)).toBe("25000.00");
  });
  it("sum cap rejects split lines atomically and rechecks current persisted cap",async()=>{
    const payload=input();payload.serviceCharges=[{description:"A",amount:"6000"},{description:"B",amount:"6000"}];payload.chargePayments=[{paymentIndex:0,amount:"12000"}];
    await expect(createConfirmedPosSale(payload,actor)).rejects.toThrow(/سقف/);expect(await db().select().from(s.invoices)).toHaveLength(0);
    await db().update(s.users).set({operationalCaps:{maxServiceChargeAmountIqd:"0"}}).where(eq(s.users.id,1));
    await expect(createConfirmedPosSale(input(),{...actor,operationalCaps:{maxServiceChargeAmountIqd:"999999"} as any})).rejects.toThrow(/سقف/);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });
  it("wrong proof leaves successful external operation recoverable and rolls back local effects",async()=>{
    const attemptId=await proof("55000"),payload=input();payload.payment={method:"CARD",amount:"50000",externalPaymentAttemptId:attemptId};payload.deliveryFeeTender={method:"CARD",combinedWithPaymentIndex:0};
    await expect(createConfirmedPosSale(payload,actor)).rejects.toThrow();
    expect(await db().select().from(s.invoices)).toHaveLength(0);expect(await db().select().from(fulfillmentCharges)).toHaveLength(0);
    expect((await db().select().from(s.externalPaymentAttempts))[0].consumedAt).toBeNull();
  });
  it("never retrofits a new charge collection onto an earlier goods receipt using the old checkout key",async()=>{
    const old=input();delete old.serviceCharges;delete old.chargePayments;
    await createConfirmedPosSale(old,actor);
    await expect(createConfirmedPosSale({...old,serviceCharges:[{description:"Late extra",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]},actor)).rejects.toThrow(/فاتورة سابقة/);
    expect(await db().select().from(fulfillmentCharges)).toHaveLength(0);
  });
  it.each(["POS","PRINT_POS"] as const)("%s charge-only guest SERVICE has a real receipt and no invoice/AR/stock fiction",async channel=>{
    const result=await createChargeOnlyCheckout({branchId:1,shiftId:channel==="POS"?1:3,clientRequestId:key(),payments:[{method:"CASH",amount:"0"}],serviceCharges:[{description:"خدمة مكتبة",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]},actor,channel);
    expect(result.mode).toBe("CHARGES");expect(result.checkoutPaymentSummary.appliedAmount).toBe("3000.00");
    expect(await db().select().from(s.invoices)).toHaveLength(0);expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    const entries=await db().select().from(s.accountingEntries);expect(entries).toHaveLength(1);expect(entries[0].customerId).toBeNull();expect(entries[0].revenue).toBe("3000.00");
  });
  it.each(["POS","PRINT_POS"] as const)("%s charge-only mixed tender preserves actual CARD and drawer cash with one cash change",async channel=>{
    const result=await createChargeOnlyCheckout({branchId:1,shiftId:channel==="POS"?1:3,deviceId:device,clientRequestId:key(),payments:[{method:"CARD",amount:"0",externalPaymentAttemptId:await proof("1500",channel),externalPaymentDeviceId:device},{method:"CASH",amount:"500"}],serviceCharges:[{description:"Mixed guest service",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"1500"},{paymentIndex:1,amount:"1500"}]},actor,channel);
    expect(result.checkoutPaymentSummary).toEqual({tenderedAmount:"3500.00",appliedAmount:"3000.00",changeAmount:"500.00"});
    const rows=await db().select().from(s.receipts);expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.paymentMethod==="CARD")).toMatchObject({amount:"1500.00",cashBucket:null});
    expect(rows.find(row=>row.paymentMethod==="CASH")).toMatchObject({amount:"1500.00",cashBucket:"DRAWER"});
    expect(await db().select().from(s.invoices)).toHaveLength(0);expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });
  it("known customer service accrues and collects once; guest refund reverses direct revenue on original rail",async()=>{
    await createChargeOnlyCheckout({branchId:1,shiftId:1,customerId:1,clientRequestId:key(),payments:[{method:"CASH",amount:"0"}],serviceCharges:[{description:"Known",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]},actor,"POS");
    expect((await db().select().from(s.customers).where(eq(s.customers.id,1)))[0].currentBalance).toBe("0.00");
    const guest=await createChargeOnlyCheckout({branchId:1,shiftId:1,clientRequestId:key(),payments:[{method:"CASH",amount:"0"}],serviceCharges:[{description:"Guest",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]},actor,"POS");
    const allocation=guest.chargeAllocations[0],row=(await db().select().from(fulfillmentCharges).where(eq(fulfillmentCharges.id,allocation.chargeId)))[0];
    const refunded=await refundFulfillmentCharge({id:row.id,expectedVersion:row.version,originalPaymentId:allocation.paymentId,amount:"3000",reason:"إلغاء الخدمة الموثق",clientRequestId:key()},manager);
    const receipt=(await db().select().from(s.receipts).where(eq(s.receipts.id,refunded.receiptId)))[0];expect(receipt.direction).toBe("OUT");expect(receipt.paymentMethod).toBe("CASH");
    const entry=(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId,refunded.receiptId)))[0];expect(entry.revenue).toBe("-3000.00");expect(entry.customerId).toBeNull();
  });
  it("PRINTING actual sale consumes one PRINT_POS proof including service extras",async()=>{
    const result=await createPrintSale({branchId:1,shiftId:3,deviceId:device,clientRequestId:key(),requireExternalPaymentAttempt:true,lines:[{variantId:2,productUnitId:2,quantity:"1"}],payment:{method:"CARD",amount:"50000",externalPaymentAttemptId:await proof("53000","PRINT_POS")},serviceCharges:[{description:"تجليد",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]},actor);
    expect(result.checkoutPaymentSummary?.appliedAmount).toBe("53000.00");expect((await db().select().from(s.invoices))[0].paidAmount).toBe("50000.00");
  });
  it("an independently approved existing claim joins the same cashier tender without a second accrual",async()=>{
    await db().update(s.customers).set({creditLimit:null}).where(eq(s.customers.id,1));
    const draft=await createFulfillmentCharge({branchId:1,customerId:1,category:"SERVICE",description:"خدمة معتمدة",amount:"3000",externalCost:"0",clientRequestId:key()},actor);
    const charge=await approveFulfillmentCharge({id:draft.id,expectedVersion:draft.version,clientRequestId:key()},manager);
    const payload=input();payload.customerId=1;payload.serviceCharges=[];payload.approvedChargeAllocations=[{chargeId:charge.id,expectedVersion:charge.version,amount:"3000"}];
    const result=await createConfirmedPosSale(payload,actor);expect(result.checkoutPaymentSummary?.appliedAmount).toBe("58000.00");
    expect((await db().select().from(s.customers).where(eq(s.customers.id,1)))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(fulfillmentChargePayments)).filter(row=>row.chargeId===charge.id&&row.kind==="COLLECTION")).toHaveLength(1);
    expect((await db().select().from(s.accountingEntries)).filter(row=>row.dedupeKey===`FULFILLMENT_CHARGE_ACCRUAL:${charge.id}`)).toHaveLength(1);
  });
  it("a guest card refund waits for actual original-rail confirmation and cannot consume its allocation twice",async()=>{
    const payload={branchId:1,shiftId:1,deviceId:device,clientRequestId:key(),payments:[{method:"CARD" as const,amount:"0",externalPaymentAttemptId:await proof("3000")}],serviceCharges:[{description:"Guest card service",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]};
    const paid=await createChargeOnlyCheckout(payload,actor,"POS"),allocation=paid.chargeAllocations[0];
    const row=(await db().select().from(fulfillmentCharges).where(eq(fulfillmentCharges.id,allocation.chargeId)))[0];
    const refund={id:row.id,expectedVersion:row.version,originalPaymentId:allocation.paymentId,amount:"3000",reason:"رد الخدمة الموثق",clientRequestId:key()};
    await expect(refundFulfillmentCharge(refund,manager)).rejects.toThrow(/مرجع/);
    expect((await db().select().from(s.receipts)).filter(row=>row.direction==="OUT")).toHaveLength(0);
    const result=await refundFulfillmentCharge({...refund,reference:key()},manager);
    const receipt=(await db().select().from(s.receipts).where(eq(s.receipts.id,result.receiptId)))[0];expect(receipt.paymentMethod).toBe("CARD");expect(receipt.cashBucket).toBeNull();
    await expect(refundFulfillmentCharge({...refund,clientRequestId:key(),expectedVersion:row.version+1,reference:key()},manager)).rejects.toThrow();
  });
});

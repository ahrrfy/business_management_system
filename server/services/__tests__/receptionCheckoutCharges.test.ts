import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { checkoutReception } from "../receptionCheckoutService";
import { confirmExternalPaymentAttempt, initiateExternalPaymentAttempt } from "../posExternalPayment";
import { collectDeposit, commitDraft, promoteDraft } from "../reception";
import { approveWorkOrderControlRequest, requestWorkOrderControl } from "../workOrder/controlRequests";
import { deliverWorkOrder } from "../workOrder/deliver";
import { prepareWorkOrderDeliveryInvoiceInTx } from "../delivery/dispatch";
import { withTx } from "../tx";
import { loadWorkOrderDepositReceiptSet } from "../workOrder/depositReceiptSet";
import {fulfillmentCharges} from "../../../drizzle/fulfillmentSchema";
import {createChargeOnlyCheckout} from "../checkoutCharges";

const actor = { userId: 2, branchId: 1, role: "cashier" } as const;
const device = "RECEPTION-SPLIT-DEVICE";
const db = () => getDb()!;
let seq = 0;
const key = () => `reception-split-${Date.now()}-${++seq}`;

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 2, openId: "split-cashier", name: "Cashier", role: "cashier", branchId: 1, operationalCaps:{maxServiceChargeAmountIqd:"10000"} });
  await db().insert(s.users).values({ id: 3, openId: "split-admin", name: "Admin", role: "admin", branchId: 1, isOwner: true });
  await db().insert(s.customers).values({ id: 1, name: "عميل محفوظ", phone: "07701234567", creditLimit: "100000" });
  await db().insert(s.products).values([
    { id: 1, name: "Goods" },
    { id: 2, name: "Print", productType: "PRINT_SERVICE", isService: true },
  ]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SPLIT-GOODS", costPrice: "100" },
    { id: 2, productId: 2, sku: "SPLIT-PRINT", costPrice: "0" },
  ]);
  await db().insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "piece", conversionFactor: 1, isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "service", conversionFactor: 1, isBaseUnit: true },
  ]);
  await db().insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000" },
  ]);
  await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 100 });
  await db().insert(s.shifts).values({ id: 1, userId: 2, branchId: 1, shiftType: "RECEPTION", status: "OPEN", openingBalance: "5000", openGuard: "1:2:RECEPTION" });
});


async function card(amount:string){const result=await initiateExternalPaymentAttempt({branchId:1,channel:"PRINT_POS",method:"CARD",amount,reference:key(),requestId:key(),deviceId:device},actor);await confirmExternalPaymentAttempt({branchId:1,channel:"PRINT_POS",attemptId:result.attemptId,deviceId:device},actor);return {method:"CARD" as const,amount,externalPaymentAttemptId:result.attemptId,externalPaymentDeviceId:device};}
const charges={serviceCharges:[{description:"تغليف",amount:"3000"}],chargePayments:[{paymentIndex:0,amount:"3000"}]};
const goods=(quantity="1",amount="1000")=>({amount,lines:[{variantId:1,productUnitId:1,quantity}]});
describe("actual Reception unified checkout",()=>{
 it("collects 50k goods + 3k SERVICE + 5k held fee with one real card operation",async()=>{
  await db().update(s.productPrices).set({price:"50000"}).where(eq(s.productPrices.productUnitId,1));
  await db().insert(s.deliveryParties).values({id:1,name:"Oracle courier",partyType:"COMPANY",isActive:true});
  const proof=await card("58000");
  const payload={branchId:1,shiftId:1,clientRequestId:key(),regularSale:goods("1","50000"),payments:[{...proof,amount:"50000"}],paidAmount:"50000",...charges,delivery:{partyId:1,fee:"5000",feeCollection:"COUNTER" as const,recipientName:"Buyer",recipientPhone:"07701234567",address:"Baghdad",externalTrackingRef:"ORACLE-WAYBILL"},deliveryFeeHeld:"5000",deliveryFeeTender:{method:"CARD" as const,combinedWithPaymentIndex:0,...{externalPaymentAttemptId:proof.externalPaymentAttemptId,externalPaymentDeviceId:device}}};
  const result=await checkoutReception(payload,actor);
  expect(result.paymentSummary).toEqual({tenderedAmount:"50000.00",appliedAmount:"50000.00",changeAmount:"0.00"});
  expect(result.checkoutPaymentSummary).toEqual({tenderedAmount:"58000.00",appliedAmount:"58000.00",changeAmount:"0.00"});
  expect(result.checkoutReceipts?.map(r=>r.kind).sort()).toEqual(["GOODS","HELD_DELIVERY","SERVICE"]);
  expect((await db().select().from(s.invoices))[0]).toMatchObject({total:"50000.00",paidAmount:"50000.00"});
  const rows=await db().select().from(s.receipts);expect(rows).toHaveLength(3);expect(rows.every(r=>r.paymentMethod==="CARD"&&r.cashBucket===null)).toBe(true);
  expect((await db().select().from(s.branchStock))[0].quantity).toBe(99);
  const replay=await checkoutReception(payload,actor);expect(replay.checkoutReceipts).toEqual(result.checkoutReceipts);expect(await db().select().from(s.receipts)).toHaveLength(3);
 });
 it("one mixed tender spans goods, print and two genuine WO deposit receipts",async()=>{
  const proof=await card("6500");
  const payload={branchId:1,shiftId:1,customerId:1,clientRequestId:key(),regularSale:goods(),printSale:{amount:"1000",lines:[{variantId:2,productUnitId:2,quantity:"1"}]},workOrders:[{title:"First custom",quantity:1,salePrice:"1000"},{title:"Second custom",quantity:1,salePrice:"1000"}],payments:[{...proof,amount:"3500"},{method:"CASH" as const,amount:"700"}],...charges};
  const result=await checkoutReception(payload,actor);
  expect(result.paymentSummary).toEqual({tenderedAmount:"4200.00",appliedAmount:"4000.00",changeAmount:"200.00"});
  expect(result.checkoutPaymentSummary).toEqual({tenderedAmount:"7200.00",appliedAmount:"7000.00",changeAmount:"200.00"});
  expect(result.workOrders).toHaveLength(2);expect(result.paymentAllocations?.filter(a=>a.workOrderId!=null)).toHaveLength(3);
  expect(result.checkoutReceipts?.filter(a=>a.kind==="DEPOSIT")).toHaveLength(3);
  expect((await db().select().from(s.externalPaymentAttempts))[0].consumedAt).not.toBeNull();
  expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
 });
 it("guest Reception charge-only CARD receipt has no invoice, invented cash or AR",async()=>{
  const proof=await card("3000");
  const payload={branchId:1,shiftId:1,clientRequestId:key(),payments:[{...proof,amount:"0"}],...charges};
  const result=await createChargeOnlyCheckout(payload,actor,"PRINT_POS","workOrders.receptionCheckout");
  expect(result.checkoutReceipts).toHaveLength(1);expect(await db().select().from(s.invoices)).toHaveLength(0);expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  expect((await db().select().from(s.receipts))[0]).toMatchObject({amount:"3000.00",cashBucket:null,paymentMethod:"CARD"});
  expect((await db().select().from(fulfillmentCharges))[0]).toMatchObject({customerId:null,paidAmount:"3000.00"});
  const replay=await createChargeOnlyCheckout(payload,actor,"PRINT_POS","workOrders.receptionCheckout");expect(replay.checkoutReceipts).toEqual(result.checkoutReceipts);
 });
 it("locked saved draft intent survives get/resume and lost commit response without spending held deposit twice",async()=>{
  const draft=await promoteDraft({branchId:1,header:{customerId:1,checkoutCharges:{serviceCharges:charges.serviceCharges,approvedChargeAllocations:[]}},lines:[{lineKind:"GOODS",variantId:1,productUnitId:1,quantity:"1",unitPrice:"1000",title:"Book"}]},actor);
  const held=await collectDeposit({draftId:draft.draftId,amount:"200",method:"CASH",clientRequestId:key()},actor);
  const current=(await db().select().from(s.receptionDrafts))[0];expect(current.checkoutCharges?.serviceCharges).toEqual(charges.serviceCharges);
  const proof=await card("3800");const payload={draftId:draft.draftId,version:current.version,expectedTotal:"1000",shiftId:1,payments:[{...proof,amount:"800"}],...charges};
  const result=await commitDraft(payload,actor);expect(result.heldApplied).toBe("200.00");expect(result.checkoutPaymentSummary?.appliedAmount).toBe("3800.00");
  expect(result.checkoutReceipts?.some(a=>a.receiptId===held.receiptId)).toBe(false);
  const replay=await commitDraft(payload,actor);expect(replay.checkoutReceipts).toEqual(result.checkoutReceipts);expect(await db().select().from(s.receipts)).toHaveLength(3);
 });
 it("changed draft intent echo or current cap revocation rolls back all new allocations",async()=>{
  const draft=await promoteDraft({branchId:1,header:{customerId:1,checkoutCharges:{serviceCharges:charges.serviceCharges}},lines:[{lineKind:"GOODS",variantId:1,productUnitId:1,quantity:"1",unitPrice:"1000",title:"Book"}]},actor);
  const current=(await db().select().from(s.receptionDrafts))[0];const payload={draftId:draft.draftId,version:current.version,expectedTotal:"1000",shiftId:1,payments:[{method:"CASH" as const,amount:"1000"}],...charges};
  await expect(commitDraft({...payload,serviceCharges:[{description:"changed",amount:"3000"}]},actor)).rejects.toThrow();
  await db().update(s.users).set({operationalCaps:{maxServiceChargeAmountIqd:"0"}}).where(eq(s.users.id,2));
  await expect(commitDraft(payload,actor)).rejects.toThrow();expect(await db().select().from(s.receipts)).toHaveLength(0);expect(await db().select().from(fulfillmentCharges)).toHaveLength(0);
 });
});

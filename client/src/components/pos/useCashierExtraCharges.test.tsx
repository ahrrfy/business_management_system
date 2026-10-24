// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({retail:vi.fn(),printing:vi.fn(),notifyError:vi.fn(),print:vi.fn()}));
vi.mock("@/lib/trpc",()=>({trpc:{sales:{checkoutCharges:{useMutation:()=>({mutateAsync:mocks.retail,isPending:false})}},printPos:{checkoutCharges:{useMutation:()=>({mutateAsync:mocks.printing,isPending:false})}}}}));
vi.mock("@/lib/notify",()=>({notify:{ok:vi.fn(),err:mocks.notifyError}}));
vi.mock("./printChargeReceipt",()=>({printCheckoutAllocationReceipt:mocks.print}));
import {useCashierExtraCharges} from "./useCashierExtraCharges";
import type {PosPaymentLegDraft} from "./posShared";
const roots:Root[]=[];
function renderHook<T>(factory:()=>T){
  let current:T,latest=factory;function Probe(){current=latest();return null;}
  const root=createRoot(document.createElement("div"));roots.push(root);act(()=>root.render(<Probe/>));
  return {result:{get current(){return current;}},rerender(next:()=>T){latest=next;act(()=>root.render(<Probe/>));}};
}
const result={mode:"CHARGES",recoveryToken:"CHECKOUT-TEST-KEY",checkoutReceipts:[{receiptId:50,paymentIndex:0,method:"CARD",amount:"1500.00",reference:"BANK-81",kind:"SERVICE"},{receiptId:51,paymentIndex:1,method:"CASH",amount:"1500.00",reference:null,kind:"SERVICE"}],checkoutPaymentSummary:{tenderedAmount:"3500.00",appliedAmount:"3000.00",changeAmount:"500.00"},chargeAllocations:[]};
function props(channel:"POS"|"PRINT_POS"="POS"){
  const legs:PosPaymentLegDraft[]=[{id:"card",method:"CARD",amount:"1500",paymentRef:"BANK-81",externalPayment:{attemptId:81,deviceId:"TERMINAL",requestId:"BANK-81-KEY",state:"CONFIRMED",fingerprint:"CARD|1500.00|BANK-81"}},{id:"cash",method:"CASH",amount:"2000",paymentRef:"",externalPayment:null}];
  return {channel,branchId:1,shiftId:1,token:"CHECKOUT-TEST-KEY",tab:{id:7,customerId:null,method:"CASH" as const,payInput:"",externalPayment:null,extraCharges:{serviceCharges:[{description:"تغليف",amount:"3000"}]}},enabled:true,connected:true,confirmed:false,cartLength:0,goodsTender:"0",busy:false,splitLegs:legs,onChange:vi.fn(),onCommitted:vi.fn(),refresh:vi.fn()};
}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,React});vi.clearAllMocks();mocks.retail.mockResolvedValue(result);mocks.printing.mockResolvedValue(result);});
afterEach(()=>{act(()=>roots.splice(0).forEach(root=>root.unmount()));});
describe("charge-only cashier UI command",()=>{
  it.each(["POS","PRINT_POS"] as const)("%s submits one command preserving confirmed CARD + actual CASH and change",async channel=>{
    const input=props(channel),hook=renderHook(()=>useCashierExtraCharges(input));
    await act(async()=>{await hook.result.current.submitChargesOnly();});
    const mutation=channel==="POS"?mocks.retail:mocks.printing;
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0][0]).toMatchObject({payments:[{method:"CARD",amount:"0.00",externalPaymentAttemptId:81,externalPaymentDeviceId:"TERMINAL"},{method:"CASH",amount:"500.00"}],chargePayments:[{paymentIndex:0,amount:"1500.00"},{paymentIndex:1,amount:"1500.00"}]});
    expect(input.onCommitted).toHaveBeenCalledWith(7,{result,recoveryToken:"CHECKOUT-TEST-KEY"});
  });
  it("does not clear the draft or create cash when a card proof no longer matches",async()=>{
    const input=props();input.splitLegs[0].amount="1600";
    const hook=renderHook(()=>useCashierExtraCharges(input));await act(async()=>{await hook.result.current.submitChargesOnly();});
    expect(mocks.retail).not.toHaveBeenCalled();expect(input.onCommitted).not.toHaveBeenCalled();expect(mocks.notifyError).toHaveBeenCalled();
  });
  it("keeps the original request and proof after a lost response",async()=>{
    mocks.retail.mockRejectedValueOnce(new Error("connection lost"));const input=props(),hook=renderHook(()=>useCashierExtraCharges(input));
    await act(async()=>{await hook.result.current.submitChargesOnly();});expect(input.onCommitted).not.toHaveBeenCalled();
    await act(async()=>{await hook.result.current.submitChargesOnly();});
    expect(mocks.retail.mock.calls[0][0]).toEqual(mocks.retail.mock.calls[1][0]);
  });
  it("never clears or prints into a different branch or checkout after a delayed committed response",async()=>{
    let resolve!:(value:typeof result)=>void;mocks.retail.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const input=props(),hook=renderHook(()=>useCashierExtraCharges(input));let pending!:Promise<void>;
    act(()=>{pending=hook.result.current.submitChargesOnly();});
    const next={...props(),branchId:2,token:"NEXT-CHECKOUT-KEY"};hook.rerender(()=>useCashierExtraCharges(next));
    await act(async()=>{resolve(result);await pending;});
    expect(input.onCommitted).not.toHaveBeenCalled();expect(next.onCommitted).not.toHaveBeenCalled();expect(mocks.print).not.toHaveBeenCalled();
  });
});

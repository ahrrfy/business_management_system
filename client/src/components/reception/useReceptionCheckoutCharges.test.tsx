// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({mutation:vi.fn(),recovery:vi.fn(),notifyError:vi.fn(),print:vi.fn()}));
vi.mock("@/lib/trpc",()=>({trpc:{useUtils:()=>({reception:{checkoutRecovery:{fetch:mocks.recovery}}}),reception:{checkoutCharges:{useMutation:()=>({mutateAsync:mocks.mutation,isPending:false})}}}}));
vi.mock("@/lib/notify",()=>({notify:{ok:vi.fn(),err:mocks.notifyError}}));
vi.mock("@/components/pos/printChargeReceipt",()=>({printCheckoutAllocationReceipt:mocks.print}));
import {useReceptionCheckoutCharges} from "./useReceptionCheckoutCharges";

const roots:Root[]=[];
function renderHook<T>(factory:()=>T){
  let current:T,latest=factory;function Probe(){current=latest();return null;}
  const root=createRoot(document.createElement("div"));roots.push(root);act(()=>root.render(<Probe/>));
  return {result:{get current(){return current;}},rerender(next:()=>T){latest=next;act(()=>root.render(<Probe/>));}};
}

const result={recoveryToken:"ORIGINAL",checkoutReceipts:[{receiptId:10,paymentIndex:0,method:"CARD",amount:"3000.00",reference:"BANK",kind:"SERVICE"}],checkoutPaymentSummary:{tenderedAmount:"3000.00",appliedAmount:"3000.00",changeAmount:"0.00"},chargeAllocations:[]};
const props=()=>({branchId:1,shiftId:1,customerId:null,token:"REQUEST",value:{serviceCharges:[{description:"خدمة",amount:"3000"}]},setValue:vi.fn(),disabled:false,goodsTender:"0",cartLength:0,onSubmit:vi.fn(),onSplit:vi.fn(),resetCommitted:vi.fn(()=>true)});
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,React});vi.clearAllMocks();mocks.mutation.mockResolvedValue(result);mocks.recovery.mockResolvedValue(result);});
afterEach(()=>act(()=>roots.splice(0).forEach(root=>root.unmount())));
describe("actual Reception charge-only UI and recovery",()=>{
 it("submits a single CARD command with real proof, no dummy customer or cash",async()=>{
  const input=props(),hook=renderHook(()=>useReceptionCheckoutCharges(input));
  await act(async()=>{await hook.result.current.submitOnly({method:"CARD",payInput:"",proof:{method:"CARD",externalPaymentAttemptId:7,externalPaymentDeviceId:"terminal"},confirmed:true});});
  expect(mocks.mutation).toHaveBeenCalledTimes(1);expect(mocks.mutation.mock.calls[0][0]).toMatchObject({customerId:null,payments:[{amount:"0.00",method:"CARD",externalPaymentAttemptId:7}],chargePayments:[{paymentIndex:0,amount:"3000.00"}]});expect(input.resetCommitted).toHaveBeenCalledTimes(1);
 });
 it("lost response keeps the original request/proof and never resets before confirmation",async()=>{
  mocks.mutation.mockRejectedValueOnce(new Error("lost"));const input=props(),hook=renderHook(()=>useReceptionCheckoutCharges(input));const args={method:"CARD",payInput:"",proof:{method:"CARD" as const,externalPaymentAttemptId:7,externalPaymentDeviceId:"terminal"},confirmed:true};
  await act(async()=>{await hook.result.current.submitOnly(args);});expect(input.resetCommitted).not.toHaveBeenCalled();
  await act(async()=>{await hook.result.current.submitOnly(args);});expect(mocks.mutation.mock.calls[0][0]).toEqual(mocks.mutation.mock.calls[1][0]);
 });
 it("a committed draft restores original receipts with a read-only request",async()=>{
  const input=props(),hook=renderHook(()=>useReceptionCheckoutCharges(input));await act(async()=>{await hook.result.current.recoverDraft(12);});
  expect(mocks.recovery).toHaveBeenCalledWith({draftId:12,branchId:1},{staleTime:0});expect(mocks.mutation).not.toHaveBeenCalled();expect(mocks.print).toHaveBeenCalledWith(expect.objectContaining({checkoutReceipts:result.checkoutReceipts}),"ORIGINAL");
 });
 it("delayed response never resets or prints into another checkout",async()=>{
  let done!:(value:typeof result)=>void;mocks.mutation.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;}));
  const input=props(),hook=renderHook(()=>useReceptionCheckoutCharges(input));let pending!:Promise<void>;act(()=>{pending=hook.result.current.submitOnly({method:"CASH",payInput:"",proof:null,confirmed:true});});
  hook.rerender(()=>useReceptionCheckoutCharges({...props(),token:"NEXT"}));await act(async()=>{done(result);await pending;});expect(input.resetCommitted).not.toHaveBeenCalled();expect(mocks.print).not.toHaveBeenCalled();
 });
});

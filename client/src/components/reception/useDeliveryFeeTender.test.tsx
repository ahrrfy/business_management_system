// @vitest-environment jsdom
import React,{act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({start:vi.fn(),finish:vi.fn()}));
vi.mock("@/lib/trpc",()=>({trpc:{reception:{initiateExternalPayment:{useMutation:()=>({mutateAsync:mocks.start,isPending:false})},confirmExternalPayment:{useMutation:()=>({mutateAsync:mocks.finish,isPending:false})}}}}));
vi.mock("@/lib/offline/outbox",()=>({getDeviceCode:async()=>"terminal"}));
import {useDeliveryFeeTender} from "./useDeliveryFeeTender";
const roots:Root[]=[];
function renderHook<T>(factory:()=>T){
  let current:T,latest=factory;function Probe(){current=latest();return null;}
  const root=createRoot(document.createElement("div"));roots.push(root);act(()=>root.render(<Probe/>));
  return {result:{get current(){return current;}},rerender(next:()=>T){latest=next;act(()=>root.render(<Probe/>));}};
}


const input=()=>({branchId:1,ownerId:7,method:"CARD",goodsAmount:"50000",feeHeld:"8000",reference:"ORIGINAL-BANK",clientRequestId:"checkout-key"});
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,React});localStorage.clear();vi.clearAllMocks();mocks.start.mockResolvedValue({attemptId:12});mocks.finish.mockResolvedValue({});});
afterEach(()=>act(()=>roots.splice(0).forEach(root=>root.unmount())));
describe("Reception scalar whole-checkout proof recovery",()=>{
 it("confirms 58k once and restores the reference and proof for the same actor and request",async()=>{
  const hook=renderHook(()=>useDeliveryFeeTender(input()));await act(async()=>{await hook.result.current.confirm();});
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({amount:"58000.00",method:"CARD"}));expect(hook.result.current.confirmed).toBe(true);
  act(()=>roots.splice(0).forEach(root=>root.unmount()));
  const restored=renderHook(()=>useDeliveryFeeTender({...input(),reference:""}));expect(restored.result.current.restoredReference).toBe("ORIGINAL-BANK");
  restored.rerender(()=>useDeliveryFeeTender(input()));expect(restored.result.current.confirmed).toBe(true);expect(restored.result.current.tender).toMatchObject({externalPaymentAttemptId:12,externalPaymentDeviceId:"terminal",combinedWithPaymentIndex:0});expect(mocks.start).toHaveBeenCalledTimes(1);
 });
 it("does not restore reference into another actor, amount or request",async()=>{
  const hook=renderHook(()=>useDeliveryFeeTender(input()));await act(async()=>{await hook.result.current.confirm();});
  for(const next of [{...input(),ownerId:8},{...input(),feeHeld:"9000"},{...input(),clientRequestId:"new"}]){hook.rerender(()=>useDeliveryFeeTender({...next,reference:""}));expect(hook.result.current.restoredReference).toBeFalsy();expect(hook.result.current.confirmed).toBe(false);}
  hook.rerender(()=>useDeliveryFeeTender({...input(),clientRequestId:"new"}));expect(hook.result.current.confirmed).toBe(false);
 });
});

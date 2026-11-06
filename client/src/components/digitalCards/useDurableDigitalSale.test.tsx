// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinancialIntent, FinancialIntentScope } from "@/lib/persistedFinancialIntent";
const state = vi.hoisted(() => ({
  saved: new Map<string, FinancialIntent<unknown>>(), failSave: false, losePrepare: false, loseFinalize: false,
  intents: new Map<string, number>(), invoices: new Map<number, number>(), status: "EXECUTED", refunded: false,
  prepare: vi.fn(), finalize: vi.fn(), initiate: vi.fn(), confirm: vi.fn(), read: vi.fn(), completed: vi.fn(), prepared: vi.fn(), onRefunded: vi.fn(),
}));
vi.mock("@/lib/offline/outbox", () => ({ getDeviceCode: async () => "reception-device-1" }));
vi.mock("@/lib/persistedFinancialIntent", () => ({
  digitalWorkspaceScopes:async(scope:FinancialIntentScope)=>Array.from(state.saved.keys()).map(s=>JSON.parse(s) as FinancialIntentScope).filter(s=>s.operation===scope.operation && s.userId===scope.userId && s.companyId===scope.companyId && s.target===scope.target),
  financialIntentScopeKey: (scope: unknown) => JSON.stringify(scope),
  loadFinancialIntent: async (scope: unknown) => state.saved.get(JSON.stringify(scope)) ?? null,
  reserveFinancialIntent: async (scope: unknown, envelope: FinancialIntent<unknown>) => {
    if (state.failSave) throw Error("quota");
    const key = JSON.stringify(scope); if (!state.saved.has(key)) state.saved.set(key, structuredClone(envelope)); return state.saved.get(key);
  },
  resolveFinancialIntent: async (scope: unknown, id: string) => { const key = JSON.stringify(scope); if (state.saved.get(key)?.id !== id) return false; state.saved.delete(key); return true; },
}));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ digitalCards: { sales: { getIntent: { fetch: state.read } } } }),
  digitalCards: { sales: { prepare: { useMutation: () => ({ mutateAsync: state.prepare }) }, finalize: { useMutation: () => ({ mutateAsync: state.finalize }) } } },
  sales: { initiateExternalPayment: { useMutation: () => ({ mutateAsync: state.initiate }) }, confirmExternalPayment: { useMutation: () => ({ mutateAsync: state.confirm }) } },
} }));
vi.mock("@/lib/confirm",()=>({confirm:async()=>true}));
import { useDurableDigitalSale, type DigitalWorkspaceCommand } from "./useDurableDigitalSale";
const uuid="12345678-1234-5678-1234-567812345678";
const pos:FinancialIntentScope={companyId:null,userId:7,branchId:1,operation:"DIGITAL_POS",target:"tab:1"};
const invoice:FinancialIntentScope={...pos,operation:"DIGITAL_INVOICE",target:"tab:"+uuid};
function command(source:"POS"|"INVOICE",method:"CASH"|"CARD"|"CREDIT"):DigitalWorkspaceCommand {
  const id=source==="INVOICE"?uuid:"original";
  return {amount:method==="CREDIT"?"0.00":"9000.00",received:method==="CREDIT"?"0.00":"10000.00",customerName:"original",
    prepare:{branchId:1,shiftId:5,clientRequestId:id,cartFingerprint:"immutable",paymentMethod:method,sourceType:source,customerId:10,
      sourcePayload:source==="INVOICE"?{version:1,lines:[{discountPercent:"10"}]}:undefined,
      lines:[{lineKey:"one",offeringId:1,priceVersionId:2,expectedSellPrice:"10000",providerReference:"REF"}]},
    ...(method==="CARD"?{proof:{requestId:id+":card",reference:"ORIGINAL-BANK",deviceId:"original-device"}}:{})};
}
let api:ReturnType<typeof useDurableDigitalSale>;let root:Root;let element:HTMLDivElement;
function Harness({scope}:{scope:FinancialIntentScope}){api=useDurableDigitalSale(scope,{onCompleted:state.completed,onNotAdmitted:state.onRefunded});return null;}
async function mount(scope=pos){element=document.createElement("div");document.body.append(element);root=createRoot(element);await act(async()=>{root.render(<Harness scope={scope}/>);});}
beforeEach(()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.clearAllMocks();state.saved.clear();state.intents.clear();state.invoices.clear();
  state.failSave=false;state.losePrepare=false;state.loseFinalize=false;state.status="EXECUTED";
  sessionStorage.setItem("advanced-sales-payment-session:7",uuid);
  state.initiate.mockImplementation(async()=>{expect(state.saved.size).toBeGreaterThan(0);return {attemptId:44,state:"INITIATED"};});
  state.confirm.mockResolvedValue({attemptId:44});
  state.prepare.mockImplementation(async(input:{clientRequestId:string})=>{
    if(!state.intents.has(input.clientRequestId))state.intents.set(input.clientRequestId,9);
    if(state.losePrepare){state.losePrepare=false;throw Error("lost prepare");}return {intentId:9};
  });
  state.finalize.mockImplementation(async(input:{intentId:number})=>{
    state.invoices.set(input.intentId,55);if(state.loseFinalize){state.loseFinalize=false;throw Error("lost finalized response");}
    return {intentId:input.intentId,invoiceId:55};
  });
  state.read.mockImplementation(async()=>({intent:{status:state.invoices.size?"FINALIZED":state.status},financialSettlement:null}));
});
afterEach(async()=>{await act(async()=>root.unmount());element.remove();vi.unstubAllGlobals();});
describe("exact durable POS and INVOICE command",()=>{
  it.each([["POS","CASH"],["POS","CARD"],["INVOICE","CASH"],["INVOICE","CREDIT"]] as const)("restores %s/%s after reload and ignores a changed form, then finalizes once",async(source,method)=>{
    const scope=source==="INVOICE"?invoice:pos;const original=command(source,method);
    await mount(scope);state.losePrepare=true;
    await act(async()=>{await api.start(original);});expect(api.pending).toBe(true);
    await act(async()=>root.unmount());element.remove();await mount(scope);
    await act(async()=>{await api.start({...command(source,"CASH"),prepare:{...original.prepare,customerId:99,lines:[]}});});
    expect(state.prepare.mock.calls[1][0]).toMatchObject(original.prepare);
    if(method==="CARD"){
      expect(state.initiate.mock.calls).toHaveLength(2);
      expect(state.initiate.mock.calls.every(([c])=>c.requestId==="original:card"&&c.reference==="ORIGINAL-BANK"&&c.deviceId==="original-device")).toBe(true);
    } else expect(state.initiate).not.toHaveBeenCalled();
    state.loseFinalize=true;await act(async()=>{await api.finish(9);});
    expect(state.saved.size).toBe(1);await act(async()=>{await api.retry();});
    expect(state.finalize.mock.calls.every(([c])=>c.customerId===10&&c.paymentMethod===method&&c.clientRequestId===original.prepare.clientRequestId&&c.paymentAmount===original.amount)).toBe(true);
    expect(state.invoices.size).toBe(1);expect(state.saved.size).toBe(0);expect(state.completed).toHaveBeenCalledOnce();
  });
  it("isolates POS tabs and recovers an invoice from its original branch",async()=>{
    await mount(pos);state.losePrepare=true;await act(async()=>{await api.start(command("POS","CARD"));});
    await act(async()=>root.unmount());element.remove();await mount({...pos,target:"tab:2"});expect(api.pending).toBe(false);
    await act(async()=>root.unmount());element.remove();await mount(invoice);state.losePrepare=true;
    await act(async()=>{await api.start(command("INVOICE","CREDIT"));});
    await act(async()=>root.unmount());element.remove();await mount({...invoice,branchId:8});
    expect(api.pending).toBe(true);await act(async()=>{await api.retry();});
    expect(state.prepare.mock.calls.at(-1)?.[0]).toMatchObject({branchId:1,paymentMethod:"CREDIT"});
  });
  it("preserves unknown bank state and recovers a lost confirmation with the same proof request",async()=>{
    await mount(pos);state.initiate.mockResolvedValueOnce({attemptId:44,state:"UNKNOWN"});
    await act(async()=>{await api.start(command("POS","CARD"));});
    expect(state.confirm).not.toHaveBeenCalled();expect(state.prepare).not.toHaveBeenCalled();expect(api.pending).toBe(true);
    state.confirm.mockRejectedValueOnce(Error("lost confirmation"));
    await act(async()=>{await api.retry();});expect(state.prepare).not.toHaveBeenCalled();
    state.initiate.mockResolvedValueOnce({attemptId:44,state:"CONFIRMED"});
    await act(async()=>{await api.retry();});
    expect(state.confirm).toHaveBeenCalledOnce();expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.initiate.mock.calls.every(([c])=>c.requestId==="original:card")).toBe(true);
  });
  it("saves no manager credentials, does not start unsupported invoice CARD, and stops on persistence failure",async()=>{
    await mount(invoice);await act(async()=>{await api.start(command("INVOICE","CARD"));});
    expect(state.saved.size).toBe(0);expect(state.initiate).not.toHaveBeenCalled();
    const candidate=command("INVOICE","CREDIT");Object.assign(candidate.prepare,{managerApproval:{email:"manager",password:"SECRET"}});
    await act(async()=>{await api.start(candidate,{email:"manager",password:"SECRET"});});
    expect(JSON.stringify(Array.from(state.saved.values()))).not.toContain("SECRET");expect(state.prepare.mock.calls[0][0].managerApproval.password).toBe("SECRET");
    state.saved.clear();await act(async()=>root.unmount());element.remove();await mount(pos);state.failSave=true;
    await act(async()=>{await api.start(command("POS","CARD"));});expect(state.initiate).not.toHaveBeenCalled();
  });
});


describe("server-proven rejected closure",()=>{
 it.each([["POS","CASH"],["INVOICE","CASH"],["INVOICE","CREDIT"]] as const)("only releases %s/%s after durable server proof, including lost closure response",async(source,method)=>{
   await mount(source==="POS"?pos:invoice);
   state.prepare.mockRejectedValueOnce(Error("retired"));await act(async()=>{await api.start(command(source,method));});
   expect(api.pending).toBe(true);expect(state.saved.size).toBe(1);
   state.prepare.mockRejectedValueOnce(Error("lost closure response"));await act(async()=>{await api.closeRejected();});
   expect(state.prepare.mock.calls.at(-1)?.[0]).toMatchObject({closeRejectedWithoutPayment:true});
   expect(api.pending).toBe(true);expect(state.saved.size).toBe(1);
   state.read.mockResolvedValue({intent:{status:"CANCELLED"},noAdmissionClosed:true});
   await act(async()=>{await api.retry();});
   expect(api.pending).toBe(false);expect(state.saved.size).toBe(0);expect(state.onRefunded).toHaveBeenCalledOnce();
 });
});

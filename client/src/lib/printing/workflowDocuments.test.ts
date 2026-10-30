// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { dispatchDocumentData, runWorkflowPrintPack, workflowPrintPackHtml, type WorkflowPrintJob } from "./workflowDocuments";

function job(title: string, silent: WorkflowPrintJob["silent"]): WorkflowPrintJob {
  return { title, silent, html: async () => `<html><head><style>body{width:80mm}</style></head><body>${title}<script>window.print()</script></body></html>`, complete: vi.fn(async () => {}) };
}
describe("workflow print pack transport boundaries", () => {
  it("labels an amended collection claim with its actual event and amounts", () => {
    const data=dispatchDocumentData({id:1,documentType:"DISPATCH_SLIP",documentNumber:"CLAIM-1",eventOccurredAt:"2026-10-30T00:00:00Z",printHistory:[],
      payload:{shipment:{consignmentId:1,consignmentNumber:"CN-1",fulfillmentRequestId:null,sourceType:"INVOICE",sourceId:1},party:{id:1,name:"الجهة"},
        recipient:{name:"العميل",phone:null,address:null,governorate:null},invoices:[{id:1,invoiceNumber:"101567",total:"35000.00"}],
        evidence:{mode:"COMMITTED_CLAIM_CHANGE_EVENT",notice:"تعديل مطالبة؛ لا قبض جديد"},
        money:{codAmount:"5000.00",deliveryFee:"5000.00",feeCollection:"COURIER",currentTotal:"35000.00",paidAmount:"30000.00"}}});
    expect(data).toMatchObject({title:"تعديل مطالبة التحصيل",codAmount:"5000.00",deliveryFee:"5000.00",notes:"تعديل مطالبة؛ لا قبض جديد",dispatchedAt:"2026-10-30T00:00:00Z"});
  });
  it("previews only documents not already submitted to the thermal printer", async () => {
    const first = job("فاتورة A", async () => ({ ok: true, via: "thermal" }));
    const second = job("بوليصة B", async () => ({ ok: false, via: "browser", reason: "popup-blocked" }));
    const open = vi.fn((_html: string) => true);
    const result = await runWorkflowPrintPack([first, second], open);
    expect(result).toEqual([{ title: "فاتورة A", sent: true, via: "thermal" }, { title: "بوليصة B", sent: true, via: "browser" }]);
    expect(open.mock.calls[0][0]).not.toContain("فاتورة A");
    expect(open.mock.calls[0][0]).toContain("بوليصة B");
    expect(first.complete).toHaveBeenCalledWith(true, undefined);
    expect(second.complete).toHaveBeenCalledWith(true, undefined);
  });
  it("continues other documents after one renderer fails and reports the partial result", async () => {
    const broken = job("بوليصة", async () => { throw new Error("تعذر الرسم"); });
    const valid = job("فاتورة", async () => ({ ok: true, via: "server" }));
    const open = vi.fn(() => true);
    const result = await runWorkflowPrintPack([broken, valid], open);
    expect(result).toEqual([{ title: "بوليصة", sent: false, error: "تعذر الرسم" }, { title: "فاتورة", sent: true, via: "server" }]);
    expect(open).not.toHaveBeenCalled();
    expect(broken.complete).toHaveBeenCalledWith(false, "تعذر الرسم");
    expect(valid.complete).toHaveBeenCalledWith(true, undefined);
  });
  it("keeps successful output submitted if the print journal update fails", async () => {
    const value = job("فاتورة", async () => ({ ok: true, via: "thermal" }));
    value.complete = vi.fn(async () => { throw new Error("response lost"); });
    const result = await runWorkflowPrintPack([value], () => { throw new Error("must not open fallback"); });
    expect(result[0].sent).toBe(true);
    expect(result[0].error).toMatch(/أرسل المستند.*تعذر تسجيل/);
  });
  it("records a blocked pack as a print failure without rerunning the silent transport", async () => {
    const silent = vi.fn(async () => ({ ok: false as const, via: "browser" as const, reason: "popup-blocked" as const }));
    const value = job("فاتورة", silent);
    const result = await runWorkflowPrintPack([value], () => false);
    expect(silent).toHaveBeenCalledTimes(1);
    expect(result[0].sent).toBe(false);
    expect(value.complete).toHaveBeenCalledWith(false, expect.stringMatching(/حُجبت/));
  });
  it("retains all receipt bodies and strips auto-print scripts from the combined preview", () => {
    const html = workflowPrintPackHtml([{ title: "A<", html: "<html><body>invoice-one<script>window.print()</script></body></html>" }, { title: "B", html: "<html><body>invoice-two<script src='/run.js'></script></body></html>" }]);
    expect(html).toContain("invoice-one"); expect(html).toContain("invoice-two");
    expect(html).not.toContain("<script"); expect(html).toContain("A&lt;"); expect(html).toContain("doc-btn-print");
  });
});

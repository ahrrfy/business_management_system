// @vitest-environment jsdom
import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DigitalRefundTenderFields } from "./DigitalRefundTenderFields";

type Props = ComponentProps<typeof DigitalRefundTenderFields>;
let root: Root | null = null;
let element: HTMLDivElement;
function props(): Props { return { originalMethod: "CARD", amount: "250000.00", method: "CARD", onMethod: vi.fn(),
  reference: "", onReference: vi.fn(), confirmed: false, onConfirmed: vi.fn(), reserved: false, evidenced: false,
  busy: false, grantToken: null, onReserve: vi.fn(), onRecord: vi.fn(), onRelease: vi.fn() }; }
async function render(value: Props) {
  if (!root) { element = document.createElement("div"); document.body.append(element); root = createRoot(element); }
  await act(async () => { root!.render(<DigitalRefundTenderFields {...value} />); });
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; element?.remove(); vi.unstubAllGlobals(); });

describe("bank refund operator guidance", () => {
  it("shows a zero CARD payout without requesting bank evidence or claiming an AR movement", async () => {
    await render({...props(), amount:"0.00"});
    expect(element.textContent).toContain("لا يوجد مبلغ يُصرف للعميل");
    expect(element.querySelectorAll("button,input")).toHaveLength(0);
    expect(element.textContent).not.toContain("ذمّة");
  });
  it("reserves before exposing the bank success attestation", async () => {
    const value = props(); await render(value);
    expect(element.querySelector('input[maxlength="100"]')).toBeNull();
    await act(async () => { Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "حجز مبلغ رد البطاقة")!.click(); });
    expect(value.onReserve).toHaveBeenCalledTimes(1); expect(value.onRecord).not.toHaveBeenCalled();
  });
  it("does not direct a recovered or expired reservation to execute another bank refund", async () => {
    const value = { ...props(), reserved: true, reservationExpiresAt: new Date(Date.now() + 60_000) };
    await render(value);
    expect(element.textContent).toContain("لا تنفّذ رداً جديداً");
    expect(element.textContent).not.toContain("نفّذ الرد مرة واحدة");
    await render({ ...value, grantToken: "winner-window" });
    expect(element.textContent).toContain("نفّذ الرد مرة واحدة");
    await render({ ...value, grantToken: "winner-window", reservationExpiresAt: new Date(Date.now() - 1000) });
    expect(element.textContent).toContain("لا تنفّذ رداً جديداً");
  });
  it("keeps confirmed evidence immutable and hides the bank option for original cash", async () => {
    await render({ ...props(), reserved: true, evidenced: true, reference: "BANK-REFUND", confirmed: true });
    expect((element.querySelector('input[maxlength="100"]') as HTMLInputElement).readOnly).toBe(true);
    expect(element.textContent).toContain("دون تكرار الرد على الجهاز");
    expect(element.querySelector("details")).toBeNull();
    await render({ ...props(), originalMethod: "CASH", method: "CASH" });
    expect(element.querySelectorAll('input[type="radio"]')).toHaveLength(1);
    expect(element.textContent).not.toContain("رد إلى البطاقة الأصلية");
  });
});

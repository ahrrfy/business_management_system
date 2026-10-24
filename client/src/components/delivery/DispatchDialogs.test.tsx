// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchDialog, type DispatchParty } from "./DispatchDialog";
import { OrderDispatchDialog } from "../store/OrderDispatchDialog";

const mocks = vi.hoisted(() => ({ parties: [] as unknown[], notify: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { storeAdmin: { orders: { parties: { useQuery: () => ({ data: mocks.parties }) } } } } }));
vi.mock("@/lib/notify", () => ({ notify: { err: mocks.notify } }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ children, onValueChange, ...props }: any) => <select {...props} onChange={e => onValueChange(e.target.value)}>{children}</select> }));
vi.mock("@/components/ui/dialog", () => ({ useDialogComposition: () => null, Dialog: ({ children }: any) => <div>{children}</div>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/delivery/AnimatedDeliveryButton", () => ({ AnimatedDeliveryButton: ({ label, isDispatching: _pending, ...props }: any) => <button {...props}>{label}</button> }));
vi.mock("@/components/delivery/WhatsAppStageActionsMenu", () => ({ WhatsAppStageActionsMenu: () => null }));
vi.mock("@/components/form/IntlPhoneInput", () => ({ IntlPhoneInput: () => null }));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: () => null }));

const internal = { id: 1, name: "internal", partyType: "INDIVIDUAL", defaultFee: "0", userId: 7, hasActiveDriverMembership: true, linkedUserDriverEligible: true, linkedUserBranchId: 3, linkedUserName: "same branch", drivers: [{ userId: 7, name: "same branch", branchId: 3 }, { userId: 8, name: "other branch", branchId: 4 }] };
const company = { ...internal, id: 2, name: "company", partyType: "COMPANY", userId: null, drivers: [], hasActiveDriverMembership: false, linkedUserDriverEligible: false };
const order = { id: 4, branchId: 3, orderNumber: "ORDER-4", title: "order", salePrice: "1000", total: "1000", customerName: "customer" };
let host: HTMLDivElement, root: Root;
type Station = "workorder" | "store";
function render(station: Station, onConfirm = vi.fn()) {
  act(() => root.render(station === "workorder"
    ? <DispatchDialog order={order} parties={mocks.parties as DispatchParty[]} pending={false} onClose={vi.fn()} onConfirm={onConfirm} />
    : <OrderDispatchDialog order={order} pending={false} onCancel={vi.fn()} onConfirm={onConfirm} />));
  return onConfirm;
}
function select(element: HTMLSelectElement, value: string) {
  act(() => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
function chooseParty(station: Station, id: string) {
  if (station === "workorder") select(host.querySelector("select")!, id);
  else act(() => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[Number(id) - 1].click());
}
function confirmButton() { return Array.from(host.querySelectorAll("button")).find(button => /تأكيد (الإرسال|التسليم)/.test(button.textContent ?? ""))!; }

beforeEach(() => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  mocks.parties = [internal, company]; vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe.each<Station>(["workorder", "store"])("%s dispatch uses explicit source-branch drivers", station => {
  it("requires a choice, excludes other branches, and forwards the chosen employee", () => {
    const onConfirm = render(station); chooseParty(station, "1");
    const driver = host.querySelector<HTMLSelectElement>('select[aria-label="المندوب الموظف المحدد"]')!;
    expect(driver.value).toBe(""); expect(confirmButton().disabled).toBe(true);
    expect(Array.from(driver.options).map(option => option.value)).toEqual(["", "7"]);
    select(driver, "7"); expect(confirmButton().disabled).toBe(false);
    act(() => confirmButton().click()); expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ partyId: 1, assignedUserId: 7 }));
  });
  it("keeps an internal party blocked when its current driver is ineligible or leaves the source branch", () => {
    const onConfirm = render(station); chooseParty(station, "1");
    select(host.querySelector<HTMLSelectElement>('select[aria-label="المندوب الموظف المحدد"]')!, "7");
    mocks.parties = [{ ...internal, linkedUserDriverEligible: false, drivers: [{ userId: 8, name: "other branch", branchId: 4 }] }, company];
    render(station, onConfirm); expect(confirmButton().disabled).toBe(true);
    expect(host.textContent).toContain("لا يوجد حساب مندوب نشط مؤهل في فرع الطلب");
    act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
  });
  it("clears the old driver on a party change and permits an external company only with its waybill", () => {
    const onConfirm = render(station); chooseParty(station, "1");
    select(host.querySelector<HTMLSelectElement>('select[aria-label="المندوب الموظف المحدد"]')!, "7");
    chooseParty(station, "2"); expect(confirmButton().disabled).toBe(true);
    const tracking = host.querySelector<HTMLInputElement>('input[maxlength="100"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(tracking, "WAYBILL-001");
      tracking.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirmButton().disabled).toBe(false); act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ partyId: 2, assignedUserId: undefined, externalTrackingRef: "WAYBILL-001" }));
  });
});

it("preserves the explicit driver across the online-order caller, validated router and native dispatch bridge", () => {
  const read = (file: string) => readFileSync(path.resolve(file), "utf8");
  const router = read("server/routers/storeAdminRouter.ts");
  const dispatch = router.slice(router.indexOf("dispatch: storeManagerProcedure"));
  expect(dispatch).toContain("assignedUserId: z.number().int().positive().nullish()");
  expect(dispatch).toContain("assignedUserId: input.assignedUserId ?? null");
  const caller = read("client/src/pages/OrderFulfillment.tsx");
  expect(caller).toMatch(/onConfirm=\{\(\{ partyId, assignedUserId, externalTrackingRef \}\) => dispatchM\.mutate\(\{\s*id: dispatchTarget\.id,\s*partyId,\s*assignedUserId,/);
  expect(caller).toContain("branchId: o.branchId");
  expect(read("client/src/components/store/OrderQuickViewDrawer.tsx")).toContain("branchId: order.branchId");
  expect(read("server/services/storeAdmin/orderFulfillmentService.ts")).toContain("branchId: onlineOrders.branchId");
  expect(read("server/services/storeAdmin/dispatchOnlineOrder.ts")).toContain("assignedUserId: input.assignedUserId");
});

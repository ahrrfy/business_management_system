// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchDialog, type DispatchParty } from "./DispatchDialog";
import { OrderDispatchDialog } from "../store/OrderDispatchDialog";
import { DeliveryReadyForDispatchTab } from "@/pages/DeliveryReadyForDispatchTab";

const mocks = vi.hoisted(() => ({ parties: [] as unknown[], ready: [] as unknown[], notify: vi.fn(), barcode: vi.fn(), label: vi.fn(), slip: vi.fn(), departure: vi.fn(), readyContact: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({}),
  auth: { me: { useQuery: () => ({ data: null }) } },
  delivery: {
    readyForDispatch: { useQuery: () => ({ data: mocks.ready }) },
    listParties: { useQuery: () => ({ data: mocks.parties }) },
    dispatch: { useMutation: () => ({ isPending: false }) },
    dispatchByBarcode: { useMutation: () => ({ isPending: false, mutateAsync: mocks.barcode }) },
  },
  storeAdmin: { orders: { parties: { useQuery: () => ({ data: mocks.parties }) } } },
} }));
vi.mock("@/lib/notify", () => ({ notify: { err: mocks.notify, ok: vi.fn(), info: vi.fn() } }));
vi.mock("@/hooks/useOperationPermission", () => ({ useOperationPermission: () => ({ allowed: true }) }));
vi.mock("@/components/delivery/DeliveryDepartureOverlay", () => ({ DeliveryDepartureOverlay: (props: unknown) => { mocks.departure(props); return null; } }));
vi.mock("@/lib/printing/deliveryDocs", () => ({ printReadyOrderLabel: mocks.label, printDeliverySlip: mocks.slip }));
vi.mock("@/lib/printing/shippingLabel", () => ({ preopenShippingLabelWindow: () => null }));
vi.mock("@/components/data-table/DataTable", () => ({ DataTable: ({ columns, data }: any) => <div>{data.map((original: any) => <div key={original.id}>{columns.find((c: any) => c.id === "actions").cell({ row: { original } })}</div>)}</div> }));
vi.mock("@/components/list", () => ({ RowActions: ({ actions, contact }: any) => { mocks.readyContact(contact); return <div>{actions.map((a: any) => <button key={a.key} onClick={a.onSelect}>{a.label}</button>)}</div>; } }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ children, onValueChange, ...props }: any) => <select {...props} onChange={e => onValueChange(e.target.value)}>{children}</select> }));
vi.mock("@/components/ui/dialog", () => ({ useDialogComposition: () => null, Dialog: ({ children }: any) => <div>{children}</div>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/delivery/AnimatedDeliveryButton", () => ({ AnimatedDeliveryButton: ({ label, isDispatching: _pending, ...props }: any) => <button {...props}>{label}</button> }));
vi.mock("@/components/delivery/WhatsAppStageActionsMenu", () => ({ WhatsAppStageActionsMenu: () => null }));
vi.mock("@/components/form/IntlPhoneInput", () => ({ IntlPhoneInput: ({ value, onChange, ariaLabel }: any) => <input aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)} /> }));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: ({ value, onChange, ariaLabel }: any) => <input aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)} /> }));

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
  mocks.ready = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("online ready dispatch money", () => {
  it.each([false, true])("direct-store redispatch displays only the persisted remainder (free=%s)", deliveryFree => {
    act(() => root.render(<OrderDispatchDialog order={{ ...order, total: deliveryFree ? "40000.00" : "45000.00", amountDueAtDoor: deliveryFree ? "0.00" : "5000.00", deliveryFree, deliveryWaivedAmount: "5000.00" }} pending={false} onCancel={vi.fn()} onConfirm={vi.fn()} />));
    const description = Array.from(host.querySelectorAll("p")).find(p => p.textContent?.includes("يُحصّل المندوب"))!;
    expect(description.querySelector("b")?.textContent).toBe(deliveryFree ? "0 د.ع" : "5,000 د.ع");
    expect(description.textContent).not.toMatch(/40,000|45,000|قيمة البضاعة كاملة/);
  });

  it.each(["COURIER", "SHOP"] as const)("locks the saved online fee across party changes for %s", collection => {
    const onConfirm = vi.fn();
    act(() => root.render(<DispatchDialog order={{ ...order, sourceType: "ONLINE_ORDER", salePrice: "40000", deliveryCost: "5000", deliveryFeeCollection: collection }} parties={[{ ...internal, defaultFee: "9000" }, company] as DispatchParty[]} pending={false} onClose={vi.fn()} onConfirm={onConfirm} />));
    chooseParty("workorder", "1");
    select(host.querySelector<HTMLSelectElement>('select[aria-label="المندوب الموظف المحدد"]')!, "7");
    expect(host.querySelector('input[aria-label="أجرة التوصيل"]')).toBeNull();
    expect(host.querySelector('[aria-label="أجرة التوصيل المثبتة"]')?.textContent).toBe("5,000 د.ع");
    const due = Array.from(host.querySelectorAll("span")).find(span => span.textContent === "يدفعه العميل للمندوب")!.parentElement!;
    expect(due.textContent).toContain(collection === "COURIER" ? "45,000" : "40,000");
    expect(due.textContent).not.toContain("50,000");
    act(() => confirmButton().click());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ fee: "5000.00", assignedUserId: 7 }));
  });

  it("keeps the non-online fee editable with the party default", () => {
    act(() => root.render(<DispatchDialog order={{ ...order, deliveryCost: "5000" }} parties={[{ ...internal, defaultFee: "9000" }] as DispatchParty[]} pending={false} onClose={vi.fn()} onConfirm={vi.fn()} />));
    chooseParty("workorder", "1");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="أجرة التوصيل"]')?.value).toBe("9000.00");
  });

  it("forwards the recipient and driver then prints and displays persisted parcel facts", async () => {
    mocks.ready = [{ ...order, sourceType: "ONLINE_ORDER", orderNumber: "ORD-4", hasDelivery: true, quantity: 1, salePrice: "40000", deposit: "0", deliveryCost: "5000", deliveryFeeCollection: "COURIER", deliveryAddress: "old address" }];
    mocks.barcode.mockResolvedValue({ sourceType: "ONLINE_ORDER", sourceId: 4, sourceNumber: "ORD-4", invoiceId: 12, invoiceNumber: "INV-12", consignmentNumber: "CN-12", codAmount: "40000.00", deliveryFee: "5000.00", feeCollection: "SHOP", recipientName: "saved recipient", recipientPhone: "07709999999", deliveryAddress: "saved address" });
    act(() => root.render(<DeliveryReadyForDispatchTab />));
    expect(mocks.readyContact.mock.lastCall![0].message).toContain("45,000");
    expect(mocks.readyContact.mock.lastCall![0].message).not.toContain("50,000");
    act(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "تسليم لمندوب")!.click());
    chooseParty("workorder", "1");
    select(host.querySelector<HTMLSelectElement>('select[aria-label="المندوب الموظف المحدد"]')!, "7");
    const phone = host.querySelector<HTMLInputElement>('input[aria-label="هاتف المستلم"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(phone, "07701234567");
      phone.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { confirmButton().click(); });
    expect(mocks.barcode).toHaveBeenCalledWith(expect.objectContaining({ barcode: "ORD-4", recipientName: "customer", recipientPhone: "07701234567", assignedUserId: 7, deliveryFee: "5000.00" }));
    expect(mocks.label).toHaveBeenCalledWith(expect.objectContaining({ customerName: "saved recipient", customerPhone: "07709999999", deliveryAddress: "saved address", deliveryCost: "5000.00", deliveryFeeCollection: "SHOP" }), expect.objectContaining({ cod: "40000.00" }));
    expect(mocks.slip).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ sourceType: "ONLINE_ORDER", sourceId: 4, invoiceId: 12, feeCollection: "SHOP", recipientName: "saved recipient" }));
    expect(mocks.departure).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerName: "saved recipient", customerPhone: "07709999999", deliveryAddress: "saved address", deliveryFee: "5000.00", feeCollection: "SHOP" }) }));
  });
});

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
  const dispatch = router.slice(router.indexOf("dispatch: deliveryCashierProcedure"));
  expect(dispatch).toContain("assignedUserId: z.number().int().positive().nullish()");
  expect(dispatch).toContain("assignedUserId: input.assignedUserId ?? null");
  const caller = read("client/src/pages/OrderFulfillment.tsx");
  expect(caller).toMatch(/onConfirm=\{\(\{ partyId, assignedUserId, externalTrackingRef \}\) => dispatchM\.mutate\(\{\s*id: dispatchTarget\.id,\s*partyId,\s*assignedUserId,/);
  expect(caller).toContain("branchId: o.branchId");
  expect(read("client/src/components/store/OrderQuickViewDrawer.tsx")).toContain("branchId: order.branchId");
  expect(read("server/services/storeAdmin/orderFulfillmentService.ts")).toContain("branchId: onlineOrders.branchId");
  expect(read("server/services/storeAdmin/dispatchOnlineOrder.ts")).toContain("assignedUserId: input.assignedUserId");
});

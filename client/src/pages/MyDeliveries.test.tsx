// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mutate: vi.fn(), ackMutate: vi.fn(), invalidate: vi.fn(), warn: vi.fn(),
  confirm: vi.fn(async (_options: { description: string }) => true),
  row: {} as Record<string, unknown>,
  onConfirmError: undefined as undefined | ((error: { data?: { code?: string } }) => void),
  onConfirmSettled: undefined as undefined | (() => void),
}));
vi.mock("@/lib/trpc", () => {
  const mutation = { useMutation: () => ({ mutate: vi.fn(), isPending: false }) };
  return { trpc: {
    useUtils: () => ({ courier: { myDeliveries: { invalidate: state.invalidate } } }),
    courier: {
      myDeliveries: { useQuery: () => ({ data: { linked: true, memberRole: "DRIVER", custodyBalance: "0",
        financialSummary: {}, toDeliver: [state.row], delivered: [] }, isLoading: false, isError: false }) },
      confirmDelivery: mutation, acknowledgeConsignmentClaim: { useMutation: () => ({ mutate: state.ackMutate, isPending: false }) },
      failDelivery: mutation, parcelTransition: mutation,
      confirmConsignmentDelivery: { useMutation: (options: { onError: (error: { data?: { code?: string } }) => void; onSettled: () => void }) => {
        state.onConfirmError = options.onError;
        state.onConfirmSettled = options.onSettled;
        return { mutate: state.mutate, isPending: false };
      } },
    },
  } };
});
vi.mock("@/lib/confirm", () => ({ confirm: state.confirm }));
vi.mock("@/lib/realtime", () => ({ useRealtimeEvent: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), warn: state.warn, err: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/delivery/DeliverySourceLink", () => ({ DeliverySourceLink: () => null }));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: ({ value, onChange, ariaLabel }: {
  value: string; onChange: (value: string) => void; ariaLabel: string;
}) => <input aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} /> }));

import MyDeliveries from "./MyDeliveries";

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  state.mutate.mockReset(); state.ackMutate.mockReset(); state.invalidate.mockReset(); state.warn.mockReset(); state.confirm.mockClear();
  state.row = { kind: "consignment", id: 11, orderNumber: "CN-11", customerName: "عميل",
    status: "OUT_FOR_DELIVERY", sourceType: "INVOICE", codDue: "10000.00",
    consignmentClaims: [{ consignmentId: 11, amount: "10000.00", invoiceNumber: "INV-11" }],
    codClaimVersion: 2, courierAckClaimVersion: 2, shipmentMemberCount: 1 };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<MyDeliveries />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.trim() === text)!;

it("sends the displayed version, amount and membership with a full courier confirmation", async () => {
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ consignmentId: 11, expectedClaimVersion: 2,
    expectedConsignmentIds: [11], expectedClaimAmount: "10000.00",
    expectedConsignmentClaims: [{ consignmentId: 11, amount: "10000.00" }] }));
});

it("displays and sends each invoice claim even when the leader is absent", async () => {
  state.row = { ...state.row, consignmentIds: [12, 13], shipmentMemberCount: 2, codDue: "17500.00",
    consignmentClaims: [{ consignmentId: 12, amount: "7500.00", invoiceNumber: "INV-12" },
      { consignmentId: 13, amount: "10000.00", invoiceNumber: "INV-13" }] };
  await act(async () => root.render(<MyDeliveries />));
  const claims = host.querySelectorAll('[aria-label="مطالبات فواتير الشحنة"] li');
  expect(claims).toHaveLength(2);
  expect(claims[0].textContent).toContain("INV-12");
  expect(claims[0].textContent).toContain("7,500");
  expect(claims[1].textContent).toContain("INV-13");
  expect(claims[1].textContent).toContain("10,000");
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ consignmentId: 11, expectedClaimVersion: 2,
    expectedConsignmentIds: [12, 13], expectedClaimAmount: "17500.00",
    expectedConsignmentClaims: [{ consignmentId: 12, amount: "7500.00" }, { consignmentId: 13, amount: "10000.00" }] }));
  const firstKey = state.mutate.mock.calls[0][0].clientRequestId;
  await act(async () => state.onConfirmSettled?.());
  state.row = { ...state.row, consignmentClaims: [{ consignmentId: 12, amount: "10000.00", invoiceNumber: "INV-12" },
    { consignmentId: 13, amount: "7500.00", invoiceNumber: "INV-13" }] };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ expectedClaimAmount: "17500.00",
    expectedConsignmentClaims: [{ consignmentId: 12, amount: "10000.00" }, { consignmentId: 13, amount: "7500.00" }] }));
  expect(state.mutate.mock.calls[1][0].clientRequestId).not.toBe(firstKey);
});

it("sends a zero claim as an explicit amount", async () => {
  state.row = { ...state.row, codDue: "0.00", courierAckClaimVersion: 1,
    consignmentClaims: [{ consignmentId: 11, amount: "0.00", invoiceNumber: "INV-11" }] };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ expectedClaimVersion: 2,
    expectedConsignmentIds: [11], expectedClaimAmount: "0.00",
    expectedConsignmentClaims: [{ consignmentId: 11, amount: "0.00" }] }));
});

it("shows the exact fractional claim before sending it", async () => {
  state.row = { ...state.row, codDue: "12345.25",
    consignmentClaims: [{ consignmentId: 11, amount: "12345.25", invoiceNumber: "INV-11" }] };
  await act(async () => root.render(<MyDeliveries />));
  expect(host.textContent).toContain("12,345.25");
  await act(async () => button("تم التسليم").click());
  expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("12,345.25") }));
  expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ expectedClaimAmount: "12345.25",
    expectedConsignmentClaims: [{ consignmentId: 11, amount: "12345.25" }] }));
});

it("sends the displayed membership and amount with a documented partial collection", async () => {
  state.row = { ...state.row, consignmentIds: [12],
    consignmentClaims: [{ consignmentId: 12, amount: "10000.00", invoiceNumber: "INV-12" }] };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تسليم جزئي").click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض فعلياً"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "4000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("تأكيد التسليم الجزئي").disabled).toBe(false);
  await act(async () => button("تأكيد التسليم الجزئي").click());
  expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ consignmentId: 11, expectedClaimVersion: 2,
    expectedConsignmentIds: [12], expectedClaimAmount: "10000.00",
    expectedConsignmentClaims: [{ consignmentId: 12, amount: "10000.00" }],
    collectedAmount: "4000.00", shortfallReason: "PARTIAL_REFUSAL" }));
});

it("closes a stale partial-collection dialog on conflict and requires fresh input", async () => {
  await act(async () => button("تسليم جزئي").click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض فعلياً"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "4000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("تأكيد التسليم الجزئي").click());
  await act(async () => { state.onConfirmError?.({ data: { code: "CONFLICT" } }); state.onConfirmSettled?.(); });
  expect(host.querySelector('[aria-label="تسليم جزئي"]')).toBeNull();
  expect(state.invalidate).toHaveBeenCalled();
  expect(state.warn).toHaveBeenCalledWith("تغيرت المطالبة", expect.stringContaining("أعد إدخال"));
  state.row = { ...state.row, codClaimVersion: 3, courierAckClaimVersion: 3, codDue: "9000.00",
    consignmentClaims: [{ consignmentId: 11, amount: "9000.00", invoiceNumber: "INV-11" }] };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تسليم جزئي").click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض فعلياً"]')!.value).toBe("");
  expect(state.mutate).toHaveBeenCalledTimes(1);
});

it("requires refresh when the member amounts are missing or do not match the displayed total", async () => {
  state.row = { ...state.row, consignmentClaims: undefined };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.invalidate).toHaveBeenCalled();
  state.row = { ...state.row, consignmentClaims: [{ consignmentId: 11, amount: "9000.00", invoiceNumber: "INV-11" }] };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.warn).toHaveBeenCalledTimes(2);
});

it("acknowledges the displayed per-invoice snapshot and refuses a missing one", async () => {
  state.row = { ...state.row, courierAckClaimVersion: 1, consignmentIds: [12, 13], shipmentMemberCount: 2, codDue: "17500.00",
    consignmentClaims: [{ consignmentId: 12, amount: "7500.00", invoiceNumber: "INV-12" },
      { consignmentId: 13, amount: "10000.00", invoiceNumber: "INV-13" }] };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("أقرّ مبلغ التحصيل الحالي").click());
  expect(state.ackMutate).toHaveBeenCalledWith(expect.objectContaining({ consignmentId: 11, expectedClaimVersion: 2,
    expectedConsignmentIds: [12, 13], expectedClaimAmount: "17500.00",
    expectedConsignmentClaims: [{ consignmentId: 12, amount: "7500.00" }, { consignmentId: 13, amount: "10000.00" }] }));
  state.ackMutate.mockClear();
  state.row = { ...state.row, consignmentClaims: undefined };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("أقرّ مبلغ التحصيل الحالي").click());
  expect(state.ackMutate).not.toHaveBeenCalled();
  expect(state.invalidate).toHaveBeenCalled();
  expect(state.warn).toHaveBeenCalledWith("تعذّر إقرار المطالبة", expect.stringContaining("مبالغ فواتيرها"));
});

it("requests a refresh instead of sending a confirmation without a displayed version", async () => {
  state.row = { ...state.row, codClaimVersion: undefined };
  await act(async () => root.render(<MyDeliveries />));
  await act(async () => button("تم التسليم").click());
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.invalidate).toHaveBeenCalled();
  expect(state.warn).toHaveBeenCalled();
});

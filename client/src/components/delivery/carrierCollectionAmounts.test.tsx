// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffConfirmDialog as StandaloneStaffConfirm, type InTransitRow } from "./StaffConfirmDialog";
import { StaffConfirmDialog as TransitStaffConfirm, ManualProofDialog } from "./TransitActionDialogs";
import { DeliveryConsignmentsTable } from "./DeliveryConsignmentsTable";
import type { RouterOutputs } from "@/lib/trpc";

type OpenRow = RouterOutputs["delivery"]["openConsignments"]["rows"][number];
const carrier = {
  id: 1, consignmentNumber: "10001", invoiceNumber: "10001", sourceType: "INVOICE", sourceId: 2,
  partyName: "ناقل", codAmount: "10000.00", collectedAmount: "1000.00", counterSettledAmount: "2000.00",
  shortfallAssigned: "3000.00", status: "DISPATCHED", parcelStatus: "OUT_FOR_DELIVERY", moneyStatus: "PARTIAL", feeDue: "0.00",
};

describe("carrier collection amounts", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(label))!;

  it.each([
    { Component: StandaloneStaffConfirm, note: "اتصال المندوب", name: "standalone" },
    { Component: TransitStaffConfirm, note: "تأكيد هاتفي مباشر مع العميل", name: "in-transit" },
  ])("confirms the server amount in the $name dialog without recollecting counter payments or shortfall", async ({ Component, note }) => {
    const onConfirm = vi.fn();
    // Deliberately partial API fixtures exercise only the financial fields consumed by these controls.
    await act(async () => root.render(<Component row={{ ...carrier, codDue: "4000.00" } as unknown as InTransitRow} pending={false} onCancel={vi.fn()} onConfirm={onConfirm} />));
    expect(host.textContent).toContain("4,000");
    expect(host.textContent).not.toContain("7,000");
    await act(async () => button(note).click());
    await act(async () => button("تأكيد التسليم").click());
    expect(onConfirm).toHaveBeenCalledWith("4000.00", note, undefined);
  });

  it("prefills manual proof with the current server amount", async () => {
    await act(async () => root.render(<ManualProofDialog row={{ ...carrier, codDue: "2500.00" } as unknown as InTransitRow} pending={false} onCancel={vi.fn()} onConfirm={vi.fn()} />));
    expect(host.querySelector<HTMLInputElement>("#proof-amount")?.value).toBe("2,500");
    expect(host.textContent).toContain("2,500");
  });

  it.each([
    { extra: { remainingDue: "2500.00" }, expected: 2500 },
    { extra: {}, expected: 4000 },
  ])("uses the same remaining amount for table display and selection: $expected", async ({ extra, expected }) => {
    const onOutcomeToggle = vi.fn();
    const row = { ...carrier, parcelStatus: "DELIVERED", ...extra } as unknown as OpenRow;
    await act(async () => root.render(<DeliveryConsignmentsTable list={[row]} rows={{}} statementMode={false} canReturn={false} onOutcomeToggle={onOutcomeToggle} onCollectedChange={vi.fn()} onReturn={vi.fn()} onOpenTimeline={vi.fn()} />));
    const amount = host.querySelector<HTMLInputElement>("input")?.value;
    expect(amount).toBe(String(expected));
    await act(async () => button("حصل").click());
    expect(onOutcomeToggle).toHaveBeenCalledWith(1, "COLLECTED", expected);
  });

  it.each([{ status: "WRITTEN_OFF" }, { returnDeclaredAt: "2026-10-29T10:00:00Z" }])("does not offer collection for a closed or return-declared row: %j", async (extra) => {
    const row = { ...carrier, parcelStatus: "DELIVERED", ...extra } as unknown as OpenRow;
    await act(async () => root.render(<DeliveryConsignmentsTable list={[row]} rows={{}} statementMode={false} canReturn={false} onOutcomeToggle={vi.fn()} onCollectedChange={vi.fn()} onReturn={vi.fn()} onOpenTimeline={vi.fn()} />));
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).not.toContain("4,000");
  });
});

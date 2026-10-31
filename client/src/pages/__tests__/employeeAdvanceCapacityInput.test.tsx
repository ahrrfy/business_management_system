// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmployeeAdvances from "@/pages/EmployeeAdvances";

const state = vi.hoisted(() => ({ max: "414108.21", mutate: vi.fn() }));
const capacity = () => ({
  period: "2026-10",
  asOf: "2026-10-31",
  earnedCompensation: "414108.21",
  approvedAdditions: "0.00",
  mandatoryDeductions: "0.00",
  existingSalaryAdvances: "0.00",
  otherEmployeeDeductions: "0.00",
  reservedRequests: "0.00",
  maxAvailable: state.max,
  blocked: false,
  blockers: [],
  warnings: [],
  excludedAttendanceDates: [],
});
vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({ can: () => true }),
}));
vi.mock("@shared/permissions", () => ({ moduleAccessAllowed: () => true }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ payroll: { advancesList: { invalidate: vi.fn() } } }),
    auth: { me: { useQuery: () => ({ data: { role: "admin" } }) } },
    employees: {
      formOptions: { useQuery: () => ({ data: { managers: [] } }) },
      list: { useQuery: () => ({ data: { rows: [{ id: 7, fullName: "موظف الاختبار", branchId: 1, branchName: "الرئيسي" }] } }) },
    },
    branches: { list: { useQuery: () => ({ data: [] }) } },
    payroll: {
      advancesList: { useQuery: () => ({ data: [], isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }) },
      advanceBalance: { useQuery: () => ({ data: { balance: "0.00", activeCount: 0, capacity: capacity() } }) },
      advanceGrant: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
      advanceCancel: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    hrEnterprise: { loans: { cancel: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } } },
  },
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ children, onValueChange, ...props }: React.ComponentProps<"select"> & { onValueChange: (value: string) => void }) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
}));
vi.mock("@/components/data-table/DataTable", () => ({ DataTable: () => null }));
vi.mock("@/components/hr/EmployeeAdvanceRepaymentPanel", () => ({ EmployeeAdvanceRepaymentPanel: () => null }));
vi.mock("@/components/list", () => ({
  ListToolbar: ({ add }: { add?: { label: string; onClick: () => void } }) => add ? <button onClick={add.onClick}>{add.label}</button> : null,
  FilterField: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return { Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => open ? <div>{children}</div> : null, DialogContent: Pass, DialogFooter: Pass, DialogHeader: Pass, DialogTitle: Pass, useDialogComposition: () => ({ isComposing: () => false, setComposing: vi.fn(), justEndedComposing: () => false, markCompositionEnd: vi.fn() }) };
});

let root: Root;
let host: HTMLDivElement;
const button = (text: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(text))!;
const limitText = () => Array.from(host.querySelectorAll("span")).find((node) => node.textContent?.startsWith("الحد المتاح"))?.nextElementSibling?.textContent;
const typeAmount = async (field: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (callback(0), 1));
  state.max = "414108.21";
  state.mutate.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("EmployeeAdvances capacity money", () => {
  it("keeps fractional limits exact and safely rejects non-integer or excessive input", async () => {
    await act(async () => root.render(<EmployeeAdvances />));
    await act(async () => button("منح سلفة").click());
    const employee = host.querySelector<HTMLSelectElement>("#adv-emp")!;
    await act(async () => { employee.value = "7"; employee.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(limitText()).toBe("414,108.21");
    const amount = host.querySelector<HTMLInputElement>("#adv-amount")!;
    await typeAmount(amount, ".");
    expect(amount.value).toBe("");
    expect(state.mutate).not.toHaveBeenCalled();
    state.max = "1.50";
    await act(async () => root.render(<EmployeeAdvances />));
    expect(limitText()).toBe("1.5");
    await typeAmount(amount, "1");
    expect(button("تسجيل طلب السلفة").hasAttribute("disabled")).toBe(false);
    await typeAmount(amount, "2");
    expect(button("تسجيل طلب السلفة").hasAttribute("disabled")).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();
  });
});

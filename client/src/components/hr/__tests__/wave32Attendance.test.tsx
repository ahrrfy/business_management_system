// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentAttendanceMonths } from "@shared/hr";

const state = vi.hoisted(() => ({
  allowed: true,
  error: false,
  refetch: vi.fn(),
}));
vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({ can: () => state.allowed }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      attendance: {
        employeeStatement: { invalidate: vi.fn() },
        list: { invalidate: vi.fn() },
        summary: { invalidate: vi.fn() },
      },
    }),
    attendance: {
      employeeStatement: {
        useQuery: ({ employeeId }: { employeeId: number }) => ({
          isLoading: false,
          isError: state.error,
          refetch: state.refetch,
          data: {
            employee: { id: employeeId, name: `موظف ${employeeId}` },
            period: "2026-10",
            amountDue: "123456",
            totals: {
              payableHours: "8",
              scheduledHours: "8",
              absentDays: 0,
              overtimeHours: "0",
            },
          },
        }),
      },
      record: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recomputeRates: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
    },
  },
}));
vi.mock("../statement/AttendanceStatementHeader", () => ({
  AttendanceStatementHeader: ({ model }: any) => (
    <>
      <span>{model.d.employee.name}</span>
      <button
        onClick={() =>
          model.setFix({
            date: "2026-10-01",
            hours: "8",
            status: "PRESENT",
            checkIn: "08:00",
            checkOut: "16:00",
            breakMinutes: "",
            sessions: [],
            shiftMode: "single",
            crossMidnight: false,
            lateDeductionMinutes: "",
            notes: "",
          })
        }
      >
        تصحيح
      </button>
    </>
  ),
}));
vi.mock("../statement/AttendanceStatementSummary", () => ({
  AttendanceStatementSummary: ({ model }: any) => (
    <span>{model.d.amountDue}</span>
  ),
}));
vi.mock("../statement/AttendanceStatementTable", () => ({
  AttendanceStatementTable: () => null,
}));
vi.mock("../statement/AttendanceCorrectionDialog", () => ({
  AttendanceCorrectionDialog: ({ model }: any) =>
    model.fix ? <span>مسودة التصحيح</span> : null,
}));
import { EmployeeStatementCard } from "../EmployeeStatementCard";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("employee statement read and edit session", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    state.allowed = true;
    state.error = false;
    state.refetch.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = (id = 1) =>
    act(() => root.render(<EmployeeStatementCard employeeId={id} />));
  it("immediately removes cached wages after read permission is revoked", () => {
    render();
    expect(host.textContent).toContain("123456");
    state.allowed = false;
    render();
    expect(host.textContent).not.toContain("123456");
    expect(host.textContent).not.toContain("تصحيح");
  });
  it("exposes a failed query and retry instead of silently hiding the statement", () => {
    state.error = true;
    render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    act(() => host.querySelector("button")!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("123456");
  });
  it("does not carry a correction draft to another employee", () => {
    render();
    act(() => host.querySelector("button")!.click());
    expect(host.textContent).toContain("مسودة التصحيح");
    render(2);
    expect(host.textContent).toContain("موظف 2");
    expect(host.textContent).not.toContain("مسودة التصحيح");
  });
});

describe("statement month choices", () => {
  it("keeps the selected UTC month available during early Baghdad hours", () => {
    expect(
      recentAttendanceMonths(3, new Date("2026-10-24T01:00:00+03:00")),
    ).toEqual(["2026-10", "2026-09", "2026-08"]);
  });
  it("crosses the year without skipping a month and leaves the supplied clock untouched", () => {
    const now = new Date("2026-01-31T23:59:00Z");
    expect(recentAttendanceMonths(3, now)).toEqual([
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
    expect(now.toISOString()).toBe("2026-01-31T23:59:00.000Z");
  });
});

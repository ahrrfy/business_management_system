// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiometricPayrollReadiness } from "../../../../server/services/payroll/biometricReadiness";
import { BiometricReadinessBanner } from "./BiometricReadinessBanner";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  refetch: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    payroll: { biometricReadiness: { useQuery: mocks.query } },
    hrDevices: {
      processFolds: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    },
    useUtils: () => ({
      payroll: { biometricReadiness: { invalidate: mocks.invalidate } },
    }),
  },
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const openDays = [
  {
    attendanceId: 1,
    employeeId: 10,
    employeeName: "علي أحمد الجبوري",
    date: "2026-10-04",
    reason: "دخول بلا انصراف",
  },
  {
    attendanceId: 2,
    employeeId: 10,
    employeeName: "علي أحمد الجبوري",
    date: "2026-10-06",
    reason: "فترة دوام مفتوحة بلا انصراف",
  },
  {
    attendanceId: 3,
    employeeId: 20,
    employeeName: "زين محمد",
    date: "2026-10-20",
    reason: "دخول بلا انصراف",
  },
];

describe("BiometricReadinessBanner actionable attendance review", () => {
  let container: HTMLDivElement;
  let root: Root;
  let data: BiometricPayrollReadiness;

  beforeEach(() => {
    vi.clearAllMocks();
    data = {
      period: "2026-10",
      pendingPunchesCount: 4,
      unmappedPunchesCount: 1,
      openDaysCount: 3,
      openEmployeesCount: 2,
      openDays,
      connectedDevicesCount: 1,
      totalDevicesCount: 1,
      ready: false,
    };
    mocks.query.mockImplementation(() => ({
      data,
      isLoading: false,
      isError: false,
      refetch: mocks.refetch,
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows employee names, every affected date and reason, and distinguishes days from employees", () => {
    act(() => root.render(<BiometricReadinessBanner period="2026-10" />));
    const text = container.textContent;
    expect(text).toContain("3 يوم عمل مفتوح لدى 2 موظف");
    expect(text).toContain("علي أحمد الجبوري");
    expect(text).toContain("زين محمد");
    for (const day of openDays) {
      expect(text).toContain(day.date);
      expect(text).toContain(day.reason);
    }
    expect(
      container.querySelectorAll(
        'ul[aria-label="الموظفون وأيام الحضور المفتوحة"] li',
      ),
    ).toHaveLength(3);
  });

  it("opens the existing attendance tab with the selected employee and month, bypassing the default today filter", () => {
    act(() => root.render(<BiometricReadinessBanner period="2026-10" />));
    const link = container.querySelector<HTMLAnchorElement>(
      'a[aria-label="مراجعة حضور علي أحمد الجبوري بتاريخ 2026-10-04"]',
    );
    const params = new URL(link!.href).searchParams;
    expect(params.get("tab")).toBe("attendance");
    expect(params.get("employeeId")).toBe("10");
    expect(params.get("period")).toBe("2026-10");
    expect(params.get("range")).toBe("month");
    expect(mocks.query).toHaveBeenCalledWith(
      { period: "2026-10" },
      { enabled: true },
    );
  });

  it("explains month-scoped pending punches and offers both synchronization and user mapping", () => {
    act(() => root.render(<BiometricReadinessBanner period="2026-10" />));
    expect(container.textContent).toContain(
      "4 بصمة من هذا الشهر بانتظار المزامنة",
    );
    expect(container.querySelector('a[href="/hr?tab=devices"]')).not.toBeNull();
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent?.includes("مزامنة البصمات الآن"))!
        .click(),
    );
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it("shows a clean month without old warning details", () => {
    data = {
      ...data,
      pendingPunchesCount: 0,
      unmappedPunchesCount: 0,
      openDaysCount: 0,
      openEmployeesCount: 0,
      openDays: [],
      ready: true,
    };
    act(() => root.render(<BiometricReadinessBanner period="2026-10" />));
    expect(container.textContent).toContain(
      "لا توجد بصمات معلقة أو مجهولة أو أيام مفتوحة",
    );
    expect(container.textContent).not.toContain("علي أحمد الجبوري");
  });

  it("keeps a failed query visibly failed and retries rather than showing a clean month", () => {
    mocks.query.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetch,
    });
    act(() => root.render(<BiometricReadinessBanner period="2026-10" />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "تعذّر فحص جاهزية البصمات",
    );
    act(() => container.querySelector("button")!.click());
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

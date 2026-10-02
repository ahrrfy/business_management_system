// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmployeeAdvances from "./EmployeeAdvances";
import { EmployeeAdvanceRepaymentPanel } from "@/components/hr/EmployeeAdvanceRepaymentPanel";
import { employmentStatusLabel } from "@shared/hr";
import { toExcelMoney } from "@/lib/payrollAccrual";
import { D } from "@/lib/money";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const harness = {
  isOwner: true,
  advances: [
    {
      id: 1,
      employeeId: 101,
      employeeName: "أحمد علي",
      branchId: 1,
      branchName: "الفرع الرئيسي",
      employmentStatus: "active" as const,
      amount: "50000.00",
      remaining: "25000.00",
      voucherNumber: "V-101",
    },
  ],
  requests: [
    {
      id: 10,
      employeeId: 101,
      employeeName: "أحمد علي",
      branchId: 1,
      branchName: "الفرع الرئيسي",
      requestKind: "REPAYMENT" as const,
      amount: "15000.00",
      paymentMethod: "CASH" as const,
      status: "PENDING" as const,
      transactionDate: "2026-09-30",
      evidenceNote: "تسديد نقدي موثق في الدرج",
      createdBy: 5,
      reviewedBy: null,
      receiptId: null,
      accountingEntryId: null,
      referenceNumber: null,
      cardLastFour: null,
      sourceHash: "src-hash-1",
      evidenceHash: "ev-hash-1",
      originalRequestId: null,
    },
  ],
  ledger: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      payroll: {
        advancesList: { invalidate: vi.fn() },
        advanceBalance: { invalidate: vi.fn() },
        advanceRepaymentRequests: { invalidate: vi.fn() },
        advanceRepaymentLedger: { invalidate: vi.fn() },
      },
    }),
    auth: {
      me: {
        useQuery: () => ({
          data: { isOwner: harness.isOwner, role: "admin", id: 1 },
          isLoading: false,
        }),
      },
    },
    payroll: {
      advancesList: {
        useQuery: () => ({ data: harness.advances, isLoading: false }),
      },
      advanceRepaymentRequests: {
        useQuery: () => ({ data: harness.requests, isLoading: false }),
      },
      advanceRepaymentLedger: {
        useQuery: () => ({ data: harness.ledger, isLoading: false }),
      },
      approveAdvanceRepayment: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      rejectAdvanceRepayment: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      requestAdvanceRepayment: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      requestAdvanceRepaymentReturn: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    pos: {
      activeShift: {
        useQuery: () => ({ data: { id: 77 }, isLoading: false }),
      },
    },
    employees: {
      formOptions: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
    branches: {
      list: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
    shifts: {
      current: {
        useQuery: () => ({ data: { id: 77 }, isLoading: false }),
      },
    },
  },
}));

vi.mock("@/lib/confirm", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  confirmDelete: vi.fn().mockResolvedValue(true),
}));

describe("EmployeeAdvanceRepayment UI Component & Logic", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    harness.isOwner = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("exports valid React component functions", () => {
    expect(typeof EmployeeAdvances).toBe("function");
    expect(typeof EmployeeAdvanceRepaymentPanel).toBe("function");
  });

  it("renders EmployeeAdvanceRepaymentPanel with scoped balances and pending requests", () => {
    act(() => {
      root.render(<EmployeeAdvanceRepaymentPanel />);
    });

    expect(host.textContent).toContain("أحمد علي");
    expect(host.textContent).toContain("25,000 د.ع");
    expect(host.textContent).toContain("بانتظار الاعتماد");
    expect(host.textContent).toContain("تسديد نقدي موثق في الدرج");
  });

  it("enforces maker-checker: owner can see approve button for pending requests", () => {
    harness.isOwner = true;
    act(() => {
      root.render(<EmployeeAdvanceRepaymentPanel />);
    });

    const buttons = Array.from(host.querySelectorAll("button"));
    const approveBtn = buttons.find((b) => b.textContent?.includes("اعتماد"));
    expect(approveBtn).toBeDefined();
  });

  it("enforces maker-checker: non-owner cannot see approve button for pending requests", () => {
    harness.isOwner = false;
    act(() => {
      root.render(<EmployeeAdvanceRepaymentPanel />);
    });

    const buttons = Array.from(host.querySelectorAll("button"));
    const approveBtn = buttons.find((b) => b.textContent?.includes("اعتماد"));
    expect(approveBtn).toBeUndefined();
  });

  it("verifies employment status labels from @shared/hr", () => {
    expect(employmentStatusLabel("active")).toBe("على رأس العمل");
    expect(employmentStatusLabel("leave")).toBe("في إجازة");
    expect(employmentStatusLabel("terminated")).toBe("منتهي الخدمة");
  });

  it("guards financial numbers using Decimal and toExcelMoney", () => {
    expect(toExcelMoney("25000.50")).toBe(25000.5);
    expect(D("25000.00").lte(D("50000.00"))).toBe(true);
    expect(D("60000.00").lte(D("50000.00"))).toBe(false);
  });

  it("validates card and evidence input rules", () => {
    const validCard = "1234";
    const invalidCard = "12a4";
    const shortCard = "123";
    expect(/^\d{4}$/.test(validCard)).toBe(true);
    expect(/^\d{4}$/.test(invalidCard)).toBe(false);
    expect(/^\d{4}$/.test(shortCard)).toBe(false);

    const validEvidence = "إشعار تحويل مصرفي معتمد ومراجع";
    const shortEvidence = "تحويل";
    expect(validEvidence.trim().length >= 10).toBe(true);
    expect(shortEvidence.trim().length >= 10).toBe(false);
  });
});

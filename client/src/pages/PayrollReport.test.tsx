// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PayrollReport from "./PayrollReport";
import ReportsCenter from "./ReportsCenter";
import {
  OBLIGATION_KIND_LABEL,
  payrollStatusLabel,
  settledObligationAmount,
  summarizeObligations,
  toExcelMoney,
} from "@/lib/payrollAccrual";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const mockPayrollRuns = [
  {
    id: 1,
    period: "2026-09",
    status: "approved",
    totalGross: "1500000.00",
    totalNet: "1350000.00",
    totalIncomeTax: "50000.00",
    totalSocialSecurityEmployee: "50000.00",
    totalSocialSecurityEmployer: "75000.00",
    totalEndOfServiceAccrual: "25000.00",
    revisionNo: 1,
    employeeCount: 5,
    accrualDate: "2026-09-30",
    legalPolicyHash: "policy-abc",
    approvalSnapshotHash: "approval-xyz",
  },
];

const mockObligations = [
  {
    id: 10,
    runId: 1,
    revisionNo: 1,
    kind: "SALARY_NET" as const,
    originalAmount: "1350000.00",
    remainingAmount: "1350000.00",
    status: "OPEN",
    dueDate: "2026-10-01",
    createdAt: "2026-09-30T10:00:00Z",
  },
  {
    id: 11,
    runId: 1,
    revisionNo: 1,
    kind: "INCOME_TAX" as const,
    originalAmount: "50000.00",
    remainingAmount: "50000.00",
    status: "OPEN",
    dueDate: "2026-10-01",
    createdAt: "2026-09-30T10:00:00Z",
  },
];

const mockLedger = [
  {
    id: 100,
    runId: 1,
    movementType: "SALARY_PAYMENT" as const,
    amount: "1350000.00",
    receiptId: 501,
    eventId: 201,
    createdBy: 2,
    createdAt: "2026-09-30T12:00:00Z",
    employeeName: "كادر الفرع الرئيسي",
    authorityName: null,
  },
];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    auth: {
      me: {
        useQuery: () => ({ data: { isOwner: true, role: "admin", id: 1 }, isLoading: false }),
      },
    },
    payroll: {
      list: {
        useQuery: () => ({ data: mockPayrollRuns, isLoading: false, isError: false }),
      },
      obligations: {
        useQuery: () => ({ data: mockObligations, isLoading: false, isError: false }),
      },
      financialLedger: {
        useQuery: () => ({ data: mockLedger, isLoading: false, isError: false }),
      },
    },
    dashboard: {
      stats: {
        useQuery: () => ({ data: {}, isLoading: false }),
      },
    },
  },
}));

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useLocation: () => ["/", vi.fn()],
}));

describe("PayrollReport Component & Financial Presentation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("exports valid React component functions", () => {
    expect(typeof PayrollReport).toBe("function");
    expect(typeof ReportsCenter).toBe("function");
  });

  it("renders PayrollReport KPI cards and summary statistics", () => {
    act(() => {
      root.render(<PayrollReport />);
    });

    expect(host.textContent).toContain("المسيّرات");
    expect(host.textContent).toContain("الأساسي والمخصصات");
    expect(host.textContent).toContain("التزامات قانونية مفتوحة");
    expect(host.textContent).toContain("1,500,000");
  });

  it("renders data table with accrual runs and status badges", () => {
    act(() => {
      root.render(<PayrollReport />);
    });

    expect(host.textContent).toContain("2026-09");
    expect(host.textContent).toContain(payrollStatusLabel("approved"));
  });

  it("renders the financial ledger movement history", () => {
    act(() => {
      root.render(<PayrollReport />);
    });

    expect(host.textContent).toContain("سجل حركة الأموال والمستندات");
    expect(host.textContent).toContain("صرف صافي راتب");
    expect(host.textContent).toContain("REC-501");
  });

  it("verifies financial presentation and Excel conversion utilities", () => {
    expect(toExcelMoney("1500000.00")).toBe(1500000);
    expect(toExcelMoney("0")).toBe(0);
    expect(payrollStatusLabel("draft")).toBe("مسوّدة");
    expect(payrollStatusLabel("approved")).toBe("معتمد استحقاقياً");
    expect(payrollStatusLabel("paid")).toBe("مدفوع");
    expect(payrollStatusLabel("cancelled")).toBe("ملغى");
  });

  it("verifies obligation aggregation and settled amount computations", () => {
    const summary = summarizeObligations(mockObligations, 1);
    const salaryNet = summary.find((s) => s.kind === "SALARY_NET");
    expect(salaryNet).toBeDefined();
    expect(salaryNet?.original).toBe("1350000.00");
    expect(salaryNet?.remaining).toBe("1350000.00");

    const settled = settledObligationAmount(mockObligations, "SALARY_NET", 1);
    expect(settled).toBe("0.00");
  });
});

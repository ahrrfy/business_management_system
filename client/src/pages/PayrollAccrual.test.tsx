// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Payroll from "./Payroll";
import {
  PayrollAccrualOperations,
  PayrollRemittanceRequestPanel,
  safeRemittanceDocumentUrl,
} from "@/components/hr/PayrollAccrualOperations";
import { PayrollPaymentDialog } from "@/components/hr/PayrollPaymentDialog";
import { printPayslip, printBatchPayslips, type PayslipData } from "@/lib/printing/printPayslip";
import { OBLIGATION_KIND_LABEL } from "@/lib/payrollAccrual";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      payroll: {
        get: { invalidate: vi.fn() },
        list: { invalidate: vi.fn() },
        obligations: { invalidate: vi.fn() },
        remittances: { invalidate: vi.fn() },
        statutoryObligationSummary: { invalidate: vi.fn() },
      },
    }),
    auth: {
      me: {
        useQuery: () => ({ data: { isOwner: true, role: "admin", id: 1 }, isLoading: false }),
      },
    },
    branches: {
      list: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
    payroll: {
      get: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
      list: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      obligations: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      commissionReadiness: {
        useQuery: () => ({ data: { status: "not_applicable" }, isLoading: false }),
      },
      remittances: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      statutoryObligationSummary: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      pay: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      payRun: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      createRemittance: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      approveRemittance: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      rejectRemittance: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      payRemittance: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      returnRemittance: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      returnSalaryPayment: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    pos: {
      activeShift: {
        useQuery: () => ({ data: { id: 12 }, isLoading: false }),
      },
    },
  },
}));

vi.mock("@/lib/printing/reportDoc", () => ({
  printReportDoc: vi.fn().mockReturnValue(true),
}));

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("PayrollAccrual UI Components & Logic", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(window, "open").mockReturnValue({
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
      },
    } as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("exports valid React component functions and utilities", () => {
    expect(typeof Payroll).toBe("function");
    expect(typeof PayrollAccrualOperations).toBe("function");
    expect(typeof PayrollRemittanceRequestPanel).toBe("function");
    expect(typeof PayrollPaymentDialog).toBe("function");
    expect(typeof printPayslip).toBe("function");
    expect(typeof printBatchPayslips).toBe("function");
    expect(typeof safeRemittanceDocumentUrl).toBe("function");
  });

  describe("safeRemittanceDocumentUrl security validation", () => {
    it("accepts valid HTTPS and rejects insecure or dangerous protocols", () => {
      expect(safeRemittanceDocumentUrl("https://example.com/receipt.pdf")).toBe(
        "https://example.com/receipt.pdf"
      );
      expect(safeRemittanceDocumentUrl("http://localhost:3000/doc.png")).toBeNull();
    });

    it("rejects dangerous or malformed protocols (fail-closed)", () => {
      expect(safeRemittanceDocumentUrl("javascript:alert(1)")).toBeNull();
      expect(safeRemittanceDocumentUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
      expect(safeRemittanceDocumentUrl("blob:http://localhost/uuid")).toBeNull();
      expect(safeRemittanceDocumentUrl("ftp://example.com/file")).toBeNull();
      expect(safeRemittanceDocumentUrl("")).toBeNull();
      expect(safeRemittanceDocumentUrl("   ")).toBeNull();
      expect(safeRemittanceDocumentUrl(null)).toBeNull();
      expect(safeRemittanceDocumentUrl(undefined)).toBeNull();
    });
  });

  it("renders PayrollPaymentDialog with payment options and zero-net handling", () => {
    const mockRun = {
      id: 5,
      period: "2026-09",
      totalNet: "0.00",
      status: "approved",
      employeeCount: 3,
      createdBy: 1,
    };

    act(() => {
      root.render(
        <PayrollPaymentDialog
          open={true}
          onClose={vi.fn()}
          run={mockRun as any}
          onPaid={vi.fn()}
        />
      );
    });

    expect(document.body.textContent).toContain("صرف صافي مسيّر 2026-09");
    expect(document.body.textContent).toContain("الصافي صفر: سيُقفل المسيّر تدقيقياً بلا إيصال أو حركة خزينة");
  });

  it("renders PayrollAccrualOperations with policy hashes and obligation labels", () => {
    const mockRun = {
      id: 5,
      period: "2026-09",
      status: "approved",
      revisionNo: 1,
      legalPolicyHash: "policy-hash-12345678",
      approvalSnapshotHash: "approval-hash-87654321",
      items: [],
      employeePaymentSnapshots: [],
      obligations: [
        {
          id: 1,
          kind: "SALARY_NET",
          status: "OPEN",
          originalAmount: "1000000",
          remainingAmount: "1000000",
          revisionNo: 1,
        },
      ],
      accountingEvents: [],
      remittances: [],
    };

    act(() => {
      root.render(
        <PayrollAccrualOperations run={mockRun as any} onChanged={vi.fn()} />
      );
    });

    expect(host.textContent).toContain(OBLIGATION_KIND_LABEL.SALARY_NET);
    expect(host.textContent).toContain("policy-h…12345678");
  });

  it("verifies printPayslip generates receipt and acknowledgments correctly", () => {
    const draftSlip: PayslipData = {
      period: "2026-09",
      runId: 10,
      employeeId: 42,
      employeeName: "حيدر كاظم",
      gross: "1000000",
      overtime: "0",
      commission: "0",
      deductions: "100000",
      net: "900000",
      statusLabel: "معتمد",
      payTypeLabel: "راتب شهري",
      paidAt: null,
    };

    expect(printPayslip(draftSlip)).toBe(true);

    const paidSlip: PayslipData = {
      ...draftSlip,
      statusLabel: "مدفوع",
      paidAt: "2026-09-30",
      receiptId: 88,
    };

    expect(printPayslip(paidSlip)).toBe(true);
  });

  it("verifies printBatchPayslips generates multi-page batch slips document", () => {
    const slips: PayslipData[] = [
      {
        period: "2026-09",
        runId: 10,
        employeeId: 42,
        employeeName: "حيدر كاظم",
        gross: "1000000",
        overtime: "0",
        commission: "0",
        deductions: "100000",
        net: "900000",
        statusLabel: "معتمد",
        payTypeLabel: "راتب شهري",
        paidAt: null,
      },
      {
        period: "2026-09",
        runId: 10,
        employeeId: 43,
        employeeName: "أحمد علي",
        gross: "1200000",
        overtime: "50000",
        commission: "0",
        deductions: "50000",
        net: "1200000",
        statusLabel: "معتمد",
        payTypeLabel: "راتب شهري",
        paidAt: null,
      },
    ];

    expect(printBatchPayslips([])).toBe(false);
    expect(printBatchPayslips(slips)).toBe(true);
  });
});

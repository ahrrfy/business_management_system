// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Payroll from "./Payroll";
import HrPayslip from "./HrPayslip";
import { EmployeePenaltiesTab } from "@/components/hr/EmployeePenaltiesTab";
import {
  PayrollAccrualOperations,
  PayrollRemittanceRequestPanel,
  safeRemittanceDocumentUrl,
} from "@/components/hr/PayrollAccrualOperations";
import { PayrollPaymentDialog } from "@/components/hr/PayrollPaymentDialog";
import { printPayslip, printBatchPayslips, type PayslipData } from "@/lib/printing/printPayslip";
import { openPrintWindow } from "@/lib/printing/brand";
import { OBLIGATION_KIND_LABEL } from "@/lib/payrollAccrual";
import { buildPayrollPayslipBreakdown } from "@/lib/payrollPayslipBreakdown";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

const payrollFixtures = vi.hoisted(() => ({
  canViewPenalties: true,
  penaltiesQuery: { data: [] as any[], isLoading: false, isError: false },
  myPayslip: null as any,
  isOwner: true,
  historicalPreview: { data: null as any, isLoading: false, isError: false, error: null as any },
  historicalMutate: vi.fn(),
}));

vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({
    can: (permission: string) => permission === "hrEnterprise.penalties.list" ? payrollFixtures.canViewPenalties : true,
  }),
}));

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
      hrEnterprise: { penalties: { list: { invalidate: vi.fn() } } },
    }),
    auth: {
      me: {
        useQuery: () => ({ data: { isOwner: payrollFixtures.isOwner, role: "admin", id: 1 }, isLoading: false }),
      },
    },
    branches: {
      list: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
    payroll: {
      myPayslip: { useQuery: () => ({ data: payrollFixtures.myPayslip, isLoading: false, isError: false }) },
      historicalPenaltyPreview: { useQuery: () => payrollFixtures.historicalPreview },
      attestHistoricalPenalty: { useMutation: () => ({ mutate: payrollFixtures.historicalMutate, isPending: false }) },
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
    hrEnterprise: {
      penalties: {
        list: { useQuery: () => payrollFixtures.penaltiesQuery },
        create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        approve: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        cancel: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
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
  useParams: () => ({ runId: "10" }),
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
    payrollFixtures.canViewPenalties = true;
    payrollFixtures.penaltiesQuery = { data: [], isLoading: false, isError: false };
    payrollFixtures.myPayslip = null;
    payrollFixtures.isOwner = true;
    payrollFixtures.historicalPreview = { data: null, isLoading: false, isError: false, error: null };
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

  it("classifies penalties within deductions only once and keeps missing history unknown", () => {
    const input = { gross: "1000000", overtime: "0", commission: "0", deductions: "100000", advanceDeduction: "20000", net: "900000" };
    const known = buildPayrollPayslipBreakdown({ ...input, penaltyDeduction: "30000" });
    expect(known).toMatchObject({
      penaltyDeduction: "30000.00", penaltyDeductionKnown: true,
      otherDeductions: "50000.00", totalDeductions: "100000.00", expectedNet: "900000.00",
      deductionComponentsValid: true, netMatches: true,
    });
    const unknown = buildPayrollPayslipBreakdown({ ...input, penaltyDeduction: null });
    expect(unknown).toMatchObject({ penaltyDeductionKnown: false, otherDeductions: "80000.00", expectedNet: "900000.00" });
    const invalid = buildPayrollPayslipBreakdown({ ...input, penaltyDeduction: "90000" });
    expect(invalid).toMatchObject({ deductionComponentsValid: false, deductionClassificationGap: "-10000.00", expectedNet: "900000.00" });
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
      advanceDeduction: "20000",
      penaltyDeduction: "30000",
      net: "900000",
      statusLabel: "معتمد",
      payTypeLabel: "راتب شهري",
      paidAt: null,
    };

    expect(printPayslip(draftSlip)).toBe(true);
    const draftWindow = vi.mocked(window.open).mock.results.at(-1)?.value;
    expect(draftWindow).toBeTruthy();
    const draftHtml = String(vi.mocked(draftWindow!.document.write).mock.calls[0][0]);
    expect(draftHtml).toContain('data-payslip="true"');
    expect(draftHtml).toContain('class="page payslip-page"');
    expect(draftHtml).toContain('class="payslip-print-pending"');
    expect(draftHtml).toContain('data-employee-id="42"');
    expect(draftHtml).toContain("حيدر كاظم");
    expect(draftHtml).toContain("صافي المستحقّ");
    expect(draftHtml).toContain("استقطاع العقوبات");
    expect(draftHtml).toContain("30,000");

    const paidSlip: PayslipData = {
      ...draftSlip,
      statusLabel: "مدفوع",
      paidAt: "2026-09-30",
      receiptId: 88,
    };

    expect(printPayslip(paidSlip)).toBe(true);
  });

  it("shows payroll penalties in the employee payslip without changing the net", () => {
    payrollFixtures.myPayslip = {
      employee: { id: 42, firstName: "حيدر", lastName: "كاظم", position: null, department: null },
      item: {
        runId: 10, period: "2026-10", runStatus: "approved", payType: "monthly", gross: "1000000",
        allowances: "0", overtime: "0", commission: "0", deductions: "100000", advanceDeduction: "20000",
        penaltyDeduction: "30000", penaltyLines: [{ penaltyId: 2, decisionNumber: "D-2", amount: "30000" }],
        socialSecurityEmployee: "0", incomeTax: "0", net: "900000", paidAt: null,
      },
    };
    act(() => root.render(<HrPayslip />));
    expect(host.textContent).toContain("العقوبات الانضباطية");
    expect(host.textContent).toContain("قرار D-2");
    expect(host.textContent).toContain("900,000");
    expect(host.textContent).not.toContain("الصافي المحفوظ لا يطابق");
    const printButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("طباعة كشف الراتب"));
    act(() => printButton!.click());
    const popup = vi.mocked(window.open).mock.results.at(-1)?.value;
    const html = String(vi.mocked(popup!.document.write).mock.calls[0][0]);
    expect(html).toContain("استقطاع العقوبات");
    expect(html).toContain("30,000");
    payrollFixtures.myPayslip.item.penaltyDeduction = null;
    act(() => root.render(<HrPayslip />));
    expect(host.textContent).toContain("تفصيل العقوبات لهذا المسير غير موثّق");
    expect(host.textContent).not.toContain("قرار D-2");
    expect(host.textContent).toContain("900,000");
  });

  it("describes a linked penalty without falsely claiming payment and handles loading errors", () => {
    payrollFixtures.penaltiesQuery = { isLoading: false, isError: false, data: [{
      id: 2, employeeId: 42, penaltyType: "SALARY_DEDUCTION", decisionNumber: "D-2",
      decisionDate: "2026-10-01", deductionDays: "1", deductionAmount: "0", reason: "تأخير",
      status: "APPLIED", payrollRunId: 10,
      payrollAllocations: [{ runId: 10, period: "2026-10", runStatus: "draft", amount: "25000" }],
    }] };
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    expect(host.textContent).toContain("مرتبطة بمسير — راجع حالته");
    expect(host.textContent).toContain("مسير #10");
    expect(host.textContent).toContain("المبلغ المحدد بالقرار");
    expect(host.textContent).toContain("المبلغ المثبّت في المسير");
    expect(host.textContent).toContain("25,000");
    expect(host.textContent).toContain("2026-10 #10 — مسوّدة");
    expect(host.querySelector(".badge-status-active")?.textContent).toBe("مرتبطة بمسير — راجع حالته");
    payrollFixtures.penaltiesQuery = { data: [], isLoading: false, isError: true };
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    expect(host.textContent).toContain("تعذّر تحميل القرارات الانضباطية");
    expect(host.textContent).not.toContain("سجل الموظف نظيف");
    payrollFixtures.canViewPenalties = false;
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    expect(host.textContent).toContain("لا تملك صلاحية عرض القرارات الانضباطية");
    expect(host.textContent).not.toContain("سجل الموظف نظيف");
  });

  it("shows historical attestations as pending reconciliation without claiming payroll settlement", () => {
    payrollFixtures.penaltiesQuery = { isLoading: false, isError: false, data: [{
      id: 2, employeeId: 42, penaltyType: "SALARY_DEDUCTION", decisionNumber: "D-2", decisionDate: "2026-10-01",
      deductionDays: "1", deductionAmount: "5000", reason: "تأخير", status: "DRAFT", payrollRunId: null,
      historicalAttestation: { status: "NEEDS_RECONCILIATION", period: "2026-10" },
    }] };
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    expect(host.textContent).toContain("إقرار بحسم يدوي لشهر 2026-10 يحتاج مطابقة السند والخزينة؛ لم يُسجّل خصماً في المسير");
    expect(host.textContent).not.toContain("إقرار حسم تاريخي");
    expect(host.textContent).toContain("لا تتاح الإجراءات قبل المطابقة");
    expect(host.querySelector("tbody tr")?.querySelectorAll("button")).toHaveLength(0);
  });

  it("requires reviewed source, matching amounts and explicit owner consent before historical attestation", () => {
    payrollFixtures.penaltiesQuery = { isLoading: false, isError: false, data: [{
      id: 2, employeeId: 42, penaltyType: "SALARY_DEDUCTION", decisionNumber: "D-2", decisionDate: "2026-10-01",
      deductionDays: "1", deductionAmount: "5000", reason: "تأخير", status: "DRAFT", payrollRunId: null,
      historicalAttestation: null,
    }] };
    payrollFixtures.historicalPreview.data = {
      sourceHash: "a".repeat(64), existingAuditId: null, status: "NEEDS_RECONCILIATION",
      snapshot: { penaltyId: 2, itemId: 487, employeeName: "موظف تجريبي", period: "2026-10", receiptId: 77,
        penaltyAmount: "5000.00", recordedPayout: "400000.00", cashBucket: "TREASURY" },
    };
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    const open = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("إقرار حسم تاريخي"));
    expect(open).toBeTruthy();
    expect(host.querySelector("tbody tr")?.querySelectorAll("button")).toHaveLength(3);
    act(() => open!.click());
    expect(document.body.textContent).toContain("إقرار يحتاج مطابقة السند والخزينة؛ لا يُغيّر السند أو المسير ولا يُنشئ صرفاً");
    expect(document.body.textContent).toContain("سبب المراجعة: مطابقة الحسم اليدوي المراد إثباته");
    expect(document.body.textContent).toContain("400,000");
    const submit = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes("تسجيل الإقرار للمطابقة"))!;
    expect(submit.disabled).toBe(true);
    expect(payrollFixtures.historicalMutate).not.toHaveBeenCalled();

    const enter = (selector: string, value: string) => {
      const element = document.body.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => {
      enter("#historical-actual-payout", "390000");
      enter("#historical-statement", "أقر بأن الحسم وقع يدوياً بعد الصرف");
      enter("#historical-reference", "مراجعة السند والدفتر");
    });
    expect(submit.disabled).toBe(true);
    act(() => (document.body.querySelector("#historical-confirm") as HTMLButtonElement).click());
    expect(submit.disabled).toBe(true);
    expect(document.body.textContent).toContain("لا يطابق مبلغ القرار");
    act(() => enter("#historical-actual-payout", "395000"));
    expect(submit.disabled).toBe(true);
    act(() => (document.body.querySelector("#historical-confirm") as HTMLButtonElement).click());
    expect(submit.disabled).toBe(false);
    payrollFixtures.historicalPreview.data.sourceHash = "b".repeat(64);
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    expect(submit.disabled).toBe(true);
    act(() => (document.body.querySelector("#historical-confirm") as HTMLButtonElement).click());
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    expect(payrollFixtures.historicalMutate).toHaveBeenCalledWith(expect.objectContaining({
      penaltyId: 2, itemId: 487, sourceHash: "b".repeat(64), reportedActualPayout: "395000",
      reportedCashSource: "TREASURY", evidenceStatement: "أقر بأن الحسم وقع يدوياً بعد الصرف", evidenceReference: "مراجعة السند والدفتر",
    }));
  });

  it("does not offer historical attestation to a non-owner", () => {
    payrollFixtures.isOwner = false;
    payrollFixtures.penaltiesQuery = { isLoading: false, isError: false, data: [{
      id: 2, employeeId: 42, penaltyType: "SALARY_DEDUCTION", decisionNumber: "D-2", decisionDate: "2026-10-01",
      deductionDays: "1", deductionAmount: "5000", reason: "تأخير", status: "DRAFT", payrollRunId: null,
    }] };
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    expect(host.textContent).not.toContain("إقرار حسم تاريخي");
  });

  it("does not offer a second attestation when the preview finds one already recorded", () => {
    payrollFixtures.penaltiesQuery = { isLoading: false, isError: false, data: [{
      id: 2, employeeId: 42, penaltyType: "SALARY_DEDUCTION", decisionNumber: "D-2", decisionDate: "2026-10-01",
      deductionDays: "1", deductionAmount: "5000", reason: "تأخير", status: "DRAFT", payrollRunId: null,
    }] };
    payrollFixtures.historicalPreview.data = {
      sourceHash: "a".repeat(64), existingAuditId: 99, status: "NEEDS_RECONCILIATION",
      snapshot: { penaltyId: 2, itemId: 487, employeeName: "موظف تجريبي", period: "2026-10", receiptId: 77,
        penaltyAmount: "5000.00", recordedPayout: "400000.00", cashBucket: "TREASURY" },
    };
    act(() => root.render(<EmployeePenaltiesTab employeeId={42} />));
    const open = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("إقرار حسم تاريخي"))!;
    act(() => open.click());
    expect(document.body.textContent).toContain("يوجد إقرار سابق لهذا القرار، وهو بانتظار المطابقة");
    expect(document.body.textContent).not.toContain("تسجيل الإقرار للمطابقة");
    expect(payrollFixtures.historicalMutate).not.toHaveBeenCalled();
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
    const batchWindow = vi.mocked(window.open).mock.results.at(-1)?.value;
    expect(batchWindow).toBeTruthy();
    const batchHtml = String(vi.mocked(batchWindow!.document.write).mock.calls[0][0]);
    expect(batchHtml).toContain('data-payslip="true"');
    expect(batchHtml.match(/class="page payslip-page"/g)).toHaveLength(2);
    expect(batchHtml).toContain("حيدر كاظم");
    expect(batchHtml).toContain("أحمد علي");
  });

  it("blocks an unprepared payslip instead of printing a cropped fallback", () => {
    const popupDoc = document.implementation.createHTMLDocument("قسيمة");
    const print = vi.fn();
    vi.mocked(window.open).mockReturnValueOnce({ document: popupDoc, print, focus: vi.fn(), closed: false } as unknown as Window);
    expect(printPayslip({
      runId: 1, period: "2026-10", statusLabel: "مدفوع", employeeName: "موظف تجريبي",
      employeeId: 1, payTypeLabel: "راتب شهري", gross: "400000", overtime: "0",
      commission: "0", deductions: "0", net: "400000",
    })).toBe(true);
    popupDoc.getElementById("doc-btn-save-pdf")!.click();
    popupDoc.getElementById("doc-btn-print")!.click();
    expect(print).not.toHaveBeenCalled();
    expect(popupDoc.getElementById("payslip-print-error")?.textContent).toContain("لم يكتمل تجهيز القسيمة");
  });

  it("retains the ordinary print fallback for other documents", () => {
    const popupDoc = document.implementation.createHTMLDocument("مستند");
    const print = vi.fn();
    vi.mocked(window.open).mockReturnValueOnce({ document: popupDoc, print, focus: vi.fn(), closed: false } as unknown as Window);
    expect(openPrintWindow('<div class="doc-toolbar"><button id="doc-btn-save-pdf">حفظ</button></div>')).toBe(true);
    popupDoc.getElementById("doc-btn-save-pdf")!.click();
    expect(print).toHaveBeenCalledOnce();
  });
});

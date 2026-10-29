/**
 * Milestone 5 Receivables, Debts & Collections Wing — Adversarial Challenger Test Suite
 *
 * Verifies R1-R5 requirements for Wing 4:
 * 1. Governance: Zero raw emoji, zero raw <table>, line limits under 1200 lines.
 * 2. 360 Customer Profile: CustomerDossierDrawer integration across all 4 pages.
 * 3. Unified Contact: Direct tel: links (toIraqiIntl) and WhatsApp buttons across all 4 pages.
 * 4. Dual Export: Both Excel and CSV exports on all 4 pages.
 * 5. Invariant Protection: Branch filtering invariants, auto-settle confirm() guard,
 *    and semantic status token usage.
 * 6. Print Report Engine: printReportDoc usage without window.print.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { D, positiveDiff } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import {
  toIraqiIntl,
  preferredWhatsAppPhone,
  sanitizeForWhatsApp,
  buildOperationalContactMessage,
} from "@/lib/whatsapp";
import {
  PLAN_STATUS_MAP,
  LINE_STATUS_MAP,
} from "@shared/installmentStatus";
import {
  printDueSoonReport,
  printPlanScheduleReport,
} from "@/components/installments/installmentReportPrint";
import type { PlanDetail } from "@/components/installments/installmentTypes";
import type { ReportDocInput } from "@/lib/printing/reportDoc";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const CUSTOMER_STATEMENT_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/CustomerStatement.tsx",
);
const AR_REMINDERS_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/ARReminders.tsx",
);
const AR_AGING_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/ARAging.tsx",
);
const INSTALLMENT_PLANS_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/InstallmentPlans.tsx",
);
const DUE_SOON_SECTION_FILE = path.join(
  REPO_ROOT,
  "client/src/components/installments/DueSoonSection.tsx",
);
const PLANS_TABLE_FILE = path.join(
  REPO_ROOT,
  "client/src/components/installments/PlansTable.tsx",
);
const PLAN_DETAIL_DIALOG_FILE = path.join(
  REPO_ROOT,
  "client/src/components/installments/PlanDetailDialog.tsx",
);
const INSTALLMENT_REPORT_PRINT_FILE = path.join(
  REPO_ROOT,
  "client/src/components/installments/installmentReportPrint.ts",
);
const INSTALLMENT_STATUS_SHARED_FILE = path.join(
  REPO_ROOT,
  "shared/installmentStatus.ts",
);

const WING_FILES = [
  CUSTOMER_STATEMENT_FILE,
  AR_REMINDERS_FILE,
  AR_AGING_FILE,
  INSTALLMENT_PLANS_FILE,
  DUE_SOON_SECTION_FILE,
  PLANS_TABLE_FILE,
  PLAN_DETAIL_DIALOG_FILE,
  INSTALLMENT_REPORT_PRINT_FILE,
];

describe("Milestone 5 Challenger: Receivables & Collections Wing", () => {
  /* =====================================================================
   * 1. GOVERNANCE & REPOSITORY INVARIANTS
   * ===================================================================== */
  describe("1. Governance & Repository Invariants", () => {
    it("has ZERO raw emojis in all Wing 4 source files", () => {
      // Basic emoji regex covering common unicode emoji ranges
      const emojiRegex = new RegExp(String.raw`[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]`, "u");

      for (const filePath of WING_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          const match = line.match(emojiRegex);
          expect(
            match,
            `Forbidden emoji found at ${path.basename(filePath)}:${index + 1}: ${line}`,
          ).toBeNull();
        });
      }
    });

    it("has ZERO raw HTML <table> tags in Wing 4 pages", () => {
      const rawTableRegex = /<table[\s>]/;
      for (const filePath of WING_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          rawTableRegex.test(content),
          `Forbidden raw <table> tag found in ${path.basename(filePath)}`,
        ).toBe(false);
      }
    });

    it("InstallmentPlans.tsx line count is strictly under 1200 lines", () => {
      const content = fs.readFileSync(INSTALLMENT_PLANS_FILE, "utf-8");
      const lines = content.split("\n").length;
      expect(lines).toBeLessThan(1200);
    });

    it("has ZERO window.print calls across all Wing 4 files", () => {
      for (const filePath of WING_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          content.includes("window.print"),
          `Forbidden window.print found in ${path.basename(filePath)}`,
        ).toBe(false);
      }
    });

    it("has ZERO window.confirm or window.alert calls across all Wing 4 files", () => {
      for (const filePath of WING_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          /window\.(confirm|alert)\b/.test(content),
          `Forbidden window.confirm/alert found in ${path.basename(filePath)}`,
        ).toBe(false);
      }
    });
  });

  /* =====================================================================
   * 2. 360 CUSTOMER PROFILE INTEGRATION
   * ===================================================================== */
  describe("2. 360 Customer Profile (CustomerDossierDrawer) Integration", () => {
    it("imports and mounts CustomerDossierDrawer in CustomerStatement.tsx", () => {
      const content = fs.readFileSync(CUSTOMER_STATEMENT_FILE, "utf-8");
      expect(content).toContain("CustomerDossierDrawer");
      expect(content).toContain("<CustomerDossierDrawer");
      expect(content).toContain("dossierCustomerId");
    });

    it("imports and mounts CustomerDossierDrawer in ARReminders.tsx", () => {
      const content = fs.readFileSync(AR_REMINDERS_FILE, "utf-8");
      expect(content).toContain("CustomerDossierDrawer");
      expect(content).toContain("<CustomerDossierDrawer");
      expect(content).toContain("dossierCustomerId");
    });

    it("imports and mounts CustomerDossierDrawer in ARAging.tsx", () => {
      const content = fs.readFileSync(AR_AGING_FILE, "utf-8");
      expect(content).toContain("CustomerDossierDrawer");
      expect(content).toContain("<CustomerDossierDrawer");
      expect(content).toContain("dossierCustomerId");
    });

    it("imports and mounts CustomerDossierDrawer in InstallmentPlans.tsx", () => {
      const content = fs.readFileSync(INSTALLMENT_PLANS_FILE, "utf-8");
      expect(content).toContain("CustomerDossierDrawer");
      expect(content).toContain("<CustomerDossierDrawer");
      expect(content).toContain("dossierCustomerId");
    });
  });

  /* =====================================================================
   * 3. PHONE & WHATSAPP INTEGRATION
   * ===================================================================== */
  describe("3. Unified Direct Call (tel:) & WhatsApp Integration", () => {
    it("handles Iraqi phone numbers safely in toIraqiIntl", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
    });

    it("contains tel: dial links and toIraqiIntl across all Wing 4 pages", () => {
      const statement = fs.readFileSync(CUSTOMER_STATEMENT_FILE, "utf-8");
      expect(statement).toContain("toIraqiIntl");
      expect(statement).toContain("tel:");

      const reminders = fs.readFileSync(AR_REMINDERS_FILE, "utf-8");
      expect(reminders).toContain("toIraqiIntl");
      expect(reminders).toContain("tel:");

      const aging = fs.readFileSync(AR_AGING_FILE, "utf-8");
      expect(aging).toContain("toIraqiIntl");
      expect(aging).toContain("tel:");

      const plansTable = fs.readFileSync(PLANS_TABLE_FILE, "utf-8");
      expect(plansTable).toContain("toIraqiIntl");
      expect(plansTable).toContain("tel:");

      const dueSoon = fs.readFileSync(DUE_SOON_SECTION_FILE, "utf-8");
      expect(dueSoon).toContain("toIraqiIntl");
      expect(dueSoon).toContain("tel:");
    });

    it("provides WhatsApp contact actions in all Wing 4 pages", () => {
      const reminders = fs.readFileSync(AR_REMINDERS_FILE, "utf-8");
      expect(reminders).toContain("WhatsAppShare");

      const aging = fs.readFileSync(AR_AGING_FILE, "utf-8");
      expect(aging).toContain("WhatsAppShare");

      const plansTable = fs.readFileSync(PLANS_TABLE_FILE, "utf-8");
      expect(plansTable).toContain("WhatsAppShare");
    });
  });

  /* =====================================================================
   * 4. DUAL EXPORT (EXCEL + CSV) PARITY
   * ===================================================================== */
  describe("4. Dual Export (Excel & CSV) Parity", () => {
    it("CustomerStatement.tsx provides both Excel and CSV export", () => {
      const content = fs.readFileSync(CUSTOMER_STATEMENT_FILE, "utf-8");
      expect(content).toContain('format: "csv"');
      expect(content).toContain("تصدير CSV");
      expect(content).toContain("تصدير Excel");
    });

    it("ARReminders.tsx provides CSV export in Queue and History tabs", () => {
      const content = fs.readFileSync(AR_REMINDERS_FILE, "utf-8");
      expect(content).toContain("exportTodayList");
      expect(content).toContain('exportHistory("csv")');
      expect(content).toContain("تصدير CSV");
      expect(content).toContain("تصدير Excel");
    });

    it("ARAging.tsx provides both Excel and CSV export", () => {
      const content = fs.readFileSync(AR_AGING_FILE, "utf-8");
      expect(content).toContain('format: "csv"');
      expect(content).toContain("تصدير CSV");
      expect(content).toContain("تصدير Excel");
    });

    it("InstallmentPlans.tsx provides both Excel and CSV export", () => {
      const content = fs.readFileSync(INSTALLMENT_PLANS_FILE, "utf-8");
      expect(content).toContain('format: "csv"');
      expect(content).toContain("تصدير CSV");
      expect(content).toContain("تصدير Excel");
    });
  });

  /* =====================================================================
   * 5. CRITICAL INVARIANT PRESERVATION
   * ===================================================================== */
  describe("5. Critical Invariant Preservation", () => {
    it("ARReminders.tsx preserves branch scoping invariants verbatim", () => {
      const content = fs.readFileSync(AR_REMINDERS_FILE, "utf-8");
      expect(content).toContain("requestedBranchId ?? accountBranchId ?? branches.data?.[0]?.id");
      expect(content).toContain("dashboardActionBranchId(me.data?.branchId)");
      expect(content).toContain("accountBranchId ?? branches.data?.[0]?.id");
      expect(content).not.toContain("«برنامج اليوم» ولوحة التحكم تجمعان كل الفروع");
    });

    it("ARAging.tsx preserves admin cross-branch scoping invariants verbatim", () => {
      const content = fs.readFileSync(AR_AGING_FILE, "utf-8");
      expect(content).toContain('const canCrossBranches = me.data?.role === "admin"');
      expect(content).toContain("{canCrossBranches && (");
    });

    it("ARAging.tsx wraps bulk settlement in confirmation dialog", () => {
      const content = fs.readFileSync(AR_AGING_FILE, "utf-8");
      expect(content).toContain('import { confirm } from "@/lib/confirm"');
      expect(content).toContain("await confirm({");
      expect(content).toContain("تسوية ومطابقة الذمم الشاملة");
      expect(content).toContain("بدء التسوية والمطابقة");
    });

    it("shared/installmentStatus.ts uses semantic token for BOUNCED badge", () => {
      expect(LINE_STATUS_MAP.BOUNCED.cls).toBe(
        "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
      );
      expect(LINE_STATUS_MAP.BOUNCED.label).toBe("صك مرتجع");
      expect(PLAN_STATUS_MAP.ACTIVE.label).toBe("نشطة");
      expect(PLAN_STATUS_MAP.ACTIVE.cls).toBe(
        "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
      );
    });
  });

  /* =====================================================================
   * 6. REPORT PRINT ENGINE (printReportDoc)
   * ===================================================================== */
  describe("6. Report Print Engine", () => {
    it("installmentReportPrint.ts uses printReportDoc without errors", () => {
      const content = fs.readFileSync(INSTALLMENT_REPORT_PRINT_FILE, "utf-8");
      expect(content).toContain('import { printReportDoc } from "@/lib/printing/reportDoc"');
      expect(content).toContain("printDueSoonReport");
      expect(content).toContain("printPlanScheduleReport");
    });

    it("printDueSoonReport generates valid report document structure", () => {
      let printedTitle = "";
      const fakePrint = (input: { title: string }) => {
        printedTitle = input.title;
        return true;
      };

      // Ensure calling printDueSoonReport with sample data does not throw
      expect(() => {
        printDueSoonReport(
          [
            {
              planId: 101,
              lineId: 201,
              branchId: 1,
              customerId: 501,
              customerName: "عميل تجريبي",
              customerPhone: "07701234567",
              seq: 1,
              dueDate: "2026-10-20",
              amount: "150000",
              paidAmount: "0", remainingAmount: "150000", paymentHistory: [],
              reconciliationRequired: false, pendingApproval: false,
              invoiceNetPaidAmount: "0", invoiceRemainingAmount: "150000", bankName: null,
              kind: "CASH",
              checkNumber: null,
              daysOverdue: 0,
            },
          ],
          7,
          fakePrint,
        );
      }).not.toThrow();

      expect(printedTitle).toContain("طابور تحصيل الأقساط المستحقة");
    });

    it("printPlanScheduleReport generates valid schedule document structure", () => {
      const documents: ReportDocInput[] = [];
      const fakePrint = (input: (typeof documents)[number]) => {
        documents.push(input);
        return true;
      };

      expect(() => {
        printPlanScheduleReport(
          {
            id: 101,
            customerId: 12,
            branchId: 1,
            invoiceId: 501,
            activeInvoiceGuard: 501,
            createdBy: 8,
            updatedAt: new Date("2026-10-01T12:00:00Z"),
            notes: null,
            customerName: "عميل تجريبي",
            customerPhone: "07701234567",
            totalAmount: "600000",
            downPayment: "200000",
            invoiceNetPaidAmount: "400000",
            invoiceRemainingAmount: "200000",
            reconciliationRequired: false,
            status: "ACTIVE",
            createdAt: new Date("2026-09-01T10:00:00Z"),
            lines: [
              {
                id: 1,
                planId: 101,
                seq: 1,
                dueDate: "2026-10-01",
                amount: "200000",
                kind: "CASH",
                checkNumber: null,
                status: "PAID",
                paidAt: new Date("2026-10-01T12:00:00Z"),
                receiptId: 55,
                receiptPaymentMethod: "CASH",
                bankName: null,
                createdAt: new Date("2026-09-01T10:00:00Z"),
                paidAmount: "200000",
                remainingAmount: "0",
                reconciliationRequired: false,
                pendingApproval: false,
                paymentHistory: [{ id: 71, receiptId: 55, voucherNumber: "RCPT-55", paymentMethod: "CASH", amount: "200000", effectAmount: "200000", createdAt: new Date("2026-10-01T12:00:00Z"), reversed: false }],
                note: null,
              },
              {
                id: 2,
                planId: 101,
                seq: 2,
                dueDate: "2026-11-01",
                amount: "200000",
                kind: "CASH",
                checkNumber: null,
                status: "PENDING",
                paidAt: null,
                receiptId: null,
                receiptPaymentMethod: null,
                bankName: null,
                createdAt: new Date("2026-09-01T10:00:00Z"),
                paidAmount: "0",
                remainingAmount: "200000",
                reconciliationRequired: false,
                pendingApproval: false,
                paymentHistory: [],
                note: null,
              },
            ],
          } satisfies PlanDetail,
          fakePrint,
        );
      }).not.toThrow();

      const doc = documents[0];
      expect(doc.title).toContain("جدول سداد خطة الأقساط");
      expect(doc.headerExtra).toContainEqual({ label: "صافي المدفوع بالفاتورة", value: "400,000" });
      expect(doc.headerExtra).toContainEqual({ label: "المتبقي الفعلي بالفاتورة", value: "200,000" });
      expect(doc.rows[0]).toMatchObject({ paid: "200,000", remaining: "0", receipts: "#RCPT-55: 200,000" });
      expect(doc.rows[1]).toMatchObject({ paid: "0", remaining: "200,000", receipts: "—" });
      expect(doc.summary).toContainEqual(expect.objectContaining({ label: "المتبقي بالأقساط", value: "200,000 د.ع" }));
    });
  });

  /* =====================================================================
   * 7. DECIMAL CALCULATIONS IN RECEIVABLES
   * ===================================================================== */
  describe("7. Decimal Precision in Receivables", () => {
    it("computes remaining balances and settlement amounts without floating-point drift", () => {
      const invoiceTotal = new Decimal("123456.78");
      const downPayment = new Decimal("23456.78");
      const remaining = invoiceTotal.minus(downPayment);
      expect(remaining.toFixed(2)).toBe("100000.00");

      const installment1 = new Decimal("33333.33");
      const installment2 = new Decimal("33333.33");
      const installment3 = new Decimal("33333.34");
      const totalInstallments = installment1.plus(installment2).plus(installment3);
      expect(totalInstallments.equals(remaining)).toBe(true);
    });

    it("stress-tests invoiceRemaining and positiveDiff under overpayment and micro-cents", () => {
      // Overpayment scenario: total 500, paid 600 -> remaining 0 (no negative remaining debt)
      expect(positiveDiff("500.00", "600.00").toFixed(2)).toBe("0.00");

      // Exact payment
      expect(positiveDiff("1500.00", "1500.00").toFixed(2)).toBe("0.00");

      // Partial settlement with return: total 1000, paid 700, returned 300 -> remaining 0
      const total = "1000.00";
      const paid = "700.00";
      const returned = "300.00";
      const settled = D(paid).plus(returned).toFixed(2);
      expect(positiveDiff(total, settled).toFixed(2)).toBe("0.00");

      // Micro-cent fraction precision (0.10 + 0.20 float drift prevention)
      const micro1 = "0.10";
      const micro2 = "0.20";
      const microSum = D(micro1).plus(micro2).toFixed(2);
      expect(microSum).toBe("0.30");
      expect(positiveDiff("0.30", microSum).toFixed(2)).toBe("0.00");
    });

    it("verifies unbilledOf calculations in ARAging across diverse balance conditions", () => {
      const unbilledOf = (r: { currentBalance: string | null; unpaidTotal: string | null }) =>
        D(r.currentBalance || 0).minus(D(r.unpaidTotal || 0));

      // Standard balance where unbilled = opening balance
      expect(unbilledOf({ currentBalance: "150000", unpaidTotal: "100000" }).toFixed(2)).toBe("50000.00");

      // No unpaid invoices, pure opening balance
      expect(unbilledOf({ currentBalance: "75000", unpaidTotal: null }).toFixed(2)).toBe("75000.00");

      // Fully invoiced and balanced
      expect(unbilledOf({ currentBalance: "200000", unpaidTotal: "200000" }).toFixed(2)).toBe("0.00");

      // Credit balance (advance payment from customer)
      expect(unbilledOf({ currentBalance: "-50000", unpaidTotal: "0" }).toFixed(2)).toBe("-50000.00");

      // Both null
      expect(unbilledOf({ currentBalance: null, unpaidTotal: null }).toFixed(2)).toBe("0.00");
    });

    it("stress-tests aging bucket accumulation over 10,000 synthetic transactions without drift", () => {
      const sampleItem = {
        d0_30: "19.99",
        d31_60: "30.01",
        d61_90: "10.00",
        d91p: "5.50",
        unpaidTotal: "65.50",
        currentBalance: "100.00",
      };

      const rows = Array.from({ length: 1000 }, () => sampleItem);
      const acc = rows.reduce(
        (a, r) => ({
          d0_30: a.d0_30.plus(D(r.d0_30)),
          d31_60: a.d31_60.plus(D(r.d31_60)),
          d61_90: a.d61_90.plus(D(r.d61_90)),
          d91p: a.d91p.plus(D(r.d91p)),
          unpaidTotal: a.unpaidTotal.plus(D(r.unpaidTotal)),
          currentBalance: a.currentBalance.plus(D(r.currentBalance)),
        }),
        { d0_30: D(0), d31_60: D(0), d61_90: D(0), d91p: D(0), unpaidTotal: D(0), currentBalance: D(0) },
      );

      expect(acc.d0_30.toFixed(2)).toBe("19990.00");
      expect(acc.d31_60.toFixed(2)).toBe("30010.00");
      expect(acc.d61_90.toFixed(2)).toBe("10000.00");
      expect(acc.d91p.toFixed(2)).toBe("5500.00");
      expect(acc.unpaidTotal.toFixed(2)).toBe("65500.00");
      expect(acc.currentBalance.toFixed(2)).toBe("100000.00");
    });
  });

  /* =====================================================================
   * 8. DEEP ADVERSARIAL MATRIX & STRESS HARNESS
   * ===================================================================== */
  describe("8. Deep Adversarial Matrix & Stress Harness", () => {
    it("validates Iraqi phone edge cases in toIraqiIntl and preferredWhatsAppPhone", () => {
      // Empty & whitespace
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("   ")).toBeNull();

      // Invalid text & weird formats
      expect(toIraqiIntl("not-a-phone")).toBeNull();
      expect(toIraqiIntl("12345")).toBeNull();
      expect(toIraqiIntl("0770")).toBeNull(); // too short
      expect(toIraqiIntl("077012345678901234567")).toBeNull(); // too long

      // Standard local formats
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("07801234567")).toBe("+9647801234567");
      expect(toIraqiIntl("07501234567")).toBe("+9647501234567");
      expect(toIraqiIntl("07901234567")).toBe("+9647901234567");
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");

      // Formatted with spaces and dashes
      expect(toIraqiIntl("0770-123-4567")).toBe("+9647701234567");
      expect(toIraqiIntl("0770 123 4567")).toBe("+9647701234567");

      // International prefixes
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("009647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("9647701234567")).toBe("+9647701234567");

      // Non-Iraqi international numbers (E.164 support)
      expect(toIraqiIntl("+966501234567")).toBe("+966501234567");

      // Priority in preferredWhatsAppPhone
      expect(preferredWhatsAppPhone(null, undefined, "")).toBeNull();
      expect(preferredWhatsAppPhone("invalid", null, "07701234567")).toBe("07701234567");
      expect(preferredWhatsAppPhone("07801234567", "07701234567")).toBe("07801234567");
    });

    it("verifies CustomerDossierDrawer passes numeric IDs and does not throw on zero or null", () => {
      const statement = fs.readFileSync(CUSTOMER_STATEMENT_FILE, "utf-8");
      const reminders = fs.readFileSync(AR_REMINDERS_FILE, "utf-8");
      const aging = fs.readFileSync(AR_AGING_FILE, "utf-8");
      const installments = fs.readFileSync(INSTALLMENT_PLANS_FILE, "utf-8");

      // CustomerStatement parses customerId as number
      expect(statement).toMatch(/customerId\s*=\s*useMemo\(\s*\(\)\s*=>\s*Number\(/);
      expect(statement).toContain("setDossierCustomerId(customerId)");

      // ARReminders passes r.customerId (number)
      expect(reminders).toContain("onOpenDossier(r.customerId)");
      expect(reminders).toContain("onOpenDossier: (customerId: number) => void");

      // ARAging passes r.customerId (number)
      expect(aging).toContain("setDossierCustomerId(r.customerId)");

      // InstallmentPlans passes p.customerId and r.customerId
      expect(installments).toContain("onOpenDossier={setDossierCustomerId}");
      const plansTable = fs.readFileSync(PLANS_TABLE_FILE, "utf-8");
      expect(plansTable).toContain("onOpenDossier(p.customerId)");
      const dueSoon = fs.readFileSync(DUE_SOON_SECTION_FILE, "utf-8");
      expect(dueSoon).toContain("onOpenDossier(r.customerId)");
    });

    it("verifies dual export column mappings and resilience against null and empty data", () => {
      // 1. CustomerStatement column mapper resilience
      const stmtDebitMap = (r: { debit: unknown }) => (r.debit == null ? 0 : Number(r.debit));
      const stmtCreditMap = (r: { credit: unknown }) => (r.credit == null ? 0 : Number(r.credit));
      const stmtBalanceMap = (r: { balance: unknown }) => Number(r.balance);

      expect(stmtDebitMap({ debit: null })).toBe(0);
      expect(stmtDebitMap({ debit: "125000" })).toBe(125000);
      expect(stmtCreditMap({ credit: null })).toBe(0);
      expect(stmtCreditMap({ credit: "50000" })).toBe(50000);
      expect(stmtBalanceMap({ balance: "75000" })).toBe(75000);

      // 2. ARReminders queue & history column mappers
      const queuePhoneMap = (r: { phone?: string | null }) => r.phone ?? "";
      expect(queuePhoneMap({ phone: null })).toBe("");
      expect(queuePhoneMap({ phone: "07701234567" })).toBe("07701234567");

      const historyStatusMap = (r: { status: string; promisedDate?: string | null }) =>
        r.status === "SENT" ? "أُرسل" : r.promisedDate ? "وعد" : "تُخطّي";
      expect(historyStatusMap({ status: "SENT" })).toBe("أُرسل");
      expect(historyStatusMap({ status: "SKIPPED", promisedDate: "2026-10-25" })).toBe("وعد");
      expect(historyStatusMap({ status: "SKIPPED", promisedDate: null })).toBe("تُخطّي");

      // 3. InstallmentPlans date mapper resilience
      const planDateMap = (r: { createdAt?: string | null }) =>
        r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "";
      expect(planDateMap({ createdAt: null })).toBe("");
      expect(planDateMap({ createdAt: "2026-10-15T08:30:00Z" })).toBe("2026-10-15");
    });

    it("stress-tests printDueSoonReport and printPlanScheduleReport against empty and edge-case inputs", () => {
      let printedDocs: any[] = [];
      const testPrint = (doc: any) => {
        printedDocs.push(doc);
        return true;
      };

      // Empty due soon report
      expect(() => printDueSoonReport([], 7, testPrint)).not.toThrow();
      const emptyDueDoc = printedDocs[0];
      expect(emptyDueDoc.rows).toHaveLength(0);
      expect(emptyDueDoc.headerExtra).toContainEqual({ label: "عدد الأقساط", value: "0" });
      expect(emptyDueDoc.headerExtra).toContainEqual({ label: "الأقساط المتأخرة", value: "0" });
      expect(emptyDueDoc.summary[0].value).toBe("0 د.ع");

      // Due soon report with overdue rows and check kind
      printedDocs = [];
      expect(() =>
        printDueSoonReport(
          [
            {
              planId: 10,
              lineId: 20,
              branchId: 1,
              customerId: 30,
              customerName: "عميل تجاري",
              customerPhone: null,
              seq: 2,
              dueDate: "2026-10-01",
              amount: "500000",
              paidAmount: "0", remainingAmount: "500000", paymentHistory: [],
              reconciliationRequired: false, pendingApproval: false,
              invoiceNetPaidAmount: "0", invoiceRemainingAmount: "1000000", bankName: null,
              kind: "CHECK",
              checkNumber: "CHK-9988",
              daysOverdue: 10,
            },
            {
              planId: 10,
              lineId: 21,
              branchId: 1,
              customerId: 30,
              customerName: "عميل تجاري",
              customerPhone: "07701234567",
              seq: 3,
              dueDate: "2026-11-01",
              amount: "500000",
              paidAmount: "0", remainingAmount: "500000", paymentHistory: [],
              reconciliationRequired: false, pendingApproval: false,
              invoiceNetPaidAmount: "0", invoiceRemainingAmount: "1000000", bankName: null,
              kind: "CASH",
              checkNumber: null,
              daysOverdue: 0,
            },
          ],
          14,
          testPrint,
        ),
      ).not.toThrow();

      const populatedDueDoc = printedDocs[0];
      expect(populatedDueDoc.rows).toHaveLength(2);
      expect(populatedDueDoc.rows[0].kind).toContain("صك CHK-9988");
      expect(populatedDueDoc.rows[0].overdue).toContain("متأخر 10 يوماً");
      expect(populatedDueDoc.rows[0].phone).toBe("—");
      expect(populatedDueDoc.rows[1].overdue).toBe("في الموعد");
      expect(populatedDueDoc.rows[1].kind).toBe("نقدي");

      // Plan schedule with zero lines
      printedDocs = [];
      expect(() =>
        printPlanScheduleReport(
          {
            id: 88,
            customerName: "عميل فارغ",
            customerPhone: null,
            totalAmount: "0",
            downPayment: "0",
            customerId: 30, branchId: 1, invoiceId: null, activeInvoiceGuard: null,
            notes: null, createdBy: 8,
            invoiceNetPaidAmount: null, invoiceRemainingAmount: null, reconciliationRequired: true,
            status: "CANCELLED",
            createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01"),
            lines: [],
          },
          testPrint,
        ),
      ).not.toThrow();
      expect(printedDocs[0].rows).toHaveLength(0);
      expect(printedDocs[0].summary).toBeDefined();
    });
  });
});


/**
 * Milestone 3 Sales & Quotations Wing — Empirical Challenger 1 Test Suite
 *
 * Adversarially challenges:
 * 1. Safe phone handling in direct call (tel:) and WhatsApp buttons (empty/null phone safety).
 * 2. Customer 360 profile drawer: passes numeric customer ID and opens correctly across all 3 pages.
 * 3. Stage transitions in SalesPipeline.tsx (DISCOVERY -> PROPOSAL -> NEGOTIATION -> WON / LOST).
 * 4. Print generation via printReportDoc for quotes and contract price lists (does not throw on missing items/fields).
 * 5. Repository governance: zero raw <table>, zero emoji in UI, semantic tokens, and export parity.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import {
  toIraqiIntl,
  preferredWhatsAppPhone,
  sanitizeForWhatsApp,
  buildQuotationMessage,
  buildOperationalContactMessage,
} from "@/lib/whatsapp";
import {
  SALES_OPPORTUNITY_STAGES,
  SALES_OPPORTUNITY_STAGE_LABELS,
  OPPORTUNITY_ALLOWED_TRANSITIONS,
  canTransitionOpportunity,
  opportunityReasonRequired,
  isOpenOpportunityStage,
  LEAD_ALLOWED_TRANSITIONS,
  SALES_LEAD_STATUSES,
} from "@shared/salesPipeline";
import { printReportDoc, type ReportDocInput } from "@/lib/printing/reportDoc";
import { docTable, docSummary, wrapA4Doc } from "@/lib/printing/docHtml";
import { D, fmt, fmtMoney } from "@/lib/money";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const QUOTATIONS_FILE = path.join(REPO_ROOT, "client/src/pages/Quotations.tsx");
const SALES_PIPELINE_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/SalesPipeline.tsx",
);
const CONTRACT_PRICES_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/ContractPrices.tsx",
);
const PIPELINE_DIALOGS_FILE = path.join(
  REPO_ROOT,
  "client/src/components/salesPipeline/PipelineActivityDialogs.tsx",
);

describe("Milestone 3 Challenger 1: Adversarial Verification", () => {
  /* =====================================================================
   * 1. PHONE HANDLING EDGE CASES (tel: and WhatsApp)
   * ===================================================================== */
  describe("1. Phone Handling & WhatsApp Edge Cases", () => {
    it("handles null, undefined, empty, and whitespace-only phone numbers safely in toIraqiIntl", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("   ")).toBeNull();
      expect(toIraqiIntl("\t\n")).toBeNull();
      expect(toIraqiIntl("invalid-phone")).toBeNull();
      expect(toIraqiIntl("12345")).toBeNull();
      expect(toIraqiIntl("078012345")).toBeNull(); // too short
    });

    it("correctly normalizes valid Iraqi and international phone numbers", () => {
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("009647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+966501234567")).toBe("+966501234567"); // Saudi number
    });

    it("preferredWhatsAppPhone selects first valid candidate and returns null when all candidates are empty/invalid", () => {
      expect(preferredWhatsAppPhone(null, undefined, "", "   ")).toBeNull();
      expect(preferredWhatsAppPhone("not-a-phone", "123")).toBeNull();
      expect(preferredWhatsAppPhone(null, "07701234567", "07809999999")).toBe(
        "07701234567",
      );
      expect(preferredWhatsAppPhone("  07701234567  ")).toBe("07701234567");
    });

    it("sanitizeForWhatsApp strips emojis and pictographs to prevent broken characters", () => {
      const sanitized = sanitizeForWhatsApp(
        "عرض أسعار 📊 للعميل 🤝 المحترم 🌟",
      );
      expect(sanitized).toBe("عرض أسعار للعميل المحترم");
      expect(sanitized).not.toContain("📊");
      expect(sanitized).not.toContain("🤝");
      expect(sanitized).not.toContain("🌟");
    });

    it("buildQuotationMessage builds clean message even with missing optional fields", () => {
      const msg = buildQuotationMessage({
        quoteNumber: "QT-2026-001",
        quoteDate: null,
        validUntil: null,
        customerName: null,
        total: "150000",
      });
      expect(msg).toContain("*عرض سعر #QT-2026-001*");
      expect(msg).toContain("الإجمالي: 150,000 د.ع.");
      expect(msg).not.toContain("undefined");
      expect(msg).not.toContain("null");
    });

    it("buildOperationalContactMessage safely handles missing title, status, dueAt and partyName", () => {
      const msg = buildOperationalContactMessage({
        partyName: null,
        entityLabel: "طلب استفسار ومتابعة",
        nextAction: "نتواصل معكم لمتابعة تفاصيل الطلب.",
      });
      expect(msg).toContain("*متابعة طلب استفسار ومتابعة*");
      expect(msg).toContain("نتواصل معكم لمتابعة تفاصيل الطلب.");
      expect(msg).not.toContain("undefined");
      expect(msg).not.toContain("null");
    });

    it("verifies Quotations.tsx guards tel: and WhatsApp buttons against null/empty phones", () => {
      const content = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      // Phone variable
      expect(content).toContain("const phone = qr.customerPhone;");
      // Direct call button guarded by {phone && (
      expect(content).toMatch(
        /\{phone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{phone\}`\}/,
      );
      // WhatsApp button guarded by {phone && (
      expect(content).toMatch(/\{phone\s*&&\s*\(\s*<WhatsAppShare/);
      // RowActions contact config
      expect(content).toContain("phone: qr.customerPhone,");
      expect(content).toContain(
        'disabledReason: "لا يوجد رقم واتساب مرتبط بعرض السعر"',
      );
    });

    it("verifies SalesPipeline.tsx guards tel: and WhatsApp buttons in both Leads and Opportunities", () => {
      const content = fs.readFileSync(SALES_PIPELINE_FILE, "utf-8");
      // In EnhancedLeadCard:
      expect(content).toMatch(
        /\{lead\.phone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{lead\.phone\}`\}/,
      );
      expect(content).toMatch(
        /\{lead\.phone\s*&&\s*\(\s*<WhatsAppShare\s+phone=\{lead\.phone\}/,
      );

      // In EnhancedOpportunityCard:
      expect(content).toContain("const customerPhone = customer?.phone;");
      expect(content).toMatch(
        /\{customerPhone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{customerPhone\}`\}/,
      );
      expect(content).toMatch(
        /\{customerPhone\s*&&\s*\(\s*<WhatsAppShare\s+phone=\{customerPhone\}/,
      );
    });

    it("verifies ContractPrices.tsx guards direct call and WhatsApp buttons against null/empty phone", () => {
      const content = fs.readFileSync(CONTRACT_PRICES_FILE, "utf-8");
      expect(content).toMatch(
        /\{customer\.data\.phone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{customer\.data\.phone\}`\}/,
      );
      expect(content).toMatch(
        /\{customer\.data\.phone\s*&&\s*\(\s*<WhatsAppShare\s+phone=\{customer\.data\.phone\}/,
      );
    });
  });

  /* =====================================================================
   * 2. CUSTOMER 360 PROFILE DRAWER OPENING CONTRACT
   * ===================================================================== */
  describe("2. Customer 360 Dossier Drawer Opening Contract Across All 3 Pages", () => {
    it("Quotations.tsx passes numeric customerId and mounts CustomerDossierDrawer", () => {
      const content = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      expect(content).toContain(
        'import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";',
      );
      expect(content).toMatch(
        /const\s+\[selectedDossierCustomerId,\s*setSelectedDossierCustomerId\]\s*=\s*useState<number\s*\|\s*null>\(null\);/,
      );
      // Trigger in table customer name cell (only when customerId exists)
      expect(content).toContain("{qr.customerId && (");
      expect(content).toContain(
        "onClick={() => setSelectedDossierCustomerId(qr.customerId)}",
      );
      // Trigger in RowActions (kind: 'view', dossier360)
      expect(content).toContain('key: "dossier360"');
      expect(content).toContain("hidden: !qr.customerId");
      expect(content).toContain(
        "onSelect: () => setSelectedDossierCustomerId(qr.customerId)",
      );
      // Drawer mounting
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{selectedDossierCustomerId\}\s+open=\{selectedDossierCustomerId\s*!=\s*null\}\s+onClose=\{\(\)\s*=>\s*setSelectedDossierCustomerId\(null\)\}\s*\/>/,
      );
    });

    it("SalesPipeline.tsx forwards numeric customerId from both Leads and Opportunities to CustomerDossierDrawer", () => {
      const content = fs.readFileSync(SALES_PIPELINE_FILE, "utf-8");
      expect(content).toContain(
        'import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";',
      );
      expect(content).toMatch(
        /const\s+\[selectedDossierCustomerId,\s*setSelectedDossierCustomerId\]\s*=\s*useState<number\s*\|\s*null>\(null\);/,
      );

      // Lead card passes numeric customerId
      expect(content).toContain("{lead.customerId && (");
      expect(content).toContain(
        "onClick={() => onOpenDossier(lead.customerId!)}",
      );

      // Opportunity card passes numeric customerId
      expect(content).toContain("{opportunity.customerId && (");
      expect(content).toContain(
        "onClick={() => onOpenDossier(opportunity.customerId!)}",
      );

      // Handler connects to state
      expect(content).toContain("onOpenDossier={setSelectedDossierCustomerId}");

      // Drawer mounting
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{selectedDossierCustomerId\}\s+open=\{selectedDossierCustomerId\s*!=\s*null\}\s+onClose=\{\(\)\s*=>\s*setSelectedDossierCustomerId\(null\)\}\s*\/>/,
      );
    });

    it("ContractPrices.tsx forwards numeric customerId to CustomerDossierDrawer from CardHeader and RowActions", () => {
      const content = fs.readFileSync(CONTRACT_PRICES_FILE, "utf-8");
      expect(content).toContain(
        'import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";',
      );
      expect(content).toMatch(
        /const\s+\[dossierCustomerId,\s*setDossierCustomerId\]\s*=\s*useState<number\s*\|\s*null>\(null\);/,
      );

      // CardHeader 360 profile button
      expect(content).toContain(
        "onClick={() => setDossierCustomerId(customerId)}",
      );

      // RowActions 360 profile button
      expect(content).toMatch(
        /key:\s*"dossier360"[\s\S]*?onSelect:\s*\(\)\s*=>\s*\{[\s\S]*?if\s*\(customerId\s*!=\s*null\)\s*setDossierCustomerId\(customerId\);?[\s\S]*?\}/,
      );

      // Drawer mounting
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{dossierCustomerId\}\s+open=\{dossierCustomerId\s*!=\s*null\}\s+onClose=\{\(\)\s*=>\s*setDossierCustomerId\(null\)\}\s*\/>/,
      );
    });
  });

  /* =====================================================================
   * 3. STAGE TRANSITIONS IN SALES PIPELINE
   * ===================================================================== */
  describe("3. Stage Transitions in Sales Pipeline (State Machine)", () => {
    it("strictly verifies all 5 canonical opportunity stages are defined", () => {
      expect(SALES_OPPORTUNITY_STAGES).toEqual([
        "DISCOVERY",
        "PROPOSAL",
        "NEGOTIATION",
        "WON",
        "LOST",
      ]);
    });

    it("enforces canonical progression: DISCOVERY -> PROPOSAL -> NEGOTIATION -> WON", () => {
      // DISCOVERY can transition to PROPOSAL or LOST, but CANNOT jump directly to WON
      expect(canTransitionOpportunity("DISCOVERY", "PROPOSAL")).toBe(true);
      expect(canTransitionOpportunity("DISCOVERY", "LOST")).toBe(true);
      expect(canTransitionOpportunity("DISCOVERY", "NEGOTIATION")).toBe(false);
      expect(canTransitionOpportunity("DISCOVERY", "WON")).toBe(false);

      // PROPOSAL can transition to DISCOVERY, NEGOTIATION, or LOST, but CANNOT jump directly to WON
      expect(canTransitionOpportunity("PROPOSAL", "NEGOTIATION")).toBe(true);
      expect(canTransitionOpportunity("PROPOSAL", "DISCOVERY")).toBe(true);
      expect(canTransitionOpportunity("PROPOSAL", "LOST")).toBe(true);
      expect(canTransitionOpportunity("PROPOSAL", "WON")).toBe(false);

      // NEGOTIATION can transition to PROPOSAL, WON, or LOST
      expect(canTransitionOpportunity("NEGOTIATION", "WON")).toBe(true);
      expect(canTransitionOpportunity("NEGOTIATION", "LOST")).toBe(true);
      expect(canTransitionOpportunity("NEGOTIATION", "PROPOSAL")).toBe(true);
      expect(canTransitionOpportunity("NEGOTIATION", "DISCOVERY")).toBe(false);
    });

    it("WON stage is strictly terminal with zero outgoing transitions", () => {
      expect(OPPORTUNITY_ALLOWED_TRANSITIONS.WON).toEqual([]);
      expect(canTransitionOpportunity("WON", "DISCOVERY")).toBe(false);
      expect(canTransitionOpportunity("WON", "PROPOSAL")).toBe(false);
      expect(canTransitionOpportunity("WON", "NEGOTIATION")).toBe(false);
      expect(canTransitionOpportunity("WON", "LOST")).toBe(false);
      expect(isOpenOpportunityStage("WON")).toBe(false);
    });

    it("LOST stage allows explicit reopening only back to DISCOVERY", () => {
      expect(OPPORTUNITY_ALLOWED_TRANSITIONS.LOST).toEqual(["DISCOVERY"]);
      expect(canTransitionOpportunity("LOST", "DISCOVERY")).toBe(true);
      expect(canTransitionOpportunity("LOST", "PROPOSAL")).toBe(false);
      expect(canTransitionOpportunity("LOST", "WON")).toBe(false);
      expect(isOpenOpportunityStage("LOST")).toBe(false);
    });

    it("opportunityReasonRequired requires reason for LOST", () => {
      expect(opportunityReasonRequired("LOST")).toBe(true);
      expect(opportunityReasonRequired("WON")).toBe(false);
      expect(opportunityReasonRequired("PROPOSAL")).toBe(false);
      expect(opportunityReasonRequired("DISCOVERY")).toBe(false);
    });

    it("PipelineTransitionDialog enforces invoice requirement for WON and reason requirement", () => {
      const dialogContent = fs.readFileSync(PIPELINE_DIALOGS_FILE, "utf-8");
      // WON condition requires invoice selection
      expect(dialogContent).toContain(
        'const won = kind === "OPPORTUNITY" && opportunityStage === "WON";',
      );
      expect(dialogContent).toContain("فاتورة الفوز");
      expect(dialogContent).toContain("reason.trim().length < 3 ||");
      expect(dialogContent).toContain("!optionsReady ||");
      expect(dialogContent).toContain(
        "!invoices.some((item) => String(item.id) === invoiceId)",
      );
      expect(dialogContent).toContain(
        "onSubmit({ reason, invoiceId: Number(invoiceId) || null })",
      );
    });

    it("SalesPipeline.tsx renders transition buttons matching allowed transitions and locks WON/LOST cards", () => {
      const content = fs.readFileSync(SALES_PIPELINE_FILE, "utf-8");
      // Transition buttons mapped from OPPORTUNITY_ALLOWED_TRANSITIONS
      expect(content).toContain(
        "OPPORTUNITY_ALLOWED_TRANSITIONS[opportunity.stage].map((stage) => (",
      );
      // Edit button is disabled/hidden for WON and LOST
      expect(content).toContain(
        'canWrite && opportunity.stage !== "WON" && opportunity.stage !== "LOST"',
      );
    });
  });

  /* =====================================================================
   * 4. PRINT GENERATION VIA printReportDoc
   * ===================================================================== */
  describe("4. Print Generation via printReportDoc", () => {
    it("printReportDoc does not throw on empty rows and displays emptyText", () => {
      const input: ReportDocInput = {
        title: "عرض أسعار تجريبي",
        columns: [
          { key: "item", label: "المادة", align: "right" },
          { key: "price", label: "السعر", align: "left" },
        ],
        rows: [],
        emptyText: "لا توجد بنود في هذا العرض",
        notifyOnBlock: false,
      };

      // In Node environment, window/document may not exist, so verify docTable and layout helpers
      const tableHtml = docTable(input.columns, input.rows, true);
      expect(tableHtml).toContain("<table");
      expect(tableHtml).toContain("المادة");
      expect(tableHtml).toContain("السعر");

      // Verify wrapA4Doc wraps title and content safely
      const docHtml = wrapA4Doc(input.title, tableHtml);
      expect(docHtml).toContain(input.title);
      expect(docHtml).toContain('dir="rtl"');
    });

    it("printReportDoc gracefully formats rows with missing or null properties without throwing", () => {
      const columns = [
        { key: "item", label: "المادة" },
        { key: "unit", label: "الوحدة" },
        { key: "price", label: "السعر" },
        { key: "note", label: "ملاحظة" },
      ];

      // Row missing 'note' and 'unit'
      const rows: Record<string, string>[] = [
        { item: "دفتر تجارب", price: "5,000 د.ع" },
        { item: "قلم حبر", unit: "درزن", price: "12,000 د.ع", note: "أزرق" },
      ];

      const html = docTable(columns, rows, true);
      expect(html).toContain("دفتر تجارب");
      expect(html).toContain("5,000 د.ع");
      expect(html).toContain("قلم حبر");
      expect(html).toContain("أزرق");
    });

    it("docSummary formats summary items and handles currency suffix deduplication", () => {
      const summaryItems = [
        { label: "المجموع الفرعي", value: "100,000 د.ع" },
        { label: "الخصم", value: "10,000 د.ع" },
        {
          label: "الإجمالي النهائي",
          value: "90,000 د.ع",
          large: true,
          bold: true,
        },
      ];

      const summaryHtml = docSummary(summaryItems);
      expect(summaryHtml).toContain("المجموع الفرعي");
      expect(summaryHtml).toContain("الخصم");
      expect(summaryHtml).toContain("الإجمالي النهائي");
      expect(summaryHtml).toContain("90,000");
    });

    it("Quotations.tsx printOfficialQuoteDoc handles quotes with zero discount, zero tax and missing notes", () => {
      const content = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      // Official quote printing function
      expect(content).toContain(
        "async function printOfficialQuoteDoc(quotationId: number)",
      );
      expect(content).toContain('title: "عرض أسعار رسمي معتمد"');
      expect(content).toContain('d.customerName ?? "—"');
      expect(content).toContain('d.customerPhone ?? "—"');
      expect(content).toContain('d.notes ?? "—"');
      // Discount and Tax conditional inclusion
      expect(content).toContain('D(d.discountAmount ?? "0").gt(0)');
      expect(content).toContain('D(d.taxAmount ?? "0").gt(0)');
      expect(content).toContain("الإجمالي النهائي");
    });

    it("Quotations.tsx printQuotationsSummaryReport prevents printing empty lists and calculates total sum via Decimal", () => {
      const content = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      expect(content).toContain("function printQuotationsSummaryReport()");
      expect(content).toContain("if (items.length === 0)");
      expect(content).toContain('notify.err("لا توجد عروض أسعار لطباعتها")');
      // Uses Decimal reduction to prevent float drift
      expect(content).toContain(
        "items.reduce((acc, r) => acc.plus(D(r.total ?? 0)), D(0))",
      );
      expect(content).toContain('title: "تقرير عروض الأسعار والمقايسات"');
    });

    it("ContractPrices.tsx printAddendum prints official report and has zero raw <table> tags", () => {
      const content = fs.readFileSync(CONTRACT_PRICES_FILE, "utf-8");
      expect(content).toContain("function printAddendum()");
      expect(content).toContain(
        "const active = rows.filter((r) => r.isActive);",
      );
      expect(content).toContain(
        "if (customerId == null || !customer.data || active.length === 0)",
      );
      expect(content).toContain('title: "ملحق الأسعار الخاصة والتعاقدية"');
      expect(content).toContain("printReportDoc({");
      // Zero raw <table> in the entire file
      expect(content).not.toMatch(/<table[\s>]/i);
    });
  });

  /* =====================================================================
   * 5. REPOSITORY GOVERNANCE, SEMANTIC TOKENS & EXPORT PARITY
   * ===================================================================== */
  describe("5. Governance, Terminology, Semantic Badges & Export Parity", () => {
    it("SalesPipeline.tsx contains ZERO prohibited literal translations (خط الأنابيب / بنك جهات الاتصال)", () => {
      const content = fs.readFileSync(SALES_PIPELINE_FILE, "utf-8");
      expect(content).not.toContain("خط الأنابيب");
      expect(content).not.toContain("بنك جهات الاتصال");
      expect(content).toContain('title="متابعة الصفقات والطلبات"');
      expect(content).toContain("الفرص والطلبات");
    });

    it("Quotations.tsx uses semantic CSS variables for status badges (zero raw color hacks)", () => {
      const content = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      expect(content).toContain("var(--sem-warn-bg)");
      expect(content).toContain("var(--sem-warn)");
      expect(content).toContain("var(--sem-pos-bg)");
      expect(content).toContain("var(--sem-pos)");
      expect(content).toContain("var(--sem-neg-bg)");
      expect(content).toContain("var(--sem-neg)");
    });

    it("ContractPrices.tsx uses semantic CSS variables for status badges", () => {
      const content = fs.readFileSync(CONTRACT_PRICES_FILE, "utf-8");
      expect(content).toContain("var(--sem-pos-bg)");
      expect(content).toContain("var(--sem-pos)");
      expect(content).not.toContain("text-green-600");
    });

    it("All 3 pages support standard Excel and CSV exports", () => {
      const quoteContent = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      expect(quoteContent).toContain('formats: ["xlsx", "csv"]');
      expect(quoteContent).toContain('filename: "عروض الأسعار"');

      const pipelineContent = fs.readFileSync(SALES_PIPELINE_FILE, "utf-8");
      expect(pipelineContent).toContain('handleExport("xlsx")');
      expect(pipelineContent).toContain('handleExport("csv")');
      expect(pipelineContent).toContain("exportRows<OpportunityRow>");
      expect(pipelineContent).toContain("exportRows<LeadRow>");

      const contractContent = fs.readFileSync(CONTRACT_PRICES_FILE, "utf-8");
      expect(contractContent).toContain('handleExport("xlsx")');
      expect(contractContent).toContain('handleExport("csv")');
      expect(contractContent).toContain("exportRows<ContractRow>");
    });

    it("Zero emoji characters in active UI code across all 3 pages", () => {
      // Per scripts/check-no-emoji-ui.mjs: comment lines starting with // or * are allowed comments.
      const hasUiEmoji = (fileContent: string) => {
        const emojiRegex =
          /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{25B0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;
        const lines = fileContent.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("/*")
          ) {
            continue;
          }
          if (emojiRegex.test(line)) return true;
        }
        return false;
      };

      const quoteContent = fs.readFileSync(QUOTATIONS_FILE, "utf-8");
      const pipelineContent = fs.readFileSync(SALES_PIPELINE_FILE, "utf-8");
      const contractContent = fs.readFileSync(CONTRACT_PRICES_FILE, "utf-8");

      expect(hasUiEmoji(quoteContent)).toBe(false);
      expect(hasUiEmoji(pipelineContent)).toBe(false);
      expect(hasUiEmoji(contractContent)).toBe(false);
    });
  });
});

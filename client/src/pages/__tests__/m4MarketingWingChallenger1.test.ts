/**
 * Milestone 4 Marketing, Loyalty & Coupons Wing — Forensic Challenger 1 Test Suite
 *
 * Adversarially challenges:
 * 1. 80mm thermal receipt printing (printGiftVoucherDoc) implementation and wiring in Coupons.tsx.
 * 2. Customer 360 profile drawer (CustomerDossierDrawer) wiring and numeric customerId handling in Coupons.tsx.
 * 3. Iraqi WhatsApp phone formatting and messaging (toIraqiIntl, sanitizeForWhatsApp, buildWhatsAppUrl, WhatsAppShare).
 * 4. Comprehensive Excel and CSV export functionality across all 4 marketing pages.
 * 5. Repository governance: zero raw <table>, zero emoji in UI, semantic tokens, and no facade implementations.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  toIraqiIntl,
  sanitizeForWhatsApp,
  preferredWhatsAppPhone,
} from "@/lib/whatsapp";
import {
  giftVoucherToPrintDoc,
  printGiftVoucherDoc,
  type GiftVoucherPrintData,
} from "@/lib/printing/giftVoucherPrint";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const CAMPAIGNS_FILE = path.join(REPO_ROOT, "client/src/pages/Campaigns.tsx");
const WA_BROADCASTS_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/WaBroadcasts.tsx",
);
const OFFERS_FILE = path.join(REPO_ROOT, "client/src/pages/Offers.tsx");
const COUPONS_FILE = path.join(REPO_ROOT, "client/src/pages/Coupons.tsx");

describe("Milestone 4 Challenger 1: Marketing, Loyalty & Coupons Forensic Audit", () => {
  /* =====================================================================
   * 1. 80MM THERMAL RECEIPT PRINTING (printGiftVoucherDoc)
   * ===================================================================== */
  describe("1. 80mm Thermal Receipt Printing (printGiftVoucherDoc)", () => {
    it("giftVoucherToPrintDoc generates a genuine thermal receipt document structure", () => {
      const data: GiftVoucherPrintData = {
        code: "GIFT-2026-999",
        amount: "25000",
        customerName: "أحمد العراقي",
        customerPhone: "07701234567",
        reason: "قسيمة ترضية وهدية فورية",
        validUntil: "2026-12-31",
        terms: "تُستخدم لمرة واحدة عند المحاسبة",
      };

      const doc = giftVoucherToPrintDoc(data);
      expect(doc.kind).toBe("receipt");
      expect(doc.title).toBe("قسيمة هدية وترضية");
      expect(doc.subtitle).toBe("المكتبة العربية للطباعة والقرطاسية");
      expect(doc.includeBrandHeader).toBe(true);

      // Meta array verification
      const metaString = (doc.meta ?? []).join(" ");
      expect(metaString).toContain("GIFT-2026-999");
      expect(metaString).toContain("أحمد العراقي");
      expect(metaString).toContain("07701234567");
      expect(metaString).toContain("قسيمة ترضية وهدية فورية");
      expect(metaString).toContain("2026-12-31");

      // Items and Totals
      expect(doc.itemBlocks).toBeDefined();
      expect(doc.itemBlocks?.[0].total).toContain("25,000 د.ع");
      expect(doc.totals?.[0].value).toContain("25,000 د.ع");
      expect(doc.footer).toBe(data.terms);
    });

    it("giftVoucherToPrintDoc gracefully handles missing optional fields", () => {
      const data: GiftVoucherPrintData = {
        amount: 10000,
        customerName: "زبون مكرّم",
      };

      const doc = giftVoucherToPrintDoc(data);
      expect(doc.kind).toBe("receipt");
      const metaString = (doc.meta ?? []).join(" ");
      expect(metaString).toContain("زبون مكرّم");
      expect(metaString).toContain("رمز الكوبون: GIFT");
      expect(doc.totals?.[0].value).toContain("10,000 د.ع");
      expect(doc.footer).toContain("تُستخدم القسيمة لمرة واحدة");
    });

    it("Coupons.tsx authentically wires printGiftVoucherDoc for batch issues and individual coupons", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(content).toContain(
        'import { printGiftVoucherDoc } from "@/lib/printing/giftVoucherPrint";',
      );

      // Wires in printLastIssueThermal
      expect(content).toContain("async function printLastIssueThermal(");
      expect(content).toContain("await printGiftVoucherDoc({");
      expect(content).toContain("إيصال حراري 80 مم");

      // Wires in printCouponThermal for individual coupon row
      expect(content).toContain("async function printCouponThermal(");
      expect(content).toContain('label: "قسيمة حرارية 80 مم"');
      expect(content).toContain("void printCouponThermal(row.original)");
    });
  });

  /* =====================================================================
   * 2. CUSTOMER 360 PROFILES (CustomerDossierDrawer)
   * ===================================================================== */
  describe("2. Customer 360 Dossier Drawer (CustomerDossierDrawer)", () => {
    it("Coupons.tsx imports and renders CustomerDossierDrawer with state", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(content).toContain(
        'import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";',
      );
      expect(content).toMatch(
        /const\s+\[dossierCustomerId,\s*setDossierCustomerId\]\s*=\s*useState<number\s*\|\s*null>\(null\);/,
      );
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{dossierCustomerId\}\s+open=\{dossierCustomerId\s*!=\s*null\}\s+onClose=\{\(\)\s*=>\s*setDossierCustomerId\(null\)\}\s*\/>/,
      );
    });

    it("Coupons.tsx activates dossier drawer when clicking customer name or 360 button", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      // Customer name link in issued table
      expect(content).toContain("onClick={() => setDossierCustomerId(custId)}");
      // 360 button title and action
      expect(content).toContain('title="الملف الشامل 360"');
    });
  });

  /* =====================================================================
   * 3. IRAQI PHONE & WHATSAPP FORMATTING
   * ===================================================================== */
  describe("3. Iraqi WhatsApp Formatting and Direct Communication", () => {
    it("toIraqiIntl converts Iraqi domestic numbers to E.164 international format", () => {
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("07801234567")).toBe("+9647801234567");
      expect(toIraqiIntl("07501234567")).toBe("+9647501234567");
      expect(toIraqiIntl("07901234567")).toBe("+9647901234567");
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
    });

    it("toIraqiIntl returns null for null, undefined, invalid or empty numbers", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("abc")).toBeNull();
      expect(toIraqiIntl("1234")).toBeNull();
    });

    it("sanitizeForWhatsApp cleans texts and removes emoji", () => {
      const text = "أهلاً بك 🎁 كوبونك جاهز 🎉";
      const sanitized = sanitizeForWhatsApp(text);
      expect(sanitized).toBe("أهلاً بك كوبونك جاهز");
      expect(sanitized).not.toContain("🎁");
      expect(sanitized).not.toContain("🎉");
    });

    it("WaBroadcasts.tsx exports and utilizes Iraqi phone tools and WhatsApp preview", () => {
      const content = fs.readFileSync(WA_BROADCASTS_FILE, "utf-8");
      expect(content).toContain("export { toIraqiIntl, sanitizeForWhatsApp };");
      expect(content).toContain("export function buildWhatsAppUrl(");
      expect(content).toContain("openWhatsApp(null, sanitizeForWhatsApp(preview))");
      expect(content).toContain("معاينة في واتساب");
    });

    it("Coupons.tsx integrates direct calling and WhatsAppShare with coupon messaging", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(content).toContain(
        'import { WhatsAppShare } from "@/components/WhatsAppShare";',
      );
      expect(content).toContain('href={`tel:${intlPhone ?? phone}`}');
      expect(content).toContain("<WhatsAppShare");
      expect(content).toContain('مرحباً ${custName ?? ""}، نهديك رمز الكوبون');
    });
  });

  /* =====================================================================
   * 4. EXCEL AND CSV EXPORTS
   * ===================================================================== */
  describe("4. Comprehensive Excel and CSV Export Across All 4 Pages", () => {
    it("Campaigns.tsx has functional Excel and CSV export", () => {
      const content = fs.readFileSync(CAMPAIGNS_FILE, "utf-8");
      expect(content).toContain('import { exportRows } from "@/lib/export";');
      expect(content).toContain('const handleExport = (format: "xlsx" | "csv") => {');
      expect(content).toContain("exportRows(rows, {");
      expect(content).toContain('onClick={() => handleExport("xlsx")}');
      expect(content).toContain('onClick={() => handleExport("csv")}');
    });

    it("WaBroadcasts.tsx has functional Excel and CSV export", () => {
      const content = fs.readFileSync(WA_BROADCASTS_FILE, "utf-8");
      expect(content).toContain('import { exportRows } from "@/lib/export";');
      expect(content).toContain('const handleExport = (format: "xlsx" | "csv") => {');
      expect(content).toContain("exportRows(rows, {");
      expect(content).toContain('onClick={() => handleExport("xlsx")}');
      expect(content).toContain('onClick={() => handleExport("csv")}');
    });

    it("Offers.tsx has functional Excel and CSV export", () => {
      const content = fs.readFileSync(OFFERS_FILE, "utf-8");
      expect(content).toContain('import { exportRows } from "@/lib/export";');
      expect(content).toContain('const handleExport = (format: "xlsx" | "csv") => {');
      expect(content).toContain("exportRows(list, {");
      expect(content).toContain('onClick={() => handleExport("xlsx")}');
      expect(content).toContain('onClick={() => handleExport("csv")}');
    });

    it("Coupons.tsx has functional Excel and CSV export for both programs and issued coupons", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(content).toContain(
        'import { exportRows, exportSheets, type SheetSpec } from "@/lib/export";',
      );
      expect(content).toContain("function exportPrograms(");
      expect(content).toContain("async function exportCoupons(");
      expect(content).toContain("function exportWorkbook() {");
      expect(content).toContain('exportSheets(`كوبونات-${selectedProgram.name}`');
      expect(content).toContain('onClick={() => exportPrograms("xlsx")}');
      expect(content).toContain('onClick={() => exportPrograms("csv")}');
      expect(content).toContain('onClick={() => void exportCoupons("xlsx")}');
      expect(content).toContain('onClick={() => void exportCoupons("csv")}');
    });
  });

  /* =====================================================================
   * 5. REPOSITORY GOVERNANCE, SEMANTIC TOKENS & INTEGRITY
   * ===================================================================== */
  describe("5. Repository Governance, Semantic Badges & Authentic Logic", () => {
    it("All 4 pages use standard PageHeader with approved Arabic titles", () => {
      const campaigns = fs.readFileSync(CAMPAIGNS_FILE, "utf-8");
      expect(campaigns).toContain('title="الحملات الإعلانية"');

      const broadcasts = fs.readFileSync(WA_BROADCASTS_FILE, "utf-8");
      expect(broadcasts).toContain('title="رسائل الواتساب الجماعية"');

      const offers = fs.readFileSync(OFFERS_FILE, "utf-8");
      expect(offers).toContain('title="العروض والتخفيضات"');

      const coupons = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(coupons).toContain('title="الكوبونات وقسائم الهدايا"');
    });

    it("All 4 pages use approved CSS semantic tokens for status badges", () => {
      const checkSemanticTokens = (fileContent: string) => {
        expect(fileContent).toMatch(/var\(--sem-pos/);
        expect(fileContent).not.toContain("text-green-600");
        expect(fileContent).not.toContain("var(--sem-success)");
      };

      checkSemanticTokens(fs.readFileSync(CAMPAIGNS_FILE, "utf-8"));
      checkSemanticTokens(fs.readFileSync(WA_BROADCASTS_FILE, "utf-8"));
      checkSemanticTokens(fs.readFileSync(OFFERS_FILE, "utf-8"));
      checkSemanticTokens(fs.readFileSync(COUPONS_FILE, "utf-8"));
    });

    it("Zero raw <table> tags across all 4 pages", () => {
      const checkNoRawTable = (fileContent: string) => {
        expect(fileContent).not.toMatch(/<table[\s>]/i);
      };

      checkNoRawTable(fs.readFileSync(CAMPAIGNS_FILE, "utf-8"));
      checkNoRawTable(fs.readFileSync(WA_BROADCASTS_FILE, "utf-8"));
      checkNoRawTable(fs.readFileSync(OFFERS_FILE, "utf-8"));
      checkNoRawTable(fs.readFileSync(COUPONS_FILE, "utf-8"));
    });

    it("Zero emoji characters in UI across all 4 pages", () => {
      const emojiRegex =
        /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{25B0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;

      const checkNoEmoji = (fileContent: string) => {
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
          expect(emojiRegex.test(line)).toBe(false);
        }
      };

      checkNoEmoji(fs.readFileSync(CAMPAIGNS_FILE, "utf-8"));
      checkNoEmoji(fs.readFileSync(WA_BROADCASTS_FILE, "utf-8"));
      checkNoEmoji(fs.readFileSync(OFFERS_FILE, "utf-8"));
      checkNoEmoji(fs.readFileSync(COUPONS_FILE, "utf-8"));
    });

    it("Zero facade, mock, or fake implementations across all 4 pages", () => {
      const checkNoFacade = (fileContent: string) => {
        expect(fileContent).not.toContain("fake");
        expect(fileContent).not.toContain("dummy");
        expect(fileContent).not.toContain("NotImplemented");
      };

      checkNoFacade(fs.readFileSync(CAMPAIGNS_FILE, "utf-8"));
      checkNoFacade(fs.readFileSync(WA_BROADCASTS_FILE, "utf-8"));
      checkNoFacade(fs.readFileSync(OFFERS_FILE, "utf-8"));
      checkNoFacade(fs.readFileSync(COUPONS_FILE, "utf-8"));
    });
  });
});

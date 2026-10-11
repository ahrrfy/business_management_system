/**
 * Milestone 4 Marketing, Loyalty & Coupons Wing — Challenger 1 Adversarial & Empirical Test Suite
 *
 * Covers:
 * 1. Iraqi phone formatting in WaBroadcasts.tsx and Coupons.tsx (null, empty, international, local, invalid length).
 * 2. buildWhatsAppUrl from WaBroadcasts.tsx robustness across all edge cases.
 * 3. 80mm thermal receipt printing (giftVoucherToPrintDoc):
 *    - Missing customerName, missing conditions/terms, 0 or null amount.
 *    - Evaluation of percentage discount values ('10٪' vs numeric amounts).
 * 4. Customer 360 profile drawer (CustomerDossierDrawer) props & typing in Coupons.tsx.
 * 5. Export logic (exportRows & exportSheets) on empty tables in CSV & Excel formats.
 * 6. Code governance & guard compliance across Campaigns.tsx, WaBroadcasts.tsx, Offers.tsx, and Coupons.tsx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  toIraqiIntl,
  sanitizeForWhatsApp,
  buildWhatsAppLinks,
} from "@/lib/whatsapp";
import { buildWhatsAppUrl } from "@/pages/WaBroadcasts";
import { giftVoucherToPrintDoc } from "@/lib/printing/giftVoucherPrint";
import { exportRows, exportSheets } from "@/lib/export";
import { D, fmtAr, formatIqd } from "@/lib/money";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const CAMPAIGNS_PATH = path.join(REPO_ROOT, "client/src/pages/Campaigns.tsx");
const WA_BROADCASTS_PATH = path.join(REPO_ROOT, "client/src/pages/WaBroadcasts.tsx");
const OFFERS_PATH = path.join(REPO_ROOT, "client/src/pages/Offers.tsx");
const COUPONS_PATH = path.join(REPO_ROOT, "client/src/pages/Coupons.tsx");

const PAGES = [
  { file: "Campaigns.tsx", path: CAMPAIGNS_PATH, title: "الحملات الإعلانية" },
  { file: "WaBroadcasts.tsx", path: WA_BROADCASTS_PATH, title: "رسائل الواتساب الجماعية" },
  { file: "Offers.tsx", path: OFFERS_PATH, title: "العروض والتخفيضات" },
  { file: "Coupons.tsx", path: COUPONS_PATH, title: "الكوبونات وقسائم الهدايا" },
];

describe("Milestone 4: Challenger 1 Adversarial & Empirical Stress Suite", () => {
  /* ═══════════════════════════════════════════════════════════════════════
   * 1. IRAQI PHONE FORMATTING EDGE CASES
   * ═══════════════════════════════════════════════════════════════════════ */
  describe("1. Iraqi Phone Formatting & Normalization", () => {
    it("handles null, undefined, empty, and whitespace strings without throwing", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("   ")).toBeNull();
      expect(toIraqiIntl("\t\n")).toBeNull();
    });

    it("handles already international numbers (+964..., 00964..., 964...)", () => {
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647809876543")).toBe("+9647809876543");
      expect(toIraqiIntl("009647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("9647501112233")).toBe("+9647501112233");
    });

    it("handles standard Iraqi local mobile numbers (07X... and 7X...)", () => {
      // 11 digits starting with 07
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("07801234567")).toBe("+9647801234567");
      expect(toIraqiIntl("07501234567")).toBe("+9647501234567");
      expect(toIraqiIntl("07901234567")).toBe("+9647901234567");
      // 10 digits starting with 7
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("7801234567")).toBe("+9647801234567");
      expect(toIraqiIntl("7501234567")).toBe("+9647501234567");
    });

    it("handles punctuation, spaces, dashes, and parentheses gracefully", () => {
      expect(toIraqiIntl("0770 123 4567")).toBe("+9647701234567");
      expect(toIraqiIntl("0780-123-4567")).toBe("+9647801234567");
      expect(toIraqiIntl("(0750) 123 4567")).toBe("+9647501234567");
      expect(toIraqiIntl(" +964-770-123-4567 ")).toBe("+9647701234567");
    });

    it("returns null safely for invalid length, non-numeric strings, or malformed numbers", () => {
      expect(toIraqiIntl("123")).toBeNull();
      expect(toIraqiIntl("077012")).toBeNull(); // too short
      expect(toIraqiIntl("07701234567890123456")).toBeNull(); // overly long
      expect(toIraqiIntl("not-a-number")).toBeNull();
      expect(toIraqiIntl("01234567890")).toBeNull(); // not Iraqi mobile prefix
      expect(toIraqiIntl("0661234567")).toBeNull(); // invalid prefix
    });

    it("WaBroadcasts.tsx export buildWhatsAppUrl handles all phone edge cases without throwing", () => {
      // Valid phone
      const url1 = buildWhatsAppUrl("07701234567", "رسالة ترحيبية");
      expect(url1).toBe("https://wa.me/9647701234567?text=%D8%B1%D8%B3%D8%A7%D9%84%D8%A9%20%D8%AA%D8%B1%D8%AD%D9%8A%D8%A8%D9%8A%D8%A9");

      // Null phone (fallback to text-only wa.me link)
      const url2 = buildWhatsAppUrl(null, "رسالة عامة");
      expect(url2).toBe("https://wa.me/?text=%D8%B1%D8%B3%D8%A7%D9%84%D8%A9%20%D8%B9%D8%A7%D9%85%D8%A9");

      // Empty string phone
      const url3 = buildWhatsAppUrl("", "رسالة");
      expect(url3).toBe("https://wa.me/?text=%D8%B1%D8%B3%D8%A7%D9%84%D8%A9");

      // Undefined phone
      const url4 = buildWhatsAppUrl(undefined, "رسالة");
      expect(url4).toBe("https://wa.me/?text=%D8%B1%D8%B3%D8%A7%D9%84%D8%A9");

      // Invalid phone
      const url5 = buildWhatsAppUrl("12345", "رسالة");
      expect(url5).toBe("https://wa.me/?text=%D8%B1%D8%B3%D8%A7%D9%84%D8%A9");

      // Emojis in message stripped automatically
      const url6 = buildWhatsAppUrl("07701234567", "عرض خاص 🎁 لا تفوّت 🌟");
      expect(decodeURIComponent(url6)).not.toContain("🎁");
      expect(decodeURIComponent(url6)).not.toContain("🌟");
      expect(decodeURIComponent(url6)).toContain("عرض خاص لا تفوّت");
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. 80MM THERMAL RECEIPT PRINTING ROBUSTNESS
   * ═══════════════════════════════════════════════════════════════════════ */
  describe("2. 80mm Thermal Gift Voucher Print Robustness", () => {
    it("generates a valid PrintDoc with full standard parameters", () => {
      const doc = giftVoucherToPrintDoc({
        code: "GIFT-100",
        amount: 25000,
        customerName: "شركة الرافدين للتجارة",
        customerPhone: "07701234567",
        reason: "ترضية تأخير طباعة",
        validUntil: "2026-12-31",
        terms: "تُخصم لمرة واحدة على أي فاتورة",
      });

      expect(doc.kind).toBe("receipt");
      expect(doc.title).toBe("قسيمة هدية وترضية");
      expect(doc.subtitle).toBe("المكتبة العربية للطباعة والقرطاسية");
      expect(doc.meta).toContain("رمز الكوبون: GIFT-100");
      expect(doc.meta).toContain("الزبون: شركة الرافدين للتجارة");
      expect(doc.meta).toContain("الهاتف: 07701234567");
      expect(doc.meta).toContain("نوع الإهداء: ترضية تأخير طباعة");
      expect(doc.meta).toContain("صالحة لغاية: 2026-12-31");
      expect(doc.footer).toBe("تُخصم لمرة واحدة على أي فاتورة");
      expect(doc.totals[0].value).toContain("25,000 د.ع");
    });

    it("falls back gracefully when optional fields are missing", () => {
      const doc = giftVoucherToPrintDoc({
        amount: 15000,
        customerName: "زبون مكرّم",
      });

      // Default code fallback
      expect(doc.meta).toContain("رمز الكوبون: GIFT");
      expect(doc.meta).toContain("الزبون: زبون مكرّم");
      // Optional fields should NOT produce 'undefined' entries
      expect(doc.meta.some((m) => m.includes("undefined"))).toBe(false);
      // Footer fallback
      expect(doc.footer).toContain("تُستخدم القسيمة لمرة واحدة عند المحاسبة");
    });

    it("handles zero, null, or undefined amounts without crashing", () => {
      // 0 amount
      const docZero = giftVoucherToPrintDoc({
        amount: 0,
        customerName: "زبون مكرّم",
      });
      expect(docZero.totals[0].value).toBe("0 د.ع");

      // null amount (treated as "—")
      const docNull = giftVoucherToPrintDoc({
        amount: null as any,
        customerName: "زبون مكرّم",
      });
      expect(docNull.totals[0].value).toBe("— د.ع");

      // empty string amount (treated as "—")
      const docEmpty = giftVoucherToPrintDoc({
        amount: "",
        customerName: "زبون مكرّم",
      });
      expect(docEmpty.totals[0].value).toBe("— د.ع");
    });

    it("evaluates percentage amounts ('10٪' vs numeric amounts) in gift voucher printing", () => {
      // Robust percentage handling: giftVoucherToPrintDoc handles percentage discounts gracefully without throwing DecimalError
      let threw = false;
      let doc: any = null;
      try {
        doc = giftVoucherToPrintDoc({
          amount: "15٪",
          customerName: "زبون مكرّم",
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(doc).not.toBeNull();
      expect(doc.totals[0].label).toBe("نسبة الخصم");
      expect(doc.totals[0].value).toBe("15٪");
      expect(doc.totals[0].value).not.toContain("د.ع");
    });

    it("empirically verifies boundary inputs: Arabic percent, ASCII percent, negative, zero-discount, and explicit discountPercent", () => {
      // 1. String with Arabic percent: '15٪'
      const docArb = giftVoucherToPrintDoc({ amount: "15٪", customerName: "زبون" });
      expect(docArb.totals[0].label).toBe("نسبة الخصم");
      expect(docArb.totals[0].value).toBe("15٪");
      expect(docArb.itemBlocks?.[0].total).toBe("15٪");
      expect(docArb.totals[0].value).not.toContain("د.ع");

      // 2. String with ASCII percent: '20%'
      const docAsc = giftVoucherToPrintDoc({ amount: "20%", customerName: "زبون" });
      expect(docAsc.totals[0].label).toBe("نسبة الخصم");
      expect(docAsc.totals[0].value).toBe("20%");
      expect(docAsc.totals[0].value).not.toContain("د.ع");

      // 3. Pure numeric amount: 50000
      const docNum = giftVoucherToPrintDoc({ amount: 50000, customerName: "زبون" });
      expect(docNum.totals[0].label).toBe("قيمة القسيمة");
      expect(docNum.totals[0].value).toBe("50,000 د.ع");
      expect(docNum.itemBlocks?.[0].name).toBe("رصيد هدية معتمد في المطبعة والقرطاسية");

      // 4. Negative amount: -100
      const docNeg = giftVoucherToPrintDoc({ amount: -100, customerName: "زبون" });
      expect(docNeg.totals[0].label).toBe("قيمة القسيمة");
      expect(docNeg.totals[0].value).toContain("-100 د.ع");

      // 5. Null / undefined / empty string amounts
      const docUndef = giftVoucherToPrintDoc({ amount: undefined as any, customerName: "زبون" });
      expect(docUndef.totals[0].value).toBe("— د.ع");

      // 6. Amount = 0 with reason containing "خصم 25٪"
      const docZeroDiscount = giftVoucherToPrintDoc({
        amount: 0,
        reason: "ترضية زبون (خصم 25٪)",
        customerName: "زبون",
      });
      expect(docZeroDiscount.totals[0].label).toBe("نسبة الخصم");
      expect(docZeroDiscount.totals[0].value).toBe("25٪");
      expect(docZeroDiscount.totals[0].value).not.toContain("د.ع");

      // 7. Amount = 0 without discount (handles gracefully as 0 د.ع)
      const docZeroPlain = giftVoucherToPrintDoc({
        amount: 0,
        reason: "هدية عامة",
        customerName: "زبون",
      });
      expect(docZeroPlain.totals[0].label).toBe("قيمة القسيمة");
      expect(docZeroPlain.totals[0].value).toBe("0 د.ع");

      // 8. Explicit discountPercent passed as number
      const docExplicitNum = giftVoucherToPrintDoc({
        amount: 0,
        discountPercent: 10,
        customerName: "زبون",
      });
      expect(docExplicitNum.totals[0].label).toBe("نسبة الخصم");
      expect(docExplicitNum.totals[0].value).toBe("10%");

      // 9. Explicit discountPercent passed as string with ٪
      const docExplicitArb = giftVoucherToPrintDoc({
        amount: 0,
        discountPercent: "30٪",
        customerName: "زبون",
      });
      expect(docExplicitArb.totals[0].label).toBe("نسبة الخصم");
      expect(docExplicitArb.totals[0].value).toBe("30٪");

      // 10. Amount = 0 with terms containing percentage
      const docTerms = giftVoucherToPrintDoc({
        amount: 0,
        terms: "خصم 15% على كل المطبوعات",
        customerName: "زبون",
      });
      expect(docTerms.totals[0].label).toBe("نسبة الخصم");
      expect(docTerms.totals[0].value).toBe("15%");

      // 11. Malformed non-numeric string amount falls back gracefully without crashing
      const docMalformed = giftVoucherToPrintDoc({
        amount: "invalid_text",
        customerName: "زبون",
      });
      expect(docMalformed.totals[0].label).toBe("قيمة القسيمة");
      expect(docMalformed.totals[0].value).toBe("invalid_text د.ع");

      // 12. Floating point amount
      const docFloat = giftVoucherToPrintDoc({
        amount: 12500.5,
        customerName: "زبون",
      });
      expect(docFloat.totals[0].value).toBe("12,500.5 د.ع");
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. CUSTOMER 360 PROFILE DRAWER INTEGRATION
   * ═══════════════════════════════════════════════════════════════════════ */
  describe("3. Customer 360 Profile Drawer Integration in Coupons.tsx", () => {
    it("Coupons.tsx properly types dossierCustomerId as number | null", () => {
      const content = fs.readFileSync(COUPONS_PATH, "utf-8");
      expect(content).toContain("const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);");
      expect(content).toContain("<CustomerDossierDrawer");
      expect(content).toContain("customerId={dossierCustomerId}");
      expect(content).toContain("open={dossierCustomerId != null}");
      expect(content).toContain("onClose={() => setDossierCustomerId(null)}");
    });

    it("Coupons.tsx guards row customer actions: only non-null customerId triggers the drawer", () => {
      const content = fs.readFileSync(COUPONS_PATH, "utf-8");
      // Check customer cell rendering in issuedColumns:
      // If custId is null/undefined -> renders 'عام' (general), doesn't invoke drawer
      expect(content).toContain("const custId = row.original.customerId;");
      expect(content).toContain('if (!custId) return <span className="text-muted-foreground">عام</span>;');
      expect(content).toContain("onClick={() => setDossierCustomerId(custId)}");
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 4. EXPORT LOGIC ON EMPTY TABLES
   * ═══════════════════════════════════════════════════════════════════════ */
  describe("4. Export Logic Empty Table Resiliency", () => {
    beforeEach(() => {
      // Mock client browser environment for export sink
      const mockAnchor = {
        href: "",
        download: "",
        click: vi.fn(),
      };
      (globalThis as any).window = {
        showSaveFilePicker: undefined, // fallback to anchor download
      };
      (globalThis as any).document = {
        createElement: vi.fn(() => mockAnchor),
      };
      (globalThis as any).URL = {
        createObjectURL: vi.fn(() => "blob:mock-url"),
        revokeObjectURL: vi.fn(),
      };
    });

    afterEach(() => {
      delete (globalThis as any).window;
      delete (globalThis as any).document;
      delete (globalThis as any).URL;
    });

    it("exportRows does not throw on empty array for CSV export", async () => {
      const dummyColumns = [
        { key: "id", header: "المعرف" },
        { key: "name", header: "الاسم" },
      ];

      expect(() => {
        exportRows([], {
          filename: "test-empty-table",
          format: "csv",
          title: "جدول فارغ",
          columns: dummyColumns,
        });
      }).not.toThrow();
    });

    it("exportRows does not throw on empty array for Excel export", async () => {
      const dummyColumns = [
        { key: "id", header: "المعرف" },
        { key: "name", header: "الاسم" },
      ];

      expect(() => {
        exportRows([], {
          filename: "test-empty-table",
          format: "xlsx",
          title: "جدول فارغ",
          columns: dummyColumns,
        });
      }).not.toThrow();
    });

    it("exportSheets does not throw on empty sheet specifications", async () => {
      expect(() => {
        exportSheets("test-empty-workbook", []);
      }).not.toThrow();

      expect(() => {
        exportSheets("test-empty-sheet", [
          {
            sheetName: "ورقة فارغة",
            title: "ورقة بلا بيانات",
            columns: [{ key: "col1", header: "العمود الأول" }],
            rows: [],
          },
        ]);
      }).not.toThrow();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
   * 5. CODE GOVERNANCE & GUARD CONFORMANCE ACROSS M4 PAGES
   * ═══════════════════════════════════════════════════════════════════════ */
  describe("5. Repository Governance & Guard Verification", () => {
    it("All 4 pages use exact approved Arabic PageHeader titles", () => {
      for (const p of PAGES) {
        const content = fs.readFileSync(p.path, "utf-8");
        expect(content).toContain(`title="${p.title}"`);
      }
    });

    it("All 4 pages contain ZERO emojis in UI code", () => {
      const emojiRegex =
        /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{25B0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;

      for (const p of PAGES) {
        const content = fs.readFileSync(p.path, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
          expect(emojiRegex.test(line)).toBe(false);
        }
      }
    });

    it("All 4 pages contain ZERO raw HTML table elements (DataTable used exclusively)", () => {
      for (const p of PAGES) {
        const content = fs.readFileSync(p.path, "utf-8");
        expect(content).not.toMatch(/<table[\s>]/i);
        expect(content).not.toMatch(/<thead[\s>]/i);
        expect(content).not.toMatch(/<tbody[\s>]/i);
        expect(content).not.toMatch(/<th[\s>]/i);
      }
    });

    it("All 4 pages contain ZERO native window.confirm or window.alert calls", () => {
      for (const p of PAGES) {
        const content = fs.readFileSync(p.path, "utf-8");
        expect(content).not.toContain("window.confirm");
        expect(content).not.toContain("window.alert");
      }
    });

    it("All 4 pages contain ZERO window.print calls", () => {
      for (const p of PAGES) {
        const content = fs.readFileSync(p.path, "utf-8");
        expect(content).not.toContain("window.print");
      }
    });

    it("All 4 pages contain Excel & CSV export support", () => {
      for (const p of PAGES) {
        const content = fs.readFileSync(p.path, "utf-8");
        expect(content).toMatch(/exportRows|exportSheets/);
        expect(content).toMatch(/Excel/i);
        expect(content).toMatch(/CSV/i);
      }
    });
  });
});

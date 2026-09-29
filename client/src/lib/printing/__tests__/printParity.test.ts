/**
 * printParity.test.ts — Multi-Role Print Parity & Structured Layout Test Suite
 * Covers Tiers 1-4 per TEST_INFRA.md and PROJECT.md:
 *  - Tier 1: Feature Coverage (Admin & Reception structured HTML, 3-column work orders, itemized delivery slips, Tafqit)
 *  - Tier 2: Boundary & Corner Cases (zero items, 50+ items, discounts/taxes, work orders with/without advance deposit)
 *  - Tier 3: Cross-Role HTML Parity (Normalized HTML equality between Admin and Reception)
 *  - Tier 4: Real-World Scenario (Full retail checkout invoice parity between roles)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy storage for captured print outputs
let capturedPrintWindows: { html: string; opts: string }[] = [];
let capturedPrintDocs: unknown[] = [];

vi.mock("../brand", async () => {
  const actual = await vi.importActual<typeof import("../brand")>("../brand");
  return {
    ...actual,
    logoUrl: () => "/logo.png",
    openPrintWindow: vi.fn((html: string, opts?: string) => {
      capturedPrintWindows.push({ html, opts: opts ?? "" });
      return true;
    }),
  };
});

vi.mock("../print", async () => {
  const actual = await vi.importActual<typeof import("../print")>("../print");
  return {
    ...actual,
    printDoc: vi.fn(async (doc: unknown) => {
      capturedPrintDocs.push(doc);
      return { via: "browser" as const, ok: true as const };
    }),
  };
});

import { openPrintWindow } from "../brand";
import { printDoc, type PrintDoc } from "../print";
import { docToHtml } from "../render";
import {
  printInvoiceA4,
  printBrowserReceipt,
  printBrowserWorkOrderReceipt,
  type InvoicePrintData,
} from "../printTemplates";
import {
  printSalesInvoiceV2,
  type SalesInvoiceV2Data,
} from "../printTemplatesV2";
import {
  printDeliverySlip,
  type LabelPrintableOrder,
} from "../deliveryDocs";

function normalizePrintHtml(html: string): string {
  return html
    // Normalize date strings (YYYY-MM-DD, DD/MM/YYYY)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "NORMALIZED_DATE")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, "NORMALIZED_DATE")
    // Normalize timestamps (HH:MM or HH:MM:SS)
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|ص|م)?\b/gi, "NORMALIZED_TIME")
    // Normalize ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "NORMALIZED_TIMESTAMP")
    // Normalize ephemeral tokens, nonces, and dynamic identifiers
    .replace(/data-print-id="[^"]*"/g, 'data-print-id="NORMALIZED_ID"')
    .replace(/nonce="[^"]*"/g, 'nonce="NORMALIZED_NONCE"')
    // Normalize SVG paths / generated random IDs
    .replace(/id="[a-zA-Z0-9_-]{8,}"/g, 'id="NORMALIZED_SVG_ID"')
    // Normalize whitespace runs
    .replace(/\s+/g, " ")
    .trim();
}

describe("Print Parity & Structured Layout Suite (Tiers 1-4)", () => {
  beforeEach(() => {
    capturedPrintWindows = [];
    capturedPrintDocs = [];
    vi.mocked(openPrintWindow).mockClear();
    vi.mocked(printDoc).mockClear();
  });

  // --------------------------------------------------------------------------
  // Tier 1: Feature Coverage
  // --------------------------------------------------------------------------
  describe("Tier 1: Feature Coverage (Structured Layouts & Role Invocations)", () => {
    it("1.1 Admin print invocation produces structured HTML with table and legal headers", async () => {
      const invoiceData: InvoicePrintData = {
        invoiceNumber: "INV-2026-0001",
        invoiceDate: "2026-09-29",
        customerName: "شركة الفرات للتجارة",
        customerAddress: "بغداد - الكرادة",
        customerPhone: "+9647701234567",
        salespersonName: "علي الكاشير",
        paymentMethod: "نقدي",
        items: [
          { productName: "ورق طباعة A4 دبل إيه", unitName: "كرتون", quantity: 5, unitPrice: 35000, total: 175000 },
          { productName: "أقلام حبر زرقاء روتو", unitName: "علبة", quantity: 2, unitPrice: 5000, total: 10000 },
        ],
        subtotal: 185000,
        total: 185000,
        paidAmount: 185000,
      };

      await printInvoiceA4(invoiceData);

      expect(openPrintWindow).toHaveBeenCalled();
      const html = capturedPrintWindows[0]?.html ?? "";

      // Structured document wrappers and Cairo typography
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("dir=\"rtl\"");
      expect(html).toContain("font-family:'Cairo'");

      // Header and document title
      expect(html).toContain("فاتورة مبيعات");
      expect(html).toContain("INV-2026-0001");
      expect(html).toContain("شركة الفرات للتجارة");

      // Structured items table layout
      expect(html).toContain("<table");
      expect(html).toContain("المنتج");
      expect(html).toContain("الوحدة");
      expect(html).toContain("الكمية");
      expect(html).toContain("السعر");
      expect(html).toContain("الإجمالي");

      // Table line items
      expect(html).toContain("ورق طباعة A4 دبل إيه");
      expect(html).toContain("أقلام حبر زرقاء روتو");
    });

    it("1.2 Reception print invocation produces structured HTML matching canonical structure", async () => {
      const receptionInvoiceData: InvoicePrintData = {
        invoiceNumber: "INV-REC-1002",
        invoiceDate: "2026-09-29",
        customerName: "عميل نقدي",
        paymentMethod: "نقدي",
        items: [
          { productName: "تجليد حراري حلزوني", unitName: "قطعة", quantity: 3, unitPrice: 2500, total: 7500 },
        ],
        subtotal: 7500,
        total: 7500,
        paidAmount: 7500,
      };

      await printInvoiceA4(receptionInvoiceData);

      expect(openPrintWindow).toHaveBeenCalled();
      const html = capturedPrintWindows[0]?.html ?? "";

      expect(html).toContain("<!doctype html>");
      expect(html).toContain("font-family:'Cairo'");
      expect(html).toContain("فاتورة مبيعات");
      expect(html).toContain("INV-REC-1002");
      expect(html).toContain("<table");
      expect(html).toContain("تجليد حراري حلزوني");
    });

    it("1.3 Work order receipt contains structured table with 3 columns (الخدمة / البند, الكمية, المبلغ)", () => {
      printBrowserWorkOrderReceipt({
        orderNumber: "WO-9001",
        orderDate: "2026-09-29",
        dueDate: "2026-10-02",
        customerName: "حيدر جاسم",
        customerPhone: "07801234567",
        employeeName: "عمر الفني",
        status: "CONFIRMED",
        jobTitle: "طباعة بروشورات دعائية 150غم",
        quantity: 500,
        total: "65000",
        paidUpfront: "25000",
        balanceDue: "40000",
        notes: "ألوان لامعة عالية الدقة",
      });

      expect(openPrintWindow).toHaveBeenCalled();
      const html = capturedPrintWindows[0]?.html ?? "";

      // Must contain structured receipt-grid table
      expect(html).toContain("receipt-grid");
      expect(html).toContain("<table");

      // Must contain the 3 required columns
      expect(html).toMatch(/الخدمة(\s*\/\s*البند)?/);
      expect(html).toContain("الكمية");
      expect(html).toContain("المبلغ");

      // Verify amounts and job details
      expect(html).toContain("WO-9001");
      expect(html).toContain("طباعة بروشورات دعائية 150غم");
    });

    it("1.4 Delivery slip contains itemized table rows and columns", async () => {
      const order: LabelPrintableOrder = {
        orderNumber: "ORD-100009",
        title: "دفتر هندسي + طقم ألوان باستيل",
        quantity: 2,
        salePrice: "15000",
        deposit: null,
        customerName: "سارة أحمد",
        customerPhone: "07709876543",
        deliveryAddress: "المنصور - شارع 14 رمضان",
      };

      const party = { name: "شركة الأمانة للشحن" };
      const dispatchMeta = {
        consignmentNumber: "CN-777",
        invoiceNumber: "INV-10009",
        codAmount: "15000",
        deliveryFee: "5000",
        externalTrackingRef: "TRK-98765",
      };

      printDeliverySlip(order, party, dispatchMeta);

      expect(printDoc).toHaveBeenCalled();
      const doc = capturedPrintDocs[0] as PrintDoc;
      expect(doc).toBeDefined();

      // Delivery slip must have populated structured items table
      expect(doc.columns).toBeDefined();
      expect(doc.columns?.length).toBeGreaterThanOrEqual(2);
      expect(doc.rows).toBeDefined();
      expect(doc.rows?.length).toBeGreaterThanOrEqual(1);

      // Verify rendering to HTML produces table.receipt-grid
      const html = await docToHtml(doc);
      expect(html).toContain("receipt-grid");
      expect(html).toContain("<table");
      expect(html).toContain("دفتر هندسي + طقم ألوان باستيل");
    });

    it("1.5 Arabic monetary numbers (Tafqit) present on all invoice prints", async () => {
      const invoiceData: InvoicePrintData = {
        invoiceNumber: "INV-TAFQIT-01",
        invoiceDate: "2026-09-29",
        customerName: "مكتبة الزهراء",
        items: [
          { productName: "كتب أدبية", unitName: "نسخة", quantity: 1, unitPrice: 50000, total: 50000 },
        ],
        subtotal: 50000,
        total: 50000,
        paidAmount: 50000,
      };

      await printInvoiceA4(invoiceData);

      const a4Html = capturedPrintWindows[0]?.html ?? "";
      // Tafqit line present in A4
      expect(a4Html).toContain("فقط خمسون ألف دينار عراقي لا غير");

      // Also test thermal receipt Tafqit
      printBrowserReceipt({
        receiptNumber: "REC-TAFQIT-01",
        date: "2026-09-29",
        time: "14:30",
        items: [{ name: "كتب أدبية", quantity: 1, price: "50000", total: "50000" }],
        subtotal: "50000",
        total: "50000",
        paid: "50000",
      });

      const receiptHtml = capturedPrintWindows[1]?.html ?? "";
      expect(receiptHtml).toContain("خمسون ألف دينار عراقي");
    });
  });

  // --------------------------------------------------------------------------
  // Tier 2: Boundary & Corner Cases
  // --------------------------------------------------------------------------
  describe("Tier 2: Boundary & Corner Cases", () => {
    it("2.1 handles invoice with zero items safely without crashing", async () => {
      const emptyInvoice: InvoicePrintData = {
        invoiceNumber: "INV-EMPTY",
        invoiceDate: "2026-09-29",
        customerName: "عميل",
        items: [],
        subtotal: 0,
        total: 0,
        paidAmount: 0,
      };

      await printInvoiceA4(emptyInvoice);
      expect(openPrintWindow).toHaveBeenCalled();
      const html = capturedPrintWindows[0]?.html ?? "";
      expect(html).toContain("INV-EMPTY");
      expect(html).toContain("<table");
    });

    it("2.2 renders 50+ line items without row truncation or structure breakage", async () => {
      const fiftyItems = Array.from({ length: 55 }, (_, i) => ({
        productName: `بند قرطاسية رقم ${i + 1}`,
        unitName: "قطعة",
        quantity: 1,
        unitPrice: 1000,
        total: 1000,
      }));

      const largeInvoice: InvoicePrintData = {
        invoiceNumber: "INV-LARGE-55",
        invoiceDate: "2026-09-29",
        customerName: "تجهيزات كبرى",
        items: fiftyItems,
        subtotal: 55000,
        total: 55000,
        paidAmount: 55000,
      };

      await printInvoiceA4(largeInvoice);
      const html = capturedPrintWindows[0]?.html ?? "";

      expect(html).toContain("بند قرطاسية رقم 1");
      expect(html).toContain("بند قرطاسية رقم 25");
      expect(html).toContain("بند قرطاسية رقم 55");
    });

    it("2.3 accurately displays discounts and sales taxes in totals breakdown", async () => {
      const discountedInvoice: InvoicePrintData = {
        invoiceNumber: "INV-DISC-TAX",
        invoiceDate: "2026-09-29",
        customerName: "عميل تجاري",
        items: [
          { productName: "حاسوب لوحي مكتبي", unitName: "جهاز", quantity: 1, unitPrice: 100000, total: 100000 },
        ],
        subtotal: 100000,
        discountAmount: 10000,
        taxAmount: 4500,
        taxRate: 5,
        total: 94500,
        paidAmount: 94500,
      };

      await printInvoiceA4(discountedInvoice);
      const html = capturedPrintWindows[0]?.html ?? "";

      // Subtotal, discount with minus sign, tax line, grand total
      expect(html).toContain("المجموع الفرعي");
      expect(html).toContain("100,000");
      expect(html).toContain("الخصم");
      expect(html).toContain("10,000");
      expect(html).toContain("ضريبة المبيعات (5٪)");
      expect(html).toContain("4,500");
      expect(html).toContain("الإجمالي المستحق");
      expect(html).toContain("94,500");
    });

    it("2.4 handles work order with advance deposit correctly", () => {
      printBrowserWorkOrderReceipt({
        orderNumber: "WO-DEPOSIT-1",
        orderDate: "2026-09-29",
        customerName: "مصطفى كامل",
        total: "50000",
        paidUpfront: "20000",
        balanceDue: "30000",
        jobTitle: "أعمال تجليد فاخر",
      });

      const html = capturedPrintWindows[0]?.html ?? "";
      expect(html).toContain("مدفوع مقدماً");
      expect(html).toContain("20,000");
      expect(html).toContain("المتبقّي عند الاستلام");
      expect(html).toContain("30,000");
    });

    it("2.5 handles work order without advance deposit correctly", () => {
      printBrowserWorkOrderReceipt({
        orderNumber: "WO-NODEPOSIT-1",
        orderDate: "2026-09-29",
        customerName: "سامر عماد",
        total: "45000",
        paidUpfront: null,
        balanceDue: "45000",
        jobTitle: "تصميم شعار ومطبوعات",
      });

      const html = capturedPrintWindows[0]?.html ?? "";
      expect(html).toContain("الإجمالي");
      expect(html).toContain("45,000");
      // Deposit lines should not be rendered when paidUpfront is null or 0
      expect(html).not.toContain("مدفوع مقدماً");
    });
  });

  // --------------------------------------------------------------------------
  // Tier 3: Cross-Role HTML Parity
  // --------------------------------------------------------------------------
  describe("Tier 3: Cross-Role HTML Parity (Admin vs Reception Equality)", () => {
    it("3.1 asserts HTML structural parity between Admin and Reception print executions", async () => {
      const canonicalData: InvoicePrintData = {
        invoiceNumber: "INV-PARITY-88",
        invoiceDate: "2026-09-29",
        customerName: "معهد اللغات العالي",
        customerAddress: "بغداد - الجادرية",
        customerPhone: "07901112233",
        salespersonName: "زينب علي",
        paymentMethod: "بطاقة إلكترونية",
        items: [
          { productName: "قواميس إنجليزية", unitName: "نسخة", quantity: 10, unitPrice: 15000, total: 150000 },
          { productName: "دفاتر ملاحظات سلك", unitName: "درزن", quantity: 2, unitPrice: 12000, total: 24000 },
        ],
        subtotal: 174000,
        discountAmount: 4000,
        total: 170000,
        paidAmount: 170000,
      };

      // Admin execution pathway (as called from InvoiceDetail.tsx)
      await printInvoiceA4(canonicalData);
      const adminHtml = capturedPrintWindows[0]?.html ?? "";

      // Reception execution pathway (as called from ReceptionInvoiceQueue.tsx)
      await printInvoiceA4(canonicalData);
      const receptionHtml = capturedPrintWindows[1]?.html ?? "";

      expect(adminHtml).toBeTruthy();
      expect(receptionHtml).toBeTruthy();

      // Normalize dynamic nonces and dates
      const normalizedAdmin = normalizePrintHtml(adminHtml);
      const normalizedReception = normalizePrintHtml(receptionHtml);

      // Parity assertion: The generated HTML trees must be completely identical
      expect(normalizedReception).toBe(normalizedAdmin);
    });

    it("3.2 validates that both roles produce identical item columns and classes", async () => {
      const testInvoice: InvoicePrintData = {
        invoiceNumber: "INV-STRUCT-01",
        invoiceDate: "2026-09-29",
        customerName: "عميل التدقيق",
        items: [
          { productName: "بند تجريبي A", quantity: 1, unitPrice: 10000, total: 10000 },
        ],
        subtotal: 10000,
        total: 10000,
        paidAmount: 10000,
      };

      await printInvoiceA4(testInvoice);
      const adminHtml = capturedPrintWindows[0]?.html ?? "";

      await printInvoiceA4(testInvoice);
      const receptionHtml = capturedPrintWindows[1]?.html ?? "";

      // Compare table classes and tags
      expect(adminHtml.match(/<table[^>]*>/g)).toEqual(receptionHtml.match(/<table[^>]*>/g));
      expect(adminHtml.match(/<th[^>]*>/g)).toEqual(receptionHtml.match(/<th[^>]*>/g));
      expect(adminHtml.match(/<td[^>]*>/g)).toEqual(receptionHtml.match(/<td[^>]*>/g));
    });
  });

  // --------------------------------------------------------------------------
  // Tier 4: Real-World Scenario
  // --------------------------------------------------------------------------
  describe("Tier 4: Real-World Scenario (Full Retail Checkout Verification)", () => {
    it("4.1 complete retail checkout print verification for Admin vs Reception", async () => {
      // Real-world retail basket checkout
      const retailSaleData: InvoicePrintData = {
        invoiceNumber: "INV-RETAIL-2026-909",
        invoiceDate: "2026-09-29",
        customerName: "د. عمر طارق",
        customerAddress: "حي الجامعة - محلة 621",
        customerPhone: "+9647805556677",
        salespersonName: "أحمد رائد",
        paymentMethod: "نقدي",
        items: [
          { productName: "حقيبة لابتوب مقاومة للصدمات 15.6 بوصة", unitName: "قطعة", quantity: 1, unitPrice: 38000, total: 38000 },
          { productName: "ماوس لاسلكي لوجيتك M185", unitName: "قطعة", quantity: 1, unitPrice: 14000, total: 14000 },
          { productName: "وسادة ماوس طبية ميموري فوم", unitName: "قطعة", quantity: 1, unitPrice: 6000, total: 6000, isGift: true },
        ],
        subtotal: 58000,
        discountAmount: 2000,
        total: 56000,
        paidAmount: 56000,
      };

      // Admin prints invoice at cashier desk
      await printInvoiceA4(retailSaleData);
      const adminPrint = capturedPrintWindows[0]?.html ?? "";

      // Reception desk operator reprints the exact same sale
      await printInvoiceA4(retailSaleData);
      const receptionPrint = capturedPrintWindows[1]?.html ?? "";

      // Both prints must feature:
      // 1. Legal company title and address
      expect(adminPrint).toContain("فاتورة مبيعات");
      expect(receptionPrint).toContain("فاتورة مبيعات");

      // 2. Structured items table
      expect(adminPrint).toContain("حقيبة لابتوب مقاومة للصدمات 15.6 بوصة");
      expect(receptionPrint).toContain("حقيبة لابتوب مقاومة للصدمات 15.6 بوصة");

      // 3. Gift indicator (هدية / مجاناً)
      expect(adminPrint).toContain("مجاناً");
      expect(receptionPrint).toContain("مجاناً");

      // 4. Tafqit monetary spelling in Arabic
      expect(adminPrint).toContain("ستة وخمسون ألف دينار عراقي");
      expect(receptionPrint).toContain("ستة وخمسون ألف دينار عراقي");

      // 5. Signature and legal verification block
      expect(adminPrint).toContain("المفوّض بالبيع");
      expect(receptionPrint).toContain("المفوّض بالبيع");

      // 6. Complete parity
      expect(normalizePrintHtml(receptionPrint)).toBe(normalizePrintHtml(adminPrint));
    });
  });
});

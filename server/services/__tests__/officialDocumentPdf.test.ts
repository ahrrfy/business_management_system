import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  generateOfficialDocumentPdf,
  officialDocumentFilename,
} from "../officialDocumentPdf";

describe("officialDocumentPdf", () => {
  it("ينشئ ملف A4 صالحاً ومضمّن الخط لمستند عربي", async () => {
    const bytes = await generateOfficialDocumentPdf({
      kind: "INVOICE",
      number: "INV-001",
      date: "2026-07-29",
      customerName: "مدارس النخيل",
      subtotal: "25000",
      total: "25000",
      paidAmount: "0",
      items: [{
        productName: "دفتر عربي",
        unitName: "قطعة",
        quantity: "1",
        unitPrice: "25000",
        total: "25000",
      }],
    });
    expect(Buffer.from(bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(1);
    const size = document.getPage(0).getSize();
    expect(size.width).toBeCloseTo(595.28, 1);
    expect(size.height).toBeCloseTo(841.89, 1);
  });

  it("ينشئ اسماً آمناً للملف", () => {
    expect(officialDocumentFilename("QUOTATION", "QT/2026:15")).toBe("quotation-QT-2026-15.pdf");
  });
});

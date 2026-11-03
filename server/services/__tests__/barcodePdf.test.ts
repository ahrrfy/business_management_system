import { describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import { calculateBarcodeBars } from "@shared/barcodeEncoding";
import {
  buildBarcodePdfFilename,
  generateBarcodePdf,
  generateBarcodeBatchPdf,
} from "../barcodePdfService";

describe("server/services/barcodePdfService", () => {
  describe("buildBarcodePdfFilename", () => {
    it("يبني اسم ملف تلقائي نظيف يحتوي اسم المنتج والباركود", () => {
      const filename = buildBarcodePdfFilename({
        productName: "دفتر ملاحظات سلك A4 فاخر",
        unitName: "قطعة",
        barcode: "2001234567893",
      });
      expect(filename).toBe("دفتر ملاحظات سلك A4 فاخر - 2001234567893.pdf");
    });

    it("يضيف اسم الوحدة إن كانت أكبر من الأساس (درزن / كرتون)", () => {
      const filename = buildBarcodePdfFilename({
        productName: "أقلام جاف أزرق",
        unitName: "درزن",
        barcode: "2009876543210",
      });
      expect(filename).toBe("أقلام جاف أزرق - درزن - 2009876543210.pdf");
    });

    it("يُنظف المحارف المحظورة في أسماء ملفات أنظمة التشغيل", () => {
      const filename = buildBarcodePdfFilename({
        productName: "ورق طباعة / A4: 80g * 500 ورقة?",
        unitName: "قطعة",
        barcode: "2001112223334",
      });
      expect(filename).not.toMatch(/[\/\\:*?"<>|]/);
      expect(filename.endsWith(".pdf")).toBe(true);
    });

    it("يعتمد الباركود عند غياب اسم المنتج", () => {
      const filename = buildBarcodePdfFilename({
        productName: "",
        unitName: "",
        barcode: "2005556667778",
      });
      expect(filename).toBe("باركود-2005556667778.pdf");
    });
  });

  describe("generateBarcodePdf", () => {
    it("يولّد ملف PDF متجهي حقيقي للمقاس القياسي 50x30 مم", async () => {
      const result = await generateBarcodePdf({
        barcode: "2001234567893",
        productName: "دفتر تجارب مدرسي A5",
        unitName: "قطعة",
        retailPrice: "1500",
        preset: "50x30",
      });

      expect(result.pdfBytes).toBeInstanceOf(Uint8Array);
      expect(result.base64.length).toBeGreaterThan(100);
      expect(result.filename).toContain("دفتر تجارب مدرسي A5");

      // التحقق من صلاحية وثيقة PDF وأبعاد الصفحة
      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(1);
      const page = doc.getPage(0);
      const { width, height } = page.getSize();
      // 50mm ≈ 141.73pt, 30mm ≈ 85.04pt
      expect(Math.round(width)).toBe(142);
      expect(Math.round(height)).toBe(85);
    });

    it("يولّد ملف PDF بنمط الرسم المتجهي الصافي artwork", async () => {
      const result = await generateBarcodePdf({
        barcode: "2001234567893",
        productName: "لوغو وباركود علبة",
        preset: "artwork",
      });

      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(1);
      const page = doc.getPage(0);
      expect(page.getHeight()).toBe(80);
    });

    it("يولّد ورقة A4 كاملة تضم شبكة من 24 ملصقاً", async () => {
      const result = await generateBarcodePdf({
        barcode: "2001234567893",
        productName: "منتج تصنيع عراقي",
        preset: "a4",
      });

      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(1);
      const page = doc.getPage(0);
      const { width, height } = page.getSize();
      // A4 = 595 x 842 pt
      expect(Math.round(width)).toBe(595);
      expect(Math.round(height)).toBe(842);
    });

    it("يرمي خطأ صريحاً عند تمرير باركود فارغ", async () => {
      await expect(generateBarcodePdf({ barcode: "" })).rejects.toThrow(
        "لا يوجد باركود لتوليد ملف PDF",
      );
    });

    it("يدعم المقاسات المخصصة بالأبعاد المليمترية widthMm و heightMm", async () => {
      const result = await generateBarcodePdf({
        barcode: "2001234567893",
        productName: "ملصق مقاس 40x25 مم",
        widthMm: 40,
        heightMm: 25,
      });

      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(1);
      const page = doc.getPage(0);
      const { width, height } = page.getSize();
      // 40mm ≈ 113.38pt, 25mm ≈ 70.86pt
      expect(Math.round(width)).toBe(113);
      expect(Math.round(height)).toBe(71);
    });

    it("يولّد ليبل 30×10مم بصفحة PDF مطابقة دون رفع الارتفاع إلى 15مم", async () => {
      const result = await generateBarcodePdf({
        barcode: "2001234567893",
        productName: "قلم جاف أزرق",
        retailPrice: "500",
        widthMm: 30,
        heightMm: 10,
      });

      const doc = await PDFDocument.load(result.pdfBytes);
      const page = doc.getPage(0);
      expect(Math.round(page.getWidth())).toBe(85);
      expect(Math.round(page.getHeight())).toBe(28);
    });

    it("كل الارتفاعات الصغيرة تطبع قضباناً فقط وبنسب ثابتة دون نصوص أو تضخيم انتقائي", async () => {
      const text = vi.spyOn(PDFPage.prototype, "drawText");
      const rect = vi.spyOn(PDFPage.prototype, "drawRectangle");
      const mmToPt = 72 / 25.4;
      try {
        for (const barcode of ["4006381333931", "ALR0000042"]) {
          for (const heightMm of [10, 11, 12, 13, 14, 14.9]) {
            text.mockClear();
            rect.mockClear();
            await generateBarcodePdf({
              barcode,
              productName: "قلم جاف أزرق",
              unitName: "درزن",
              brand: "علامة",
              sku: "رمز-١٢٣",
              retailPrice: "500",
              widthMm: 30,
              heightMm,
            });
            expect(text).not.toHaveBeenCalled();
            const bars = rect.mock.calls.slice(1).map(([r]) => r!);
            const encoded = calculateBarcodeBars(barcode);
            expect(bars).toHaveLength(encoded.bars.length);
            const modulePt = (barcode === "4006381333931" ? 0.25 : 0.125) * mmToPt;
            for (let i = 0; i < bars.length; i++) {
              expect(bars[i].height).toBeCloseTo((heightMm - 1) * mmToPt, 8);
              expect(bars[i].y).toBeCloseTo(0.5 * mmToPt, 8);
              expect(bars[i].width).toBeCloseTo(encoded.bars[i].width * modulePt, 8);
            }
            expect(bars[0].x).toBeGreaterThan(encoded.quietZoneLeft * modulePt);
            const last = bars[bars.length - 1];
            expect(30 * mmToPt - last.x! - last.width!).toBeGreaterThan(encoded.quietZoneRight * modulePt);
          }
        }
      } finally {
        text.mockRestore();
        rect.mockRestore();
      }
    });

    it("يولّد ليبل 30×10مم عندما يحتوي SKU على محارف عربية", async () => {
      const result = await generateBarcodePdf({
        barcode: "2001234567893",
        productName: "قلم جاف أزرق",
        sku: "رمز-١٢٣",
        retailPrice: "500",
        widthMm: 30,
        heightMm: 10,
      });

      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(1);
      expect(Math.round(doc.getPage(0).getHeight())).toBe(28);
    });
  });

  describe("generateBarcodeBatchPdf", () => {
    it("يولّد ملف PDF لدفعة ملصقات بنمط الصفحات الفردية (رول طابعة حرارية)", async () => {
      const result = await generateBarcodeBatchPdf({
        items: [
          { barcode: "2001112223334", productName: "منتج أ", count: 2 },
          { barcode: "2005556667778", productName: "منتج ب", count: 3 },
        ],
        layout: "individual_pages",
        widthMm: 50,
        heightMm: 30,
      });

      expect(result.totalLabels).toBe(5);
      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(5);
    });

    it("يحافظ على 30×10مم في كل صفحات دفعة الرول", async () => {
      const text = vi.spyOn(PDFPage.prototype, "drawText");
      try {
      const result = await generateBarcodeBatchPdf({
        items: [
          { barcode: "2001112223334", productName: "منتج صغير", count: 2 },
        ],
        layout: "individual_pages",
        widthMm: 30,
        heightMm: 10,
      });

      const doc = await PDFDocument.load(result.pdfBytes);
      expect(doc.getPageCount()).toBe(2);
      for (const page of doc.getPages()) {
        expect(Math.round(page.getWidth())).toBe(85);
        expect(Math.round(page.getHeight())).toBe(28);
      }
      expect(text).not.toHaveBeenCalled();
      } finally {
        text.mockRestore();
      }
    });

    it("يولّد ملف PDF لدفعة ملصقات بنمط شبكة A4", async () => {
      const result = await generateBarcodeBatchPdf({
        items: [{ barcode: "2001112223334", productName: "منتج أ", count: 25 }],
        layout: "a4_grid",
      });

      expect(result.totalLabels).toBe(25);
      const doc = await PDFDocument.load(result.pdfBytes);
      // 25 ملصقاً في شبكة 24 لكل ورقة = ورقتين (صفحتين)
      expect(doc.getPageCount()).toBe(2);
      const page1 = doc.getPage(0);
      expect(Math.round(page1.getWidth())).toBe(595);
      expect(Math.round(page1.getHeight())).toBe(842);
    });

    it("يرمي خطأ صريحاً عند تمرير عناصر فارغة", async () => {
      await expect(generateBarcodeBatchPdf({ items: [] })).rejects.toThrow(
        "لا توجد عناصر بباركود صالح لتوليد دفعة الملصقات",
      );
    });
  });
});

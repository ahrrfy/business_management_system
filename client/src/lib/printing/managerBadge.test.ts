import { describe, expect, it } from "vitest";
import {
  buildManagerBadgeCardHtml,
  buildManagerBadgeThermalHtml,
} from "./managerBadge";

describe("قوالب طباعة شارة اعتماد المدير (Manager Badge Printing)", () => {
  const sampleData = {
    userName: "أحمد علي",
    userRole: "مدير الفرع",
    userIdentifier: "ahmed_mgr",
    branchName: "فرع المنصور",
    badgeBarcode: "MGR-3-987654",
  };

  describe("1. قالب بطاقة الهوية (ID Card / CR80)", () => {
    it("يضبط حجم الصفحة 85.6mm × 54mm بهامش صفري", () => {
      const html = buildManagerBadgeCardHtml(sampleData);
      expect(html).toContain("size: 85.6mm 54mm");
      expect(html).toContain("margin: 0;");
      expect(html).toContain("width: 85.6mm;");
      expect(html).toContain("height: 54mm;");
    });

    it("يتضمن بيانات المدير كاملة والباركود ورمز QR", () => {
      const html = buildManagerBadgeCardHtml(sampleData);
      expect(html).toContain("أحمد علي");
      expect(html).toContain("مدير الفرع");
      expect(html).toContain("فرع المنصور");
      expect(html).toContain("ahmed_mgr");
      expect(html).toContain("<svg"); // Barcode and QR code SVG
      expect(html).toContain("MGR-3-987654");
    });

    it("يتضمن قواعد إخفاء شريط الأدوات عند الطباعة", () => {
      const html = buildManagerBadgeCardHtml(sampleData);
      expect(html).toContain("@media print");
      expect(html).toContain(".toolbar { display: none !important; }");
    });
  });

  describe("2. قالب الإيصال الحراري (80mm Thermal Receipt)", () => {
    it("يضبط حجم الصفحة 80mm auto بهامش صفري وتوسيط الشريحة بعرض 72مم", () => {
      const html = buildManagerBadgeThermalHtml(sampleData);
      expect(html).toContain("size: 80mm auto;");
      expect(html).toContain("margin: 0;");
      expect(html).toContain("width: 72mm;");
      expect(html).toContain("max-width: 72mm;");
      expect(html).toContain("margin: 0 auto;");
    });

    it("يتضمن وسم نوع الوثيقة والباركود لتسهيل المسح المباشر", () => {
      const html = buildManagerBadgeThermalHtml(sampleData);
      expect(html).toContain("شارة اعتماد المدير (POS / الاستقبال)");
      expect(html).toContain("أحمد علي");
      expect(html).toContain("مدير الفرع");
      expect(html).toContain("فرع المنصور");
      expect(html).toContain("ahmed_mgr");
      expect(html).toContain("MGR-3-987654");
      expect(html).toContain("امسح الباركود مباشرة في نقاط البيع");
    });

    it("يُخفي الإطار وشريط الأدوات عند الطباعة لمنع التداخل والقطع", () => {
      const html = buildManagerBadgeThermalHtml(sampleData);
      expect(html).toContain("@media print");
      expect(html).toContain(".thermal-slip { border: none !important;");
    });
  });

  describe("3. قالب الإيصال الحراري المصغر (58mm Thermal Receipt)", () => {
    it("يضبط حجم الصفحة 58mm auto وتوسيط الشريحة بعرض 48مم لمنع اقتطاع الهوامش", () => {
      const html = buildManagerBadgeThermalHtml(sampleData, { paperWidth: "58mm" });
      expect(html).toContain("size: 58mm auto;");
      expect(html).toContain("width: 48mm;");
      expect(html).toContain("max-width: 48mm;");
    });

    it("يحتوي على كافة بيانات المدير وشارة الباركود والـ QR بما يتناسب مع العرض 48مم", () => {
      const html = buildManagerBadgeThermalHtml(sampleData, { paperWidth: "58mm" });
      expect(html).toContain("أحمد علي");
      expect(html).toContain("MGR-3-987654");
      expect(html).toContain("<svg");
    });
  });
});


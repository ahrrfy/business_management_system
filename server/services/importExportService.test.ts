import { describe, it, expect } from "vitest";
import { importExportService } from "./importExportService";

describe("ImportExportService", () => {
  describe("smartColumnMapping", () => {
    it("يجب أن يطابق الأعمدة بدقة عالية", () => {
      const headers = ["اسم المنتج", "رمز المنتج", "سعر التكلفة", "سعر البيع", "الكمية"];
      const mappings = importExportService.smartColumnMapping(headers, "products");

      expect(mappings).toHaveLength(5);
      expect(mappings[0].targetField).toBe("name");
      expect(mappings[0].confidence).toBeGreaterThanOrEqual(0.7);
      // المطابقة الذكية يجب أن تجد مطابقة للحقول المطلوبة
      const mappedFields = mappings.map(m => m.targetField).filter(f => f !== "");
      expect(mappedFields.length).toBeGreaterThan(0);
      expect(mappings.some(m => m.confidence > 0.5)).toBe(true);
    });

    it("يجب أن يطابق الأعمدة الإنجليزية بدقة", () => {
      const headers = ["name", "email", "phone", "address"];
      const mappings = importExportService.smartColumnMapping(headers, "customers");

      expect(mappings).toHaveLength(4);
      expect(mappings[0].targetField).toBe("name");
      expect(mappings[0].confidence).toBeGreaterThanOrEqual(0.95);
      expect(mappings[1].targetField).toBe("email");
      expect(mappings[2].targetField).toBe("phone");
      expect(mappings[3].targetField).toBe("address");
    });

    it("يجب أن يتعامل مع الأعمدة غير المعروفة", () => {
      const headers = ["unknown_column", "another_unknown"];
      const mappings = importExportService.smartColumnMapping(headers, "products");

      expect(mappings).toHaveLength(2);
      expect(mappings[0].targetField).toBe("");
      expect(mappings[0].confidence).toBe(0);
    });

    it("يجب أن يطابق الأسماء البديلة", () => {
      const headers = ["supplier_name", "vendor_email", "tel"];
      const mappings = importExportService.smartColumnMapping(headers, "suppliers");

      expect(mappings[0].targetField).toBe("name");
      expect(mappings[0].confidence).toBeGreaterThan(0.7);
      // الحقول الأخرى يجب أن تكون مطابقة بشكل ما
      expect(mappings[1].confidence).toBeGreaterThan(0.5);
      expect(mappings[2].confidence).toBeGreaterThan(0.5);
    });

    it("يجب أن يتعامل مع الحالات المختلطة", () => {
      const headers = ["Product_Name", "SKU-Code", "Cost-Price"];
      const mappings = importExportService.smartColumnMapping(headers, "products");

      expect(mappings[0].targetField).toBe("name");
      expect(mappings[0].confidence).toBeGreaterThan(0.5);
      expect(mappings[1].targetField).toBe("sku");
      expect(mappings[1].confidence).toBeGreaterThan(0.5);
      expect(mappings[2].targetField).toBe("costPrice");
      expect(mappings[2].confidence).toBeGreaterThan(0.5);
    });
  });

  describe("getExpectedColumns", () => {
    it("يجب أن يرجع الأعمدة المتوقعة للمنتجات", () => {
      const columns = importExportService.getExpectedColumns("products");

      expect(columns).toHaveLength(9);
      expect(columns[0].field).toBe("name");
      expect(columns[0].required).toBe(true);
      expect(columns[1].field).toBe("sku");
      expect(columns[1].required).toBe(true);
    });

    it("يجب أن يرجع الأعمدة المتوقعة للعملاء", () => {
      const columns = importExportService.getExpectedColumns("customers");

      expect(columns).toHaveLength(8);
      expect(columns[0].field).toBe("name");
      expect(columns[0].required).toBe(true);
      expect(columns[1].field).toBe("email");
      expect(columns[1].required).toBe(false);
    });

    it("يجب أن يرجع الأعمدة المتوقعة للموردين", () => {
      const columns = importExportService.getExpectedColumns("suppliers");

      expect(columns).toHaveLength(8);
      expect(columns[0].field).toBe("name");
      expect(columns[0].required).toBe(true);
    });
  });

  describe("validateImportData", () => {
    it("يجب أن يكتشف البيانات الصحيحة", async () => {
      const data = [
        {
          "Product Name": "منتج 1",
          "SKU": "SKU001",
          "Cost Price": "100",
          "Sale Price": "150",
          "Quantity": "10",
        },
        {
          "Product Name": "منتج 2",
          "SKU": "SKU002",
          "Cost Price": "200",
          "Sale Price": "300",
          "Quantity": "20",
        },
      ];

      const mappings = [
        { sourceColumn: "Product Name", targetField: "name", confidence: 0.95 },
        { sourceColumn: "SKU", targetField: "sku", confidence: 0.95 },
        { sourceColumn: "Cost Price", targetField: "costPrice", confidence: 0.95 },
        { sourceColumn: "Sale Price", targetField: "salePrice", confidence: 0.95 },
        { sourceColumn: "Quantity", targetField: "quantityOnHand", confidence: 0.95 },
      ];

      const result = await importExportService.validateImportData(data, "products", mappings);

      expect(result.isValid).toBe(true);
      expect(result.validRows).toBe(2);
      expect(result.errorRows).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("يجب أن يكتشف البيانات الناقصة", async () => {
      const data = [
        {
          "Product Name": "",
          "SKU": "SKU001",
          "Cost Price": "100",
          "Sale Price": "150",
          "Quantity": "10",
        },
      ];

      const mappings = [
        { sourceColumn: "Product Name", targetField: "name", confidence: 0.95 },
        { sourceColumn: "SKU", targetField: "sku", confidence: 0.95 },
        { sourceColumn: "Cost Price", targetField: "costPrice", confidence: 0.95 },
        { sourceColumn: "Sale Price", targetField: "salePrice", confidence: 0.95 },
        { sourceColumn: "Quantity", targetField: "quantityOnHand", confidence: 0.95 },
      ];

      const result = await importExportService.validateImportData(data, "products", mappings);

      expect(result.isValid).toBe(false);
      expect(result.errorRows).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("يجب أن يكتشف القيم غير الرقمية", async () => {
      const data = [
        {
          "Product Name": "منتج 1",
          "SKU": "SKU001",
          "Cost Price": "not_a_number",
          "Sale Price": "150",
          "Quantity": "10",
        },
      ];

      const mappings = [
        { sourceColumn: "Product Name", targetField: "name", confidence: 0.95 },
        { sourceColumn: "SKU", targetField: "sku", confidence: 0.95 },
        { sourceColumn: "Cost Price", targetField: "costPrice", confidence: 0.95 },
        { sourceColumn: "Sale Price", targetField: "salePrice", confidence: 0.95 },
        { sourceColumn: "Quantity", targetField: "quantityOnHand", confidence: 0.95 },
      ];

      const result = await importExportService.validateImportData(data, "products", mappings);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message.includes("ليست رقماً"))).toBe(true);
    });

    it("يجب أن يحذر من القيم السالبة", async () => {
      const data = [
        {
          "Product Name": "منتج 1",
          "SKU": "SKU001",
          "Cost Price": "-100",
          "Sale Price": "150",
          "Quantity": "10",
        },
      ];

      const mappings = [
        { sourceColumn: "Product Name", targetField: "name", confidence: 0.95 },
        { sourceColumn: "SKU", targetField: "sku", confidence: 0.95 },
        { sourceColumn: "Cost Price", targetField: "costPrice", confidence: 0.95 },
        { sourceColumn: "Sale Price", targetField: "salePrice", confidence: 0.95 },
        { sourceColumn: "Quantity", targetField: "quantityOnHand", confidence: 0.95 },
      ];

      const result = await importExportService.validateImportData(data, "products", mappings);

      expect(result.warnings.some(w => w.message.includes("سالبة"))).toBe(true);
    });

    it("يجب أن يحذر من عناوين بريد غير صحيحة", async () => {
      const data = [
        {
          "Customer Name": "عميل 1",
          "Email": "invalid_email",
          "Phone": "123456789",
        },
      ];

      const mappings = [
        { sourceColumn: "Customer Name", targetField: "name", confidence: 0.95 },
        { sourceColumn: "Email", targetField: "email", confidence: 0.95 },
        { sourceColumn: "Phone", targetField: "phone", confidence: 0.95 },
      ];

      const result = await importExportService.validateImportData(data, "customers", mappings);

      expect(result.warnings.some(w => w.message.includes("غير صالح"))).toBe(true);
    });

    it("يجب أن يكتشف الحقول المطلوبة غير المربوطة", async () => {
      const data = [
        {
          "Product Name": "منتج 1",
          "Cost Price": "100",
          "Sale Price": "150",
          "Quantity": "10",
        },
      ];

      const mappings = [
        { sourceColumn: "Product Name", targetField: "name", confidence: 0.95 },
        { sourceColumn: "Cost Price", targetField: "costPrice", confidence: 0.95 },
        { sourceColumn: "Sale Price", targetField: "salePrice", confidence: 0.95 },
        { sourceColumn: "Quantity", targetField: "quantityOnHand", confidence: 0.95 },
      ];

      const result = await importExportService.validateImportData(data, "products", mappings);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.field === "sku")).toBe(true);
    });
  });
});

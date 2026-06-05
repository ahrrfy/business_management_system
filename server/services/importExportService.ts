import { getDb } from "../db";
import { products, customers, suppliers } from "../../drizzle/schema";
import { eq, like } from "drizzle-orm";

/**
 * ====================================
 * خدمة الاستيراد والتصدير المركزية
 * ====================================
 * - استيراد البيانات من Excel/CSV
 * - مطابقة الأعمدة الذكية
 * - التحقق من صحة البيانات
 * - الكشف عن التكرارات
 * - تصدير البيانات بصيغ متعددة
 */

// أنواع البيانات المدعومة
export type ImportEntityType = "products" | "customers" | "suppliers";

// خريطة الأعمدة المتوقعة لكل نوع
const COLUMN_MAPPINGS: Record<ImportEntityType, { field: string; label: string; required: boolean; aliases: string[] }[]> = {
  products: [
    { field: "name", label: "اسم المنتج", required: true, aliases: ["product_name", "product", "اسم", "المنتج", "item_name", "item"] },
    { field: "sku", label: "رمز المنتج", required: true, aliases: ["sku", "code", "barcode", "الرمز", "الباركود", "رقم_المنتج"] },
    { field: "description", label: "الوصف", required: false, aliases: ["description", "desc", "الوصف", "التفاصيل"] },
    { field: "costPrice", label: "سعر التكلفة", required: true, aliases: ["cost", "cost_price", "التكلفة", "سعر_الشراء", "purchase_price"] },
    { field: "salePrice", label: "سعر البيع", required: true, aliases: ["price", "sale_price", "selling_price", "السعر", "سعر_البيع"] },
    { field: "wholesalePrice", label: "سعر الجملة", required: false, aliases: ["wholesale", "wholesale_price", "سعر_الجملة"] },
    { field: "quantityOnHand", label: "الكمية", required: true, aliases: ["quantity", "qty", "stock", "الكمية", "المخزون"] },
    { field: "minStock", label: "الحد الأدنى", required: false, aliases: ["min_stock", "minimum", "الحد_الأدنى"] },
    { field: "maxStock", label: "الحد الأقصى", required: false, aliases: ["max_stock", "maximum", "الحد_الأقصى"] },
  ],
  customers: [
    { field: "name", label: "اسم العميل", required: true, aliases: ["customer_name", "name", "الاسم", "العميل", "client"] },
    { field: "email", label: "البريد الإلكتروني", required: false, aliases: ["email", "mail", "البريد", "الإيميل"] },
    { field: "phone", label: "الهاتف", required: false, aliases: ["phone", "mobile", "tel", "الهاتف", "الجوال", "الموبايل"] },
    { field: "address", label: "العنوان", required: false, aliases: ["address", "العنوان", "الموقع"] },
    { field: "city", label: "المدينة", required: false, aliases: ["city", "المدينة"] },
    { field: "country", label: "الدولة", required: false, aliases: ["country", "الدولة", "البلد"] },
    { field: "taxId", label: "الرقم الضريبي", required: false, aliases: ["tax_id", "vat", "الرقم_الضريبي"] },
    { field: "customerType", label: "نوع العميل", required: false, aliases: ["type", "customer_type", "النوع"] },
  ],
  suppliers: [
    { field: "name", label: "اسم المورد", required: true, aliases: ["supplier_name", "name", "الاسم", "المورد", "vendor"] },
    { field: "email", label: "البريد الإلكتروني", required: false, aliases: ["email", "mail", "البريد"] },
    { field: "phone", label: "الهاتف", required: false, aliases: ["phone", "mobile", "tel", "الهاتف", "الجوال"] },
    { field: "address", label: "العنوان", required: false, aliases: ["address", "العنوان"] },
    { field: "city", label: "المدينة", required: false, aliases: ["city", "المدينة"] },
    { field: "country", label: "الدولة", required: false, aliases: ["country", "الدولة"] },
    { field: "taxId", label: "الرقم الضريبي", required: false, aliases: ["tax_id", "vat", "الرقم_الضريبي"] },
    { field: "paymentTerms", label: "شروط الدفع", required: false, aliases: ["payment_terms", "terms", "شروط_الدفع"] },
  ],
};

export interface ImportValidationResult {
  isValid: boolean;
  totalRows: number;
  validRows: number;
  errorRows: number;
  duplicateRows: number;
  errors: { row: number; field: string; message: string }[];
  duplicates: { row: number; field: string; existingValue: string }[];
  warnings: { row: number; field: string; message: string }[];
}

export interface ColumnMapping {
  sourceColumn: string;
  targetField: string;
  confidence: number;
}

class ImportExportService {
  /**
   * مطابقة الأعمدة الذكية
   * يقارن أسماء الأعمدة في الملف المستورد مع الحقول المتوقعة
   */
  smartColumnMapping(headers: string[], entityType: ImportEntityType): ColumnMapping[] {
    const expectedColumns = COLUMN_MAPPINGS[entityType];
    const mappings: ColumnMapping[] = [];

    for (const header of headers) {
      const normalizedHeader = header.toLowerCase().trim().replace(/[\s_-]+/g, "_");
      let bestMatch: { field: string; confidence: number } = { field: "", confidence: 0 };

      for (const col of expectedColumns) {
        // مطابقة مباشرة
        if (normalizedHeader === col.field.toLowerCase()) {
          bestMatch = { field: col.field, confidence: 1.0 };
          break;
        }

        // مطابقة مع الأسماء البديلة
        for (const alias of col.aliases) {
          const normalizedAlias = alias.toLowerCase().replace(/[\s_-]+/g, "_");
          if (normalizedHeader === normalizedAlias) {
            bestMatch = { field: col.field, confidence: 0.95 };
            break;
          }
          // مطابقة جزئية
          if (normalizedHeader.includes(normalizedAlias) || normalizedAlias.includes(normalizedHeader)) {
            const confidence = 0.7;
            if (confidence > bestMatch.confidence) {
              bestMatch = { field: col.field, confidence };
            }
          }
        }
      }

      if (bestMatch.confidence > 0) {
        mappings.push({
          sourceColumn: header,
          targetField: bestMatch.field,
          confidence: bestMatch.confidence,
        });
      } else {
        mappings.push({
          sourceColumn: header,
          targetField: "",
          confidence: 0,
        });
      }
    }

    return mappings;
  }

  /**
   * التحقق من صحة البيانات المستوردة
   */
  async validateImportData(
    data: Record<string, any>[],
    entityType: ImportEntityType,
    columnMappings: ColumnMapping[]
  ): Promise<ImportValidationResult> {
    const expectedColumns = COLUMN_MAPPINGS[entityType];
    const errors: { row: number; field: string; message: string }[] = [];
    const duplicates: { row: number; field: string; existingValue: string }[] = [];
    const warnings: { row: number; field: string; message: string }[] = [];
    let validRows = 0;
    let errorRows = 0;
    let duplicateRows = 0;

    const db = await getDb();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      let rowHasError = false;
      let rowIsDuplicate = false;

      // التحقق من الحقول المطلوبة
      for (const col of expectedColumns) {
        if (!col.required) continue;

        const mapping = columnMappings.find((m) => m.targetField === col.field);
        if (!mapping || !mapping.sourceColumn) {
          errors.push({ row: i + 1, field: col.field, message: `الحقل "${col.label}" مطلوب ولم يتم ربطه` });
          rowHasError = true;
          continue;
        }

        const value = row[mapping.sourceColumn];
        if (value === undefined || value === null || value === "") {
          errors.push({ row: i + 1, field: col.field, message: `القيمة فارغة في "${col.label}"` });
          rowHasError = true;
        }
      }

      // التحقق من الأرقام
      const numericFields = ["costPrice", "salePrice", "wholesalePrice", "quantityOnHand", "minStock", "maxStock", "creditLimit", "salary"];
      for (const mapping of columnMappings) {
        if (numericFields.includes(mapping.targetField)) {
          const value = row[mapping.sourceColumn];
          if (value !== undefined && value !== null && value !== "") {
            const num = parseFloat(value);
            if (isNaN(num)) {
              errors.push({ row: i + 1, field: mapping.targetField, message: `القيمة "${value}" ليست رقماً صحيحاً` });
              rowHasError = true;
            } else if (num < 0) {
              warnings.push({ row: i + 1, field: mapping.targetField, message: `القيمة سالبة: ${value}` });
            }
          }
        }
      }

      // التحقق من البريد الإلكتروني
      const emailMapping = columnMappings.find((m) => m.targetField === "email");
      if (emailMapping) {
        const email = row[emailMapping.sourceColumn];
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          warnings.push({ row: i + 1, field: "email", message: `البريد "${email}" غير صالح` });
        }
      }

      // التحقق من التكرارات في قاعدة البيانات
      if (db) {
        try {
          if (entityType === "products") {
            const skuMapping = columnMappings.find((m) => m.targetField === "sku");
            if (skuMapping) {
              const sku = row[skuMapping.sourceColumn];
              if (sku) {
                const existing = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
                if (existing.length > 0) {
                  duplicates.push({ row: i + 1, field: "sku", existingValue: sku });
                  rowIsDuplicate = true;
                }
              }
            }
          } else if (entityType === "customers") {
            const nameMapping = columnMappings.find((m) => m.targetField === "name");
            if (nameMapping) {
              const name = row[nameMapping.sourceColumn];
              if (name) {
                const existing = await db.select().from(customers).where(eq(customers.name, name)).limit(1);
                if (existing.length > 0) {
                  duplicates.push({ row: i + 1, field: "name", existingValue: name });
                  rowIsDuplicate = true;
                }
              }
            }
          } else if (entityType === "suppliers") {
            const nameMapping = columnMappings.find((m) => m.targetField === "name");
            if (nameMapping) {
              const name = row[nameMapping.sourceColumn];
              if (name) {
                const existing = await db.select().from(suppliers).where(eq(suppliers.name, name)).limit(1);
                if (existing.length > 0) {
                  duplicates.push({ row: i + 1, field: "name", existingValue: name });
                  rowIsDuplicate = true;
                }
              }
            }
          }
        } catch (e) {
          // تجاهل أخطاء التحقق من التكرارات
        }
      }

      if (rowHasError) {
        errorRows++;
      } else if (rowIsDuplicate) {
        duplicateRows++;
      } else {
        validRows++;
      }
    }

    return {
      isValid: errorRows === 0,
      totalRows: data.length,
      validRows,
      errorRows,
      duplicateRows,
      errors,
      duplicates,
      warnings,
    };
  }

  /**
   * تنفيذ الاستيراد الفعلي
   */
  async executeImport(
    data: Record<string, any>[],
    entityType: ImportEntityType,
    columnMappings: ColumnMapping[],
    skipDuplicates: boolean = true
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    let imported = 0;
    let skipped = 0;
    const importErrors: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];

      try {
        // بناء الكائن المراد إدخاله
        const record: Record<string, any> = {};
        for (const mapping of columnMappings) {
          if (mapping.targetField && mapping.sourceColumn) {
            record[mapping.targetField] = row[mapping.sourceColumn];
          }
        }

        if (entityType === "products") {
          // التحقق من التكرار
          if (skipDuplicates && record.sku) {
            const existing = await db.select().from(products).where(eq(products.sku, record.sku)).limit(1);
            if (existing.length > 0) {
              skipped++;
              continue;
            }
          }

          await db.insert(products).values({
            name: record.name || "منتج بدون اسم",
            sku: record.sku || `SKU-${Date.now()}-${i}`,
            description: record.description || null,
            costPrice: (parseFloat(record.costPrice) || 0).toString(),
            salePrice: (parseFloat(record.salePrice) || 0).toString(),
            wholesalePrice: record.wholesalePrice ? parseFloat(record.wholesalePrice).toString() : null,
            quantityOnHand: parseInt(record.quantityOnHand) || 0,
            minStock: parseInt(record.minStock) || 5,
            maxStock: parseInt(record.maxStock) || 1000,
            reorderPoint: parseInt(record.reorderPoint) || 10,
            isActive: true,
          });
          imported++;
        } else if (entityType === "customers") {
          if (skipDuplicates && record.name) {
            const existing = await db.select().from(customers).where(eq(customers.name, record.name)).limit(1);
            if (existing.length > 0) {
              skipped++;
              continue;
            }
          }

          await db.insert(customers).values({
            name: record.name || "عميل بدون اسم",
            email: record.email || null,
            phone: record.phone || null,
            address: record.address || null,
            city: record.city || null,
            country: record.country || null,
            taxId: record.taxId || null,
            customerType: record.customerType === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL",
            isActive: true,
          });
          imported++;
        } else if (entityType === "suppliers") {
          if (skipDuplicates && record.name) {
            const existing = await db.select().from(suppliers).where(eq(suppliers.name, record.name)).limit(1);
            if (existing.length > 0) {
              skipped++;
              continue;
            }
          }

          await db.insert(suppliers).values({
            name: record.name || "مورد بدون اسم",
            email: record.email || null,
            phone: record.phone || null,
            address: record.address || null,
            city: record.city || null,
            country: record.country || null,
            taxId: record.taxId || null,
            paymentTerms: record.paymentTerms || null,
          });
          imported++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        importErrors.push(`صف ${i + 1}: ${message}`);
      }
    }

    return { imported, skipped, errors: importErrors };
  }

  /**
   * تصدير البيانات
   */
  async exportData(entityType: ImportEntityType): Promise<Record<string, any>[]> {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    if (entityType === "products") {
      return await db.select().from(products);
    } else if (entityType === "customers") {
      return await db.select().from(customers);
    } else if (entityType === "suppliers") {
      return await db.select().from(suppliers);
    }

    return [];
  }

  /**
   * الحصول على الأعمدة المتوقعة لنوع معين
   */
  getExpectedColumns(entityType: ImportEntityType) {
    return COLUMN_MAPPINGS[entityType];
  }
}

export const importExportService = new ImportExportService();

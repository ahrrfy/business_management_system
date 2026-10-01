import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StackedEntityCell } from "@/components/data-table/StackedEntityCell";
import { compareNumericDisplay, numericFromDisplay } from "@/components/data-table/columnContract";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n?/gu, "\n");

describe("تعميم نمط الخلايا المكدسة StackedEntityCell وتحسين العرض الأفقي للجداول", () => {
  const invoicesSrc = read("../Invoices.tsx");
  const vouchersSrc = read("../Vouchers.tsx");
  const purchaseRegSrc = read("../PurchaseRegister.tsx");
  const salesRegSrc = read("../SalesRegister.tsx");
  const arApDetailSrc = read("../ArApAgingDetail.tsx");
  const apAgingSrc = read("../APAging.tsx");
  const arAgingSrc = read("../ARAging.tsx");
  const customersSrc = read("../Customers.tsx");
  const woProfitSrc = read("../WorkOrderProfitability.tsx");

  describe("1. جدول الفواتير (Invoices.tsx)", () => {
    it("يدمج العميل ورقم الفاتورة باستخدام StackedEntityCell مع زر نسخ مستقر", () => {
      expect(invoicesSrc).toContain('id: "customerAndInvoice"');
      expect(invoicesSrc).toContain('header: "العميل / رقم الفاتورة"');
      expect(invoicesSrc).toContain("setDrawerInvoiceId(r.id)");
      expect(invoicesSrc).toContain("copyValue={r.invoiceNumber}");
    });

    it("يدمج إجماليات المبالغ المالية (الإجمالي والمدفوع والمتبقي) مع الألوان الدلالية", () => {
      expect(invoicesSrc).toContain('id: "financialSummary"');
      expect(invoicesSrc).toContain('header: "المبالغ (الإجمالي / المتبقي)"');
      expect(invoicesSrc).toContain("text-money-negative");
      expect(invoicesSrc).toContain("text-money-positive");
    });

    it("يدمج طريقة الدفع وشارات التحصيل والعربون", () => {
      expect(invoicesSrc).toContain('id: "paymentAndCollection"');
      expect(invoicesSrc).toContain('header: "طريقة الدفع والتحصيل"');
      expect(invoicesSrc).toContain("عربون — متبقٍ للتحصيل");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل INVOICE_EXPORT_COLUMNS", () => {
      expect(invoicesSrc).toContain('{ key: "invoiceNumber", header: "رقم الفاتورة" }');
      expect(invoicesSrc).toContain('{ key: "customerName", header: "العميل"');
      expect(invoicesSrc).toContain('{ key: "total", header: "الإجمالي"');
      expect(invoicesSrc).toContain('{ key: "paidAmount", header: "المدفوع"');
      expect(invoicesSrc).toContain('{ key: "remainingAmount", header: "المتبقي"');
      expect(invoicesSrc).toContain('{ key: "paymentMethod", header: "طريقة الدفع"');
    });
  });

  describe("2. جدول السندات (Vouchers.tsx)", () => {
    it("يدمج رقم السند والبصمة/المرجع باستخدام StackedEntityCell", () => {
      expect(vouchersSrc).toContain('id: "voucherNumber"');
      expect(vouchersSrc).toContain('header: "رقم السند / المرجع"');
      expect(vouchersSrc).toContain("shortHash(r.signatureHash)");
      expect(vouchersSrc).toContain("copyValue={r.voucherNumber ? String(r.voucherNumber) : null}");
    });

    it("يدمج اسم الطرف والفاتورة المرتبطة باستخدام StackedEntityCell", () => {
      expect(vouchersSrc).toContain('id: "party"');
      expect(vouchersSrc).toContain('header: "الطرف / الفاتورة"');
      expect(vouchersSrc).toContain("invoiceText");
      expect(vouchersSrc).toContain("copyValue={r.invoiceNumber ?? undefined}");
    });

    it("يدمج نوع السند والاعتماد في عمود حالة واحد", () => {
      expect(vouchersSrc).toContain('id: "direction"');
      expect(vouchersSrc).toContain('header: "النوع والاعتماد"');
      expect(vouchersSrc).toContain("voucherApprovalLabel(r)");
    });
  });

  describe("3. سجل المشتريات (PurchaseRegister.tsx)", () => {
    it("يدمج المورد ورقم أمر الشراء باستخدام StackedEntityCell", () => {
      expect(purchaseRegSrc).toContain('id: "supplierAndOrder"');
      expect(purchaseRegSrc).toContain('header: "المورّد / أمر الشراء"');
      expect(purchaseRegSrc).toContain("copyValue={row.original.poNumber ?? (row.original.poId ? String(row.original.poId) : null)}");
    });

    it("يدمج الكمية وسعر الوحدة في خلية مالية متناسقة", () => {
      expect(purchaseRegSrc).toContain('id: "quantityAndPrice"');
      expect(purchaseRegSrc).toContain('header: "الكمية / السعر"');
      expect(purchaseRegSrc).toContain("formatQuantity(row.original.quantity)");
      expect(purchaseRegSrc).toContain("fmtAr(row.original.unitPrice)");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(purchaseRegSrc).toContain('{ key: "poNumber", header: "أمر الشراء"');
      expect(purchaseRegSrc).toContain('{ key: "supplierName", header: "المورّد"');
      expect(purchaseRegSrc).toContain('{ key: "quantity", header: "الكمية"');
      expect(purchaseRegSrc).toContain('{ key: "unitPrice", header: "سعر الوحدة"');
      expect(purchaseRegSrc).toContain('{ key: "total", header: "الإجمالي"');
    });
  });

  describe("4. سجل المبيعات (SalesRegister.tsx)", () => {
    it("يدمج العميل ورقم الفاتورة باستخدام StackedEntityCell", () => {
      expect(salesRegSrc).toContain('id: "customerAndInvoice"');
      expect(salesRegSrc).toContain('header: "العميل / الفاتورة"');
      expect(salesRegSrc).toContain("copyValue={row.original.invoiceNumber}");
    });

    it("يدمج الكمية وسعر البيع", () => {
      expect(salesRegSrc).toContain('id: "quantityAndPrice"');
      expect(salesRegSrc).toContain('header: "الكمية / السعر"');
    });

    it("يدمج التكلفة وصافي الربح مع التلوين الدلالي", () => {
      expect(salesRegSrc).toContain('id: "costAndProfit"');
      expect(salesRegSrc).toContain('header: "الربح / التكلفة"');
      expect(salesRegSrc).toContain("text-money-negative");
      expect(salesRegSrc).toContain("text-money-positive");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(salesRegSrc).toContain('{ key: "invoiceNumber", header: "الفاتورة" }');
      expect(salesRegSrc).toContain('{ key: "customerName", header: "العميل"');
      expect(salesRegSrc).toContain('{ key: "unitPrice", header: "سعر الوحدة"');
      expect(salesRegSrc).toContain('{ key: "unitCost", header: "تكلفة الوحدة"');
      expect(salesRegSrc).toContain('{ key: "profit", header: "الربح"');
    });
  });

  describe("5. تفصيل أعمار الذمم (ArApAgingDetail.tsx)", () => {
    it("يدمج الطرف والمستند المرجعي باستخدام StackedEntityCell", () => {
      expect(arApDetailSrc).toContain('id: "partyAndDocument"');
      expect(arApDetailSrc).toContain('header: isAR ? "العميل / الفاتورة" : "المورد / أمر الشراء"');
      expect(arApDetailSrc).toContain("copyValue={row.original.number}");
    });

    it("يدمج تاريخ المستند وتاريخ الاستحقاق/أيام التأخر", () => {
      expect(arApDetailSrc).toContain('id: "dateAndDue"');
      expect(arApDetailSrc).toContain('header: "التاريخ / الاستحقاق"');
      expect(arApDetailSrc).toContain("row.original.daysOverdue");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(arApDetailSrc).toContain('{ key: "number", header: isAR ? "رقم الفاتورة" : "رقم أمر الشراء" }');
      expect(arApDetailSrc).toContain('{ key: "partyName", header: isAR ? "العميل" : "المورد" }');
      expect(arApDetailSrc).toContain('{ key: "date", header: "التاريخ" }');
      expect(arApDetailSrc).toContain('{ key: "daysOverdue", header: "أيام التأخّر"');
    });
  });

  describe("6. أعمار الذمم الدائنة (APAging.tsx)", () => {
    it("يدمج المورد ورقم الهاتف باستخدام StackedEntityCell", () => {
      expect(apAgingSrc).toContain('id: "supplierAndPhone"');
      expect(apAgingSrc).toContain('header: "المورد / الهاتف"');
      expect(apAgingSrc).toContain("copyValue={row.original.phone}");
    });

    it("يدمج الرصيد الإجمالي والرصيد غير المفوتر/الافتتاحي", () => {
      expect(apAgingSrc).toContain('id: "currentBalance"');
      expect(apAgingSrc).toContain('header: "الرصيد / الافتتاحي"');
      expect(apAgingSrc).toContain("unbilledOf(row.original)");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(apAgingSrc).toContain('{ key: "supplierName", header: "المورد" }');
      expect(apAgingSrc).toContain('{ key: "phone", header: "الهاتف" }');
      expect(apAgingSrc).toContain('{ key: "unbilled", header: "غير مفوتر/افتتاحي"');
      expect(apAgingSrc).toContain('{ key: "currentBalance", header: "الرصيد الحالي"');
    });
  });

  describe("7. أعمار الذمم المدينة (ARAging.tsx)", () => {
    it("يدمج العميل والهاتف والفئة باستخدام StackedEntityCell", () => {
      expect(arAgingSrc).toContain('id: "customerAndPhone"');
      expect(arAgingSrc).toContain('header: "العميل / الفئة والهاتف"');
      expect(arAgingSrc).toContain("copyValue={row.original.phone}");
    });

    it("يدمج الرصيد الإجمالي والرصيد غير المفوتر/الافتتاحي", () => {
      expect(arAgingSrc).toContain('id: "currentBalance"');
      expect(arAgingSrc).toContain('header: "الرصيد / الافتتاحي"');
      expect(arAgingSrc).toContain("unbilledOf(row.original)");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(arAgingSrc).toContain('{ key: "customerName", header: "العميل" }');
      expect(arAgingSrc).toContain('{ key: "phone", header: "الهاتف" }');
      expect(arAgingSrc).toContain('{ key: "unbilled", header: "غير مفوتر/افتتاحي"');
      expect(arAgingSrc).toContain('{ key: "currentBalance", header: "الرصيد الحالي"');
    });
  });

  describe("8. دليل العملاء (Customers.tsx)", () => {
    it("يدمج العميل ورقم الهاتف والرمز القديم باستخدام StackedEntityCell", () => {
      expect(customersSrc).toContain('id: "name"');
      expect(customersSrc).toContain('header: "العميل / الهاتف"');
      expect(customersSrc).toContain("copyValue={c.phone}");
    });

    it("يدمج فئة السعر ونوع العميل والمدينة", () => {
      expect(customersSrc).toContain('id: "typeTierAndCity"');
      expect(customersSrc).toContain('header: "الفئة والنوع / المدينة"');
    });

    it("يدمج الرصيد وسقف الائتمان", () => {
      expect(customersSrc).toContain('id: "balanceAndCreditLimit"');
      expect(customersSrc).toContain('header: "الرصيد / سقف الائتمان"');
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(customersSrc).toContain('{ key: "name", header: "الاسم" }');
      expect(customersSrc).toContain('{ key: "legacyCode", header: "الرقم القديم"');
      expect(customersSrc).toContain('{ key: "customerType", header: "النوع" }');
      expect(customersSrc).toContain('{ key: "phone", header: "الهاتف" }');
      expect(customersSrc).toContain('{ key: "creditLimit", header: "سقف الائتمان"');
      expect(customersSrc).toContain('{ key: "currentBalance", header: "الرصيد الحالي"');
    });
  });

  describe("9. ربحية أوامر الشغل (WorkOrderProfitability.tsx)", () => {
    it("يدمج رقم الأمر وتاريخ التسليم باستخدام StackedEntityCell", () => {
      expect(woProfitSrc).toContain('id: "orderAndDate"');
      expect(woProfitSrc).toContain('header: "أمر الشغل / تاريخ التسليم"');
      expect(woProfitSrc).toContain("copyValue={row.original.orderNumber}");
    });

    it("يدمج وصف العمل واسم العميل باستخدام StackedEntityCell", () => {
      expect(woProfitSrc).toContain('id: "jobAndCustomer"');
      expect(woProfitSrc).toContain('header: "العمل / العميل"');
    });

    it("يدمج صافي الربح ونسبة الهامش % مع الحفاظ على صف الإجماليات", () => {
      expect(woProfitSrc).toContain('id: "profitAndMargin"');
      expect(woProfitSrc).toContain('header: "صافي الربح / الهامش"');
      expect(woProfitSrc).toContain("marginPct");
    });

    it("يحافظ على فصل الأعمدة في تصدير الإكسل", () => {
      expect(woProfitSrc).toContain('{ key: "deliveredAt", header: "تاريخ التسليم" }');
      expect(woProfitSrc).toContain('{ key: "orderNumber", header: "رقم الأمر" }');
      expect(woProfitSrc).toContain('{ key: "title", header: "العمل" }');
      expect(woProfitSrc).toContain('{ key: "customerName", header: "العميل"');
      expect(woProfitSrc).toContain('{ key: "profit", header: "الربح"');
      expect(woProfitSrc).toContain('{ key: "marginPct", header: "الهامش %"');
    });
  });

  describe("عزل LTR وتفادي التكرار وسلوك المكون العام", () => {
    it("يرسم StackedEntityCell مع شارة ثانوية وزر نسخ", () => {
      const html = renderToStaticMarkup(
        React.createElement(StackedEntityCell, {
          primary: "عميل تجريبي",
          secondary: "INV-9999",
          copyValue: "INV-9999",
          secondaryBadge: React.createElement("span", { className: "badge" }, "شارة"),
        }),
      );
      expect(html).toContain("عميل تجريبي");
      expect(html).toContain('<bdi dir="ltr">INV-9999</bdi>');
      expect(html).toContain("شارة");
      expect(html).toContain("button");
    });

    it("يرسم StackedEntityCell مع secondaryIsCode={false} بدون فئة font-mono وباتجاه auto", () => {
      const html = renderToStaticMarkup(
        React.createElement(StackedEntityCell, {
          primary: "طباعة بروشورات",
          secondary: "شركة الرافدين للتجارة",
          secondaryIsCode: false,
          secondaryDir: "auto",
        }),
      );
      expect(html).toContain("طباعة بروشورات");
      expect(html).toContain('<bdi dir="auto">شركة الرافدين للتجارة</bdi>');
      expect(html).not.toContain("font-mono");
    });

    it("يرسم StackedEntityCell مع secondaryDir صريح rtl", () => {
      const html = renderToStaticMarkup(
        React.createElement(StackedEntityCell, {
          primary: "سند قبض",
          secondary: "فاتورة #INV-123",
          secondaryDir: "rtl",
        }),
      );
      expect(html).toContain('<bdi dir="rtl">فاتورة #INV-123</bdi>');
    });

    it("يربط الطرف بكشف الحساب ويستخدم ملاحة SPA بدون إعادة تحميل الصفحة الكاملة", () => {
      expect(vouchersSrc).toContain("statementHref(r)");
      expect(vouchersSrc).toContain("navigate(`/invoices/${r.invoiceId}`)");
      expect(purchaseRegSrc).toContain("navigate(`/purchases/${row.original.poId}`)");
      expect(salesRegSrc).toContain("navigate(`/invoices/${row.original.invoiceId}`)");
      expect(arApDetailSrc).toContain("navigate(isAR ? `/invoices/${row.original.id}` : `/purchases/${row.original.id}`)");
    });
  });

  describe("دقة تحليل الأرقام والفرز في الخلايا المكدسة المركبة (columnContract & sorting)", () => {
    it("يستخرج القيمة العددية الأساسية بدقة من النصوص المركبة بدون دمج خاطئ أو إرجاع NaN", () => {
      // حالة الإجمالي مع المدفوع: 1,000.50 (مدفوع: 200.25)
      expect(numericFromDisplay("1,000.50 (مدفوع: 200.25)")).toBe(1000.5);
      // حالة الكمية مع السعر: 15 × 250.75
      expect(numericFromDisplay("15 × 250.75")).toBe(15);
      // رقم سالب بمحرف يونيكود
      expect(numericFromDisplay("−1,250.50")).toBe(-1250.5);
      // سالب مع نص إضافي
      expect(numericFromDisplay("-500.00 (ربح: 120.00)")).toBe(-500);
      // نص غير رقمي
      expect(numericFromDisplay("غير محدد")).toBeNull();
      expect(numericFromDisplay("—")).toBeNull();
    });

    it("يرتّب القيم المركبة في compareNumericDisplay بحيث تبقى القيم الفارغة في الذيل", () => {
      expect(compareNumericDisplay("1,000.50 (مدفوع: 200)", "2,500.00 (مدفوع: 100)")).toBeLessThan(0);
      expect(compareNumericDisplay("2,500.00 (مدفوع: 100)", "1,000.50 (مدفوع: 200)")).toBeGreaterThan(0);
      expect(compareNumericDisplay("1,000.00", "—")).toBeLessThan(0);
      expect(compareNumericDisplay("—", "1,000.00")).toBeGreaterThan(0);
      expect(compareNumericDisplay("—", "—")).toBe(0);
    });

    it("يحتوي كل جدول يدمج أرقاماً مركبة على دوال فرز صريحة ومستقرة", () => {
      // Invoices
      expect(invoicesSrc).toContain("sortingFn: (a, b) => D(a.original.total || 0).cmp(D(b.original.total || 0))");
      // SalesRegister
      expect(salesRegSrc).toContain("sortingFn: (a, b) => D(a.original.quantity || 0).cmp(D(b.original.quantity || 0))");
      expect(salesRegSrc).toContain("sortingFn: (a, b) => D(a.original.profit || 0).cmp(D(b.original.profit || 0))");
      // PurchaseRegister
      expect(purchaseRegSrc).toContain("sortingFn: (a, b) => D(a.original.quantity || 0).cmp(D(b.original.quantity || 0))");
      // Customers
      expect(customersSrc).toContain("sortingFn: (a, b) => D(a.original.currentBalance || 0).cmp(D(b.original.currentBalance || 0))");
      // WorkOrderProfitability
      expect(woProfitSrc).toContain("sortingFn: (a, b) => D(a.original.profit || 0).cmp(D(b.original.profit || 0))");
      // Vouchers
      expect(vouchersSrc).toContain("sortingFn: (a, b) => Number(a.original.voucherNumber || 0) - Number(b.original.voucherNumber || 0)");
      // ArApAgingDetail
      expect(arApDetailSrc).toContain("sortingFn: (a, b) => a.original.date.localeCompare(b.original.date)");
    });
  });
});


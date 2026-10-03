import { describe, expect, it } from "vitest";
import { wrapA4Doc, wrapMultiA4Doc, pageHeader, docHeader } from "./docHtml";
import { buildSalesInvoiceV2Html, buildPurchaseInvoiceV2Html } from "./printTemplatesV2";

describe("wrapA4Doc", () => {
  it("يدعم التقرير الأفقي مع بقاء قواعد الجداول متعددة الصفحات", () => {
    const html = wrapA4Doc("تقرير", "<table><thead><tr><th>رأس</th></tr></thead></table>", {
      orientation: "landscape",
    });

    expect(html).toContain("@page{size:A4 landscape;margin:0}");
    expect(html).toContain("width:1123px;min-height:794px");
    expect(html).toContain("thead{display:table-header-group}");
    expect(html).toContain("tr,td,th{page-break-inside:avoid;break-inside:avoid}");
  });
});

describe("wrapMultiA4Doc", () => {
  it("يدعم دمج صفحات A4 متعددة مع فواصل الصفحات وأزرار شريط الأدوات", () => {
    const pages = ["<div>صفحة 1</div>", "<div>صفحة 2</div>"];
    const html = wrapMultiA4Doc("قسائم الرواتب", pages, {
      badgeLabel: "مسيّر رواتب 2026-09",
    });

    expect(html).toContain("قسائم الرواتب");
    expect(html).toContain("مسيّر رواتب 2026-09");
    expect(html).toContain('data-page-index="1"');
    expect(html).toContain('data-page-index="2"');
    expect(html).toContain("page-break-after:always !important");
    expect(html).toContain("حفظ كملف PDF");
    expect(html).toContain("طباعة المستند");
  });
});

describe("pageHeader - باركود رقم المستند", () => {
  it("يعرض الباركود بجانب الرقم افتراضياً عند تمرير قيمة نصية", () => {
    const html = pageHeader({
      title: "فاتورة مبيعات",
      fields: [
        { label: "رقم الفاتورة", value: "22333" },
        { label: "التاريخ", value: "03/10/2026" },
      ],
      barcode: "INV-22333",
    });

    expect(html).toContain("رقم الفاتورة");
    expect(html).toContain("22333");
    expect(html).toContain("<svg");
    expect(html).toContain('title="INV-22333"');
    expect(html).toContain("align-items:center");
  });

  it("يعرض الباركود تحت الرقم مباشرة عند تحديد placement='below'", () => {
    const html = pageHeader({
      title: "فاتورة مبيعات",
      fields: [
        { label: "رقم الفاتورة", value: "22333" },
        { label: "التاريخ", value: "03/10/2026" },
      ],
      barcode: {
        value: "INV-22333",
        placement: "below",
        caption: "INV-22333",
      },
    });

    expect(html).toContain("رقم الفاتورة");
    expect(html).toContain("22333");
    expect(html).toContain("<svg");
    expect(html).toContain("flex-direction:column;align-items:flex-end");
    expect(html).toContain("INV-22333");
  });

  it("يحافظ على الترويسة الكلاسيكية دون باركود عند غيابه", () => {
    const html = pageHeader({
      title: "فاتورة مبيعات",
      fields: [
        { label: "رقم الفاتورة", value: "22333" },
        { label: "التاريخ", value: "03/10/2026" },
      ],
    });

    expect(html).toContain("رقم الفاتورة");
    expect(html).toContain("22333");
    expect(html).not.toContain("<svg");
  });
});

describe("buildSalesInvoiceV2Html & buildPurchaseInvoiceV2Html", () => {
  const dummySalesInvoice = {
    invoiceNumber: "22333",
    invoiceDate: "2026-10-03",
    customerName: "عميل تجريبي",
    subtotal: 50000,
    total: 50000,
    items: [
      {
        productName: "دفتر ملاحظات",
        quantity: 2,
        unitPrice: 25000,
        total: 50000,
      },
    ],
  };

  it("يولّد باركود الفاتورة تلقائياً ببادئة INV في فاتورة المبيعات الرسمية", () => {
    const html = buildSalesInvoiceV2Html(dummySalesInvoice);

    expect(html).toContain("فاتورة مبيعات");
    expect(html).toContain("22333");
    expect(html).toContain('title="INV-22333"');
    expect(html).toContain("<svg");
  });

  it("يدعم خيار موضع الباركود تحته (below) في فاتورة المبيعات", () => {
    const html = buildSalesInvoiceV2Html({
      ...dummySalesInvoice,
      barcodePlacement: "below",
    });

    expect(html).toContain('title="INV-22333"');
    expect(html).toContain("flex-direction:column;align-items:flex-end");
  });

  it("يتيح إلغاء الباركود صراحةً عند تمرير barcode: false", () => {
    const html = buildSalesInvoiceV2Html({
      ...dummySalesInvoice,
      barcode: false,
    });

    // الترويسة لا تحوي باركود رقم الفاتورة (QR التحقق أسفل الصفحة منفصل)
    expect(html).not.toContain('title="INV-22333"');
  });

  it("يولّد باركود الفاتورة تلقائياً ببادئة PO في فاتورة المشتريات الرسمية", () => {
    const html = buildPurchaseInvoiceV2Html({
      invoiceNumber: "5544",
      invoiceDate: "2026-10-03",
      supplierName: "مورّد القرطاسية",
      subtotal: 100000,
      total: 100000,
      items: [
        {
          productName: "أقلام حبر",
          quantity: 10,
          unitPrice: 10000,
          total: 100000,
        },
      ],
    });

    expect(html).toContain("فاتورة مشتريات");
    expect(html).toContain("5544");
    expect(html).toContain('title="PO-5544"');
    expect(html).toContain("<svg");
  });
});

describe("docHeader - التوليد التلقائي لباركود رقم المستند (Model 1)", () => {
  it("يولّد باركود النموذج 1 تلقائياً بجانب رقم المستند عند تمرير docNum", () => {
    const html = docHeader("أمر شراء", "9988", "2026-10-03");

    expect(html).toContain("أمر شراء");
    expect(html).toContain("9988");
    expect(html).toContain("<svg");
    expect(html).toContain('title="PO-9988"');
  });

  it("يلغي الباركود عند تمرير barcode: false أو null", () => {
    const htmlFalse = docHeader("أمر شراء", "9988", "2026-10-03", undefined, false);
    expect(htmlFalse).not.toContain("<svg");
    expect(htmlFalse).not.toContain('title="PO-9988"');

    const htmlNull = docHeader("أمر شراء", "9988", "2026-10-03", undefined, null);
    expect(htmlNull).not.toContain("<svg");
    expect(htmlNull).not.toContain('title="PO-9988"');
  });

  it("يدعم موضع الباركود تحته (below) في docHeader", () => {
    const html = docHeader("أمر شراء", "9988", "2026-10-03", undefined, undefined, "below");

    expect(html).toContain('title="PO-9988"');
    expect(html).toContain("flex-direction:column;align-items:flex-end");
  });
});

describe("pageHeader - استهداف حقل مرجع الفاتورة (Warehouse Slip)", () => {
  it("يضع الباركود بجانب حقل مرجع الفاتورة عندما لا يحتوي على كلمة رقم", () => {
    const html = pageHeader({
      title: "سند تجهيز مخزني",
      fields: [
        { label: "مرجع الفاتورة", value: "77665" },
        { label: "التاريخ", value: "2026-10-03" },
      ],
      barcode: "INV-77665",
    });

    expect(html).toContain("مرجع الفاتورة");
    expect(html).toContain("77665");
    expect(html).toContain('title="INV-77665"');
    expect(html).toContain("<svg");
  });
});


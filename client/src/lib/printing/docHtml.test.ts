import { describe, expect, it } from "vitest";
import { wrapA4Doc, wrapMultiA4Doc, wrapReceiptDoc, pageHeader, docHeader, docTableV2 } from "./docHtml";
import {
  buildSalesInvoiceV2Html,
  buildPurchaseInvoiceV2Html,
} from "./printTemplatesV2";

describe("wrapA4Doc", () => {
  it("يدعم التقرير الأفقي مع بقاء قواعد الجداول متعددة الصفحات", () => {
    const html = wrapA4Doc(
      "تقرير",
      "<table><thead><tr><th>رأس</th></tr></thead></table>",
      {
        orientation: "landscape",
      },
    );

    expect(html).toContain("@page{size:A4 landscape;margin:0}");
    expect(html).toContain("width:1123px;min-height:794px");
    expect(html).toContain("thead{display:table-header-group}");
    expect(html).toContain(
      "tr,td,th{page-break-inside:avoid;break-inside:avoid}",
    );
  });

  it("يزود المعاينة بأزرار تفاعلية حقيقية متوافقة مع CSP: معرفات فريدة، ربط برمجي، وغياب تام للسمات المضمنة", () => {
    const html = wrapA4Doc("كشف حساب رسمي", "<div>المحتوى</div>");

    expect(html).toContain("html2pdf.bundle.min.js");
    expect(html).toContain('id="doc-btn-print"');
    expect(html).toContain('id="doc-btn-save-pdf"');
    expect(html).toContain('id="doc-btn-close"');
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("onload=");
    expect(html).toContain("addEventListener('click', printDoc)");
    expect(html).toContain("addEventListener('click', saveDocAsPdf)");
    expect(html).toContain("addEventListener('click', closeDocPreview)");
    expect(html).toContain("CLOSE_PRINT_WINDOW");
    expect(html).toContain("doc-exporting-pdf");
    expect(html).toContain("showSaveFilePicker");
    expect(html).toContain("outputPdf('blob')");
  });
});

describe("wrapMultiA4Doc", () => {
  it("يدعم دمج صفحات A4 متعددة مع فواصل الصفحات وأزرار شريط الأدوات دون سمات مضمنة", () => {
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
    expect(html).toContain('id="doc-pages-container"');
    expect(html).toContain('id="doc-btn-print"');
    expect(html).toContain('id="doc-btn-save-pdf"');
    expect(html).toContain('id="doc-btn-close"');
    expect(html).not.toContain("onclick=");
    expect(html).toContain("addEventListener('click', printDoc)");
    expect(html).toContain("addEventListener('click', saveDocAsPdf)");
    expect(html).toContain("addEventListener('click', closeDocPreview)");
    expect(html).toContain("doc-exporting-pdf");
    expect(html).toContain("showSaveFilePicker");
    expect(html).toContain("outputPdf('blob')");
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

  it("يستبدل عمود الضريبة بعمود الباركود مع الترميز الكامل SVG عند عدم تفعيل الضريبة في فاتورة المبيعات", () => {
    const html = buildSalesInvoiceV2Html({
      ...dummySalesInvoice,
      taxAmount: 0,
      taxRate: 0,
      items: [
        {
          productName: "دفتر ملاحظات",
          quantity: 2,
          unitPrice: 25000,
          total: 50000,
          barcode: "628100012345",
        },
      ],
    });

    // عمود الباركود يحل محل عمود الضريبة في رأس الجدول
    expect(html).toContain(">الباركود<");
    expect(html).not.toContain(">الضريبة<");
    // خلية الباركود تحتوي على SVG هندسي صالح للماسحات الضوئية ورقم الباركود تحته
    expect(html).toContain("<svg");
    expect(html).toContain("max-width:105px;height:22px");
    expect(html).toContain("628100012345");
  });

  it("يُبقي عمود الضريبة كما هو في فاتورة المبيعات إذا كانت الضريبة مفعلة وذات قيمة", () => {
    const html = buildSalesInvoiceV2Html({
      ...dummySalesInvoice,
      taxAmount: 5000,
      taxRate: 10,
      items: [
        {
          productName: "دفتر ملاحظات",
          quantity: 2,
          unitPrice: 25000,
          taxRate: 10,
          taxAmount: 5000,
          total: 55000,
          barcode: "628100012345",
        },
      ],
    });

    // عمود الضريبة يظهر لأن الضريبة مفعلة
    expect(html).toContain(">الضريبة<");
    expect(html).not.toContain(">الباركود<");
  });

  it("يستبدل عمود الضريبة بعمود الباركود مع SVG في فاتورة المشتريات الرسمية عند عدم وجود ضريبة", () => {
    const html = buildPurchaseInvoiceV2Html({
      invoiceNumber: "5544",
      invoiceDate: "2026-10-03",
      supplierName: "مورّد القرطاسية",
      subtotal: 100000,
      total: 100000,
      taxAmount: 0,
      taxRate: 0,
      items: [
        {
          productName: "أقلام حبر",
          quantity: 10,
          unitPrice: 10000,
          total: 100000,
          barcode: "978020137962",
        },
      ],
    });

    expect(html).toContain("فاتورة مشتريات");
    expect(html).toContain("5544");
    expect(html).toContain('title="PO-5544"');
    expect(html).toContain(">الباركود<");
    expect(html).not.toContain(">الضريبة<");
    expect(html).toContain("<svg");
    expect(html).toContain("978020137962");
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
    const htmlFalse = docHeader(
      "أمر شراء",
      "9988",
      "2026-10-03",
      undefined,
      false,
    );
    expect(htmlFalse).not.toContain("<svg");
    expect(htmlFalse).not.toContain('title="PO-9988"');

    const htmlNull = docHeader(
      "أمر شراء",
      "9988",
      "2026-10-03",
      undefined,
      null,
    );
    expect(htmlNull).not.toContain("<svg");
    expect(htmlNull).not.toContain('title="PO-9988"');
  });

  it("يدعم موضع الباركود تحته (below) في docHeader", () => {
    const html = docHeader(
      "أمر شراء",
      "9988",
      "2026-10-03",
      undefined,
      undefined,
      "below",
    );

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

describe("wrapReceiptDoc", () => {
  it("يغلّف الإيصال الحراري برباط برمجي للطباعة دون سمة onload المضمنة لضمان توافق CSP", () => {
    const html = wrapReceiptDoc("إيصال قبض", "<div>محتوى الإيصال</div>");
    expect(html).toContain("إيصال قبض");
    expect(html).toContain("80mm");
    expect(html).not.toContain("onload=");
    expect(html).toContain("addEventListener('load'");
    expect(html).toContain("window.print()");
  });
});

describe("docTableV2 - دعم rawHtml للأعمدة المركبة مثل الباركود", () => {
  it("يمرر محتوى HTML دون تشفير عند تحديد rawHtml: true", () => {
    const tableHtml = docTableV2(
      [
        { key: "barcode", label: "الباركود", rawHtml: true },
        { key: "name", label: "اسم المنتج" },
      ],
      [
        {
          barcode: '<svg class="test-barcode"><rect width="10" height="20"/></svg>',
          name: "منتج تجريبي & اختبار <1>",
        },
      ],
    );

    // المحتوى الخام في rawHtml يبقى وسماً كما هو
    expect(tableHtml).toContain('<svg class="test-barcode"><rect width="10" height="20"/></svg>');
    // الأعمدة العادية يتم تشفير محتواها النصي للحماية
    expect(tableHtml).toContain("&amp;");
    expect(tableHtml).toContain("&lt;1&gt;");
  });
});


import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { wrapA4Doc, wrapMultiA4Doc, wrapReceiptDoc, pageHeader, docHeader, docTableV2, docFooter, infoCards } from "./docHtml";
import { isCardPaymentMethod } from "./cardBrandLogos";
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

  it("يزود المعاينة بأزرار تفاعلية حقيقية متوافقة مع CSP: معرفات فريدة، ربط برمجي عبر نص برمجي خارجي، وغياب تام للسمات المضمنة", () => {
    const html = wrapA4Doc("كشف حساب رسمي", "<div>المحتوى</div>");

    expect(html).toContain("html2pdf.bundle.min.js");
    expect(html).toContain('id="doc-btn-print"');
    expect(html).toContain('id="doc-btn-save-pdf"');
    expect(html).toContain('id="doc-btn-close"');
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("onload=");
    expect(html).toContain("/vendor/doc-toolbar.js");
    expect(html).toContain('data-title="كشف حساب رسمي"');
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
    expect(html).toContain("/vendor/doc-toolbar.js");
    expect(html).toContain('data-title="قسائم الرواتب"');
  });
});

describe("payslip PDF export", () => {
  function toolbarHarness(contentHeight: number, assetsHang = false, logoMissing = false) {
    const saveButton = { innerHTML: "حفظ", disabled: false, style: { opacity: "", cursor: "" }, addEventListener: vi.fn() };
    const notice = { hidden: true, textContent: "", style: { cssText: "" }, setAttribute: vi.fn() };
    const imageWarning = { id: "", textContent: "", style: { cssText: "" }, setAttribute: vi.fn() };
    const toolbar = {
      getAttribute: (name: string) => ({ "data-title": "رواتب", "data-multi": "true", "data-payslip": "true" } as Record<string, string>)[name] ?? null,
      insertAdjacentElement: vi.fn(), appendChild: vi.fn(),
    };
    const frameBox = { left: 38, right: 756, top: 38, bottom: 1081 };
    const pages = [1, 2].map((id) => {
      const content = {
        style: { transform: "" }, scrollWidth: 718, scrollHeight: contentHeight,
        getBoundingClientRect: () => {
          const scale = Number(content.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
          return { left: 38, right: 38 + 718 * scale, top: 38, bottom: 38 + contentHeight * scale, width: 718 * scale, height: contentHeight * scale };
        },
        querySelectorAll: () => [],
      };
      const frame = { getBoundingClientRect: () => frameBox, getAttribute: () => String(id), removeAttribute: vi.fn(), setAttribute: vi.fn() };
      return {
        id,
        getBoundingClientRect: () => ({ width: 794, height: 1119 }),
        querySelector: (selector: string) => selector === ".payslip-content" ? content : frame,
      };
    });
    let pageCount = 1;
    const pdfBlob = { type: "application/pdf" };
    const pdf = {
      addPage: vi.fn(() => { pageCount++; }),
      deletePage: vi.fn(() => { pageCount--; }),
      getNumberOfPages: () => pageCount,
      addImage: vi.fn(), output: vi.fn(() => pdfBlob), save: vi.fn(),
    };
    const canvas = { width: 1588, height: 2238, toDataURL: vi.fn(() => "data:image/jpeg;base64,AA==") };
    const from = vi.fn();
    const html2pdf = vi.fn(() => {
      const worker = {
        set: () => worker,
        from: (page: unknown) => { from(page); return worker; },
        toCanvas: () => { canvas.width = 1588; canvas.height = 2238; return worker; },
        toPdf: () => worker,
        get: (key: string) => Promise.resolve(key === "canvas" ? canvas : pdf),
      };
      return worker;
    });
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const listeners: Record<string, () => void> = {};
    const classes = new Set<string>(["payslip-print-pending"]);
    const fakeDocument = {
      readyState: "complete", images: logoMissing ? [{ complete: true, naturalWidth: 0 }] : [], fonts: { ready: assetsHang ? new Promise(() => {}) : Promise.resolve() },
      body: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
      querySelector: (selector: string) => selector === ".doc-toolbar" ? toolbar : null,
      querySelectorAll: (selector: string) => selector === ".page.payslip-page" ? pages : [],
      getElementById: (id: string) => id === "doc-btn-save-pdf" ? saveButton : id === "payslip-print-error" ? notice : null,
      createElement: () => imageWarning,
    };
    const fakeWindow = {
      html2pdf, setTimeout: assetsHang ? (callback: () => void) => { queueMicrotask(callback); return 0; } : setTimeout,
      clearTimeout, focus: vi.fn(), print: vi.fn(),
      showSaveFilePicker: vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close }) }),
      addEventListener: (name: string, callback: () => void) => { listeners[name] = callback; },
      saveDocAsPdf: undefined as undefined | (() => Promise<void>),
    };
    const source = readFileSync("client/public/vendor/doc-toolbar.js", "utf8");
    runInNewContext(source, { window: fakeWindow, document: fakeDocument, console: { error: vi.fn() }, setTimeout });
    return { fakeWindow, saveButton, notice, imageWarning, pages, pdf, pdfBlob, from, write, close, classes, listeners, pageCount: () => pageCount };
  }

  it("exports each employee as one A4 page in one PDF", async () => {
    const h = toolbarHarness(600);
    await h.fakeWindow.saveDocAsPdf!();
    expect(h.from.mock.calls.map((call) => call[0])).toEqual(h.pages);
    expect(h.pageCount()).toBe(2);
    expect(h.pdf.addImage).toHaveBeenCalledTimes(2);
    expect(h.write).toHaveBeenCalledWith(h.pdfBlob);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.saveButton.disabled).toBe(false);
    expect(h.classes.has("payslip-print-pending")).toBe(false);
  });

  it("refuses an unreadably dense payslip without writing a cropped PDF", async () => {
    const h = toolbarHarness(3000);
    await h.fakeWindow.saveDocAsPdf!();
    expect(h.from).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.saveButton.disabled).toBe(false);
    expect(h.notice.textContent).toContain("للموظف #1");
    h.listeners.beforeprint();
    expect(h.classes.has("payslip-print-invalid")).toBe(true);
  });

  it("restores the save button and reports an asset loading timeout", async () => {
    const h = toolbarHarness(600, true);
    await h.fakeWindow.saveDocAsPdf!();
    expect(h.from).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.saveButton.disabled).toBe(false);
    expect(h.notice.textContent).toContain("تعذّر تحميل خط القسيمة أو صورتها");
    expect(h.classes.has("payslip-print-pending")).toBe(true);
  });

  it("warns when the logo fails while allowing PDF export", async () => {
    const h = toolbarHarness(600, false, true);
    await h.fakeWindow.saveDocAsPdf!();
    expect(h.imageWarning.textContent).toContain("سيصدر المستند دون شعار");
    expect(h.write).toHaveBeenCalledWith(h.pdfBlob);
    expect(h.saveButton.disabled).toBe(false);
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

describe("docFooter - تخصيص تذييل المستند عبر إعدادات المنشأة", () => {
  it("يطبق سطر التذييل المخصص الممرر عبر CompanySettings", () => {
    const footerHtml = docFooter({
      footerLine: "بغداد — الكرادة · هاتف الإدارة: 07700000000",
    });

    expect(footerHtml).toContain("بغداد — الكرادة · هاتف الإدارة: 07700000000");
  });
});

describe("infoCards & isCardPaymentMethod — شعارا Visa و Mastercard لحقول الدفع والصرف والاسترداد", () => {
  it("يدرج شعار البطاقة في infoCards لحقول طريقة الدفع وطريقة الصرف وطريقة الاسترداد", () => {
    const html = infoCards([
      {
        title: "بيانات السند",
        variant: "green",
        fields: [
          { label: "طريقة الصرف", value: "بطاقة" },
          { label: "طريقة الاسترداد", value: "استرداد بالبطاقة" },
        ],
      },
    ]);

    expect(html).toContain("/visa-mastercard.png");
    expect(html).toContain("طريقة الصرف");
    expect(html).toContain("طريقة الاسترداد");
    expect(html).toContain("استرداد بالبطاقة");
  });

  it("يتعرف على صيغ الدفع والاسترداد بالبطاقة ويستثني فئات المنتجات مثل بطاقة هدية", () => {
    expect(isCardPaymentMethod("CARD")).toBe(true);
    expect(isCardPaymentMethod("بطاقة")).toBe(true);
    expect(isCardPaymentMethod("استرداد بالبطاقة")).toBe(true);
    expect(isCardPaymentMethod("عند الاستلام (COD) — عربون بطاقة")).toBe(true);
    expect(isCardPaymentMethod("بطاقة وارد")).toBe(true);
    expect(isCardPaymentMethod("نقدي")).toBe(false);
    expect(isCardPaymentMethod("بطاقة هدية")).toBe(false);
    expect(isCardPaymentMethod("بطاقات رقمية")).toBe(false);
  });

  it("يدرج شعاري Visa و Mastercard في فاتورة المبيعات A4 ذات الدفع المختلط عند وجود دفعة بالبطاقة", () => {
    const html = buildSalesInvoiceV2Html({
      invoiceNumber: "INV-MIX-1",
      invoiceDate: "2026-10-22",
      customerName: "عميل دفع مختلط",
      paymentMethod: "مختلطة",
      paymentLegs: [
        { method: "نقدي", amount: 20000 },
        { method: "بطاقة", amount: 30000, reference: "POS-7788" },
      ],
      subtotal: 50000,
      total: 50000,
      items: [{ productName: "قرطاسية", quantity: 1, unitPrice: 50000, total: 50000 }],
    });

    expect(html).toContain("دفعة (بطاقة)");
    expect(html).toContain("/visa-mastercard.png");
  });
});



import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./brand", async () => {
  const actual = await vi.importActual<typeof import("./brand")>("./brand");
  return {
    ...actual,
    logoUrl: () => "/logo.png",
    openPrintWindow: vi.fn(() => true),
  };
});

import { openPrintWindow } from "./brand";
import { printBrowserReceipt, printShiftCloseBrowser, printInvoiceA4 } from "./printTemplates";
import { resolveQrUrl } from "./render";
import * as qrModule from "./qr";
import { printA4Invoice } from "./a4Invoice";
import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";
import { RGBLuminanceSource, BinaryBitmap, HybridBinarizer, QRCodeReader } from "@zxing/library";

describe("printShiftCloseBrowser — عقد الطباعة الحرارية", () => {
  beforeEach(() => vi.mocked(openPrintWindow).mockClear());

  it("ينتظر الخطوط والصور ويطبع داخل عرض Epson الفعلي مع عزل RTL", () => {
    printShiftCloseBrowser({
      shiftId: 398,
      openedAt: "2026-08-31T09:58:00.000Z",
      closedAt: new Date("2026-08-31T10:05:00.000Z"),
      cashierName: "احمد خالد الزبيدي",
      branchName: "الفرع الرئيسي",
      openingBalance: 0,
      invoiceCount: 0,
      salesTotal: 0,
      payments: [],
      expectedCash: 0,
      countedCash: 0,
      variance: 0,
    });

    expect(openPrintWindow).toHaveBeenCalledOnce();
    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).toContain("@page{size:auto;margin:0}");
    expect(html).toContain("width:72mm");
    expect(html).toContain("direction:rtl");
    expect(html).toContain("unicode-bidi:isolate");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("min-height:27px");
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("document.fonts.ready");
    expect(html).toContain("Promise.all");
    expect(html).not.toContain('body onload="window.print()');
  });
});

describe("printBrowserReceipt — إفصاح مبالغ التوصيل", () => {
  beforeEach(() => vi.mocked(openPrintWindow).mockClear());

  it("فاتورة مدفوعة مسبقاً بالكامل مع توصيل COURIER تطلب فقط أجرة التوصيل وتفصح عن السداد المسبق", () => {
    printBrowserReceipt({
      receiptNumber: "INV-100",
      date: "2026-09-24",
      time: "12:00",
      items: [{ name: "بضاعة", quantity: 1, price: "50000", total: "50000" }],
      subtotal: "50000",
      total: "50000",
      paid: "50000",
      delivery: {
        partyName: "شركة البراق",
        fee: "5000",
        feeCollection: "COURIER",
        address: "البصرة",
      },
    });

    expect(openPrintWindow).toHaveBeenCalledOnce();
    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).not.toContain("55,000");
    expect(html).toContain("يدفع الزبون (أجرة التوصيل فقط)");
    expect(html).toContain("5,000 د.ع");
    expect(html).toContain("البضاعة مدفوعة مسبقاً بالكامل");
  });

  it("فاتورة مدفوعة مسبقاً بالكامل مع توصيل COUNTER تظهر المطلوب 0 د.ع مدفوع بالكامل", () => {
    printBrowserReceipt({
      receiptNumber: "INV-101",
      date: "2026-09-24",
      time: "12:00",
      items: [{ name: "بضاعة", quantity: 1, price: "50000", total: "50000" }],
      subtotal: "50000",
      total: "50000",
      paid: "50000",
      delivery: {
        partyName: "مندوب",
        fee: "5000",
        feeCollection: "COUNTER",
        address: "النجف",
      },
    });

    expect(openPrintWindow).toHaveBeenCalledOnce();
    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).toContain("المطلوب من الزبون");
    expect(html).toContain("0 د.ع (مدفوع بالكامل)");
  });
});

describe("printInvoiceA4 — توليد روابط QR للتحقق الرقمي", () => {
  beforeEach(() => vi.mocked(openPrintWindow).mockClear());

  it("يولّد رمز QR مع رابط تحقق scannable افتراضياً", async () => {
    await printInvoiceA4({
      invoiceNumber: "INV-2026-0001",
      invoiceDate: "2026-09-29",
      customerName: "عميل تجربة",
      subtotal: "50000",
      total: "50000",
      paidAmount: "50000",
      items: [
        {
          productName: "دفتر تجارب",
          quantity: 2,
          unitPrice: 25000,
          total: 50000,
        },
      ],
    });

    expect(openPrintWindow).toHaveBeenCalledOnce();
    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).toContain("<svg");
    // يتضمّن رابط التحقق الرقمي ولا يعود للنص الخام المتعدد الأسطر القديم
    expect(html).not.toContain("رقم الفاتورة: INV-2026-0001\nالتاريخ:");
  });

  it("يحترم qrPayload المشفر عند تمريره من الخادم", async () => {
    const customPayload = "INV|INV-2026-0002|2026-09-29|50000|1|abcdef123456";
    await printInvoiceA4({
      invoiceNumber: "INV-2026-0002",
      invoiceDate: "2026-09-29",
      subtotal: "50000",
      total: "50000",
      paidAmount: "50000",
      qrPayload: customPayload,
      items: [],
    });

    expect(openPrintWindow).toHaveBeenCalledOnce();
    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).toContain("<svg");
  });

  it("يحترم qrUrl المباشر عند تمريره", async () => {
    const customUrl = "https://custom.domain.com/verify?ref=INV-2026-0003";
    await printInvoiceA4({
      invoiceNumber: "INV-2026-0003",
      invoiceDate: "2026-09-29",
      subtotal: "50000",
      total: "50000",
      paidAmount: "50000",
      qrUrl: customUrl,
      items: [],
    });

    expect(openPrintWindow).toHaveBeenCalledOnce();
    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).toContain("<svg");
  });
});

describe("resolveQrUrl — معالجة الروابط وحالات الحافة", () => {
  it("يبقي الروابط المطلقة كما هي", () => {
    expect(resolveQrUrl("https://example.com/verify?ref=123")).toBe("https://example.com/verify?ref=123");
    expect(resolveQrUrl("http://localhost:5173/verify?payload=abc")).toBe("http://localhost:5173/verify?payload=abc");
  });

  it("يدعم المسارات النسبية بأمان", () => {
    const res = resolveQrUrl("/verify?ref=ORD-100009");
    expect(res).toContain("/verify?ref=ORD-100009");
  });

  it("يُحوّل المعرّف الخام أو payload إلى رابط تحقق", () => {
    const res = resolveQrUrl("ORD-100009");
    expect(res).toContain("/verify?payload=ORD-100009");
  });

  it("يُعيد نصاً فارغاً عند تمرير مدخل فارغ", () => {
    expect(resolveQrUrl("")).toBe("");
  });

  it("يمنع التشفير المزدوج عند تمرير مسار نسبي يحوي معلمات مشفرة", () => {
    const res = resolveQrUrl("/verify?ref=ORD%20100&branch=2");
    expect(res).toBe("/verify?ref=ORD%20100&branch=2");
    expect(res).not.toContain("%2520");
    expect(res).not.toContain("/verify?payload=");
  });

  it("يُعالج النصوص العربية والرموز الخاصة بأمان في payload", () => {
    const res = resolveQrUrl("فاتورة 100#1&2");
    expect(res).toBe(`/verify?payload=${encodeURIComponent("فاتورة 100#1&2")}`);
    expect(res).toContain("%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9");
  });
});

/** مساعدة تجريبية لفك تشفير مصفوفة QR من مسار SVG المتزامن عبر ZXing */
function decodeQrSyncSvg(svg: string): string {
  const viewBoxMatch = svg.match(/viewBox=["']0 0 (\d+) (\d+)["']/);
  if (!viewBoxMatch) throw new Error("No viewBox found in SVG");
  const total = parseInt(viewBoxMatch[1]!, 10);
  const scale = 8;
  const border = 4;
  const fullSize = (total + border * 2) * scale;
  const lumArray = new Uint8ClampedArray(fullSize * fullSize);
  lumArray.fill(255);
  const dMatch = svg.match(/d=["']([^"']+)["']/);
  if (!dMatch) throw new Error("No path d found in SVG");
  const regex = /M(\d+),(\d+)h1v1h-1z/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(dMatch[1]!)) !== null) {
    const c = parseInt(m[1]!, 10);
    const r = parseInt(m[2]!, 10);
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        lumArray[((r + border) * scale + dy) * fullSize + (c + border) * scale + dx] = 0;
      }
    }
  }
  const lum = new RGBLuminanceSource(lumArray, fullSize, fullSize);
  const bitmap = new BinaryBitmap(new HybridBinarizer(lum));
  const reader = new QRCodeReader();
  return reader.decode(bitmap).getText();
}

describe("printInvoiceA4 — فحص عدائي لمدخلات QR ومحتوى SVG", () => {
  beforeEach(() => {
    vi.mocked(openPrintWindow).mockClear();
  });

  it("يُمرّر رابط /verify المشفر إلى qrCodeSvg ولا يتضمن نصاً عربياً خاماً", async () => {
    const spy = vi.spyOn(qrModule, "qrCodeSvg");
    await printInvoiceA4({
      invoiceNumber: "INV/2026/09 #1 & 2",
      invoiceDate: "2026-09-29",
      customerName: "زبون تجريبي",
      subtotal: "75000",
      total: "75000",
      paidAmount: "75000",
      items: [
        {
          productName: "مادة تجربة",
          quantity: 1,
          unitPrice: 75000,
          total: 75000,
        },
      ],
    });

    expect(spy).toHaveBeenCalled();
    const calledUrl = spy.mock.calls[0]?.[0] ?? "";
    expect(calledUrl).toContain("/verify?ref=INV%2F2026%2F09%20%231%20%26%202");
    expect(/رقم الفاتورة/.test(calledUrl)).toBe(false);

    const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
    expect(html).toContain("<svg");
    expect(html).not.toContain("رقم الفاتورة: INV/2026/09 #1 & 2\nالتاريخ:");
    spy.mockRestore();
  });

  it("يحترم الأصل (origin) عند توفر window.location.origin", async () => {
    const origWindow = global.window;
    try {
      global.window = {
        location: { origin: "https://erp.alroyah.iq" },
      } as any;

      const spy = vi.spyOn(qrModule, "qrCodeSvg");
      await printInvoiceA4({
        invoiceNumber: "INV-9988",
        invoiceDate: "2026-09-29",
        subtotal: "10000",
        total: "10000",
        items: [],
      });

      const calledUrl = spy.mock.calls[0]?.[0] ?? "";
      expect(calledUrl).toBe("https://erp.alroyah.iq/verify?ref=INV-9988");
      spy.mockRestore();
    } finally {
      global.window = origWindow;
    }
  });

  it("يُحوّل qrPayload الخام إلى رابط تحقق بدلاً من تشفير الرموز الخام مباشرة", async () => {
    const spy = vi.spyOn(qrModule, "qrCodeSvg");
    const rawHmac = "INV|1001|2026-09-29|50000|1|hmac_test_sig";
    await printInvoiceA4({
      invoiceNumber: "INV-1001",
      invoiceDate: "2026-09-29",
      subtotal: "50000",
      total: "50000",
      qrPayload: rawHmac,
      items: [],
    });

    const calledUrl = spy.mock.calls[0]?.[0] ?? "";
    expect(calledUrl).toBe(`/verify?payload=${encodeURIComponent(rawHmac)}`);
    expect(calledUrl).not.toBe(rawHmac);
    spy.mockRestore();
  });
});

describe("a4Invoice — التحقق التجريبي وفك تشفير رمز QR في الفاتورة الرسمية", () => {
  it("يُضمّن رمز QR يربط بـ /verify ويفك تشفيره تجريبياً عبر ZXing", () => {
    const writtenHtmls: string[] = [];
    const mockIframe: any = {
      style: {},
      contentWindow: {
        document: {
          open: vi.fn(),
          write: vi.fn((html: string) => writtenHtmls.push(html)),
          close: vi.fn(),
        },
        focus: vi.fn(),
        print: vi.fn(),
      },
    };

    const origDoc = global.document;
    try {
      global.document = {
        createElement: vi.fn((tag: string) => (tag === "iframe" ? mockIframe : ({} as any))),
        body: {
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        } as any,
      } as any;

      printA4Invoice({
        invoiceNumber: "INV-A4-777",
        invoiceDate: "2026-09-29",
        customerName: "شركة الرؤية التجريبية",
        subtotal: "120000",
        total: "120000",
        paidAmount: "120000",
        items: [
          {
            productName: "أقلام حبر فاخرة",
            quantity: 10,
            unitPrice: 12000,
            total: 120000,
          },
        ],
      });

      expect(writtenHtmls.length).toBeGreaterThan(0);
      const html = writtenHtmls[0]!;
      expect(html).toContain('class="qr"');
      expect(html.includes("رقم الفاتورة: INV-A4-777\nالتاريخ:")).toBe(false);

      const svgMatch = html.match(/<svg[^>]*>[\s\S]*?<\/svg>/);
      expect(svgMatch).toBeTruthy();
      const svg = svgMatch![0];

      const decodedUrl = decodeQrSyncSvg(svg);
      expect(decodedUrl).toBe("/verify?ref=INV-A4-777");
    } finally {
      global.document = origDoc;
    }
  });

  it("يحترم qrPayload المشفر ويفك تشفيره إلى رابط /verify?payload=...", () => {
    const writtenHtmls: string[] = [];
    const mockIframe: any = {
      style: {},
      contentWindow: {
        document: {
          open: vi.fn(),
          write: vi.fn((html: string) => writtenHtmls.push(html)),
          close: vi.fn(),
        },
        focus: vi.fn(),
        print: vi.fn(),
      },
    };

    const origDoc = global.document;
    try {
      global.document = {
        createElement: vi.fn((tag: string) => (tag === "iframe" ? mockIframe : ({} as any))),
        body: {
          appendChild: vi.fn(),
          removeChild: vi.fn(),
        } as any,
      } as any;

      printA4Invoice({
        invoiceNumber: "INV-A4-888",
        invoiceDate: "2026-09-29",
        subtotal: "50000",
        total: "50000",
        qrPayload: "ORD-100009",
        items: [],
      });

      const html = writtenHtmls[0]!;
      const svgMatch = html.match(/<svg[^>]*>[\s\S]*?<\/svg>/);
      expect(svgMatch).toBeTruthy();
      const svg = svgMatch![0];

      const decodedUrl = decodeQrSyncSvg(svg);
      expect(decodedUrl).toBe("/verify?payload=ORD-100009");
    } finally {
      global.document = origDoc;
    }
  });
});

describe("BarcodeDisplay — توليد SVG مع رابط scannable عبر resolveQrUrl", () => {
  it("يُمرّر الرابط المحلول لـ qrCodeSvg بدلاً من الحمولة الخام ويُنشئ SVG", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      url: "https://bms.vision.iq",
    });
    const origWindow = global.window;
    const origDoc = global.document;
    const origHTMLElement = global.HTMLElement;
    const origReact = (global as any).React;

    try {
      global.window = dom.window as any;
      global.document = dom.window.document as any;
      global.HTMLElement = dom.window.HTMLElement as any;
      (global as any).React = React;
      (global as any).IS_REACT_ACT_ENVIRONMENT = true;

      const spy = vi.spyOn(qrModule, "qrCodeSvg");
      const rootEl = dom.window.document.getElementById("root")!;
      const root = createRoot(rootEl);

      const rawPayload = "INV|1001|2026-09-29|50000|1|hmac_signature_xyz";
      await act(async () => {
        root.render(
          React.createElement(BarcodeDisplay, {
            barcodeSet: {
              barcode128: "INV-1001",
              qrPayload: rawPayload,
              displayLabel: "INV-1001\n2026-09-29",
            },
          }),
        );
      });

      expect(spy).toHaveBeenCalled();
      const passedUrl = spy.mock.calls[0]?.[0];
      // يجب أن يكون رابطاً قابلاً للمسح (scannable URL) وليس الحمولة الخام المجردة
      expect(passedUrl).toBe(`https://bms.vision.iq/verify?payload=${encodeURIComponent(rawPayload)}`);
      expect(passedUrl).not.toBe(rawPayload);

      // التأكد من أن DOM يحوي عنصر SVG للباركود
      expect(rootEl.innerHTML).toContain("<svg");
      spy.mockRestore();
    } finally {
      global.window = origWindow;
      global.document = origDoc;
      global.HTMLElement = origHTMLElement;
      (global as any).React = origReact;
      delete (global as any).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it("يحترم الروابط النسبية الصريحة دون تشفير مزدوج", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      url: "https://bms.vision.iq",
    });
    const origWindow = global.window;
    const origDoc = global.document;
    const origHTMLElement = global.HTMLElement;
    const origReact = (global as any).React;

    try {
      global.window = dom.window as any;
      global.document = dom.window.document as any;
      global.HTMLElement = dom.window.HTMLElement as any;
      (global as any).React = React;
      (global as any).IS_REACT_ACT_ENVIRONMENT = true;

      const spy = vi.spyOn(qrModule, "qrCodeSvg");
      const rootEl = dom.window.document.getElementById("root")!;
      const root = createRoot(rootEl);

      await act(async () => {
        root.render(
          React.createElement(BarcodeDisplay, {
            barcodeSet: {
              barcode128: "ORD-100009",
              qrPayload: "/verify?ref=ORD-100009",
              displayLabel: "ORD-100009",
            },
          }),
        );
      });

      expect(spy).toHaveBeenCalled();
      const passedUrl = spy.mock.calls[0]?.[0];
      expect(passedUrl).toBe("https://bms.vision.iq/verify?ref=ORD-100009");
      expect(passedUrl).not.toContain("payload=");
      spy.mockRestore();
    } finally {
      global.window = origWindow;
      global.document = origDoc;
      global.HTMLElement = origHTMLElement;
      (global as any).React = origReact;
      delete (global as any).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});



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
import { printBrowserReceipt, printShiftCloseBrowser } from "./printTemplates";

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

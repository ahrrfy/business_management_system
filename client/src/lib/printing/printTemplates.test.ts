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
import { printShiftCloseBrowser } from "./printTemplates";

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
    expect(html).toContain("grid-template-columns:minmax(0,1fr) 34px 88px");
    expect(html).toContain("document.fonts.ready");
    expect(html).toContain("Promise.all");
    expect(html).not.toContain('body onload="window.print()');
  });
});

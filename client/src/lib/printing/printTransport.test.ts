import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptBrowserData } from "./printTemplates";

const mocks = vi.hoisted(() => ({
  docToHtml: vi.fn(),
  docToRaster: vi.fn(),
  printHtml: vi.fn(),
  isPaired: vi.fn(),
  sendBytes: vi.fn(),
  tryReconnectPrinter: vi.fn(),
  isWebUsbSupported: vi.fn(),
  isServerBridgeEnabled: vi.fn(),
  sendRawToServer: vi.fn(),
  receiptToRaster: vi.fn(),
  printBrowserReceipt: vi.fn(),
}));

vi.mock("./render", () => ({
  docToHtml: mocks.docToHtml,
  docToRaster: mocks.docToRaster,
  printHtml: mocks.printHtml,
}));

vi.mock("./thermal", () => ({
  isPaired: mocks.isPaired,
  sendBytes: mocks.sendBytes,
  tryReconnectPrinter: mocks.tryReconnectPrinter,
  isWebUsbSupported: mocks.isWebUsbSupported,
  pairPrinter: vi.fn(),
}));

vi.mock("./serverBridge", () => ({
  isServerBridgeEnabled: mocks.isServerBridgeEnabled,
  sendRawToServer: mocks.sendRawToServer,
  getServerBridgeStatus: vi.fn(),
  serverPrintTest: vi.fn(),
}));

vi.mock("./receiptRaster", () => ({ receiptToRaster: mocks.receiptToRaster }));

vi.mock("./printTemplates", () => ({
  printBrowserReceipt: mocks.printBrowserReceipt,
  printBarcodeSheet: vi.fn(),
  printBrowserWorkOrderReceipt: vi.fn(),
  printShiftOpenBrowser: vi.fn(),
  printShiftCloseBrowser: vi.fn(),
}));

import { printDoc, printReceipt } from "./print";

const doc = {
  kind: "opening" as const,
  title: "سند اختبار",
  meta: ["مرجع 1"],
};

const receipt: ReceiptBrowserData = {
  receiptNumber: "INV-1",
  date: "2026-08-27",
  items: [{ name: "دفتر", quantity: 1, price: "1000", total: "1000" }],
  subtotal: "1000",
  total: "1000",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isServerBridgeEnabled.mockResolvedValue(false);
  mocks.isPaired.mockReturnValue(false);
  mocks.isWebUsbSupported.mockReturnValue(false);
  mocks.docToHtml.mockResolvedValue("<html></html>");
  mocks.docToRaster.mockResolvedValue({ width: 8, height: 1, data: new Uint8Array([0]) });
  mocks.receiptToRaster.mockResolvedValue({ width: 8, height: 1, data: new Uint8Array([0]) });
  mocks.printHtml.mockReturnValue(true);
  mocks.printBrowserReceipt.mockReturnValue(true);
});

describe("print transport fallback", () => {
  it("يتراجع printDoc إلى المتصفح عند فشل WebUSB", async () => {
    mocks.isPaired.mockReturnValue(true);
    mocks.sendBytes.mockRejectedValue(new Error("open(): Access denied"));

    await expect(printDoc(doc)).resolves.toEqual({ via: "browser", ok: true });
    expect(mocks.sendBytes).toHaveBeenCalledOnce();
    expect(mocks.printHtml).toHaveBeenCalledWith("<html></html>");
  });

  it("يعيد printDoc فشل popup صراحةً", async () => {
    mocks.printHtml.mockReturnValue(false);

    await expect(printDoc(doc)).resolves.toEqual({
      via: "browser",
      ok: false,
      reason: "popup-blocked",
    });
  });

  it("يعيد printReceipt فشل popup صراحةً", async () => {
    mocks.printBrowserReceipt.mockReturnValue(false);

    await expect(printReceipt(receipt)).resolves.toEqual({
      via: "browser",
      ok: false,
      reason: "popup-blocked",
    });
  });
});

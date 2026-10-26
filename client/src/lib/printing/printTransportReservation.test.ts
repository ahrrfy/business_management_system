// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as brand from "./brand";
import * as render from "./render";
import { printDoc, printReceipt } from "./print";
import { printDeliveryDispatchSlipAsync } from "./printDeliveryDispatchSlip";
import { EscPos } from "./escpos";
import type { ReceiptBrowserData } from "./printTemplates";
import { printInvoiceA4 } from "./printTemplates";
import {
  buildCompanyStatementReceiptDoc,
  renderCompanyStatementReceiptHtml,
  printCompanyStatementReceiptAsync,
} from "./printCompanyStatementReceipt";

const hardware = vi.hoisted(() => ({
  bridge: vi.fn(),
  sendServer: vi.fn(),
  paired: vi.fn(),
  sendUsb: vi.fn(),
  reconnect: vi.fn(),
  supported: vi.fn(),
  receiptRaster: vi.fn(),
}));
vi.mock("./serverBridge", () => ({
  isServerBridgeEnabled: hardware.bridge,
  sendRawToServer: hardware.sendServer,
  getServerBridgeStatus: vi.fn(),
  serverPrintTest: vi.fn(),
}));
vi.mock("./thermal", () => ({
  isPaired: hardware.paired,
  sendBytes: hardware.sendUsb,
  tryReconnectPrinter: hardware.reconnect,
  isWebUsbSupported: hardware.supported,
  pairPrinter: vi.fn(),
}));
vi.mock("./receiptRaster", () => ({ receiptToRaster: hardware.receiptRaster }));

function popup() {
  const document = {
    open: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
    getElementById: vi.fn(() => null),
  };
  return {
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    print: vi.fn(),
    document,
  } as unknown as Window;
}
const doc = {
  kind: "receipt" as const,
  title: "بوليصة محجوزة",
  meta: ["مرجع اختبار"],
};
const receipt: ReceiptBrowserData = {
  receiptNumber: "INV-RESERVED-1",
  date: "2026-10-26",
  items: [{ name: "دفتر", quantity: 1, price: "1000", total: "1000" }],
  subtotal: "1000",
  total: "1000",
};
let open: MockInstance<typeof window.open>;
beforeEach(() => {
  vi.clearAllMocks();
  hardware.bridge.mockResolvedValue(false);
  hardware.paired.mockReturnValue(false);
  hardware.supported.mockReturnValue(false);
  hardware.sendServer.mockResolvedValue(undefined);
  hardware.sendUsb.mockResolvedValue(undefined);
  hardware.receiptRaster.mockResolvedValue({
    width: 8,
    height: 1,
    data: new Uint8Array([0]),
  });
  open = vi.spyOn(window, "open").mockImplementation(() => popup());
});
afterEach(() => {
  brand.releaseReservedPrintWindow();
  vi.restoreAllMocks();
});

describe("explicit print window reservation", () => {
  it("keeps company settlement time unknown and prints the copy time separately", () => {
    const receipt = {
      companyName: "شركة التوصيل",
      statementNumber: "STMT-1",
      remittanceNumber: "RM-1",
      deliveriesConfirmed: 1,
      collectedTotal: "1000.00",
      netRemitted: "900.00",
      printedAt: new Date("2031-03-04T09:10:00Z"),
    };
    const doc = buildCompanyStatementReceiptDoc(receipt);
    expect(doc.meta).toContain("تاريخ التسوية: غير متاح في السجل");
    expect(doc.meta.find((line) => line.startsWith("وقت الطباعة:"))).toContain(
      "2031",
    );
    const html = renderCompanyStatementReceiptHtml(receipt);
    expect(html).toContain("غير متاح في السجل");
    expect(html).toContain("2031");
  });

  it("honors company statement explicit reservations and blocked popups", async () => {
    const receipt = {
      companyName: "شركة التوصيل",
      statementNumber: "STMT-1",
      remittanceNumber: "RM-1",
      deliveriesConfirmed: 1,
      collectedTotal: "1000.00",
      netRemitted: "900.00",
    };
    const reserved = popup();
    await expect(
      printCompanyStatementReceiptAsync(receipt, { into: reserved }),
    ).resolves.toEqual({ via: "browser", ok: true });
    expect(reserved.document.write).toHaveBeenCalledWith(
      expect.stringContaining("STMT-1"),
    );
    await expect(
      printCompanyStatementReceiptAsync(receipt, { into: null }),
    ).resolves.toEqual({ via: "browser", ok: false, reason: "popup-blocked" });
    expect(open).not.toHaveBeenCalled();
  });
  it("writes the document into its reserved window after asynchronous transport discovery without opening another popup", async () => {
    const reserved = popup();
    let resolveStatus!: (enabled: boolean) => void;
    hardware.bridge.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const pending = printDoc(doc, { into: reserved });
    expect(open).not.toHaveBeenCalled();
    resolveStatus(false);
    await expect(pending).resolves.toEqual({ via: "browser", ok: true });
    expect(reserved.document.write).toHaveBeenCalledWith(
      expect.stringContaining(doc.title),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it.each([null, "closed"] as const)(
    "reports blocked reservation %s without opening a replacement",
    async (kind) => {
      const reserved =
        kind === null ? null : Object.assign(popup(), { closed: true });
      await expect(printDoc(doc, { into: reserved })).resolves.toEqual({
        via: "browser",
        ok: false,
        reason: "popup-blocked",
      });
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit windows independent of the legacy singleton reservation", () => {
    const legacy = popup();
    vi.mocked(window.open).mockReturnValueOnce(legacy);
    expect(brand.reservePrintWindow()).toBe(true);
    const explicit = popup();
    expect(
      brand.openPrintWindow("<p>explicit</p>", undefined, { into: explicit }),
    ).toBe(true);
    expect(explicit.document.write).toHaveBeenCalledWith("<p>explicit</p>");
    expect(brand.openPrintWindow("<p>legacy</p>")).toBe(true);
    expect(legacy.document.write).toHaveBeenCalledWith("<p>legacy</p>");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("preopens an independent document window without replacing a legacy reservation", () => {
    const legacy = popup();
    vi.mocked(window.open).mockReturnValueOnce(legacy);
    brand.reservePrintWindow();
    const independent = popup();
    vi.mocked(window.open).mockReturnValueOnce(independent);
    expect(typeof brand.preopenDocumentWindow).toBe("function");
    expect(brand.preopenDocumentWindow("width=380,height=640")).toBe(
      independent,
    );
    expect(legacy.close).not.toHaveBeenCalled();
    brand.openPrintWindow("<p>legacy remains available</p>");
    expect(legacy.document.write).toHaveBeenCalledWith(
      "<p>legacy remains available</p>",
    );
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("passes a dispatch slip through the same reserved browser transport", async () => {
    const reserved = popup();
    await expect(
      printDeliveryDispatchSlipAsync(
        {
          consignmentNumber: "CN-100001",
          orderNumber: "INV-1",
          partyName: "مندوب",
          recipientName: "عميل",
          recipientPhone: "07700000000",
          deliveryAddress: "بغداد",
          salePrice: "1000",
          codAmount: "1000",
          deliveryFee: "0",
          feeCollection: "SHOP",
        },
        { into: reserved },
      ),
    ).resolves.toEqual({ via: "browser", ok: true });
    expect(reserved.document.write).toHaveBeenCalledWith(
      expect.stringContaining("CN-100001"),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps invoice browser reservation when hardware paired=%s",
    async (paired) => {
      hardware.paired.mockReturnValue(paired);
      if (paired)
        hardware.sendUsb.mockRejectedValueOnce(new Error("USB disconnected"));
      const reserved = popup();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(
        printReceipt(receipt, { into: reserved, openDrawer: false }),
      ).resolves.toEqual({ via: "browser", ok: true });
      expect(reserved.document.write).toHaveBeenCalledWith(
        expect.stringContaining("INV-RESERVED-1"),
      );
      expect(open).not.toHaveBeenCalled();
      warning.mockRestore();
    },
  );

  it("does not retry a blocked invoice reservation with a new popup", async () => {
    await expect(
      printReceipt(receipt, { into: null, openDrawer: false }),
    ).resolves.toEqual({ via: "browser", ok: false, reason: "popup-blocked" });
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps the A4 invoice adapter's reservation through asynchronous QR preparation", async () => {
    const reserved = popup();
    await expect(
      printInvoiceA4(
        {
          invoiceNumber: "INV-A4-RESERVED",
          invoiceDate: "2026-10-26",
          items: [
            {
              productName: "دفتر",
              quantity: 1,
              unitPrice: "1000",
              total: "1000",
            },
          ],
          subtotal: "1000",
          total: "1000",
        },
        { into: reserved },
      ),
    ).resolves.toBe(true);
    expect(reserved.document.write).toHaveBeenCalledWith(
      expect.stringContaining("INV-A4-RESERVED"),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("does not replace a blocked A4 invoice popup after QR preparation", async () => {
    await expect(
      printInvoiceA4(
        {
          invoiceNumber: "INV-A4-BLOCKED",
          items: [],
          subtotal: "0",
          total: "0",
        },
        { into: null },
      ),
    ).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["server", "thermal"] as const)(
    "closes the unused explicit fallback after %s document transport succeeds",
    async (via) => {
      vi.spyOn(render, "docToRaster").mockResolvedValue({
        width: 8,
        height: 1,
        data: new Uint8Array([0]),
      });
      hardware.bridge.mockResolvedValue(via === "server");
      hardware.paired.mockReturnValue(via === "thermal");
      const reserved = popup();
      await expect(printDoc(doc, { into: reserved })).resolves.toEqual({
        via,
        ok: true,
      });
      expect(reserved.close).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("closes the unused invoice fallback without opening the drawer on reprint", async () => {
    hardware.paired.mockReturnValue(true);
    const drawer = vi.spyOn(EscPos.prototype, "openDrawer");
    const reserved = popup();
    await expect(
      printReceipt(receipt, { into: reserved, openDrawer: false }),
    ).resolves.toEqual({ via: "thermal", ok: true });
    expect(drawer).not.toHaveBeenCalled();
    expect(reserved.close).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});

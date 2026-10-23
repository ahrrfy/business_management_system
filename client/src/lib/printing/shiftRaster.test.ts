import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShiftCloseData } from "./printTemplates";
import { shiftCloseToCanvas, shiftCloseToRaster } from "./shiftRaster";

type TextAlign = "left" | "right" | "center" | "start" | "end";

interface TextDraw {
  text: string;
  x: number;
  y: number;
  font: string;
  align: TextAlign;
  width: number;
  direction: string;
}

function fontSize(font: string): number {
  return Number(/(\d+)px/.exec(font)?.[1] ?? 16);
}

function horizontalBounds(draw: TextDraw): [number, number] {
  if (draw.align === "right" || draw.align === "end") return [draw.x - draw.width, draw.x];
  if (draw.align === "center") return [draw.x - draw.width / 2, draw.x + draw.width / 2];
  return [draw.x, draw.x + draw.width];
}

function makeCanvasHarness() {
  const draws: TextDraw[] = [];
  const context = {
    save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
    measureText(text: string) {
      return { width: Array.from(text).length * fontSize(this.font) * 0.55 };
    },
    fillText(text: string, x: number, y: number) {
      draws.push({
        text,
        x,
        y,
        font: this.font,
        align: this.textAlign,
        width: this.measureText(text).width,
        direction: this.direction,
      });
    },
    getImageData(_x: number, _y: number, width: number, height: number) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "start" as TextAlign,
    font: "16px sans-serif", textBaseline: "alphabetic", direction: "ltr",
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  return { canvas, context, draws };
}

afterEach(() => vi.unstubAllGlobals());

describe("shiftCloseToCanvas — عقد تخطيط الورق الحراري", () => {
  it("يبقي أعمدة الطريقة والعدد والمبلغ منفصلة على عرض 576 نقطة", async () => {
    const harness = makeCanvasHarness();
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => harness.canvas,
    });
    vi.stubGlobal("Image", class {
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });

    const fixture: ShiftCloseData = {
      shiftId: 398,
      openedAt: "2026-08-31T09:58:00.000Z",
      closedAt: new Date("2026-08-31T10:05:00.000Z"),
      cashierName: "احمد خالد الزبيدي",
      branchName: "الفرع الرئيسي",
      openingBalance: 0,
      invoiceCount: 12,
      salesTotal: 123_456_789,
      payments: [{ method: "CASH", direction: "IN", count: 12, total: 123_456_789 }],
      expectedCash: 123_456_789,
      countedCash: 123_456_789,
      variance: 0,
    };
    const drawn = await shiftCloseToCanvas(fixture);

    expect(drawn).not.toBeNull();
    expect(harness.canvas.width).toBe(576);
    expect(harness.context.direction).toBe("rtl");

    const amount = harness.draws.find((draw) => draw.text === "123,456,789");
    const count = harness.draws.find((draw) => draw.text === "12" && draw.y === amount?.y);
    const method = harness.draws.find((draw) => draw.text === "نقدي وارد");
    expect(amount).toBeDefined();
    expect(count).toBeDefined();
    expect(method).toBeDefined();
    expect(amount!.direction).toBe("ltr");
    expect(count!.direction).toBe("ltr");
    expect(method!.direction).toBe("rtl");

    const [amountLeft, amountRight] = horizontalBounds(amount!);
    const [countLeft, countRight] = horizontalBounds(count!);
    const [methodLeft, methodRight] = horizontalBounds(method!);
    expect(amountLeft).toBeGreaterThanOrEqual(16);
    expect(amountRight).toBeLessThan(countLeft);
    expect(countRight).toBeLessThan(methodLeft);
    expect(methodRight).toBeLessThanOrEqual(560);

    const finalInkBottom = Math.max(...harness.draws.map((draw) => draw.y + fontSize(draw.font) * 0.25));
    expect(finalInkBottom).toBeLessThanOrEqual(drawn!.height);
    expect(drawn!.height).toBeLessThan(harness.canvas.height);

    const raster = await shiftCloseToRaster(fixture);
    expect(raster).not.toBeNull();
    expect(raster!.width).toBe(576);
    expect(raster!.height).toBe(drawn!.height);
    expect(raster!.data).toHaveLength(Math.ceil(576 / 8) * drawn!.height);
  });

  it("يلف اسم مستلم العهدة ومرجعها الطويل وفق قياس الخط داخل عرض الورق", async () => {
    const harness = makeCanvasHarness();
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => harness.canvas,
    });
    vi.stubGlobal("Image", class {
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });

    const drawn = await shiftCloseToCanvas({
      shiftId: 399,
      openedAt: "2026-08-31T09:58:00.000Z",
      closedAt: new Date("2026-08-31T10:05:00.000Z"),
      cashierName: "كاشير",
      branchName: "الفرع الرئيسي",
      openingBalance: 0,
      invoiceCount: 1,
      salesTotal: 1000,
      payments: [{ method: "CASH", direction: "IN", count: 1, total: 1000 }],
      expectedCash: 1000,
      countedCash: 1000,
      variance: 0,
      treasuryReturn: {
        amount: 1000,
        referenceNumber: "REFERENCEREFERENCEREFERENCEREFERENCEREFERENCEREFERENCE",
      },
    });

    const handoverDraws = harness.draws.filter((draw) =>
      draw.text.includes("رقم سند الترحيل:") ||
      draw.text.includes("تم الترحيل") ||
      draw.text.includes("REFERENCE"),
    );
    expect(handoverDraws.length).toBeGreaterThanOrEqual(3);
    for (const draw of handoverDraws) {
      const [left, right] = horizontalBounds(draw);
      expect(left).toBeGreaterThanOrEqual(28);
      expect(right).toBeLessThanOrEqual(548);
    }
    expect(new Set(handoverDraws.map((draw) => draw.y)).size).toBe(handoverDraws.length);
    expect(Math.max(...harness.draws.map((draw) => draw.y))).toBeLessThanOrEqual(drawn!.height);
  });

  it("يرسم شعار فيزا وماستركارد في صف تفصيل الدفع بالبطاقة مع الحفاظ على فصل الأعمدة", async () => {
    const harness = makeCanvasHarness();
    const loadedSrcs: string[] = [];
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => harness.canvas,
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        loadedSrcs.push(value);
        queueMicrotask(() => this.onload?.());
      }
    });

    const drawn = await shiftCloseToCanvas({
      shiftId: 400,
      openedAt: "2026-08-31T09:58:00.000Z",
      closedAt: new Date("2026-08-31T10:05:00.000Z"),
      cashierName: "كاشير",
      branchName: "الفرع الرئيسي",
      openingBalance: 0,
      invoiceCount: 2,
      salesTotal: 50_000,
      payments: [
        { method: "CASH", direction: "IN", count: 1, total: 20_000 },
        { method: "CARD", direction: "IN", count: 1, total: 30_000 },
      ],
      expectedCash: 20_000,
      countedCash: 20_000,
      variance: 0,
    });

    expect(drawn).not.toBeNull();
    expect(loadedSrcs).toContain("/visa-mastercard.png");
    expect(harness.context.drawImage).toHaveBeenCalled();

    const cardMethod = harness.draws.find((draw) => draw.text === "بطاقة وارد");
    const cardAmount = harness.draws.find((draw) => draw.text === "30,000" && draw.y === cardMethod?.y);
    const cardCount = harness.draws.find((draw) => draw.text === "1" && draw.y === cardMethod?.y);
    expect(cardMethod).toBeDefined();
    expect(cardAmount).toBeDefined();
    expect(cardCount).toBeDefined();

    const [amountLeft, amountRight] = horizontalBounds(cardAmount!);
    const [countLeft, countRight] = horizontalBounds(cardCount!);
    const [methodLeft, methodRight] = horizontalBounds(cardMethod!);
    expect(amountLeft).toBeGreaterThanOrEqual(16);
    expect(amountRight).toBeLessThan(countLeft);
    expect(countRight).toBeLessThan(methodLeft);
    expect(methodRight).toBeLessThanOrEqual(560);
  });
});


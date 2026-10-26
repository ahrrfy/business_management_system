// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docToRaster, type PrintDoc } from "./render";

type Draw = { text: string; x: number; y: number; align: CanvasTextAlign };
let draws: Draw[];
beforeEach(() => {
  draws = [];
  const context = {
    font: "",
    fillStyle: "",
    textAlign: "right" as CanvasTextAlign,
    measureText: (text: string) => ({ width: text.length * 8 }),
    fillText(text: string, x: number, y: number) {
      draws.push({ text, x, y, align: this.textAlign });
    },
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("thermal table middle columns", () => {
  it("renders the quantity header and value between the item and amount", async () => {
    const doc: PrintDoc = {
      kind: "receipt",
      title: "بوليصة",
      meta: [],
      columns: ["البند", "الكمية", "المبلغ"],
      rows: [["دفتر", "17", "1,234.56"]],
    };
    expect(await docToRaster(doc)).not.toBeNull();
    expect(draws.map((draw) => draw.text)).toEqual(
      expect.arrayContaining([
        "البند",
        "الكمية",
        "المبلغ",
        "دفتر",
        "17",
        "1,234.56",
      ]),
    );
    const item = draws.find((draw) => draw.text === "دفتر")!;
    const quantity = draws.find((draw) => draw.text === "17")!;
    const amount = draws.find((draw) => draw.text === "1,234.56")!;
    expect(quantity.x).toBeLessThan(item.x);
    expect(quantity.x).toBeGreaterThan(amount.x);
    expect(quantity.y).toBe(item.y);
    expect(quantity.y).toBe(amount.y);
    expect(quantity.align).toBe("center");
  });

  it("keeps every middle column in a four-column table", async () => {
    await docToRaster({
      kind: "receipt",
      title: "بوليصة",
      meta: [],
      columns: ["الصنف", "الكمية", "السعر", "المجموع"],
      rows: [["قلم", "17", "500", "8500"]],
    });
    expect(draws.map((draw) => draw.text)).toEqual(
      expect.arrayContaining([
        "الصنف",
        "الكمية",
        "السعر",
        "المجموع",
        "قلم",
        "17",
        "500",
        "8500",
      ]),
    );
    const quantity = draws.find((draw) => draw.text === "17")!;
    const price = draws.find((draw) => draw.text === "500")!;
    expect(quantity.x).toBeGreaterThan(price.x);
    expect(quantity.y).toBe(price.y);
  });

  it("preserves two-column financial rows and all monetary digits", async () => {
    await docToRaster({
      kind: "receipt",
      title: "سند",
      meta: [],
      columns: ["البيان", "القيمة"],
      rows: [["المبلغ الأصلي", "1,234.56"]],
    });
    expect(draws.map((draw) => draw.text)).toEqual(
      expect.arrayContaining(["البيان", "القيمة", "المبلغ الأصلي", "1,234.56"]),
    );
    const amount = draws.find((draw) => draw.text === "1,234.56")!;
    expect(amount.align).toBe("left");
    expect(draws.some((draw) => draw.text.includes("…"))).toBe(false);
  });
});

// اختبارات لفّ نص أسماء الأصناف في الراسم الحراري المُعلَّم (الجزء النقي — بلا Canvas حقيقي)
import { afterEach, describe, expect, it, vi } from "vitest";
import { receiptToCanvas, wrapLines } from "./receiptRaster";

/** قياس زائف: عرض كل محرف = 10px ⇒ maxW=100 يستوعب 10 محارف */
const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) };

describe("wrapLines — لفّ أسماء الأصناف", () => {
  it("نص قصير يبقى سطراً واحداً كما هو", () => {
    expect(wrapLines(ctx, "قلم أزرق", 200)).toEqual(["قلم أزرق"]);
  });

  it("نص أطول من العرض يلتفّ على سطرين دون فقدان كلمات", () => {
    const lines = wrapLines(ctx, "دفتر مدرسي ٩٦ ورقة", 100);
    expect(lines.length).toBe(2);
    expect(lines.join(" ")).toBe("دفتر مدرسي ٩٦ ورقة");
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(100);
  });

  it("الفائض عن سطرين يُقصّ ويُختم آخر سطر بـ«…»", () => {
    const lines = wrapLines(ctx, "اسم منتج طويل جداً يتجاوز السطرين المسموحين في عمود الصنف", 100);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(100);
  });

  it("كلمة واحدة أعرض من العمود تُقصّ بـ«…» ضمن العرض", () => {
    const lines = wrapLines(ctx, "كلمةواحدةطويلةجداًبلامسافات", 100);
    expect(lines.length).toBe(1);
    expect(lines[0].endsWith("…")).toBe(true);
    expect(ctx.measureText(lines[0]).width).toBeLessThanOrEqual(100);
  });

  it("نص فارغ يعيد سطراً فارغاً واحداً (لا ينهار)", () => {
    expect(wrapLines(ctx, "", 100)).toEqual([""]);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("receiptToCanvas — سعة الإيصال", () => {
  it("لا يقصّ تذييل إيصال قصير يجمع الوردية والعربون والآجل والتوصيل", async () => {
    const context = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      arcTo: vi.fn(), closePath: vi.fn(),
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "start", font: "",
      textBaseline: "alphabetic", direction: "rtl",
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => canvas,
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });

    const drawn = await receiptToCanvas({
      receiptNumber: "INV-CLIP-1", date: "2026-08-11", time: "18:30",
      cashierName: "موظف الخدمة", customerName: "عميل الاختبار", shiftId: 12,
      items: [{ name: "دفتر", quantity: 1, price: "1000", total: "1000" }],
      subtotal: "1000", total: "1000", paymentMethod: "نقدي", paid: "250", change: "0",
      heldDeposits: "500", credit: "750",
      delivery: {
        partyName: "مندوب الاختبار", fee: "250", feeCollection: "COURIER",
        address: "بغداد — عنوان اختبار كامل",
      },
    });

    expect(drawn).not.toBeNull();
    expect(drawn!.height).toBeLessThan(canvas.height);
  });
});

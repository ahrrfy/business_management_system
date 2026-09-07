import { describe, expect, it } from "vitest";
import {
  findProductBoundingBox,
  findOpaqueProductBoundingBox,
  autoWhiteBalance,
  enhanceVibranceAndContrast,
  applyUnsharpMask,
} from "../studioEnhancer";

describe("studioEnhancer — محرك تحسين صور الاستوديو", () => {
  it("findProductBoundingBox يكتشف حدود المنتج بدقة من قناة الشفافية", () => {
    const W = 100;
    const H = 100;
    const alpha = new Uint8ClampedArray(W * H).fill(0);

    // ارسم كائناً في المربع [20..50] عرضاً و [30..70] ارتفاعاً
    for (let y = 30; y <= 70; y++) {
      for (let x = 20; x <= 50; x++) {
        alpha[y * W + x] = 255;
      }
    }

    const bbox = findProductBoundingBox(alpha, W, H);
    expect(bbox.hasContent).toBe(true);
    expect(bbox.minX).toBe(20);
    expect(bbox.maxX).toBe(50);
    expect(bbox.minY).toBe(30);
    expect(bbox.maxY).toBe(70);
    expect(bbox.width).toBe(31);
    expect(bbox.height).toBe(41);
  });

  it("findProductBoundingBox يتعامل بأمان مع مصفوفة ألفا فارغة", () => {
    const W = 50;
    const H = 50;
    const alpha = new Uint8ClampedArray(W * H).fill(0);
    const bbox = findProductBoundingBox(alpha, W, H);
    expect(bbox.hasContent).toBe(false);
  });

  it("autoWhiteBalance يعادل الصبغة اللونية الدافئة/الصفراء", () => {
    // أنشئ صورة وهمية صفراء فاقعة (R=200, G=190, B=100)
    const W = 20;
    const H = 20;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 200;     // R
      data[i + 1] = 190; // G
      data[i + 2] = 100; // B
      data[i + 3] = 255; // A
    }
    const mockImageData = { data, width: W, height: H } as unknown as ImageData;
    autoWhiteBalance(mockImageData);

    // الأزرق يجب أن يرتفع لمعادلة الاصفرار
    expect(data[2]).toBeGreaterThan(100);
  });

  it("enhanceVibranceAndContrast يعزز التباين دون كسر القيم (0-255)", () => {
    const W = 10;
    const H = 10;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 150;
      data[i + 1] = 80;
      data[i + 2] = 60;
      data[i + 3] = 255;
    }
    const mockImageData = { data, width: W, height: H } as unknown as ImageData;
    enhanceVibranceAndContrast(mockImageData, { vibrance: 0.3, contrast: 0.2 });

    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBeGreaterThanOrEqual(0);
      expect(data[i]).toBeLessThanOrEqual(255);
      expect(data[i + 1]).toBeGreaterThanOrEqual(0);
      expect(data[i + 1]).toBeLessThanOrEqual(255);
      expect(data[i + 2]).toBeGreaterThanOrEqual(0);
      expect(data[i + 2]).toBeLessThanOrEqual(255);
    }
  });

  it("applyUnsharpMask يعزز حواف التفاصيل بأمان", () => {
    const W = 5;
    const H = 5;
    const data = new Uint8ClampedArray(W * H * 4).fill(100);
    // بكسل مركزي ساطع
    const centerIdx = (2 * W + 2) * 4;
    data[centerIdx] = 200;
    data[centerIdx + 1] = 200;
    data[centerIdx + 2] = 200;
    data[centerIdx + 3] = 255;

    const mockImageData = { data, width: W, height: H } as unknown as ImageData;
    applyUnsharpMask(mockImageData, W, H, 0.4);

    expect(data[centerIdx]).toBeGreaterThanOrEqual(200);
  });

  describe("findOpaqueProductBoundingBox — الاقتصاص التلقائي الذكي للصور المعتمة", () => {
    it("يكتشف حدود المنتج ويقص الهوامش البيضاء الزائدة حوله بدقة", () => {
      const W = 100;
      const H = 100;
      const data = new Uint8ClampedArray(W * H * 4);
      // املأ الصورة كاملة بخلفية بيضاء نقية (255, 255, 255)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
      // ضع غلاف كتاب أو منتج بلون داكن في النطاق [25..75] عرضاً و [20..80] ارتفاعاً
      for (let y = 20; y <= 80; y++) {
        for (let x = 25; x <= 75; x++) {
          const idx = (y * W + x) * 4;
          data[idx] = 40;     // R
          data[idx + 1] = 60; // G
          data[idx + 2] = 90; // B
        }
      }

      const mockImageData = { data, width: W, height: H } as unknown as ImageData;
      const bbox = findOpaqueProductBoundingBox(mockImageData);

      expect(bbox.hasContent).toBe(true);
      // يجب أن يكون الصندوق قريباً جداً من [25..75] و [20..80] مع هامش الأمان
      expect(bbox.minX).toBeLessThanOrEqual(25);
      expect(bbox.maxX).toBeGreaterThanOrEqual(75);
      expect(bbox.minY).toBeLessThanOrEqual(20);
      expect(bbox.maxY).toBeGreaterThanOrEqual(80);
      // ويجب أن يكون قد قص الهوامش البيضاء الخارجية (لا يرجع الصورة كاملة 0..99)
      expect(bbox.minX).toBeGreaterThan(0);
      expect(bbox.minY).toBeGreaterThan(0);
      expect(bbox.maxX).toBeLessThan(99);
      expect(bbox.maxY).toBeLessThan(99);
    });

    it("يسقط بأمان للصندوق الكامل إذا كانت الخلفية معقدة أو غير متجانسة", () => {
      const W = 60;
      const H = 60;
      const data = new Uint8ClampedArray(W * H * 4);
      // زوايا بألوان مختلفة تماماً (صورة غير معزولة)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (i % 255);
        data[i + 1] = ((i * 2) % 255);
        data[i + 2] = ((i * 3) % 255);
        data[i + 3] = 255;
      }

      const mockImageData = { data, width: W, height: H } as unknown as ImageData;
      const bbox = findOpaqueProductBoundingBox(mockImageData);

      expect(bbox.hasContent).toBe(true);
      expect(bbox.minX).toBe(0);
      expect(bbox.minY).toBe(0);
      expect(bbox.width).toBe(W);
      expect(bbox.height).toBe(H);
    });
  });
});

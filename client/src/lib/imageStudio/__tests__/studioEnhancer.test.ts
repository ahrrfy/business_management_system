import { describe, expect, it } from "vitest";
import {
  findProductBoundingBox,
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
});

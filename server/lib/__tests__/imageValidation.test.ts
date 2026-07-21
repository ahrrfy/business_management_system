import { describe, expect, it } from "vitest";
import { assertValidImageDataUrl, parseImageDimensions } from "../imageValidation";

const dataUrl = (mime: string, bytes: number[]) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
// PNG بترويسة IHDR تُعلن أبعاداً: توقيع(٨) + طول(٤) + "IHDR"(٤) + عرض(٤) + ارتفاع(٤) + حشو.
const pngWithDims = (w: number, h: number) => [...PNG, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 0x08, 0x06, 0x00, 0x00, 0x00];
// JPEG بمقطع SOF0 يُعلن الأبعاد: SOI + FFC0 + طول + دقّة + ارتفاع(٢) + عرض(٢) + مكوّنات.
const jpegWithDims = (w: number, h: number) => [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x01, 0x22, 0x00];

describe("assertValidImageDataUrl", () => {
  it("يقبل صورة مطابقة لصيغتها", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", PNG), 2_000_000, true)).not.toThrow();
    expect(() => assertValidImageDataUrl(dataUrl("image/jpeg", JPEG), 2_000_000, true)).not.toThrow();
  });

  it("يرفض بيانات متنكّرة أو غير Base64", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", JPEG), 2_000_000, true)).toThrow();
    expect(() => assertValidImageDataUrl("data:image/png;base64,ليسBase64", 2_000_000, true)).toThrow();
  });

  it("يرفض أبعاداً تتجاوز الحدّ (قنبلة بكسلات) في PNG وJPEG", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", pngWithDims(5000, 100)), 2_000_000, true)).toThrow();
    expect(() => assertValidImageDataUrl(dataUrl("image/jpeg", jpegWithDims(100, 9000)), 2_000_000, true)).toThrow();
  });

  it("يقبل أبعاداً ضمن الحدّ", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", pngWithDims(1600, 1200)), 2_000_000, true)).not.toThrow();
  });

  it("يتساهل عند تعذّر تحليل الأبعاد (ترويسة قصيرة) فلا يكسر صورةً صالحة المغناطيس", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", PNG), 2_000_000, true)).not.toThrow();
    expect(parseImageDimensions(Buffer.from(PNG), "image/png")).toBeNull();
  });

  it("لا يفحص الأبعاد بلا strictMagic (توافق خلفيّ)", () => {
    expect(() => assertValidImageDataUrl(dataUrl("image/png", pngWithDims(9000, 9000)))).not.toThrow();
  });

  it("parseImageDimensions يقرأ PNG وJPEG بدقّة", () => {
    expect(parseImageDimensions(Buffer.from(pngWithDims(1600, 1200)), "image/png")).toEqual({ width: 1600, height: 1200 });
    expect(parseImageDimensions(Buffer.from(jpegWithDims(800, 600)), "image/jpeg")).toEqual({ width: 800, height: 600 });
  });
});

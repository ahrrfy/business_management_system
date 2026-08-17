import { describe, expect, it, vi } from "vitest";
import { createProductWebpThumbnail, fitProductThumbnailDimensions } from "./productImageThumbnail";

describe("fitProductThumbnailDimensions", () => {
  it("يصغّر أطول ضلع إلى 320 مع حفظ النسبة ولا يكبّر الصور الصغيرة", () => {
    expect(fitProductThumbnailDimensions(1_600, 800)).toEqual({ width: 320, height: 160 });
    expect(fitProductThumbnailDimensions(200, 100)).toEqual({ width: 200, height: 100 });
    expect(fitProductThumbnailDimensions(1, 4_000)).toEqual({ width: 1, height: 320 });
  });

  it("يرفض أبعاداً غير صحيحة", () => {
    expect(() => fitProductThumbnailDimensions(0, 10)).toThrow();
    expect(() => fitProductThumbnailDimensions(Number.NaN, 10)).toThrow();
  });
});

describe("createProductWebpThumbnail", () => {
  it("يرسم الأبعاد المحسوبة ويعيد WebP فقط", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const toDataURL = vi.fn(() => "data:image/webp;base64,UklGRg==");
    const result = await createProductWebpThumbnail("data:image/png;base64,AAAA", {
      loadImage: async () => ({ naturalWidth: 800, naturalHeight: 400 } as HTMLImageElement),
      createCanvas: (width, height) => ({
        width,
        height,
        getContext: () => ({ drawImage, fillRect } as unknown as CanvasRenderingContext2D),
        toDataURL,
      } as unknown as HTMLCanvasElement),
    });
    expect(result).toBe("data:image/webp;base64,UklGRg==");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 320, 160);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 320, 160);
    expect(toDataURL).toHaveBeenCalledWith("image/webp", 0.78);
  });

  it("يرفض fallback المتصفح إلى PNG أو ناتجاً يتجاوز سقف المصغرة", async () => {
    const runtime = (output: string) => ({
      loadImage: async () => ({ naturalWidth: 10, naturalHeight: 10 } as HTMLImageElement),
      createCanvas: () => ({
        getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }),
        toDataURL: () => output,
      } as unknown as HTMLCanvasElement),
    });
    await expect(createProductWebpThumbnail("data:image/png;base64,AAAA", runtime("data:image/png;base64,AAAA")))
      .rejects.toThrow(/WebP/);
    await expect(createProductWebpThumbnail(
      "data:image/png;base64,AAAA",
      runtime(`data:image/webp;base64,${"A".repeat(180_000)}`),
    )).rejects.toThrow(/حجم/);
  });
});

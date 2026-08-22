import { describe, expect, it, vi } from "vitest";
import { createProductDisplayThumbnail, fitProductThumbnailDimensions } from "./productImageThumbnail";

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

describe("createProductDisplayThumbnail", () => {
  it("يرسم الأبعاد المحسوبة ويفضّل WebP حين يدعمه المتصفح", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const toDataURL = vi.fn(() => "data:image/webp;base64,UklGRg==");
    const result = await createProductDisplayThumbnail("data:image/png;base64,AAAA", {
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

  /** مصنعُ زمنِ تشغيلٍ يحاكي متصفّحاً يدعم صيغاً بعينها ويسقط لغيرها إلى PNG (سلوك Safari). */
  const runtimeSupporting = (supported: string[], oversizedFor: string[] = []) => {
    const calls: string[] = [];
    return {
      calls,
      runtime: {
        loadImage: async () => ({ naturalWidth: 10, naturalHeight: 10 }) as HTMLImageElement,
        createCanvas: () =>
          ({
            getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }),
            toDataURL: (mime: string) => {
              calls.push(mime);
              if (!supported.includes(mime)) return "data:image/png;base64,AAAA";
              const payload = oversizedFor.includes(mime) ? "A".repeat(180_000) : "AAAA";
              return `data:${mime};base64,${payload}`;
            },
          }) as unknown as HTMLCanvasElement,
      },
    };
  };

  it("⭐ Safari/iOS بلا ترميز WebP: يسقط إلى JPEG بدل منع المصوّر من الإرسال", async () => {
    // البلاغ الحقيقيّ: `toDataURL("image/webp")` يُرجع PNG صامتاً على iOS، فكان الحارس
    // يشتعل ويُمنع الإرسال نهائياً — مشتقُّ عرضٍ يوقف عملاً منجَزاً.
    const { runtime, calls } = runtimeSupporting(["image/jpeg"]);
    await expect(createProductDisplayThumbnail("data:image/png;base64,AAAA", runtime)).resolves.toBe(
      "data:image/jpeg;base64,AAAA",
    );
    expect(calls).toEqual(["image/webp", "image/jpeg"]);
  });

  it("لا يقبل سقوط المتصفح الصامت إلى PNG بوصفه ناتجاً صالحاً", async () => {
    const { runtime } = runtimeSupporting([]);
    await expect(createProductDisplayThumbnail("data:image/png;base64,AAAA", runtime)).rejects.toThrow(
      /تعذّر على المتصفح/,
    );
  });

  it("يتخطّى صيغةً تجاوزت السقف إلى التالية بدل الفشل فوراً", async () => {
    const { runtime, calls } = runtimeSupporting(["image/webp", "image/jpeg"], ["image/webp"]);
    await expect(createProductDisplayThumbnail("data:image/png;base64,AAAA", runtime)).resolves.toBe(
      "data:image/jpeg;base64,AAAA",
    );
    expect(calls).toEqual(["image/webp", "image/jpeg"]);
  });

  it("يميّز «كبيرة» عن «غير مدعومة» — السببان لهما علاجان مختلفان", async () => {
    const { runtime } = runtimeSupporting(["image/webp", "image/jpeg"], ["image/webp", "image/jpeg"]);
    await expect(createProductDisplayThumbnail("data:image/png;base64,AAAA", runtime)).rejects.toThrow(/حجم/);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  parsePublicProductImageWidth,
  productImageUrl,
  readPublicStoredBodyWithRetry,
  withPublicProductImageWidth,
} from "../../../imageRoute";
import {
  ImageStoreUnavailableError,
  MAX_PUBLIC_PRODUCT_THUMBNAIL_BYTES,
  PUBLIC_PRODUCT_IMAGE_WIDTHS,
} from "..";

const DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;

describe("public product image delivery contract", () => {
  it("يحصر مفاتيح الحجم في 320/640/1200 ويحافظ على الرابط الخارجي", () => {
    expect(PUBLIC_PRODUCT_IMAGE_WIDTHS).toEqual([320, 640, 1200]);
    expect(MAX_PUBLIC_PRODUCT_THUMBNAIL_BYTES).toBe(128 * 1024);
    expect(parsePublicProductImageWidth(undefined)).toEqual({ valid: true, width: null });
    expect(parsePublicProductImageWidth("320")).toEqual({ valid: true, width: 320 });
    expect(parsePublicProductImageWidth("321")).toEqual({ valid: false });
    expect(productImageUrl(5, DATA_URL, 320)).toMatch(/^\/api\/img\/product\/5\?v=[0-9a-f]{16}&w=320$/);
    expect(withPublicProductImageWidth("https://cdn.example/p.jpg", 320)).toBe("https://cdn.example/p.jpg");
    expect(withPublicProductImageWidth("/api/img/product/5?v=abc", 1200)).toBe("/api/img/product/5?v=abc&w=1200");
  });

  it("يعيد upstream مرة واحدة فقط ثم ينجح، ولا يعيد القاطع أو الإلغاء", async () => {
    const bytes = Buffer.from("image");
    const transient = vi.fn()
      .mockRejectedValueOnce(new ImageStoreUnavailableError("upstream", "get"))
      .mockResolvedValueOnce(bytes);
    await expect(readPublicStoredBodyWithRetry(transient, new AbortController().signal)).resolves.toEqual(bytes);
    expect(transient).toHaveBeenCalledTimes(2);

    const circuit = vi.fn().mockRejectedValue(new ImageStoreUnavailableError("circuit_open", "get"));
    await expect(readPublicStoredBodyWithRetry(circuit, new AbortController().signal)).rejects.toMatchObject({ reason: "circuit_open" });
    expect(circuit).toHaveBeenCalledTimes(1);

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = vi.fn().mockRejectedValue(new ImageStoreUnavailableError("upstream", "get"));
    await expect(readPublicStoredBodyWithRetry(cancelled, aborted.signal)).rejects.toMatchObject({ reason: "upstream" });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

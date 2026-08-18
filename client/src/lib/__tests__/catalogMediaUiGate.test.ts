import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

describe("catalog media UI gate", () => {
  it("create forms never serialize image data URLs into catalog.createProduct", () => {
    for (const path of [
      "client/src/pages/ProductNew.tsx",
      "client/src/components/product/SimpleProductForm.tsx",
      "client/src/components/product/BundleForm.tsx",
    ]) {
      const text = source(path);
      expect(text).not.toMatch(/url:\s*i\.dataUrl/);
      expect(text).not.toMatch(/image:\s*v\.image/);
    }
  });

  it("catalog edit payload keeps IDs and metadata only, never bytes", () => {
    const text = source("client/src/lib/productImages.ts");
    expect(text).not.toMatch(/url:\s*unchanged\s*\?/);
    expect(text).not.toMatch(/url:\s*it\.dataUrl/);

    const edit = source("client/src/pages/ProductEdit.tsx");
    const payload = edit.slice(edit.indexOf("function buildPayload"), edit.indexOf("async function save"));
    expect(payload).not.toMatch(/image:\s*v\.image\s*[,}]/);
    expect(payload).toMatch(/image:\s*v\.image\s*===\s*null\s*\?\s*null\s*:\s*undefined/);

    for (const path of [
      "client/src/pages/ProductEdit.tsx",
      "client/src/components/product/SimpleProductEditForm.tsx",
    ]) {
      const consumer = source(path);
      expect(consumer).toContain("images: buildProductImagesPayload(images)");
      expect(consumer).not.toMatch(/images:\s*images\.map/);
    }
  });

  it("legacy catalog surfaces expose no direct image uploader", () => {
    const files = [
      "client/src/components/product/ProductMediaContentSection.tsx",
      "client/src/components/product/VariantsTable.tsx",
      "client/src/pages/store/StoreCatalog.tsx",
    ];
    const [media, variants, store] = files.map(source);
    expect(media).toContain('href="/catalog/image-studio"');
    expect(media).toMatch(/studioTaskId\s*!=\s*null[\s\S]*<ImageStudioUploader/);
    expect(variants).not.toContain("<ImageSlot");
    expect(store).not.toContain("<ImageUploader");
    expect(store).toContain('href="/catalog/image-studio"');
  });

  it("store catalog retains removal only and never submits image bytes", () => {
    const text = source("client/src/pages/store/StoreCatalog.tsx");
    expect(text).toMatch(/setM\.mutate\(\{\s*productId:\s*target\.productId,\s*url:\s*null\s*\}\)/);
    expect(text).not.toMatch(/setM\.mutate\([\s\S]{0,120}url\s*\)/);
  });
});

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

    const model = source("client/src/components/form/product/productFormModel.ts");
    const payload = model.slice(model.indexOf("function buildUpdateProductPayload"), model.indexOf("function makeVariant"));
    expect(payload).not.toMatch(/image:\s*v\.image\s*[,}]/);
    expect(payload).toMatch(/image:\s*v\.image\s*===\s*null\s*\?\s*null\s*:\s*undefined/);
    expect(payload).toContain("images: buildProductImagesPayload(m.images)");
    expect(payload).not.toMatch(/images:\s*images\.map/);

    const simple = source("client/src/components/product/SimpleProductEditForm.tsx");
    expect(simple).toContain("images: buildProductImagesPayload(images)");
    expect(simple).not.toMatch(/images:\s*images\.map/);
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

  it("a workflow task can process one image only; batches use separate task IDs", () => {
    const section = source("client/src/components/product/ProductMediaContentSection.tsx");
    expect(section).toContain("maxItems={studioTaskId != null ? 1 : maxImages}");
    const uploader = source("client/src/components/product/ImageStudioUploader.tsx");
    expect(uploader.match(/workflowTaskId == null && value\.length > 1/g)).toHaveLength(2);
  });
});

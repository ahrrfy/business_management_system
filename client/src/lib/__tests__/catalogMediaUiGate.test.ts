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

  it("campaign batches keep a distinct task, processing mode, and receipt for every image", () => {
    const text = source("client/src/components/product-studio/StudioCampaignImageBatch.tsx");
    expect(text).toMatch(/slots\.map\(\(slot,[\s\S]*studioTaskId=\{slot\.taskId\}/);
    expect(text).toContain("onStudioModeChange={(mode) => patch(slot.taskId, { mode })}");
    expect(text).toContain("onProcessingReceiptChange={(receipt) => patch(slot.taskId, { receipt })}");
    expect(text).toContain('mode: slot.mode === "AI" ? "FLATTEN" : slot.mode, processingReceipt: slot.receipt');
  });

  it("a workflow task can process one image only; batches use separate task IDs", () => {
    const section = source("client/src/components/product/ProductMediaContentSection.tsx");
    expect(section).toContain("maxItems={studioTaskId != null ? 1 : maxImages}");
    const uploader = source("client/src/components/product/ImageStudioUploader.tsx");
    expect(uploader.match(/workflowTaskId == null && value\.length > 1/g)).toHaveLength(2);
  });

  it("does not turn an unknown server refresh into a destructive draft conflict", () => {
    const page = source("client/src/pages/ProductImageStudio.tsx");
    // Reconciliation must fetch the exact task, not infer absence from a list page.
    const selection = source("client/src/components/product-studio/useStudioSelectedTask.ts");
    expect(page).toContain("useStudioSelectedTask(scope, selectedId, offline, taskItems, scannedTask)");
    expect(selection).toMatch(/const selectedTaskQuery = trpc\.productStudio\.tasks\.useQuery\([\s\S]{0,100}taskId: selectedId/);
    const refresh = page.slice(page.indexOf("const refreshed = await selectedTaskQuery.refetch();"), page.indexOf("const result = await reconcileStudioDraftAfterReconnect("));
    expect(refresh).toMatch(/if \(refreshed\.isError\)\s*\{[\s\S]{0,250}setResumeRetry[\s\S]{0,100}return;/);
    expect(refresh).toContain("refreshed.data?.items.find((item) => Number(item.id) === taskId)");
    expect(refresh).not.toContain(".pages");
  });

  it("additional image slots claim local drafts and cannot replace an unknown server original", () => {
    const batch = source("client/src/components/product-studio/StudioCampaignImageBatch.tsx");
    expect(batch).toContain("reconcileStudioDraftAfterReconnect");
    expect(batch).toMatch(/disabled=\{[^}]*slot\.hasOriginal && !slot\.image[^}]*slot\.hasCandidate/);
  });

  it("revalidates each additional draft ownership immediately before its own submit", () => {
    const batch = source("client/src/components/product-studio/StudioCampaignImageBatch.tsx");
    expect(batch).toMatch(/for \(const slot of pending\)[\s\S]{0,700}await persistSlotDraft\(props\.userId, slot\)[\s\S]{0,900}await submit\.mutateAsync/);
    expect(batch).toContain("patch(slot.taskId, { ownershipLost: true })");
    expect(batch).toMatch(/pending\.some\(\(slot\) => slot\.conflict \|\| slot\.ownershipLost/);
  });
});

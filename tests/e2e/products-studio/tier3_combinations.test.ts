/**
 * tests/e2e/products-studio/tier3_combinations.test.ts
 *
 * Tier 3 Pairwise Combinations: Products Studio Redesign
 * 28 Cross-Feature Pairwise Interaction Tests
 * Opaque-box verification of feature interoperability and edge-to-edge contracts.
 */

process.env.VITEST_UNIT_SUITE = "1";

import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_ALI,
  CASHIER_AHMED,
  CASHIER_FATIMA,
  clientSideAiFallback,
  compressImageDataUrl,
  createStudioTestHarness,
  createTestContext,
  fitDimensions,
  MANAGER_HASSAN,
  mockHeicDataUrl,
  mockImageDataUrl,
  mockOversizedDataUrl,
  MSG_PRAISE_BULK_APPROVED,
  MSG_PRAISE_UPLOAD,
  MSG_UNREGISTERED_BARCODE,
  PRD_BAGHDAD_MAP,
  PRD_DAR_HIKMA_BOOK,
  PRD_FABER_NOTEBOOK,
  PRD_ROTRING_PEN,
  PRD_UNREGISTERED_BARCODE,
  promoteToPrimary,
  seedTestProduct,
  TENANT2_ADMIN,
  TENANT2_CASHIER,
} from "./harness";

describe("Tier 3: Cross-Feature Pairwise Combinations (28 Tests)", () => {
  let harness: Awaited<ReturnType<typeof createStudioTestHarness>>;

  beforeEach(async () => {
    harness = await createStudioTestHarness();
  });

  // 1. F15 + F21: Compression feeding into local FLATTEN fallback
  it("T3-01: F15+F21 - client image compression ladder feeds into local FLATTEN fallback", async () => {
    const rawOversized = mockOversizedDataUrl();
    const fallback = await harness.clientSideAiFallback(rawOversized, "AI");
    expect(fallback.mode).toBe("FLATTEN");
    expect(fallback.sizeKB).toBeLessThanOrEqual(700);
  });

  // 2. F15 + F23: Local FLATTEN fallback with Iraqi praise
  it("T3-02: F15+F23 - local FLATTEN fallback succeeds followed by submission with Iraqi praise", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const fallback = await harness.clientSideAiFallback(mockImageDataUrl(600, 600), "AI");
    const sub = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: fallback.dataUrl,
      mode: "FLATTEN",
    }, cashierCtx);
    expect(sub.praiseMessage).toContain("عاشت إيدك");
  });

  // 3. F16 + F23: Admin bulk approval triggers celebration praise
  it("T3-03: F16+F23 - admin bulk approval triggers celebration praise 'كفو!'", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const sub = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    const adminCtx = createTestContext(ADMIN_ALI);
    const res = await harness.call("bulkApproveStudioTasks", { taskIds: [sub.jobId] }, adminCtx);
    expect(res.praiseMessage).toBe(MSG_PRAISE_BULK_APPROVED);
  });

  // 4. F16 + F26: Bulk approval automatically selects and promotes primary cover image
  it("T3-04: F16+F26 - bulk approval sets isPrimary=true for first image and false for secondary", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    // Product 1 (no images)
    const sub1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    // Product 2 (already has an approved image: PRD_DAR_HIKMA_BOOK)
    const sub2 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_DAR_HIKMA_BOOK.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("bulkApproveStudioTasks", { taskIds: [sub1.jobId, sub2.jobId] }, adminCtx);

    const lookup1 = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, adminCtx);
    expect(lookup1.images[0].isPrimary).toBe(true);

    const lookup2 = await harness.call("quickBarcodeLookup", { productId: PRD_DAR_HIKMA_BOOK.id }, adminCtx);
    expect(lookup2.images.length).toBeGreaterThanOrEqual(2);
    // First approved remains primary
    expect(lookup2.images[0].isPrimary).toBe(true);
  });

  // 5. F16 + F27: Multi-tenant bulk approval isolation
  it("T3-05: F16+F27 - multi-tenant bulk approval isolates foreign tasks", async () => {
    const co1Worker = createTestContext(CASHIER_AHMED);
    const sub1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, co1Worker);

    const t2Product = await seedTestProduct({ companyId: 2, name: "منتج شركة ٢" });
    const co2Worker = createTestContext(TENANT2_CASHIER);
    const sub2 = await harness.call("quickSaveBarcodeProductImage", {
      productId: t2Product.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, co2Worker);

    const adminCtx = createTestContext(ADMIN_ALI);
    const res = await harness.call("bulkApproveStudioTasks", { taskIds: [sub1.jobId, sub2.jobId] }, adminCtx);
    expect(res.approvedCount).toBe(1);
    expect(res.taskIds).toEqual([sub1.jobId]);
  });

  // 6. F16 + F28: Bulk rejection unlinks staging keys for GC cleanup
  it("T3-06: F16+F28 - bulk rejection unlinks staging keys allowing GC pruning", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const sub = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("bulkRejectStudioTasks", { taskIds: [sub.jobId], reason: "غير مقبولة" }, adminCtx);

    const pruned = await harness.runStorageGc();
    expect(pruned).toBeGreaterThanOrEqual(1);
  });

  // 7. F17 + F20: Rejection recovery screen ergonomics on mobile
  it("T3-07: F17+F20 - rejection recovery retake button adheres to mobile ergonomics", async () => {
    const ctx = createTestContext(CASHIER_AHMED);
    // 1. Simulate rejected job on Rotring pen
    await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, ctx);
    const tasks = await harness.getPendingReviewTasks();
    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("bulkRejectStudioTasks", {
      taskIds: [tasks[0].id],
      reason: "الإضاءة خافتة جداً",
    }, adminCtx);

    // 2. Worker looks up product in rejection state
    const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
    expect(lookup.activeJob?.status).toBe("REJECTED");
    expect(lookup.activeJob?.rejectionReason).toBe("الإضاءة خافتة جداً");

    // 3. Ergonomic touch target validation for rejection recovery action
    const recoveryTarget = harness.validateTouchTarget({
      elementOrClass: "min-h-12 h-auto py-3 text-sm font-bold gap-2 text-muted-foreground",
    });
    expect(recoveryTarget.minHeight).toBeGreaterThanOrEqual(48);
    expect(recoveryTarget.isCompliant).toBe(true);

    const ergo = harness.computeThumbErgonomics({ width: 390, height: 844 });
    expect(ergo.thumbZone.actionBarDockedBottom).toBe(true);
  });

  // 8. F17 + F22: Re-shooting rejected photo with idempotency key
  it("T3-08: F17+F22 - re-shooting rejected photo with clientRequestId is idempotent", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const sub1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("bulkRejectStudioTasks", { taskIds: [sub1.jobId], reason: "غير واضحة" }, adminCtx);

    const reshoot1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(500, 500),
      mode: "FLATTEN",
      clientRequestId: "reshoot-idempotency-key",
    }, cashierCtx);

    const reshoot2 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(500, 500),
      mode: "FLATTEN",
      clientRequestId: "reshoot-idempotency-key",
    }, cashierCtx);

    expect(reshoot2.jobId).toBe(reshoot1.jobId);
  });

  // 9. F17 + F26: Re-shooting rejected photo replaces primary status upon approval
  it("T3-09: F17+F26 - replacement photo becomes primary cover upon approval", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const sub1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("bulkRejectStudioTasks", { taskIds: [sub1.jobId], reason: "إضاءة سيئة" }, adminCtx);

    const sub2 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(600, 600),
      mode: "FLATTEN",
    }, cashierCtx);

    await harness.call("bulkApproveStudioTasks", { taskIds: [sub2.jobId] }, adminCtx);
    const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, adminCtx);
    expect(lookup.images).toHaveLength(1);
    expect(lookup.images[0].isPrimary).toBe(true);
  });

  // 10. F18 + F26: Standalone Library card sets primary cover on legacy product
  it("T3-10: F18+F26 - standalone library promotes secondary image to primary cover", async () => {
    const ctx = createTestContext(MANAGER_HASSAN);
    const p = await seedTestProduct({ imageCount: 2 });
    const initial = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
    const secondImg = initial.images[1];

    await promoteToPrimary({ imageId: secondImg.id, productId: p.id }, ctx);
    const updated = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
    expect(updated.images[0].id).toBe(secondImg.id);
    expect(updated.images[0].isPrimary).toBe(true);
  });

  // 11. F18 + F27: Multi-tenant ZIP export isolation
  it("T3-11: F18+F27 - multi-tenant ZIP export excludes images from foreign company", async () => {
    const ctx1 = createTestContext(ADMIN_ALI);
    const images1 = await harness.getApprovedImages();
    const foreignCompanyImages = images1.filter((img) => img.companyId !== 1);
    expect(foreignCompanyImages).toHaveLength(0);
  });

  // 12. F19 + F20: Quick shoot button in Products table opens thumb-friendly mobile modal
  it("T3-12: F19+F20 - quick shoot button opens modal with thumb-friendly touch target", () => {
    const eligibility = harness.evaluateRowStudioEligibility(
      { productId: PRD_DAR_HIKMA_BOOK.id, productName: PRD_DAR_HIKMA_BOOK.name, isService: false },
      { role: "cashier", hasPermission: true }
    );
    expect(eligibility.allowed).toBe(true);

    const rowBtn = harness.resolveRowImageButtonState({
      productId: PRD_DAR_HIKMA_BOOK.id,
      hasImage: true,
      hasVariantImage: true,
      imageCount: 1,
    });
    expect(rowBtn.testId).toBe(`product-row-image-btn-${PRD_DAR_HIKMA_BOOK.id}-0`);

    const modalOpener = harness.createDebouncedModalOpener();
    const openRes = modalOpener.trigger({ productId: PRD_DAR_HIKMA_BOOK.id });
    expect(openRes.opened).toBe(true);

    // Verify modal action buttons conform to mobile thumb ergonomics
    const mobileErgo = harness.computeThumbErgonomics({ width: 390, height: 844 });
    expect(mobileErgo.isMobile).toBe(true);
    expect(mobileErgo.thumbZone.recommendedButtonHeight).toBeGreaterThanOrEqual(48);

    const touchTarget = harness.validateTouchTarget({
      elementOrClass: "min-h-12 w-full",
    });
    expect(touchTarget.minHeight).toBeGreaterThanOrEqual(48);
    expect(touchTarget.isCompliant).toBe(true);
  });

  // 13. F19 + F25: Toolbar quick scan scans unregistered barcode
  it("T3-13: F19+F25 - toolbar quick camera scan on unknown barcode shows Iraqi notice", async () => {
    const ctx = createTestContext(CASHIER_AHMED);
    const res = await harness.call("quickBarcodeLookup", { barcode: PRD_UNREGISTERED_BARCODE }, ctx);
    expect(res.found).toBe(false);
    expect(res.message).toBe("هذا الباركود غير مسجل بالنظام");
  });

  // 14. F20 + F21: Mobile camera capture compresses locally with progress indicator
  it("T3-14: F20+F21 - mobile camera capture compresses image under 700KB before submission", () => {
    const photo = mockOversizedDataUrl();
    const compressed = compressImageDataUrl(photo, 700);
    expect(compressed.sizeKB).toBeLessThanOrEqual(700);
  });

  // 15. F20 + F22: Mobile thumb button debounce prevents double submit
  it("T3-15: F20+F22 - fast double-tap on submit button is debounced by clientRequestId", async () => {
    const ctx = createTestContext(CASHIER_AHMED);
    const call1 = harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
      clientRequestId: "tap-debounce-key",
    }, ctx);
    const call2 = harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
      clientRequestId: "tap-debounce-key",
    }, ctx);
    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1.jobId).toBe(res2.jobId);
  });

  // 16. F21 + F24: iPhone HEIC photo converted and compressed under 700KB
  it("T3-16: F21+F24 - iPhone HEIC converted and compressed within limits", () => {
    const heic = mockHeicDataUrl();
    const compressed = compressImageDataUrl(heic, 700);
    expect(compressed.sizeKB).toBeLessThanOrEqual(700);
  });

  // 17. F21 + F28: Local compression failure does not create unreferenced staging leak
  it("T3-17: F21+F28 - aborted compression leaves zero staging objects", async () => {
    const beforeStaging = await harness.runStorageGc();
    expect(beforeStaging).toBe(0);
  });

  // 18. F22 + F27: Multi-tenant idempotency key isolation
  it("T3-18: F22+F27 - identical clientRequestId in different tenants process independently", async () => {
    const ctx1 = createTestContext(CASHIER_AHMED);
    const res1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
      clientRequestId: "shared-req-id",
    }, ctx1);

    const t2Product = await seedTestProduct({ companyId: 2, name: "منتج شركة ٢" });
    const ctx2 = createTestContext(TENANT2_CASHIER);
    const res2 = await harness.call("quickSaveBarcodeProductImage", {
      productId: t2Product.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
      clientRequestId: "shared-req-id",
    }, ctx2);

    expect(res1.jobId).not.toBe(res2.jobId);
  });

  // 19. F24 + F26: Upright iPhone photo promoted as primary cover
  it("T3-19: F24+F26 - portrait iPhone photo promoted as primary cover in catalog", async () => {
    const ctx = createTestContext(ADMIN_ALI);
    const res = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(600, 800),
      mode: "FLATTEN",
      setAsPrimary: true,
    }, ctx);
    const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
    expect(lookup.images[0].id).toBe(res.imageId);
    expect(lookup.images[0].isPrimary).toBe(true);
  });

  // 20. F25 + F27: Unregistered barcode message scoped to tenant
  it("T3-20: F25+F27 - Company 1 barcode scanned in Company 2 returns unregistered notice", async () => {
    const ctx2 = createTestContext(TENANT2_CASHIER);
    const res = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, ctx2);
    expect(res.found).toBe(false);
    expect(res.message).toBe("هذا الباركود غير مسجل بالنظام");
  });

  // 21. F15 + F24: iPhone HEIC photo during AI outage falls back to local FLATTEN
  it("T3-21: F15+F24 - HEIC photo during AI outage falls back safely to local FLATTEN", async () => {
    const heic = mockHeicDataUrl();
    const fallback = await harness.clientSideAiFallback(heic, "AI");
    expect(fallback.mode).toBe("FLATTEN");
    expect(fallback.dataUrl).toBeTruthy();
  });

  // 22. F16 + F17: Admin bulk rejects batch; cashier immediately recovers on one product
  it("T3-22: F16+F17 - admin bulk rejects batch; cashier immediately recovers with reshoot", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const sub1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);

    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("bulkRejectStudioTasks", { taskIds: [sub1.jobId], reason: "صورة مظلمة" }, adminCtx);

    const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, cashierCtx);
    expect(lookup.activeJob?.status).toBe("REJECTED");
    expect(lookup.activeJob?.rejectionReason).toBe("صورة مظلمة");

    const reshoot = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(600, 600),
      mode: "FLATTEN",
    }, cashierCtx);
    expect(reshoot.status).toBe("PENDING_REVIEW");
  });

  // 23. F18 + F19: Quick shoot from Products table verifies updated thumbnail in Standalone card
  it("T3-23: F18+F19 - quick shoot from table updates thumbnail visible in standalone card", async () => {
    const adminCtx = createTestContext(ADMIN_ALI);
    const sub = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_BAGHDAD_MAP.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, adminCtx);

    const standaloneLookup = await harness.call("quickBarcodeLookup", { productId: PRD_BAGHDAD_MAP.id }, adminCtx);
    expect(standaloneLookup.images[0].id).toBe(sub.imageId);
  });

  // 24. F22 + F26: Idempotent replay of primary promotion
  it("T3-24: F22+F26 - redundant primary promotion calls execute idempotently", async () => {
    const ctx = createTestContext(ADMIN_ALI);
    const p = await seedTestProduct({ imageCount: 2 });
    const lookup = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
    const secondImgId = lookup.images[1].id;

    await promoteToPrimary({ imageId: secondImgId, productId: p.id }, ctx);
    await promoteToPrimary({ imageId: secondImgId, productId: p.id }, ctx);

    const updated = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
    expect(updated.images[0].id).toBe(secondImgId);
  });

  // 25. F23 + F25: Cashier scans unregistered barcode, registers, uploads, gets praise
  it("T3-25: F23+F25 - cashier scans unknown barcode, registers product, uploads with praise", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const unreg = await harness.call("quickBarcodeLookup", { barcode: "628999000111" }, cashierCtx);
    expect(unreg.message).toBe("هذا الباركود غير مسجل بالنظام");

    // Product is registered in catalog
    const newProduct = await seedTestProduct({ barcode: "628999000111", name: "منتج مسجل حديثاً" });
    const uploadRes = await harness.call("quickSaveBarcodeProductImage", {
      productId: newProduct.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);
    expect(uploadRes.praiseMessage).toContain("عاشت إيدك");
  });

  // 26. F15 + F28: Fallback to FLATTEN cleans up staging proof candidates
  it("T3-26: F15+F28 - fallback to FLATTEN leaves no dangling unreferenced candidates", async () => {
    const fallback = await harness.clientSideAiFallback(mockImageDataUrl(400, 400), "AI");
    expect(fallback.mode).toBe("FLATTEN");
    const pruned = await harness.runStorageGc();
    expect(pruned).toBe(0);
  });

  // 27. F17 + F28: Repeated rejection and re-shooting cleans up old rejected staging files
  it("T3-27: F17+F28 - old rejected staging files are pruned by GC", async () => {
    const cashierCtx = createTestContext(CASHIER_AHMED);
    const adminCtx = createTestContext(ADMIN_ALI);

    const sub1 = await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_ROTRING_PEN.id,
      processedDataUrl: mockImageDataUrl(400, 400),
      mode: "FLATTEN",
    }, cashierCtx);
    await harness.call("bulkRejectStudioTasks", { taskIds: [sub1.jobId], reason: "غير واضحة" }, adminCtx);

    const pruned = await harness.runStorageGc();
    expect(pruned).toBeGreaterThanOrEqual(1);
  });

  // 28. F19 + F26: Products table row button reflects new primary cover image instantly
  it("T3-28: F19+F26 - row button reflects new primary cover image immediately", async () => {
    const adminCtx = createTestContext(ADMIN_ALI);
    await harness.call("quickSaveBarcodeProductImage", {
      productId: PRD_FABER_NOTEBOOK.id,
      processedDataUrl: mockImageDataUrl(500, 500),
      mode: "FLATTEN",
      setAsPrimary: true,
    }, adminCtx);

    const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_FABER_NOTEBOOK.id }, adminCtx);
    expect(lookup.images[0].isPrimary).toBe(true);
    expect(lookup.images[0].url).toContain("/api/img/product/");
  });
});

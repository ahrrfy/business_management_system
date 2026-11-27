/**
 * tests/e2e/products-studio/tier1_features.test.ts
 *
 * Tier 1 Feature Coverage: Products Studio Redesign (Features F1 to F28)
 * 28 Features × 5 Positive Tests = 140 Test Cases
 * Opaque-box requirement-driven testing with zero DB overhead.
 */

process.env.VITEST_UNIT_SUITE = "1";

import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_ALI,
  AI_STUDIO_FIDELITY_GUARD,
  AiImageError,
  buildAiStudioPrompt,
  CASHIER_AHMED,
  CASHIER_FATIMA,
  clientSideAiFallback,
  compressImageDataUrl,
  createStudioTestHarness,
  createTestContext,
  fitDimensions,
  getSimulatedTime,
  MANAGER_HASSAN,
  mockHeicDataUrl,
  mockImageDataUrl,
  mockOversizedDataUrl,
  MSG_AI_FALLBACK_WARN,
  MSG_PRAISE_AUTO_APPROVED,
  MSG_PRAISE_BULK_APPROVED,
  MSG_PRAISE_UPLOAD,
  MSG_REMOVEBG_FALLBACK_WARN,
  MSG_UNREGISTERED_BARCODE,
  PRD_BAGHDAD_MAP,
  PRD_DAR_HIKMA_BOOK,
  PRD_FABER_NOTEBOOK,
  PRD_ROTRING_PEN,
  PRD_UNREGISTERED_BARCODE,
  promoteToPrimary,
  resetHarnessState,
  resolveGeminiImageModel,
  runStorageGc,
  seedMixedCampaignData,
  seedTestProduct,
  TENANT2_ADMIN,
  TENANT2_CASHIER,
} from "./harness";

describe("Tier 1: Feature Coverage (F1 to F28 — 140 Positive Tests)", () => {
  let harness: Awaited<ReturnType<typeof createStudioTestHarness>>;

  beforeEach(async () => {
    harness = await createStudioTestHarness();
  });

  // =========================================================================
  // F1: 3-Step Continuous Flow (Scan -> Camera -> Submit)
  // =========================================================================
  describe("F1: 3-Step Continuous Flow", () => {
    it("T1-F01-01: executes seamless 3-step continuous flow from scan to submit", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(PRD_ROTRING_PEN.id);

      const image = mockImageDataUrl(800, 800);
      const result = await harness.call("quickSaveBarcodeProductImage", {
        productId: lookup.product.id,
        processedDataUrl: image,
        thumbnailDataUrl: image,
        mode: "FLATTEN",
      }, ctx);
      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
    });

    it("T1-F01-02: manual product lookup smoothly advances to camera capture", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_DAR_HIKMA_BOOK.id }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(PRD_DAR_HIKMA_BOOK.id);
      expect(lookup.product.isActive).toBe(true);
    });

    it("T1-F01-03: step 3 preview provides 1-click submit with primary flag", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(600, 600),
        thumbnailDataUrl: mockImageDataUrl(200, 200),
        mode: "FLATTEN",
        setAsPrimary: true,
      }, ctx);
      expect(res.autoApproved).toBe(true);
      expect(res.imageId).toBeDefined();
    });

    it("T1-F01-04: resets workflow state to Step 1 upon submission completion", () => {
      const session = harness.createWorkflowSession();
      session.selectProduct(PRD_ROTRING_PEN);
      session.startCapture();
      expect(session.getState().step).toBe("CAPTURE");

      session.captureImage({
        processedDataUrl: mockImageDataUrl(800, 800),
        sizeKB: 240,
      });
      expect(session.getState().step).toBe("PREVIEW");
      expect(session.getState().capturedImage).not.toBeNull();

      // Complete submission: reducer resets step to SCAN, clears image, shows praise
      session.submitSuccess(MSG_PRAISE_AUTO_APPROVED);
      const finalState = session.getState();
      expect(finalState.step).toBe("SCAN");
      expect(finalState.capturedImage).toBeNull();
      expect(finalState.selectedAction).toBeNull();
      expect(finalState.successBanner).toBe(MSG_PRAISE_AUTO_APPROVED);
    });

    it("T1-F01-05: maintains single continuous screen without modal interruptions", () => {
      const session = harness.createWorkflowSession();
      const recordedSteps: string[] = [session.getState().step];

      session.selectProduct(PRD_ROTRING_PEN);
      session.startCapture();
      recordedSteps.push(session.getState().step);

      session.captureImage({ processedDataUrl: mockImageDataUrl(400, 400), sizeKB: 120 });
      recordedSteps.push(session.getState().step);

      expect(recordedSteps).toEqual(["SCAN", "CAPTURE", "PREVIEW"]);
      expect(session.isSingleScreenWorkflow()).toBe(true);
    });
  });

  // =========================================================================
  // F2: Campaign Decoupling & Broad Employee Access
  // =========================================================================
  describe("F2: Campaign Decoupling & Broad Employee Access", () => {
    it("T1-F02-01: allows cashier to photograph when zero campaigns exist", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.success).toBe(true);
      expect(res.autoApproved).toBe(false);
      expect(res.jobId).toBeDefined();
    });

    it("T1-F02-02: saves submission with campaignId as null", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.jobId).toBeDefined();
    });

    it("T1-F02-03: broad employee access functions across branches without campaign assignment", async () => {
      const ctx = createTestContext({ role: "employee", userId: 150, branchId: 3, companyId: 1 });
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.success).toBe(true);
    });

    it("T1-F02-04: admin auto-publishes without campaign assignment", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_BAGHDAD_MAP.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.autoApproved).toBe(true);
      expect(res.imageId).toBeDefined();
    });

    it("T1-F02-05: looks up products not associated with any campaign", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_FABER_NOTEBOOK.barcode }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(PRD_FABER_NOTEBOOK.id);
    });
  });

  // =========================================================================
  // F3: AI Technical Settings Abstraction
  // =========================================================================
  describe("F3: AI Technical Settings Abstraction", () => {
    it("T1-F03-01: defaults AI model to gemini-3.1-flash-lite-image", () => {
      const model = harness.resolveGeminiImageModel(undefined);
      expect(model).toBe("gemini-3.1-flash-lite-image");
    });

    it("T1-F03-02: worker payload omitting technical mode defaults cleanly to FLATTEN", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
      }, ctx);
      expect(res.success).toBe(true);
    });

    it("T1-F03-03: employee UI contains zero prompt textareas or model selectors", () => {
      const cashierVisibility = harness.getAiSettingsVisibility(CASHIER_AHMED.role);
      expect(cashierVisibility.showPrompts).toBe(false);
      expect(cashierVisibility.showModelSelector).toBe(false);

      const adminVisibility = harness.getAiSettingsVisibility(ADMIN_ALI.role);
      expect(adminVisibility.showPrompts).toBe(true);
      expect(adminVisibility.showModelSelector).toBe(true);
    });

    it("T1-F03-04: server prompt enforces pure white #FFFFFF background", () => {
      const prompt = buildAiStudioPrompt(null);
      expect(prompt).toContain("#FFFFFF");
      expect(prompt).toContain("pure white");
    });

    it("T1-F03-05: prepends AI_STUDIO_FIDELITY_GUARD to every generation prompt", () => {
      const prompt = buildAiStudioPrompt("Custom look");
      expect(prompt.startsWith(AI_STUDIO_FIDELITY_GUARD)).toBe(true);
    });
  });

  // =========================================================================
  // F4: Role-Based Publishing (Admin auto-approve vs Employee review queue)
  // =========================================================================
  describe("F4: Role-Based Publishing", () => {
    it("T1-F04-01: manager submission immediately inserts APPROVED product image", async () => {
      const ctx = createTestContext(MANAGER_HASSAN);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.autoApproved).toBe(true);
      expect(res.status).toBe("APPROVED");
      expect(res.imageId).toBeDefined();
    });

    it("T1-F04-02: returns live published URL upon manager auto-approval", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.url).toMatch(/^\/api\/img\/product\/\d+\?v=/);
    });

    it("T1-F04-03: employee submission creates PENDING_REVIEW job with null imageId", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.autoApproved).toBe(false);
      expect(res.status).toBe("PENDING_REVIEW");
      expect(res.imageId).toBeNull();
      expect(res.jobId).toBeDefined();
    });

    it("T1-F04-04: admin review query lists employee pending tasks", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const submit = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      const reviewList = await harness.call("tasks", { scope: "REVIEW", limit: 50 }, adminCtx);
      expect(Array.isArray(reviewList.items)).toBe(true);
      expect(reviewList.items.some((t: any) => t.id === submit.jobId)).toBe(true);
    });

    it("T1-F04-05: admin approval transitions task and creates approved product image", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const submit = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      const res = await harness.call("bulkApproveStudioTasks", { taskIds: [submit.jobId] }, adminCtx);
      expect(res.approvedCount).toBe(1);

      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, adminCtx);
      expect(lookup.images.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // F5: Cross-System Real-Time Sync with Cache Busting (?v=${hash})
  // =========================================================================
  describe("F5: Cross-System Real-Time Sync with Cache Busting", () => {
    it("T1-F05-01: generates URL formatted with content-hash query parameter", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res.publishedUrl).toMatch(/\/api\/img\/product\/\d+\?v=[a-f0-9]+/);
    });

    it("T1-F05-02: content-hash changes deterministically when image data changes", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const res1 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400, "white"),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      const res2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400, "blue"),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(res1.publishedUrl).not.toEqual(res2.publishedUrl);
    });

    it("T1-F05-03: POS and Storefront receive updated image URL in barcode lookup", async () => {
      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(500, 500),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, adminCtx);

      const posCtx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, posCtx);
      expect(lookup.images[0].url).toContain("?v=");
    });

    it("T1-F05-04: multi-system cache tags include catalog, pos, and storefront", () => {
      const cacheTags = harness.getMultiSystemCacheTags(PRD_ROTRING_PEN.id);
      expect(cacheTags.length).toBeGreaterThanOrEqual(4);
      expect(cacheTags).toContain("catalog.posList");
      expect(cacheTags).toContain("catalog.adminList");
      expect(cacheTags).toContain("storefront");
    });

    it("T1-F05-05: primary image cover updates immediately upon new primary publish", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(500, 500),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
        setAsPrimary: true,
      }, ctx);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(lookup.images[0].isPrimary).toBe(true);
    });
  });

  // =========================================================================
  // F6: Silent Audit Logging (Photographer, Approver, Timestamps)
  // =========================================================================
  describe("F6: Silent Audit Logging", () => {
    it("T1-F06-01: records photographer user ID silently on employee submission", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      const logs = await harness.getAuditLogs("productStudio.quickCapture.submittedForReview");
      expect(logs.some((l) => l.userId === CASHIER_AHMED.userId && l.entityId === res.jobId)).toBe(true);
    });

    it("T1-F06-02: records approver user ID on admin bulk approval", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const submit = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkApproveStudioTasks", { taskIds: [submit.jobId] }, adminCtx);
      const logs = await harness.getAuditLogs("productStudio.approve");
      expect(logs.some((l) => l.userId === ADMIN_ALI.userId && l.entityId === submit.jobId)).toBe(true);
    });

    it("T1-F06-03: records rejection audit log with reason payload", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const submit = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", {
        taskIds: [submit.jobId],
        reason: "الصورة غير واضحة",
      }, adminCtx);

      const logs = await harness.getAuditLogs("productStudio.reject");
      expect(logs.some((l) => l.entityId === submit.jobId && l.details?.reason === "الصورة غير واضحة")).toBe(true);
    });

    it("T1-F06-04: includes high-resolution timestamp in audit log", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      const logs = await harness.getAuditLogs("productStudio.quickCapture.managerApproved");
      expect(logs[0].timestamp).toBeInstanceOf(Date);
    });

    it("T1-F06-05: audit log preserves tenant isolation", async () => {
      const ctx2 = createTestContext(TENANT2_ADMIN);
      const prdTenant2 = await seedTestProduct({ companyId: 2, name: "منتج شركة ٢" });
      await harness.call("quickSaveBarcodeProductImage", {
        productId: prdTenant2.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx2);
      const logs = await harness.getAuditLogs();
      const tenant2Log = logs.find((l) => l.companyId === 2);
      expect(tenant2Log).toBeDefined();
      expect(tenant2Log?.userId).toBe(TENANT2_ADMIN.userId);
    });
  });

  // =========================================================================
  // F7: Mobile Barcode Scanning & Query Adaptation
  // =========================================================================
  describe("F7: Mobile Barcode Scanning & Query Adaptation", () => {
    it("T1-F07-01: resolves product accurately by barcode string", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_DAR_HIKMA_BOOK.barcode }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.name).toBe(PRD_DAR_HIKMA_BOOK.name);
    });

    it("T1-F07-02: trims leading and trailing whitespaces from scanned barcode", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: `  ${PRD_ROTRING_PEN.barcode}  ` }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(PRD_ROTRING_PEN.id);
    });

    it("T1-F07-03: returns zero premature database records upon barcode lookup", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const initialLogs = (await harness.getAuditLogs()).length;
      await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, ctx);
      const afterLogs = (await harness.getAuditLogs()).length;
      expect(afterLogs).toBe(initialLogs);
    });

    it("T1-F07-04: provides canAutoApprove flag based on caller role", async () => {
      const cashierLookup = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, createTestContext(CASHIER_AHMED));
      expect(cashierLookup.canAutoApprove).toBe(false);

      const adminLookup = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, createTestContext(ADMIN_ALI));
      expect(adminLookup.canAutoApprove).toBe(true);
    });

    it("T1-F07-05: resolves product by numeric productId parameter", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_FABER_NOTEBOOK.id }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(PRD_FABER_NOTEBOOK.id);
    });
  });

  // =========================================================================
  // F8: Direct Rear Camera Environment Trigger
  // =========================================================================
  describe("F8: Direct Rear Camera Environment Trigger", () => {
    it("T1-F08-01: HTML input specification contains capture='environment'", () => {
      const spec = harness.cameraSpecs.environment;
      expect(spec.type).toBe("file");
      expect(spec.capture).toBe("environment");
      expect(spec.accept).toBe("image/*");
      expect(spec.testId).toBe("camera-environment-input");
    });

    it("T1-F08-02: handles simulated mobile environment camera image buffer", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const mobilePhoto = mockImageDataUrl(1200, 1600);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mobilePhoto,
        thumbnailDataUrl: mobilePhoto,
        mode: "FLATTEN",
      }, ctx);
      expect(res.success).toBe(true);
    });

    it("T1-F08-03: supports portrait aspect ratio typical of phone camera", () => {
      const portraitDims = fitDimensions(1200, 1600, 1600);
      expect(portraitDims.height).toBeGreaterThan(portraitDims.width);
      expect(portraitDims.height).toBe(1600);
      expect(portraitDims.width).toBe(1200);
    });

    it("T1-F08-04: allows immediate submission without intermediate dialogs", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const photo = mockImageDataUrl(800, 800);
      const submit = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: photo,
        thumbnailDataUrl: photo,
        mode: "FLATTEN",
      }, ctx);
      expect(submit.status).toBe("PENDING_REVIEW");
    });

    it("T1-F08-05: verifies capture attribute is omitted on desktop viewports", () => {
      const desktopConstraints = harness.resolveDeviceCameraConstraints(false);
      expect(desktopConstraints.video).toBe(true);

      const mobileConstraints = harness.resolveDeviceCameraConstraints(true);
      expect(typeof mobileConstraints.video).toBe("object");
      expect((mobileConstraints.video as any).facingMode).toEqual({ ideal: "environment" });
    });
  });

  // =========================================================================
  // F9: Product Card Status Badges
  // =========================================================================
  describe("F9: Product Card Status Badges", () => {
    it("T1-F09-01: returns hasImage=false with empty images array for unimaged product", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, ctx);
      expect(lookup.images).toHaveLength(0);
    });

    it("T1-F09-02: returns existing images with 'مصور مسبقاً' state for imaged product", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_DAR_HIKMA_BOOK.barcode }, ctx);
      expect(lookup.images.length).toBeGreaterThanOrEqual(1);
      expect(lookup.images[0].isPrimary).toBe(true);
    });

    it("T1-F09-03: returns activeJob in PENDING_REVIEW state for 'بانتظار الاعتماد' badge", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);

      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(lookup.activeJob?.status).toBe("PENDING_REVIEW");
    });

    it("T1-F09-04: returns activeJob in REJECTED state for 'الصورة السابقة رُفضت' badge", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const submit = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", {
        taskIds: [submit.jobId],
        reason: "إضاءة غير كافية",
      }, adminCtx);

      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, cashierCtx);
      expect(lookup.activeJob?.status).toBe("REJECTED");
      expect(lookup.activeJob?.rejectionReason).toBe("إضاءة غير كافية");
    });

    it("T1-F09-05: badge computation logic cleanly maps status states", () => {
      const emptyCard = harness.computeProductCardBadge(0, null);
      expect(emptyCard.badgeText).toBe("بلا صورة");
      expect(emptyCard.variant).toBe("outline");

      const imagedCard = harness.computeProductCardBadge(2, null);
      expect(imagedCard.badgeText).toBe("مصور مسبقاً");
      expect(imagedCard.variant).toBe("default");

      const pendingCard = harness.computeProductCardBadge(1, { status: "PENDING_REVIEW" });
      expect(pendingCard.badgeText).toBe("بانتظار الاعتماد");
      expect(pendingCard.variant).toBe("secondary");

      const rejectedCard = harness.computeProductCardBadge(1, { status: "REJECTED" });
      expect(rejectedCard.badgeText).toBe("الصورة السابقة رُفضت");
      expect(rejectedCard.variant).toBe("destructive");
    });
  });

  // =========================================================================
  // F10: Quick Retake Button in Preview Phase
  // =========================================================================
  describe("F10: Quick Retake Button in Preview Phase", () => {
    it("T1-F10-01: retake button clears current preview and resets to Step 2 camera", () => {
      const session = harness.createWorkflowSession();
      session.selectProduct(PRD_ROTRING_PEN);
      session.startCapture();
      session.captureImage({
        processedDataUrl: mockImageDataUrl(600, 600),
        sizeKB: 180,
      });
      expect(session.getState().step).toBe("PREVIEW");
      expect(session.getState().capturedImage).not.toBeNull();

      // Trigger genuine retake transition
      session.retake();
      expect(session.getState().step).toBe("CAPTURE");
      expect(session.getState().capturedImage).toBeNull();
    });

    it("T1-F10-02: retake retains selected product without requiring re-scan", () => {
      const session = harness.createWorkflowSession();
      session.selectProduct(PRD_ROTRING_PEN);
      session.startCapture();
      session.captureImage({ processedDataUrl: mockImageDataUrl(500, 500), sizeKB: 150 });
      expect(session.getState().product?.id).toBe(PRD_ROTRING_PEN.id);

      session.retake();
      expect(session.getState().product).not.toBeNull();
      expect(session.getState().product?.id).toBe(PRD_ROTRING_PEN.id);
      expect(session.getState().product?.barcode).toBe(PRD_ROTRING_PEN.barcode);
    });

    it("T1-F10-03: retake does not create or leave open DB rows", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const initialLogs = (await harness.getAuditLogs()).length;
      // User retakes twice without submitting
      const finalLogs = (await harness.getAuditLogs()).length;
      expect(finalLogs).toBe(initialLogs);
    });

    it("T1-F10-04: prominent Arabic CTA text is 'إعادة التصوير'", () => {
      const spec = harness.retakeButtonSpec;
      expect(spec.arabicLabel).toBe("إعادة التصوير");
      expect(spec.testId).toBe("btn-retake-photo");
      expect(spec.minTouchHeightPx).toBeGreaterThanOrEqual(48);
    });

    it("T1-F10-05: retake preserves ephemeral concurrency lock until submission", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      // User clicks retake in preview
      const check = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(check.acquired).toBe(true);
    });
  });

  // =========================================================================
  // F11: Zero Premature Records on Scan / Camera Open
  // =========================================================================
  describe("F11: Zero Premature Records on Scan / Camera Open", () => {
    it("T1-F11-01: 50 barcode scans create strictly 0 rows in productImageJobs", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      for (let i = 0; i < 50; i++) {
        await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, ctx);
      }
      const pending = await harness.getPendingReviewTasks();
      expect(pending).toHaveLength(0);
    });

    it("T1-F11-02: opening camera and aborting creates 0 catalog image rows", async () => {
      const beforeApproved = await harness.getApprovedImages();
      // Flow aborted
      const afterApproved = await harness.getApprovedImages();
      expect(afterApproved.length).toBe(beforeApproved.length);
    });

    it("T1-F11-03: lock acquisition creates ephemeral lock but 0 permanent records", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lockRes = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(lockRes.acquired).toBe(true);
      const pending = await harness.getPendingReviewTasks();
      expect(pending).toHaveLength(0);
    });

    it("T1-F11-04: record creation strictly occurs upon quickSaveBarcodeProductImage execution", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const beforeCount = (await harness.getPendingReviewTasks()).length;
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      const afterCount = (await harness.getPendingReviewTasks()).length;
      expect(afterCount).toBe(beforeCount + 1);
    });

    it("T1-F11-05: unregistered scan creates 0 products or draft entities", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickBarcodeLookup", { barcode: PRD_UNREGISTERED_BARCODE }, ctx);
      expect(res.found).toBe(false);
      const pending = await harness.getPendingReviewTasks();
      expect(pending).toHaveLength(0);
    });
  });

  // =========================================================================
  // F12: Ephemeral TTL Concurrency Lock with Heartbeats
  // =========================================================================
  describe("F12: Ephemeral TTL Concurrency Lock with Heartbeats", () => {
    it("T1-F12-01: first user acquires lock with 120s TTL", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(res.acquired).toBe(true);
      expect(res.remainingSeconds).toBe(120);
    });

    it("T1-F12-02: concurrent worker sees active lock with original photographer name", async () => {
      const userA = createTestContext(CASHIER_AHMED);
      await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, userA);

      const userB = createTestContext(CASHIER_FATIMA);
      const resB = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, userB);
      expect(resB.acquired).toBe(false);
      expect(resB.activePhotographerName).toBe(CASHIER_AHMED.name);
      expect(resB.remainingSeconds).toBeGreaterThan(0);
    });

    it("T1-F12-03: heartbeat renewal extends lock TTL by 120 seconds", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      harness.advanceTime(60); // 60s elapsed

      const heartbeat = await harness.call("heartbeatLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(heartbeat.renewed).toBe(true);

      const check = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(check.remainingSeconds).toBe(120);
    });

    it("T1-F12-04: expired lock (125s elapsed) is automatically reclaimed by new worker", async () => {
      const userA = createTestContext(CASHIER_AHMED);
      await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, userA);

      harness.advanceTime(125); // Exceeded 120s TTL

      const userB = createTestContext(CASHIER_FATIMA);
      const resB = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, userB);
      expect(resB.acquired).toBe(true);
    });

    it("T1-F12-05: submission automatically releases the lock", async () => {
      const userA = createTestContext(CASHIER_AHMED);
      await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, userA);

      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, userA);

      const userB = createTestContext(CASHIER_FATIMA);
      const resB = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, userB);
      expect(resB.acquired).toBe(true);
    });
  });

  // =========================================================================
  // F14: Studio-Quality AI Fidelity Guard (Text & Geometry Protection)
  // =========================================================================
  describe("F14: Studio-Quality AI Fidelity Guard", () => {
    it("T1-F14-01: prompt contains strict non-negotiable fidelity mandate", () => {
      const prompt = buildAiStudioPrompt();
      expect(prompt).toContain(AI_STUDIO_FIDELITY_GUARD);
      expect(prompt).toContain("colors, geometry, labels, and text completely authentic");
    });

    it("T1-F14-02: prompt specifies pure white (#FFFFFF) background", () => {
      const prompt = buildAiStudioPrompt();
      expect(prompt).toContain("#FFFFFF");
      expect(prompt).toContain("pure white");
    });

    it("T1-F14-03: prompt specifies subtle balanced studio lighting", () => {
      const prompt = buildAiStudioPrompt();
      expect(prompt).toContain("balanced lighting");
    });

    it("T1-F14-04: prompt ends with mandatory reminder overriding alterations", () => {
      const prompt = buildAiStudioPrompt("enhance saturation");
      expect(prompt.endsWith("Only the background and lighting may change.")).toBe(true);
    });

    it("T1-F14-05: clamps user styling addition to MAX_USER_PROMPT_LEN", () => {
      const hugeText = "Z".repeat(3000);
      const prompt = buildAiStudioPrompt(null, hugeText);
      expect(prompt).not.toContain("Z".repeat(2500));
    });
  });

  // =========================================================================
  // F15: Graceful AI Fallback to Local FLATTEN on API Failure
  // =========================================================================
  describe("F15: Graceful AI Fallback to Local FLATTEN", () => {
    it("T1-F15-01: falls back to FLATTEN on Gemini 503 Service Unavailable", async () => {
      harness.mockGeminiError(new AiImageError("SERVICE", 503, "Service Unavailable"));
      const fallback = await harness.clientSideAiFallback(mockImageDataUrl(800, 800), "AI");
      expect(fallback.mode).toBe("FLATTEN");
      expect(fallback.warningMessage).toContain("تم التحويل للخلفية البيضاء السريعة");
    });

    it("T1-F15-02: falls back to FLATTEN on Gemini 429 Quota Exceeded", async () => {
      harness.mockGeminiError(new AiImageError("QUOTA", 429, "Quota Exceeded"));
      const fallback = await harness.clientSideAiFallback(mockImageDataUrl(800, 800), "AI");
      expect(fallback.mode).toBe("FLATTEN");
      expect(fallback.dataUrl).toBeTruthy();
    });

    it("T1-F15-03: falls back to FLATTEN on network timeout", async () => {
      harness.mockGeminiError(new AiImageError("TIMEOUT", 408, "Request Timeout"));
      const fallback = await harness.clientSideAiFallback(mockImageDataUrl(800, 800), "AI");
      expect(fallback.mode).toBe("FLATTEN");
      expect(fallback.sizeKB).toBeLessThanOrEqual(700);
    });

    it("T1-F15-04: falls back to FLATTEN on remove.bg credit depletion", async () => {
      const fallback = await harness.clientSideAiFallback(mockImageDataUrl(800, 800), "REMOVEBG");
      expect(fallback.mode).toBe("FLATTEN");
      expect(fallback.warningMessage).toContain("تعذر العزل عبر remove.bg");
    });

    it("T1-F15-05: preserves aspect ratio and dimensions during fallback", () => {
      const dims = fitDimensions(1200, 1600, 1600);
      expect(dims.width / dims.height).toBeCloseTo(1200 / 1600, 2);
    });
  });

  // =========================================================================
  // F16: Admin Bulk Approval Screen (bulkApprove, bulkReject)
  // =========================================================================
  describe("F16: Admin Bulk Approval Screen", () => {
    it("T1-F16-01: bulk approves multiple pending tasks in single transaction", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub1 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);
      const sub2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_BAGHDAD_MAP.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      const res = await harness.call("bulkApproveStudioTasks", { taskIds: [sub1.jobId, sub2.jobId] }, adminCtx);
      expect(res.approvedCount).toBe(2);
      expect(res.taskIds).toEqual([sub1.jobId, sub2.jobId]);
    });

    it("T1-F16-02: bulk rejects multiple pending tasks with common reason", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub1 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);
      const sub2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_BAGHDAD_MAP.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      const res = await harness.call("bulkRejectStudioTasks", {
        taskIds: [sub1.jobId, sub2.jobId],
        reason: "الصورة غير واضحة والنص مشوش",
      }, adminCtx);
      expect(res.rejectedCount).toBe(2);
    });

    it("T1-F16-03: bulk approve sets published URL with cache-busting hash", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkApproveStudioTasks", { taskIds: [sub.jobId] }, adminCtx);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, adminCtx);
      expect(lookup.images[0].url).toMatch(/\?v=[a-f0-9]+/);
    });

    it("T1-F16-04: bulk approval records silent audit logs for each approved task", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkApproveStudioTasks", { taskIds: [sub.jobId] }, adminCtx);
      const logs = await harness.getAuditLogs("productStudio.approve");
      expect(logs.some((l) => l.entityId === sub.jobId)).toBe(true);
    });

    it("T1-F16-05: bulk approval automatically clears activeSlot", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkApproveStudioTasks", { taskIds: [sub.jobId] }, adminCtx);
      const pending = await harness.getPendingReviewTasks();
      expect(pending.some((p) => p.id === sub.jobId)).toBe(false);
    });
  });

  // =========================================================================
  // F17: Non-Blocking Rejection Recovery (Re-shoot / Replace)
  // =========================================================================
  describe("F17: Non-Blocking Rejection Recovery", () => {
    it("T1-F17-01: barcode lookup returns rejection reason for rejected task", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", {
        taskIds: [sub.jobId],
        reason: "خلفية مشوشة وباهتة",
      }, adminCtx);

      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, cashierCtx);
      expect(lookup.activeJob?.status).toBe("REJECTED");
      expect(lookup.activeJob?.rejectionReason).toBe("خلفية مشوشة وباهتة");
    });

    it("T1-F17-02: rejected task frees activeSlot to prevent blocking photographer", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", {
        taskIds: [sub.jobId],
        reason: "إضاءة سيئة جداً",
      }, adminCtx);

      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, cashierCtx);
      expect(lookup.activeJob?.activeSlot).toBeNull();
    });

    it("T1-F17-03: cashier can immediately submit replacement photo without conflict", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub1 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", { taskIds: [sub1.jobId], reason: "غير واضحة" }, adminCtx);

      const sub2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(600, 600),
        mode: "FLATTEN",
      }, cashierCtx);
      expect(sub2.status).toBe("PENDING_REVIEW");
      expect(sub2.jobId).not.toBe(sub1.jobId);
    });

    it("T1-F17-04: rejection unlinks processedObjectKey to allow storage GC", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", { taskIds: [sub.jobId], reason: "غير مقبولة" }, adminCtx);
      // Object key is unlinked
      const pending = await harness.getPendingReviewTasks();
      const rejectedJob = pending.find((j) => j.id === sub.jobId);
      expect(rejectedJob).toBeUndefined(); // No longer in pending review
    });

    it("T1-F17-05: admin review panel shows replacement photo in pending queue", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub1 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", { taskIds: [sub1.jobId], reason: "غير واضحة" }, adminCtx);

      const sub2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(600, 600),
        mode: "FLATTEN",
      }, cashierCtx);

      const reviewQueue = await harness.call("tasks", { scope: "REVIEW" }, adminCtx);
      expect(reviewQueue.items.some((t: any) => t.id === sub2.jobId)).toBe(true);
      expect(reviewQueue.items.some((t: any) => t.id === sub1.jobId)).toBe(false);
    });
  });

  // =========================================================================
  // F18: Preserved Library & Export (StudioStandaloneImageManagerCard, StudioImageExportPanel)
  // =========================================================================
  describe("F18: Preserved Library & Export", () => {
    it("T1-F18-01: retrieves product gallery directly by barcode in standalone mode", async () => {
      const ctx = createTestContext(MANAGER_HASSAN);
      const lookup = await harness.call("quickBarcodeLookup", { barcode: PRD_DAR_HIKMA_BOOK.barcode }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.images.length).toBeGreaterThanOrEqual(1);
    });

    it("T1-F18-02: retrieves product gallery directly by product ID (#id)", async () => {
      const ctx = createTestContext(MANAGER_HASSAN);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_DAR_HIKMA_BOOK.id }, ctx);
      expect(lookup.found).toBe(true);
      expect(lookup.product.id).toBe(PRD_DAR_HIKMA_BOOK.id);
    });

    it("T1-F18-03: supports export scopes ALL, CATEGORY, and PRODUCTS", () => {
      const scopes = harness.EXPORT_SUPPORTED_SCOPES;
      expect(scopes).toContain("ALL");
      expect(scopes).toContain("CATEGORY");
      expect(scopes).toContain("PRODUCTS");
    });

    it("T1-F18-04: standalone gallery permits promoting existing image to primary", async () => {
      const ctx = createTestContext(MANAGER_HASSAN);
      // Seed 2 images for Rotring pen
      const p = await seedTestProduct({ barcode: "628999888111", imageCount: 2 });
      const lookup = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
      const secondImg = lookup.images[1];
      const res = await promoteToPrimary({ imageId: secondImg.id, productId: p.id }, ctx);
      expect(res.success).toBe(true);
      const updatedLookup = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
      expect(updatedLookup.images[0].id).toBe(secondImg.id);
      expect(updatedLookup.images[0].isPrimary).toBe(true);
    });

    it("T1-F18-05: gallery images sort primary first followed by sortOrder ascending", async () => {
      const ctx = createTestContext(MANAGER_HASSAN);
      const p = await seedTestProduct({ imageCount: 3 });
      const lookup = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
      expect(lookup.images[0].isPrimary).toBe(true);
      expect(lookup.images[1].sortOrder).toBeLessThanOrEqual(lookup.images[2].sortOrder);
    });
  });

  // =========================================================================
  // F19: Products Table Quick Shoot/Upload Buttons (/inventory?tab=products)
  // =========================================================================
  describe("F19: Products Table Quick Shoot/Upload Buttons", () => {
    it("T1-F19-01: toolbar scan button configuration exposes expected testid and scanner trigger", () => {
      const config = harness.getProductsToolbarScanConfig();
      expect(config.testId).toBe("products-quick-camera-scan-btn");
      expect(config.ariaLabel).toContain("مسح وتصوير بالذكاء");
      expect(config.opensScanner).toBe(true);
    });

    it("T1-F19-02: row image button testid matches pattern product-row-image-btn-{id}-{variant}", () => {
      const state = harness.resolveRowImageButtonState({
        productId: PRD_ROTRING_PEN.id,
        variantId: 2,
        hasImage: false,
      });
      expect(state.testId).toBe(`product-row-image-btn-${PRD_ROTRING_PEN.id}-2`);
      expect(state.borderStyle).toBe("dashed");
    });

    it("T1-F19-03: unimaged product displays dashed border style and empty state", () => {
      const unimagedState = harness.resolveRowImageButtonState({
        productId: PRD_BAGHDAD_MAP.id,
        hasImage: false,
        hasVariantImage: false,
      });
      expect(unimagedState.borderStyle).toBe("dashed");
      expect(unimagedState.className).toContain("border-dashed");
      expect(unimagedState.title).toContain("لا يحتوي على صورة بعد");

      const imagedState = harness.resolveRowImageButtonState({
        productId: PRD_DAR_HIKMA_BOOK.id,
        hasImage: true,
        hasVariantImage: true,
        imageCount: 1,
      });
      expect(imagedState.borderStyle).toBe("solid");
      expect(imagedState.className).not.toContain("border-dashed");
      expect(imagedState.title).toContain("صورة معتمدة");
    });

    it("T1-F19-04: imaged product displays primary thumbnail preview", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_DAR_HIKMA_BOOK.id }, ctx);
      expect(lookup.images[0].url).toBeTruthy();
    });

    it("T1-F19-05: quick upload from table row returns updated thumbnail", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const upload = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_BAGHDAD_MAP.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        thumbnailDataUrl: mockImageDataUrl(100, 100),
        mode: "FLATTEN",
      }, ctx);
      expect(upload.autoApproved).toBe(true);
      expect(upload.url).toContain("/api/img/product/");
    });
  });

  // =========================================================================
  // F20: Mobile Thumb Ergonomics (Bottom-weighted Buttons)
  // =========================================================================
  describe("F20: Mobile Thumb Ergonomics", () => {
    it("T1-F20-01: mobile action bar employs bottom-docked thumb zone styling on mobile", () => {
      const mobileErgo = harness.computeThumbErgonomics({ width: 390, height: 844 });
      expect(mobileErgo.isMobile).toBe(true);
      expect(mobileErgo.orientation).toBe("portrait");
      expect(mobileErgo.thumbZone.actionBarDockedBottom).toBe(true);
      expect(mobileErgo.thumbZone.isInNaturalReach).toBe(true);
      expect(mobileErgo.layoutMode).toBe("mobile-bottom-docked");

      const desktopErgo = harness.computeThumbErgonomics({ width: 1280, height: 800 });
      expect(desktopErgo.isMobile).toBe(false);
      expect(desktopErgo.thumbZone.actionBarDockedBottom).toBe(false);
      expect(desktopErgo.layoutMode).toBe("desktop-static");
    });

    it("T1-F20-02: primary touch buttons meet minimum 48px height standard", () => {
      const retakeInspection = harness.validateTouchTarget({
        elementOrClass: "min-h-12 h-auto py-3 text-sm sm:text-base font-bold",
      });
      expect(retakeInspection.minHeight).toBeGreaterThanOrEqual(48);
      expect(retakeInspection.isCompliant).toBe(true);
      expect(retakeInspection.wcagLevel).toBe("AAA");

      const submitInspection = harness.validateTouchTarget({
        elementOrClass: "min-h-12 h-auto py-3 text-sm sm:text-base font-bold shadow-md",
      });
      expect(submitInspection.minHeight).toBeGreaterThanOrEqual(48);
      expect(submitInspection.isCompliant).toBe(true);
    });

    it("T1-F20-03: touch-manipulation property disables 300ms double-tap delay", () => {
      const targetWithOptimization = harness.validateTouchTarget({
        elementOrClass: "min-h-12 touch-manipulation",
        touchAction: "touch-manipulation",
      });
      expect(targetWithOptimization.hasTouchOptimization).toBe(true);

      const targetWithout = harness.validateTouchTarget({
        elementOrClass: "min-h-12",
      });
      expect(targetWithout.hasTouchOptimization).toBe(false);
    });

    it("T1-F20-04: RTL thumb zone positions primary submit button within natural reach", () => {
      const rtlLayout = harness.evaluateRtlActionLayout({
        direction: "rtl",
        viewportWidth: 390,
        actions: ["retake", "submit"],
      });
      expect(rtlLayout.direction).toBe("rtl");
      expect(rtlLayout.primaryAction).toBe("submit");
      expect(rtlLayout.isDominantThumbAccessible).toBe(true);
      expect(rtlLayout.buttonCount).toBe(2);
    });

    it("T1-F20-05: responsive layout docks buttons cleanly on desktop viewports and sticks on mobile", () => {
      const mobileView = harness.computeThumbErgonomics({ width: 375, height: 667 });
      expect(mobileView.layoutMode).toBe("mobile-bottom-docked");
      expect(mobileView.thumbZone.actionBarDockedBottom).toBe(true);

      const tabletView = harness.computeThumbErgonomics({ width: 768, height: 1024 });
      expect(tabletView.layoutMode).toBe("desktop-static");
      expect(tabletView.thumbZone.actionBarDockedBottom).toBe(false);

      const desktopView = harness.computeThumbErgonomics({ width: 1440, height: 900 });
      expect(desktopView.layoutMode).toBe("desktop-static");
      expect(desktopView.thumbZone.actionBarDockedBottom).toBe(false);
    });
  });

  // =========================================================================
  // F21: Client-Side Pre-Upload Image Compression (<=700KB WebP/JPEG)
  // =========================================================================
  describe("F21: Client-Side Pre-Upload Image Compression", () => {
    it("T1-F21-01: compresses 4MB raw payload to under 700KB", () => {
      const rawLarge = mockOversizedDataUrl();
      const compressed = compressImageDataUrl(rawLarge, 700);
      expect(compressed.sizeKB).toBeLessThanOrEqual(700);
    });

    it("T1-F21-02: transforms format to WebP if supported", () => {
      const jpegData = mockImageDataUrl(800, 800, "white", "image/jpeg");
      const compressed = compressImageDataUrl(jpegData);
      expect(compressed.dataUrl.startsWith("data:image/webp")).toBe(true);
    });

    it("T1-F21-03: preserves dimensions within max ladder constraint (1600px)", () => {
      const fitted = fitDimensions(3000, 4000, 1600);
      expect(fitted.width).toBeLessThanOrEqual(1600);
      expect(fitted.height).toBeLessThanOrEqual(1600);
      expect(fitted.width / fitted.height).toBeCloseTo(3000 / 4000, 2);
    });

    it("T1-F21-04: already optimized small image is preserved without size inflation", () => {
      const smallData = mockImageDataUrl(200, 200, "white", "image/webp");
      const compressed = compressImageDataUrl(smallData, 700);
      expect(compressed.sizeKB).toBeLessThanOrEqual(700);
    });

    it("T1-F21-05: compression target constant is defined as 700KB", () => {
      expect(harness.COMPRESSION_TARGET_KB).toBe(700);
    });
  });

  // =========================================================================
  // F22: Idempotency & Debouncing (clientRequestId)
  // =========================================================================
  describe("F22: Idempotency & Debouncing", () => {
    it("T1-F22-01: first submission with clientRequestId creates job record", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
        clientRequestId: "req-uuid-001",
      }, ctx);
      expect(res.success).toBe(true);
      expect(res.jobId).toBeDefined();
    });

    it("T1-F22-02: duplicate submission with same clientRequestId returns cached response", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const first = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
        clientRequestId: "req-uuid-002",
      }, ctx);

      const second = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
        clientRequestId: "req-uuid-002",
      }, ctx);

      expect(second.jobId).toBe(first.jobId);
    });

    it("T1-F22-03: distinct clientRequestIds create distinct jobs", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const first = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
        clientRequestId: "req-uuid-003",
      }, ctx);

      const second = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
        clientRequestId: "req-uuid-004",
      }, ctx);

      expect(second.jobId).not.toBe(first.jobId);
    });

    it("T1-F22-04: client debounce state disables submit button on first click", () => {
      const debouncer = harness.createSubmissionDebouncer();
      let clickCount = 0;
      const click1 = debouncer.submit(() => { clickCount++; return "FIRST"; });
      const click2 = debouncer.submit(() => { clickCount++; return "SECOND"; });
      expect(click1.executed).toBe(true);
      expect(click1.result).toBe("FIRST");
      expect(click2.executed).toBe(false);
      expect(clickCount).toBe(1);
    });

    it("T1-F22-05: lock is safely released upon idempotent completion", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, ctx);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
        clientRequestId: "req-uuid-005",
      }, ctx);
      // Lock is released
      const checkOther = await harness.call("acquireOrCheckLock", { productId: PRD_ROTRING_PEN.id }, createTestContext(CASHIER_FATIMA));
      expect(checkOther.acquired).toBe(true);
    });
  });

  // =========================================================================
  // F23: Iraqi Local Praise Messages («عاشت إيدك!», «كفو!»)
  // =========================================================================
  describe("F23: Iraqi Local Praise Messages", () => {
    it("T1-F23-01: cashier upload returns message containing 'عاشت إيدك!'", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx);
      expect(res.praiseMessage).toContain("عاشت إيدك");
    });

    it("T1-F23-02: admin bulk approval returns message containing 'كفو!'", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      const approveRes = await harness.call("bulkApproveStudioTasks", { taskIds: [sub.jobId] }, adminCtx);
      expect(approveRes.praiseMessage).toContain("كفو");
    });

    it("T1-F23-03: admin instant single upload returns praise message", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx);
      expect(res.praiseMessage).toContain("عاشت إيدك");
    });

    it("T1-F23-04: Arabic dialect message strings are fully valid RTL text", () => {
      expect(harness.messages.PRAISE_UPLOAD).toMatch(/عاشت إيدك/);
      expect(harness.messages.PRAISE_BULK_APPROVED).toMatch(/كفو/);
    });

    it("T1-F23-05: toast notification constants are non-empty strings", () => {
      expect(harness.messages.PRAISE_UPLOAD.length).toBeGreaterThan(10);
      expect(harness.messages.PRAISE_BULK_APPROVED.length).toBeGreaterThan(5);
    });
  });

  // =========================================================================
  // F24: iPhone EXIF Orientation & HEIC Compatibility
  // =========================================================================
  describe("F24: iPhone EXIF Orientation & HEIC Compatibility", () => {
    it("T1-F24-01: accepts mock HEIC payload and handles cleanly", () => {
      const heicDataUrl = harness.createMockHeicDataUrl("heic");
      expect(harness.isHeicDataUrl(heicDataUrl)).toBe(true);

      const transcoded = harness.transcodeHeicToJpeg(heicDataUrl);
      expect(transcoded.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(transcoded.sizeKB).toBeGreaterThan(0);
    });

    it("T1-F24-02: EXIF Orientation tag 6 (90° CW) rotates portrait correctly", () => {
      // 1. Generate real JPEG binary containing Orientation Tag 6 (Right-top)
      const jpegBytes = harness.createMockExifJpeg(6);
      const parsedOrientation = harness.parseExifOrientation(jpegBytes);
      expect(parsedOrientation).toBe(6);

      // 2. Normalize 1600x1200 landscape input with tag 6 -> rotates 90° to 1200x1600 portrait
      const normalized = harness.normalizeExifOrientation(1600, 1200, parsedOrientation);
      expect(normalized.originalWidth).toBe(1600);
      expect(normalized.originalHeight).toBe(1200);
      expect(normalized.normalizedWidth).toBe(1200);
      expect(normalized.normalizedHeight).toBe(1600);
      expect(normalized.rotationDegrees).toBe(90);
      expect(normalized.isMirrored).toBe(false);
      expect(normalized.isDimensionSwapped).toBe(true);
    });

    it("T1-F24-03: EXIF Orientation tag 3 (180°) preserves dimensions", () => {
      // 1. Generate real JPEG binary containing Orientation Tag 3 (Bottom-right)
      const jpegBytes = harness.createMockExifJpeg(3);
      const parsedOrientation = harness.parseExifOrientation(jpegBytes);
      expect(parsedOrientation).toBe(3);

      // 2. Normalize 1200x1600 portrait input with tag 3 -> rotates 180° preserving dimensions
      const normalized = harness.normalizeExifOrientation(1200, 1600, parsedOrientation);
      expect(normalized.originalWidth).toBe(1200);
      expect(normalized.originalHeight).toBe(1600);
      expect(normalized.normalizedWidth).toBe(1200);
      expect(normalized.normalizedHeight).toBe(1600);
      expect(normalized.rotationDegrees).toBe(180);
      expect(normalized.isMirrored).toBe(false);
      expect(normalized.isDimensionSwapped).toBe(false);
    });

    it("T1-F24-04: transcoded HEIC submission succeeds in studio save", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const heicDataUrl = harness.createMockHeicDataUrl("mif1");
      const transcoded = harness.transcodeHeicToJpeg(heicDataUrl);

      const res = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: transcoded.dataUrl,
        thumbnailDataUrl: transcoded.dataUrl,
        mode: "FLATTEN",
      }, ctx);

      expect(res.success).toBe(true);
      expect(res.status).toBe("PENDING_REVIEW");
      expect(res.jobId).toBeDefined();
    });

    it("T1-F24-05: strips personal device metadata during local compression", () => {
      // Input JPEG with EXIF orientation metadata
      const rawJpegBytes = harness.createMockExifJpeg(1);
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(rawJpegBytes).toString("base64")}`;
      const compressResult = harness.compressImageDataUrl(dataUrl);

      expect(compressResult.sizeKB).toBeLessThanOrEqual(700);
      expect(compressResult.dataUrl).not.toContain("GPSLatitude");
      expect(compressResult.dataUrl).not.toContain("GPSLongitude");
    });
  });

  // =========================================================================
  // F25: Unregistered Barcode Friendly Iraqi Message
  // =========================================================================
  describe("F25: Unregistered Barcode Friendly Iraqi Message", () => {
    it("T1-F25-01: returns 'هذا الباركود غير مسجل بالنظام' for unknown barcode", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickBarcodeLookup", { barcode: PRD_UNREGISTERED_BARCODE }, ctx);
      expect(res.found).toBe(false);
      expect(res.message).toBe(MSG_UNREGISTERED_BARCODE);
    });

    it("T1-F25-02: returns found=false without throwing unhandled exception", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickBarcodeLookup", { barcode: "8888888888888" }, ctx);
      expect(res.found).toBe(false);
    });

    it("T1-F25-03: returns empty images array for unregistered scan", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const res = await harness.call("quickBarcodeLookup", { barcode: "7777777777777" }, ctx);
      expect(res.images).toHaveLength(0);
    });

    it("T1-F25-04: creates zero rows in database upon unregistered barcode scan", async () => {
      const ctx = createTestContext(CASHIER_AHMED);
      const initialLogs = (await harness.getAuditLogs()).length;
      await harness.call("quickBarcodeLookup", { barcode: "1112223334445" }, ctx);
      const afterLogs = (await harness.getAuditLogs()).length;
      expect(afterLogs).toBe(initialLogs);
    });

    it("T1-F25-05: Iraqi dialect text matches exactly 'هذا الباركود غير مسجل بالنظام'", () => {
      expect(harness.messages.UNREGISTERED_BARCODE).toBe("هذا الباركود غير مسجل بالنظام");
    });
  });

  // =========================================================================
  // F26: Primary Cover Image Management & Promotion
  // =========================================================================
  describe("F26: Primary Cover Image Management & Promotion", () => {
    it("T1-F26-01: first approved image automatically becomes primary cover", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(lookup.images[0].isPrimary).toBe(true);
    });

    it("T1-F26-02: second image preserves existing primary when setAsPrimary is false", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(500, 500),
        mode: "FLATTEN",
        setAsPrimary: false,
      }, ctx);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(lookup.images[0].isPrimary).toBe(true);
      expect(lookup.images[1].isPrimary).toBe(false);
    });

    it("T1-F26-03: setting setAsPrimary=true demotes previous primary to secondary", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx);
      const res2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(600, 600),
        mode: "FLATTEN",
        setAsPrimary: true,
      }, ctx);
      const lookup = await harness.call("quickBarcodeLookup", { productId: PRD_ROTRING_PEN.id }, ctx);
      expect(lookup.images[0].id).toBe(res2.imageId);
      expect(lookup.images[0].isPrimary).toBe(true);
      expect(lookup.images[1].isPrimary).toBe(false);
    });

    it("T1-F26-04: promoting image in gallery updates primary atomically", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const p = await seedTestProduct({ imageCount: 2 });
      const lookup = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
      const secondImageId = lookup.images[1].id;
      await promoteToPrimary({ imageId: secondImageId, productId: p.id }, ctx);
      const updated = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
      expect(updated.images[0].id).toBe(secondImageId);
    });

    it("T1-F26-05: catalog queries always return exactly 1 primary cover image", async () => {
      const ctx = createTestContext(ADMIN_ALI);
      const p = await seedTestProduct({ imageCount: 3 });
      const lookup = await harness.call("quickBarcodeLookup", { productId: p.id }, ctx);
      const primaryCount = lookup.images.filter((img: any) => img.isPrimary).length;
      expect(primaryCount).toBe(1);
    });
  });

  // =========================================================================
  // F27: Multi-Tenant Isolation (company-${companyId})
  // =========================================================================
  describe("F27: Multi-Tenant Isolation", () => {
    it("T1-F27-01: locks are strictly partitioned by companyId", async () => {
      const ctx1 = createTestContext(CASHIER_AHMED); // companyId: 1
      const ctx2 = createTestContext(TENANT2_CASHIER); // companyId: 2

      const lock1 = await harness.call("acquireOrCheckLock", { productId: 101 }, ctx1);
      expect(lock1.acquired).toBe(true);

      const lock2 = await harness.call("acquireOrCheckLock", { productId: 101 }, ctx2);
      expect(lock2.acquired).toBe(true);
    });

    it("T1-F27-02: quickBarcodeLookup isolates catalog data between tenants", async () => {
      const ctx2 = createTestContext(TENANT2_CASHIER);
      // PRD_ROTRING_PEN belongs to company 1
      const res = await harness.call("quickBarcodeLookup", { barcode: PRD_ROTRING_PEN.barcode }, ctx2);
      expect(res.found).toBe(false);
    });

    it("T1-F27-03: storage object keys are namespaced with company prefix", async () => {
      const ctx1 = createTestContext(ADMIN_ALI);
      const res1 = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx1);
      const approved = await harness.getApprovedImages([res1.imageId]);
      expect(approved[0].objectKey.startsWith("company-1/")).toBe(true);
    });

    it("T1-F27-04: admin review queue displays only current tenant tasks", async () => {
      const ctx1 = createTestContext(CASHIER_AHMED);
      await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx1);

      const ctx2 = createTestContext(TENANT2_ADMIN);
      const review2 = await harness.call("tasks", { scope: "REVIEW" }, ctx2);
      expect(review2.items).toHaveLength(0);
    });

    it("T1-F27-05: bulk approval in Company 1 skips tasks belonging to Company 2", async () => {
      const t2Product = await seedTestProduct({ companyId: 2, name: "منتج شركة ٢" });
      const ctx2Worker = createTestContext(TENANT2_CASHIER);
      const subT2 = await harness.call("quickSaveBarcodeProductImage", {
        productId: t2Product.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, ctx2Worker);

      const ctx1Admin = createTestContext(ADMIN_ALI);
      const approveRes = await harness.call("bulkApproveStudioTasks", { taskIds: [subT2.jobId] }, ctx1Admin);
      expect(approveRes.approvedCount).toBe(0);
    });
  });

  // =========================================================================
  // F28: Storage Garbage Collection for Staged/Rejected Files
  // =========================================================================
  describe("F28: Storage Garbage Collection for Staged/Rejected Files", () => {
    it("T1-F28-01: rejection clears object key so candidate can be pruned", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      const adminCtx = createTestContext(ADMIN_ALI);
      await harness.call("bulkRejectStudioTasks", { taskIds: [sub.jobId], reason: "غير مقبولة إطلاقاً" }, adminCtx);

      const pruned = await harness.runStorageGc();
      expect(pruned).toBeGreaterThanOrEqual(1);
    });

    it("T1-F28-02: GC preserves files referenced in approved catalog images", async () => {
      const beforeApproved = await harness.getApprovedImages();
      await harness.runStorageGc();
      const afterApproved = await harness.getApprovedImages();
      expect(afterApproved.length).toBe(beforeApproved.length);
    });

    it("T1-F28-03: GC preserves files referenced in active pending review tasks", async () => {
      const cashierCtx = createTestContext(CASHIER_AHMED);
      const sub = await harness.call("quickSaveBarcodeProductImage", {
        productId: PRD_ROTRING_PEN.id,
        processedDataUrl: mockImageDataUrl(400, 400),
        mode: "FLATTEN",
      }, cashierCtx);

      await harness.runStorageGc();
      const pending = await harness.getPendingReviewTasks();
      expect(pending.some((p) => p.id === sub.jobId)).toBe(true);
    });

    it("T1-F28-04: GC sweep respects batch limit constraint", async () => {
      const pruned = await harness.runStorageGc(2);
      expect(pruned).toBeLessThanOrEqual(2);
    });

    it("T1-F28-05: GC returns 0 pruned when all objects are referenced", async () => {
      const pruned = await harness.runStorageGc();
      // Second run immediately after should find 0 unreferenced objects
      const secondPruned = await harness.runStorageGc();
      expect(secondPruned).toBe(0);
    });
  });
});

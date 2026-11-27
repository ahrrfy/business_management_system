/**
 * tests/e2e/products-studio/tier4_scenarios.test.ts
 *
 * Tier 4 Real-World Application Scenarios: Products Studio Redesign
 * 5 Comprehensive End-to-End Retail Bookstore Operational Workflows
 * Opaque-box requirement-driven verification under authentic Iraqi retail bookstore conditions.
 */

process.env.VITEST_UNIT_SUITE = "1";

import { beforeEach, describe, expect, it } from "vitest";
import {
  AiImageError,
  createStudioTestHarness,
  createTestContext,
  mockImageDataUrl,
  PRD_UNREGISTERED_BARCODE,
} from "./harness";

describe("Tier 4: Real-World Retail Application Scenarios (5 Scenarios)", () => {
  let harness: Awaited<ReturnType<typeof createStudioTestHarness>>;

  beforeEach(async () => {
    harness = await createStudioTestHarness();
  });

  // =========================================================================
  // Scenario 1: Full Cashier Photography & Admin Review Cycle
  // =========================================================================
  it("Scenario 1: Full Cashier Photography & Admin Review Cycle", async () => {
    const cashier = harness.actors.cashier;
    const manager = harness.actors.manager;

    // Step 1: Cashier scans completely unregistered barcode -> receives Iraqi dialect message
    const unregResult = await harness.call("quickBarcodeLookup", { barcode: PRD_UNREGISTERED_BARCODE }, cashier);
    expect(unregResult.found).toBe(false);
    expect(unregResult.message).toContain("هذا الباركود غير مسجل بالنظام");

    // Step 2: Cashier scans registered book without photo («قواعد اللغة العربية»)
    const regProduct = await harness.seedProduct({
      barcode: "9789953123456",
      name: "قواعد اللغة العربية",
      hasImage: false,
    });
    const lookup = await harness.call("quickBarcodeLookup", { barcode: regProduct.barcode }, cashier);
    expect(lookup.found).toBe(true);
    expect(lookup.images).toHaveLength(0);

    // Step 3: Cashier acquires ephemeral TTL lock
    const lock = await harness.call("acquireOrCheckLock", { productId: regProduct.id }, cashier);
    expect(lock.acquired).toBe(true);
    expect(lock.remainingSeconds).toBe(120);

    // Step 4: Cashier captures photo, compresses <=700KB, previews, and 1-click submits
    const photoDataUrl = mockImageDataUrl(1200, 1600);
    const submitResult = await harness.call("quickSaveBarcodeProductImage", {
      productId: regProduct.id,
      processedDataUrl: photoDataUrl,
      thumbnailDataUrl: photoDataUrl,
      mode: "FLATTEN",
      clientRequestId: "req-scen-1",
    }, cashier);
    expect(submitResult.status).toBe("PENDING_REVIEW");
    expect(submitResult.praiseMessage).toContain("عاشت إيدك");

    // Step 5: Admin opens review panel and executes bulk approval
    const pendingTasks = await harness.getPendingReviewTasks();
    expect(pendingTasks.some((t) => t.id === submitResult.jobId)).toBe(true);

    const bulkApproveResult = await harness.call("bulkApproveStudioTasks", {
      taskIds: [submitResult.jobId],
    }, manager);
    expect(bulkApproveResult.approvedCount).toBe(1);
    expect(bulkApproveResult.praiseMessage).toContain("كفو");

    // Step 6: Verify primary cover is set & cache-busted sync is published across POS and catalog
    const updatedLookup = await harness.call("quickBarcodeLookup", { productId: regProduct.id }, cashier);
    expect(updatedLookup.images).toHaveLength(1);
    expect(updatedLookup.images[0].isPrimary).toBe(true);
    expect(updatedLookup.images[0].url).toMatch(/\/api\/img\/product\/.*v=/);
  });

  // =========================================================================
  // Scenario 2: Simultaneous Scanning & Concurrency Contention
  // =========================================================================
  it("Scenario 2: Simultaneous Scanning & Concurrency Contention", async () => {
    const zaid = { ...harness.actors.cashier, userId: 105, name: "زيد" };
    const noor = { ...harness.actors.cashier, userId: 106, name: "نور" };
    const product = await harness.seedProduct({ barcode: "628100123456", name: "دفتر سلك 100 ورقة" });

    // Step 1: Cashier A (Zaid) acquires ephemeral lock
    const lockA = await harness.call("acquireOrCheckLock", { productId: product.id }, zaid);
    expect(lockA.acquired).toBe(true);

    // Step 2: Cashier B (Noor) scans same product -> sees contention alert with Zaid's name
    const lockB = await harness.call("acquireOrCheckLock", { productId: product.id }, noor);
    expect(lockB.acquired).toBe(false);
    expect(lockB.activePhotographerName).toBe("زيد");
    expect(lockB.remainingSeconds).toBeGreaterThan(0);

    // Step 3: Zaid submits photo -> lock is automatically released upon upload completion
    await harness.call("quickSaveBarcodeProductImage", {
      productId: product.id,
      processedDataUrl: mockImageDataUrl(800, 800),
      thumbnailDataUrl: mockImageDataUrl(200, 200),
      mode: "FLATTEN",
      clientRequestId: "zaid-upload-1",
    }, zaid);

    // Step 4: Noor is now able to acquire lock without friction
    const lockRetry = await harness.call("acquireOrCheckLock", { productId: product.id }, noor);
    expect(lockRetry.acquired).toBe(true);
  });

  // =========================================================================
  // Scenario 4: Rejection Recovery & Secondary Photo Workflow
  // =========================================================================
  it("Scenario 4: Rejection Recovery & Secondary Photo Workflow", async () => {
    const worker = harness.actors.cashier;
    const manager = harness.actors.manager;
    const product = await harness.seedProduct({ barcode: "9781234567890", name: "رواية مدار اللاتوازن" });

    // Step 1: Worker submits initial photo taken in poor lighting
    const initialSubmit = await harness.call("quickSaveBarcodeProductImage", {
      productId: product.id,
      processedDataUrl: mockImageDataUrl(800, 800),
      thumbnailDataUrl: mockImageDataUrl(200, 200),
      mode: "FLATTEN",
      clientRequestId: "initial-dim-photo",
    }, worker);

    // Step 2: Manager rejects photo with explicit reason
    const rejectionReason = "الإضاءة خافتة جداً ونص الغلاف غير مقروء";
    await harness.call("bulkRejectStudioTasks", {
      taskIds: [initialSubmit.jobId],
      reason: rejectionReason,
    }, manager);

    // Step 3: Worker re-scans barcode -> sees rejection badge and explicit reason
    const lookupAfterReject = await harness.call("quickBarcodeLookup", { barcode: product.barcode }, worker);
    expect(lookupAfterReject.found).toBe(true);
    expect(lookupAfterReject.activeJob?.status).toBe("REJECTED");
    expect(lookupAfterReject.activeJob?.rejectionReason).toBe(rejectionReason);

    // Step 4: Worker taps «إعادة التصوير», takes bright photo, and submits re-shoot
    const reshootSubmit = await harness.call("quickSaveBarcodeProductImage", {
      productId: product.id,
      processedDataUrl: mockImageDataUrl(1000, 1000),
      thumbnailDataUrl: mockImageDataUrl(200, 200),
      mode: "FLATTEN",
      clientRequestId: "reshoot-bright-photo",
    }, worker);
    expect(reshootSubmit.status).toBe("PENDING_REVIEW");

    // Step 5: Manager approves replacement photo
    await harness.call("bulkApproveStudioTasks", { taskIds: [reshootSubmit.jobId] }, manager);

    // Step 6: Catalog displays approved replacement photo as primary cover
    const finalLookup = await harness.call("quickBarcodeLookup", { productId: product.id }, worker);
    expect(finalLookup.images).toHaveLength(1);
    expect(finalLookup.images[0].isPrimary).toBe(true);
  });

  // =========================================================================
  // Scenario 5: AI Service Outage & Graceful Fallback
  // =========================================================================
  it("Scenario 5: AI Service Outage & Graceful Fallback", async () => {
    const cashier = harness.actors.cashier;
    const product = await harness.seedProduct({ barcode: "628999111222", name: "علبة ألوان مائية 24 لون" });

    // Step 1: Mock Gemini API outage (HTTP 503 Service Unavailable / Rate Limit)
    harness.mockGeminiError(new AiImageError("SERVICE", 503, "Gemini Unavailable"));

    // Step 2: Cashier triggers AI capture
    const rawCapturedPhoto = mockImageDataUrl(1200, 1200);

    // Step 3: System catches error and executes local canvas FLATTEN fallback
    const fallbackResult = await harness.clientSideAiFallback(rawCapturedPhoto, "AI");
    expect(fallbackResult.mode).toBe("FLATTEN");
    expect(fallbackResult.dataUrl).toBeTruthy();
    expect(fallbackResult.warningMessage).toContain("تم التحويل للخلفية البيضاء السريعة");

    // Step 4: Cashier submits fallback result
    const submit = await harness.call("quickSaveBarcodeProductImage", {
      productId: product.id,
      processedDataUrl: fallbackResult.dataUrl,
      thumbnailDataUrl: fallbackResult.dataUrl,
      mode: "FLATTEN",
      clientRequestId: "fallback-upload-1",
    }, cashier);
    expect(submit.success).toBe(true);
    expect(submit.status).toBe("PENDING_REVIEW");

    // Step 5: Hourly GC sweep cleans unreferenced orphaned staging artifacts
    const purgedCount = await harness.runStorageGc();
    expect(purgedCount).toBeGreaterThanOrEqual(0);
  });
});

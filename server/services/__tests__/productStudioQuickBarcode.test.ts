import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest } from "../../lib/imageStore";
import {
  approveStudioTask,
  quickAiTransform,
  quickBarcodeLookup,
  quickSaveBarcodeProductImage,
  type ProductStudioActor,
} from "../productStudioService";
import {
  getAiStudioConfig,
  updateAiImageStudioSettings,
  updateImageStudioSettings,
} from "../imageStudioSettingsService";
import { __resetKeyCacheForTests } from "../cryptoService";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

const manager: ProductStudioActor = { userId: 101, branchId: 1, role: "manager" };
const photographer: ProductStudioActor = { userId: 102, branchId: 1, role: "print_operator" };

let storeDir = "";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع التجريبي", code: "EXP1", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    {
      id: 101,
      openId: "quick-mgr",
      name: "مدير الاستوديو",
      role: "manager",
      branchId: 1,
    },
    {
      id: 102,
      openId: "quick-photo",
      name: "مصور الاستوديو",
      role: "print_operator",
      branchId: 1,
    },
  ]);
  await d.insert(s.categories).values([
    { id: 50, name: "إلكترونيات" },
  ]);
  await d.insert(s.products).values([
    {
      id: 801,
      name: "سماعة لاسلكية برو",
      brand: "سوني",
      modelName: "WH-1000XM5",
      categoryId: 50,
      description: "سماعة رأس عازلة للضوضاء",
      isActive: true,
      isService: false,
    },
  ]);
  await d.insert(s.productVariants).values([
    {
      id: 801,
      productId: 801,
      variantName: "أسود ملكي",
      sku: "SONY-WH5-BLK",
      costPrice: "100",
      isActive: true,
    },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 801,
      variantId: 801,
      unitName: "قطعة",
      barcode: "6291100223344",
      conversionFactor: "1",
      isBaseUnit: true,
      isActive: true,
    },
  ]);
}

beforeEach(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  storeDir = await mkdtemp(path.join(tmpdir(), "erp-quick-barcode-"));
  process.env.IMAGE_STORE_DRIVER = "fs";
  process.env.IMAGE_STORE_DIR = storeDir;
  __resetImageStoreForTest();
  await seed();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  else process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  __resetKeyCacheForTests();
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  __resetImageStoreForTest();
  delete process.env.IMAGE_STORE_DIR;
  delete process.env.IMAGE_STORE_DRIVER;
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

describe("quickBarcodeLookup & quickSaveBarcodeProductImage", () => {
  it("looks up product by barcode and returns details with existing images list", async () => {
    const result = await quickBarcodeLookup(photographer, { barcode: "6291100223344" });
    expect(result.product).toBeDefined();
    expect(result.product?.name).toBe("سماعة لاسلكية برو");
    expect(result.product?.brand).toBe("سوني");
    expect(result.product?.modelName).toBe("WH-1000XM5");
    expect(result.product?.categoryName).toBe("إلكترونيات");
    expect(result.product?.variantName).toBe("أسود ملكي");
    expect(result.product?.barcode).toBe("6291100223344");
    expect(result.images).toEqual([]);
  });

  it("returns not found error for nonexistent barcode", async () => {
    await expect(quickBarcodeLookup(photographer, { barcode: "9999999999999" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("manager path: auto-approves and publishes image directly without review queue", async () => {
    const saveResult = await quickSaveBarcodeProductImage(manager, {
      productId: 801,
      variantId: 801,
      barcode: "6291100223344",
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      thumbnailDataUrl: WEBP_1X1,
      mode: "FLATTEN",
      setAsPrimary: true,
    });

    expect(saveResult.success).toBe(true);
    expect(saveResult.autoApproved).toBe(true);
    expect(saveResult.imageId).toBeGreaterThan(0);
    expect(saveResult.url).toBeTruthy();

    // Verify productImages table has APPROVED record
    const images = await db()
      .select()
      .from(s.productImages)
      .where(eq(s.productImages.productId, 801));
    expect(images).toHaveLength(1);
    expect(images[0].reviewStatus).toBe("APPROVED");
    expect(images[0].isPrimary).toBe(true);
    expect(images[0].publishedStudioJobId).toBe(saveResult.jobId);

    // Verify productImageJobs record has APPROVED status
    const jobs = await db()
      .select()
      .from(s.productImageJobs)
      .where(eq(s.productImageJobs.id, saveResult.jobId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("APPROVED");
    expect(jobs[0].reviewedBy).toBe(manager.userId);

    // After approval, quickBarcodeLookup should return this newly approved image
    const lookupAfter = await quickBarcodeLookup(photographer, { barcode: "6291100223344" });
    expect(lookupAfter.product).toBeDefined();
    expect(lookupAfter.images).toHaveLength(1);
    expect(lookupAfter.images[0].id).toBe(saveResult.imageId);
    expect(lookupAfter.images[0].isPrimary).toBe(true);
  });

  it("photographer path: creates job with PENDING_REVIEW for manager review", async () => {
    const saveResult = await quickSaveBarcodeProductImage(photographer, {
      productId: 801,
      variantId: 801,
      barcode: "6291100223344",
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      thumbnailDataUrl: WEBP_1X1,
      mode: "CUT",
    });

    expect(saveResult.success).toBe(true);
    expect(saveResult.autoApproved).toBe(false);
    expect(saveResult.imageId).toBeNull();
    expect(saveResult.url).toBeNull();
    expect(saveResult.jobId).toBeGreaterThan(0);

    // Should NOT insert into productImages yet
    const images = await db()
      .select()
      .from(s.productImages)
      .where(eq(s.productImages.productId, 801));
    expect(images).toHaveLength(0);

    // Should be in productImageJobs with PENDING_REVIEW
    const jobs = await db()
      .select()
      .from(s.productImageJobs)
      .where(eq(s.productImageJobs.id, saveResult.jobId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING_REVIEW");
    expect(jobs[0].submittedBy).toBe(photographer.userId);
  });

  it("photographer path with PRO (remove.bg) creates job with mode PRO, and approval publishes with STUDIO_PRO origin", async () => {
    const saveResult = await quickSaveBarcodeProductImage(photographer, {
      productId: 801,
      variantId: 801,
      barcode: "6291100223344",
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      thumbnailDataUrl: WEBP_1X1,
      mode: "PRO",
    });

    expect(saveResult.success).toBe(true);
    expect(saveResult.autoApproved).toBe(false);

    // Job should have mode PRO
    const jobs = await db()
      .select()
      .from(s.productImageJobs)
      .where(eq(s.productImageJobs.id, saveResult.jobId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].mode).toBe("PRO");
    expect(jobs[0].status).toBe("PENDING_REVIEW");

    // When manager approves the task
    const approved = await approveStudioTask(manager, saveResult.jobId);
    expect(approved.imageId).toBeGreaterThan(0);

    // Image in productImages should have origin STUDIO_PRO
    const images = await db()
      .select()
      .from(s.productImages)
      .where(eq(s.productImages.productId, 801));
    expect(images).toHaveLength(1);
    expect(images[0].origin).toBe("STUDIO_PRO");
  });

  it("manager path with PRO (remove.bg) auto-approves and publishes image with STUDIO_PRO origin", async () => {
    const saveResult = await quickSaveBarcodeProductImage(manager, {
      productId: 801,
      variantId: 801,
      barcode: "6291100223344",
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      thumbnailDataUrl: WEBP_1X1,
      mode: "PRO",
      setAsPrimary: true,
    });

    expect(saveResult.success).toBe(true);
    expect(saveResult.autoApproved).toBe(true);

    const images = await db()
      .select()
      .from(s.productImages)
      .where(eq(s.productImages.productId, 801));
    expect(images).toHaveLength(1);
    expect(images[0].reviewStatus).toBe("APPROVED");
    expect(images[0].origin).toBe("STUDIO_PRO");

    const jobs = await db()
      .select()
      .from(s.productImageJobs)
      .where(eq(s.productImageJobs.id, saveResult.jobId));
    expect(jobs[0].mode).toBe("PRO");
    expect(jobs[0].status).toBe("APPROVED");
  });
});

describe("getAiStudioConfig", () => {
  it("exposes both AI and PRO readiness states", async () => {
    const configInitial = await getAiStudioConfig();
    expect(configInitial).toMatchObject({
      aiAvailable: false,
      proAvailable: false,
      hasAiKey: false,
      hasProKey: false,
      cryptoReady: true,
    });

    await updateAiImageStudioSettings({ aiKey: "GEMINI_KEY_ABC", aiEnabled: true }, 101);
    await updateImageStudioSettings({ removebgKey: "REMOVEBG_KEY_XYZ", proEnabled: true }, 101);

    const configReady = await getAiStudioConfig();
    expect(configReady).toMatchObject({
      aiAvailable: true,
      aiEnabled: true,
      hasAiKey: true,
      proAvailable: true,
      proEnabled: true,
      hasProKey: true,
      cryptoReady: true,
    });
  });
});

describe("quickAiTransform", () => {
  it("rejects with BAD_REQUEST if imageDataUrl is invalid", async () => {
    await expect(
      quickAiTransform(photographer, { imageDataUrl: "invalid-base64" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects with PRECONDITION_FAILED when AI key is missing or disabled", async () => {
    await expect(
      quickAiTransform(photographer, { imageDataUrl: PNG_1X1, mode: "AI" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("rejects with PRECONDITION_FAILED when REMOVEBG key is missing or disabled", async () => {
    await expect(
      quickAiTransform(photographer, { imageDataUrl: PNG_1X1, mode: "REMOVEBG" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("transforms image via AI (Gemini) when runtime is configured", async () => {
    await updateAiImageStudioSettings({ aiKey: "AI_KEY_TEST_12345" }, 101);
    await updateAiImageStudioSettings({ aiEnabled: true }, 101);

    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "enhanced image" },
                  { inlineData: { mimeType: "image/png", data: "VEVTVF9BSV9JTUFHRQ==" } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const result = await quickAiTransform(photographer, {
      imageDataUrl: PNG_1X1,
      mode: "AI",
      productId: 801,
      barcode: "6291100223344",
    });

    expect(result.provider).toBe("GEMINI");
    expect(result.imageDataUrl).toBe("data:image/png;base64,VEVTVF9BSV9JTUFHRQ==");
    expect(fakeFetch).toHaveBeenCalled();
  });

  it("transforms image via REMOVEBG when service is configured", async () => {
    await updateImageStudioSettings({ removebgKey: "REMOVEBG_KEY_TEST_12345" }, 101);
    await updateImageStudioSettings({ proEnabled: true }, 101);

    const fakeCutout = Buffer.from("FAKE_CUTOUT_PNG_BYTES");
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(fakeCutout, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "X-Credits-Charged": "1",
          "X-Width": "100",
          "X-Height": "100",
        },
      }),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const result = await quickAiTransform(photographer, {
      imageDataUrl: PNG_1X1,
      mode: "REMOVEBG",
      productId: 801,
      barcode: "6291100223344",
    });

    expect(result.provider).toBe("REMOVEBG");
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${fakeCutout.toString("base64")}`);
    expect(fakeFetch).toHaveBeenCalled();
  });
});


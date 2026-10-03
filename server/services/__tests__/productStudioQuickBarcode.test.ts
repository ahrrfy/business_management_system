import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest } from "../../lib/imageStore";
import {
  quickBarcodeLookup,
  quickSaveBarcodeProductImage,
  type ProductStudioActor,
} from "../productStudioService";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const WEBP_1X1 = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

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
  storeDir = await mkdtemp(path.join(tmpdir(), "erp-quick-barcode-"));
  process.env.IMAGE_STORE_DRIVER = "fs";
  process.env.IMAGE_STORE_DIR = storeDir;
  __resetImageStoreForTest();
  await seed();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
});

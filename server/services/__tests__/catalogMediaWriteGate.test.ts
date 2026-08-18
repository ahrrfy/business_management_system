import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createProduct } from "../catalog/productCreate";
import { updateProductWithVariants } from "../productEditService";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const OTHER_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII=";

const actor = { userId: 1, branchId: 1 };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function ctx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: {
      id: 1,
      role: "admin",
      branchId: 1,
      name: "admin",
      email: "admin@local.test",
      isActive: true,
    } as unknown as TrpcContext["user"],
  };
}

const caller = () => appRouter.createCaller(ctx());

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnits",
  "productImageJobs",
  "productImages",
  "productVariants",
  "products",
  "categories",
  "users",
  "branches",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedProduct() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "media-gate-admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NOTE-1", costPrice: "500" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000" });
}

function createInput() {
  return {
    name: "قلم",
    variants: [
      {
        sku: "PEN-1",
        costPrice: "500",
        units: [
          {
            unitName: "قطعة",
            conversionFactor: "1",
            isBaseUnit: true,
            prices: [{ priceTier: "RETAIL" as const, price: "1000" }],
          },
        ],
      },
    ],
  };
}

function updateInput() {
  return {
    productId: 1,
    name: "دفتر مُحدَّث",
    unitTemplate: [
      {
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
        prices: [{ priceTier: "RETAIL" as const, price: "1000" }],
      },
    ],
    variants: [{ id: 1, sku: "NOTE-1", costPrice: "500", unitBarcodes: {} }],
  };
}

beforeEach(async () => {
  await reset();
  await seedProduct();
});

describe("catalog legacy media write gate", () => {
  it("API createProduct rejects product image bytes and rolls back the product", async () => {
    await expect(
      caller().catalog.createProduct({ ...createInput(), images: [{ url: PNG_DATA_URL }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await db().select().from(s.products).where(eq(s.products.name, "قلم"))).toHaveLength(0);
  });

  it("service createProduct rejects variant image bytes outside Product Studio", async () => {
    const input = createInput();
    input.variants[0] = { ...input.variants[0], image: PNG_DATA_URL };

    await expect(createProduct(input, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.products).where(eq(s.products.name, "قلم"))).toHaveLength(0);
  });

  it("API updateProductVariants rejects new product image bytes before metadata changes", async () => {
    await expect(
      caller().catalog.updateProductVariants({
        ...updateInput(),
        images: [{ url: PNG_DATA_URL, isPrimary: true, sortOrder: 0 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const [product] = await db().select().from(s.products).where(eq(s.products.id, 1));
    expect(product.name).toBe("دفتر");
  });

  it("service updateProductWithVariants rejects replacement variant bytes before metadata changes", async () => {
    await db().insert(s.productImages).values({
      id: 10,
      productId: 1,
      variantId: 1,
      url: PNG_DATA_URL,
      origin: "MANUAL",
      reviewStatus: "APPROVED",
    });
    const input = updateInput();
    input.variants[0] = { ...input.variants[0], image: OTHER_PNG_DATA_URL };

    await expect(updateProductWithVariants(input, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [product] = await db().select().from(s.products).where(eq(s.products.id, 1));
    const [image] = await db().select().from(s.productImages).where(eq(s.productImages.id, 10));
    expect(product.name).toBe("دفتر");
    expect(image.url).toBe(PNG_DATA_URL);
  });

  it("keeps legacy images readable while allowing metadata-only edits", async () => {
    await db().insert(s.productImages).values([
      { id: 11, productId: 1, variantId: 1, url: PNG_DATA_URL, origin: "MANUAL", reviewStatus: "APPROVED" },
      { id: 12, productId: 1, variantId: null, url: PNG_DATA_URL, origin: "MANUAL", reviewStatus: "APPROVED", isPrimary: true },
    ]);
    const input = updateInput();
    input.variants[0] = { ...input.variants[0], image: PNG_DATA_URL };

    await expect(
      updateProductWithVariants(
        { ...input, images: [{ id: 12, isPrimary: true, sortOrder: 0 }] },
        actor,
      ),
    ).resolves.toMatchObject({ productId: 1 });

    const images = await db().select().from(s.productImages).where(eq(s.productImages.productId, 1));
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.url)).toEqual([PNG_DATA_URL, PNG_DATA_URL]);
    const [product] = await db().select().from(s.products).where(eq(s.products.id, 1));
    expect(product.name).toBe("دفتر مُحدَّث");
  });

  it("API keeps an unchanged legacy image URL while applying non-media edits", async () => {
    const legacyUrl = "/uploads/legacy/note-1.png";
    await db().insert(s.productImages).values({
      id: 13,
      productId: 1,
      variantId: 1,
      url: legacyUrl,
      origin: "MANUAL",
      reviewStatus: "APPROVED",
    });
    const input = updateInput();
    input.variants[0] = { ...input.variants[0], image: legacyUrl };

    await expect(caller().catalog.updateProductVariants(input)).resolves.toMatchObject({ productId: 1 });

    const [image] = await db().select().from(s.productImages).where(eq(s.productImages.id, 13));
    expect(image.url).toBe(legacyUrl);
    const [product] = await db().select().from(s.products).where(eq(s.products.id, 1));
    expect(product.name).toBe("دفتر مُحدَّث");
  });
});

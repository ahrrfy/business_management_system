import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { moderateStorefrontProductReview } from "../storeAdmin/storefrontProductReviewAdminService";
import {
  listStorefrontProductReviews,
  submitStorefrontProductReview,
} from "../storefrontProductReviewService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const instance = getDb();
  if (!instance) throw new Error("DATABASE_URL not set for tests");
  return instance;
}

async function createOrder(input: {
  id: number;
  orderNumber: string;
  status: "PENDING" | "DELIVERED";
  orderDate?: Date;
}) {
  await db().insert(s.onlineOrders).values({
    id: input.id,
    orderNumber: input.orderNumber,
    customerId: 1,
    subtotal: "1000.00",
    total: "1000.00",
    status: input.status,
    orderDate: input.orderDate,
  });
  await db().insert(s.onlineOrderItems).values({
    onlineOrderId: input.id,
    variantId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: "1000.00",
    total: "1000.00",
  });
}

beforeEach(async () => {
  await truncateAllTables();
  const database = db();
  await database.insert(s.customers).values({ id: 1, name: "عميل مراجعة" });
  await database.insert(s.products).values({ id: 1, name: "دفتر موثق" });
  await database
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "REVIEW-1", costPrice: "0" });
});

describe("storefront product review integrity", () => {
  it("rejects a review before verified delivery and stores nothing", async () => {
    await createOrder({
      id: 1,
      orderNumber: "ORD-REVIEW-PENDING",
      status: "PENDING",
    });

    await expect(
      submitStorefrontProductReview({
        customerId: 1,
        productId: 1,
        rating: 5,
        comment: "تجربة ممتازة جداً",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await db()
      .select({ id: s.storefrontProductReviews.id })
      .from(s.storefrontProductReviews);
    expect(rows).toHaveLength(0);
  });

  it("uses an older unreviewed delivered order when the latest one was already reviewed", async () => {
    await createOrder({
      id: 1,
      orderNumber: "ORD-REVIEW-OLDER",
      status: "DELIVERED",
      orderDate: new Date("2026-01-01T10:00:00.000Z"),
    });
    await createOrder({
      id: 2,
      orderNumber: "ORD-REVIEW-LATEST",
      status: "DELIVERED",
      orderDate: new Date("2026-02-01T10:00:00.000Z"),
    });
    await db().insert(s.storefrontProductReviews).values({
      productId: 1,
      customerId: 1,
      onlineOrderId: 2,
      rating: 4,
      comment: "مراجعة الطلب الأحدث",
      status: "REJECTED",
    });

    await expect(
      submitStorefrontProductReview({
        customerId: 1,
        productId: 1,
        rating: 5,
        comment: "مراجعة تجربة شراء سابقة",
      }),
    ).resolves.toEqual({ ok: true, status: "PENDING" });

    const rows = await db()
      .select({
        onlineOrderId: s.storefrontProductReviews.onlineOrderId,
        status: s.storefrontProductReviews.status,
      })
      .from(s.storefrontProductReviews)
      .orderBy(s.storefrontProductReviews.onlineOrderId);
    expect(
      rows.map((row) => ({
        onlineOrderId: Number(row.onlineOrderId),
        status: row.status,
      })),
    ).toEqual([
      { onlineOrderId: 1, status: "PENDING" },
      { onlineOrderId: 2, status: "REJECTED" },
    ]);
  });

  it("keeps new reviews pending and never exposes customer or order data publicly", async () => {
    await createOrder({
      id: 1,
      orderNumber: "ORD-REVIEW-PUBLIC",
      status: "DELIVERED",
    });
    await submitStorefrontProductReview({
      customerId: 1,
      productId: 1,
      rating: 5,
      comment: "المنتج مطابق والوصول كان سريعاً",
    });

    await expect(listStorefrontProductReviews(1)).resolves.toMatchObject({
      summary: { count: 0, average: 0 },
      items: [],
    });

    await db()
      .update(s.storefrontProductReviews)
      .set({ status: "APPROVED" })
      .where(eq(s.storefrontProductReviews.onlineOrderId, 1));
    const published = await listStorefrontProductReviews(1);
    expect(published.items).toHaveLength(1);
    expect(published.items[0]).toMatchObject({
      rating: 5,
      comment: "المنتج مطابق والوصول كان سريعاً",
    });
    expect(published.items[0]).not.toHaveProperty("customerId");
    expect(published.items[0]).not.toHaveProperty("onlineOrderId");
  });

  it("accepts one pending moderation decision and rejects a later API reversal", async () => {
    await createOrder({
      id: 1,
      orderNumber: "ORD-REVIEW-MODERATE",
      status: "DELIVERED",
    });
    await db().insert(s.storefrontProductReviews).values({
      id: 1,
      productId: 1,
      customerId: 1,
      onlineOrderId: 1,
      rating: 4,
      comment: "تجربة جيدة بعد الاستلام",
      status: "PENDING",
    });

    await expect(
      moderateStorefrontProductReview({ reviewId: 1, status: "APPROVED" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      moderateStorefrontProductReview({ reviewId: 1, status: "REJECTED" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const stored = (
      await db()
        .select({
          status: s.storefrontProductReviews.status,
          moderatedAt: s.storefrontProductReviews.moderatedAt,
        })
        .from(s.storefrontProductReviews)
        .where(eq(s.storefrontProductReviews.id, 1))
    )[0];
    expect(stored).toMatchObject({ status: "APPROVED" });
    expect(stored.moderatedAt).toBeInstanceOf(Date);
  });
});

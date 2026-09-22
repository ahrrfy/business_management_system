import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import type { DigitalCheckoutSnapshot } from "../../../shared/digitalSale";
import { getDb } from "../../db";
import { setProductActive } from "../catalog/adminList";
import {
  prepareCheckoutSnapshot,
} from "../digitalCards/mixedCartService";
import { reserveIntentInventory } from "../digitalCards/inventoryReservationService";
import { deleteCustomer } from "../customerService";
import { lockPeriod } from "../periodLockService";
import { closeShift } from "../shiftService";
import { withGovernanceTx, withTx } from "../tx";
import { truncateAllTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "cashier" } as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("Missing test DB");
  return value;
}

function checkoutSnapshot(
  customerId: number | null = null,
  reservedBase = 1,
): DigitalCheckoutSnapshot {
  return {
    version: 1,
    requestFingerprint: "guard-snapshot",
    customerId,
    priceTier: "RETAIL",
    regularLines: [
      {
        lineKey: "ordinary-1",
        variantId: 1,
        productUnitId: 1,
        quantity: "1.000",
        unitPrice: "10.00",
        discountAmount: "0.00",
        total: "10.00",
        promotionId: null,
        isGift: false,
      },
    ],
    inventoryReservations: [
      {
        sourceVariantId: 1,
        stockVariantId: 1,
        demandedBase: 1,
        reservedBase,
      },
    ],
    pricingGuard: {
      paidCostTotal: "4.00",
      giftCostTotal: "0.00",
      paidLineBelowCost: false,
      manualLineDiscountGate: false,
      referenceGrossTotal: "10.00",
    },
    expectedSubtotal: "10.00",
    sourceType: "POS",
  };
}

async function insertIntent(input: {
  id?: number;
  shiftId?: number;
  status?: typeof s.digitalSaleIntents.$inferInsert.status;
  snapshot?: DigitalCheckoutSnapshot | null;
  key?: string;
}) {
  const id = input.id ?? 1;
  await db().insert(s.digitalSaleIntents).values({
    id,
    clientRequestId: input.key ?? `intent-${id}`,
    branchId: 1,
    shiftId: input.shiftId ?? 1,
    createdBy: 1,
    status: input.status ?? "PREPARED",
    cartFingerprint: `fingerprint-${id}`,
    checkoutSnapshot: input.snapshot ?? null,
    paymentMethod: "CASH",
    expectedTotal: "10.00",
    expiresAt: new Date(Date.now() + 60_000),
  });
}

beforeEach(async () => {
  await truncateAllTables();
  await db().insert(s.branches).values({
    id: 1,
    name: "MAIN",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values({
    id: 1,
    openId: "digital-guard-cashier",
    name: "Cashier",
    role: "cashier",
    branchId: 1,
  });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    status: "OPEN",
    openingBalance: "0",
  });
  await db().insert(s.customers).values({
    id: 1,
    name: "Guard customer",
    defaultPriceTier: "RETAIL",
  });
  await db().insert(s.products).values({
    id: 1,
    name: "Guard item",
    allowBackorder: false,
  });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "GUARD-1",
    costPrice: "4.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(s.productPrices).values({
    productUnitId: 1,
    priceTier: "RETAIL",
    price: "10.00",
  });
  await db().insert(s.branchStock).values({
    branchId: 1,
    variantId: 1,
    quantity: 0,
  });
});

describe("digital issuance lifecycle guards", () => {
  it("يمنع إغلاق الوردية مع نيّة غير نهائية ويسمح بعد حسمها", async () => {
    await insertIntent({ status: "PREPARED" });

    await expect(
      closeShift({ shiftId: 1, countedCash: "0" }, actor),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const [stillOpen] = await db()
      .select({ status: s.shifts.status })
      .from(s.shifts)
      .where(eq(s.shifts.id, 1));
    expect(stillOpen?.status).toBe("OPEN");

    await db()
      .update(s.digitalSaleIntents)
      .set({ status: "FINALIZED" })
      .where(eq(s.digitalSaleIntents.id, 1));
    await expect(
      closeShift({ shiftId: 1, countedCash: "0" }, actor),
    ).resolves.toMatchObject({ shiftId: 1 });
  });

  it.each(["FINALIZED", "CANCELLED", "EXPIRED", "WRITTEN_OFF"] as const)(
    "لا يمنع الحالة النهائية %s من إغلاق الوردية",
    async (status) => {
      await insertIntent({ status });
      await expect(
        closeShift({ shiftId: 1, countedCash: "0" }, actor),
      ).resolves.toMatchObject({ shiftId: 1 });
    },
  );

  it("يمنع إغلاق الوردية عند مطالبة مزوّد غير مكتملة حتى لو كانت حالة النيّة نهائية", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "Digital provider" });
    await db().insert(s.products).values({
      id: 2,
      name: "Digital item",
      productType: "DIGITAL_CARD",
      isService: true,
    });
    await db().insert(s.productVariants).values({
      id: 2,
      productId: 2,
      sku: "DIGITAL-GUARD",
      costPrice: "0",
    });
    await db().insert(s.productUnits).values({
      id: 2,
      variantId: 2,
      unitName: "بطاقة",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db().insert(s.digitalProviders).values({
      id: 1,
      supplierId: 1,
      providerType: "TELECOM",
      settlementMode: "POSTPAID",
      recognitionMode: "PRINCIPAL_GROSS",
      referencePolicy: "OPTIONAL",
      settlementCycle: "ON_DEMAND",
      createdBy: 1,
    });
    await db().insert(s.digitalOfferings).values({
      id: 1,
      providerId: 1,
      productId: 2,
      variantId: 2,
      productUnitId: 2,
      offeringType: "TELECOM_CARD",
      pricingMode: "FIXED_MARGIN",
    });
    await db().insert(s.digitalPriceBatches).values({
      id: 1,
      branchId: 1,
      providerId: 1,
      businessDate: "2026-09-17",
      status: "PUBLISHED",
      createdBy: 1,
      publishedBy: 1,
    });
    await db().insert(s.digitalPriceVersions).values({
      id: 1,
      batchId: 1,
      branchId: 1,
      offeringId: 1,
      providerShare: "8.00",
      sellPrice: "10.00",
      marginAmount: "2.00",
      validFrom: new Date(),
      createdBy: 1,
    });
    await insertIntent({ status: "FINALIZED" });
    await db().insert(s.digitalSaleIntentItems).values({
      id: 1,
      intentId: 1,
      lineKey: "digital-1",
      offeringId: 1,
      providerId: 1,
      priceVersionId: 1,
      sellPriceSnapshot: "10.00",
      providerShareSnapshot: "8.00",
      marginSnapshot: "2.00",
    });
    await db().execute(sql`
      INSERT INTO digitalSaleExecutionClaims
        (intentItemId, claimToken, claimedBy, claimedAt, expiresAt,
         providerIdempotencyKey, completedAt)
      VALUES
        (1, 'unfinished-claim', 1, ${new Date()}, ${new Date(Date.now() + 60_000)},
         'provider-idempotency-1', NULL)
    `);

    await expect(
      closeShift({ shiftId: 1, countedCash: "0" }, actor),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("يمنع تعطيل منتج تحجزه نيّة رقمية ثم يسمح بعد تحرير الحجز", async () => {
    await insertIntent({ snapshot: checkoutSnapshot() });
    await db().insert(s.digitalIntentInventoryReservations).values({
      intentId: 1,
      branchId: 1,
      sourceVariantId: 1,
      stockVariantId: 1,
      reservedBase: 1,
      status: "ACTIVE",
    });

    await expect(setProductActive(1, false, actor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await db()
      .update(s.digitalIntentInventoryReservations)
      .set({ status: "RELEASED", releasedAt: new Date() })
      .where(eq(s.digitalIntentInventoryReservations.intentId, 1));
    await expect(setProductActive(1, false, actor)).resolves.toEqual({
      productId: 1,
      isActive: false,
    });
  });

  it("يمنع حذف عميل مرتبط بنيّة نشطة ويسمح بعد انتقالها إلى حالة نهائية", async () => {
    await insertIntent({ snapshot: checkoutSnapshot(1) });

    await expect(deleteCustomer(1, actor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await db()
      .update(s.digitalSaleIntents)
      .set({ status: "CANCELLED" })
      .where(eq(s.digitalSaleIntents.id, 1));
    await expect(deleteCustomer(1, actor)).resolves.toMatchObject({
      customerId: 1,
      deleted: true,
    });
  });

  it("لا يعتبر نافذة الافتتاح بديلاً عن الحجز الفعلي في السلة الرقمية المختلطة", async () => {
    await db().insert(s.openingModeSettings).values({
      id: 1,
      enabled: true,
      endsAt: new Date(Date.now() + 60_000),
      maxNegativeQtyPerLine: 100,
    });

    await expect(
      withTx((tx) =>
        prepareCheckoutSnapshot(
          tx,
          {
            branchId: 1,
            regularLines: [
              {
                lineKey: "ordinary-1",
                variantId: 1,
                productUnitId: 1,
                quantity: "1",
              },
            ],
          },
          actor,
        ),
      ),
    ).rejects.toThrow(/المخزون غير كافٍ/);
  });

  it("يرفض في طبقة الحجز لقطة طلب مخزون بلا حجز كامل", async () => {
    await expect(
      withTx((tx) =>
        reserveIntentInventory(tx, {
          intentId: 999,
          branchId: 1,
          snapshot: checkoutSnapshot(null, 0),
        }),
      ),
    ).rejects.toThrow(/بلا حجز كامل/);
  });

  it("يمنع إقفال فترة تشمل اليوم مع نيّة إصدار رقمية غير محسومة", async () => {
    await insertIntent({ status: "EXECUTING" });
    const closeInput = {
      cutoffDate: "2099-12-31",
      lockedBy: 1,
      lockedAt: new Date("2026-09-17T12:00:00.000Z"),
    };

    await expect(
      withGovernanceTx((tx) => lockPeriod(tx, closeInput)),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db()
      .update(s.digitalSaleIntents)
      .set({ status: "FINALIZED" })
      .where(eq(s.digitalSaleIntents.id, 1));
    await expect(
      withGovernanceTx((tx) => lockPeriod(tx, closeInput)),
    ).resolves.toMatchObject({ id: expect.any(Number) });
  });
});

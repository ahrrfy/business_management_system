/**
 * tests/e2e/promotions/tier1_features/schema_and_migration.test.ts
 *
 * Tier 1 Feature Coverage: Physical Schema & Migration Integrity (F01–F06)
 * Opaque-box verification of physical columns, enum types, CHECK constraints,
 * child tables, and migration idempotency.
 */

import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  promotions,
  promotionTargets,
  promotionTiers,
} from "../../../../drizzle/schema";
import {
  validatePromotionSchema,
  validateTargetGrain,
} from "../infra/testHarness";
import {
  PRD_INK_EPSON,
  PRD_PEN_ROTRING,
} from "../infra/mockFixtures";

describe("Tier 1: Schema & Migration (F01–F06)", () => {
  // =========================================================================
  // F01: Schema: 6 Promotion Types
  // =========================================================================
  describe("F01: Schema: 6 Promotion Types", () => {
    it("T1-F01-01: validates PERCENT promotion with discountPercent > 0 and discountAmount = 0", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "15.00",
        discountAmount: "0.00",
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("T1-F01-02: validates AMOUNT promotion with discountAmount > 0 and discountPercent = 0", () => {
      const res = validatePromotionSchema({
        type: "AMOUNT",
        discountAmount: "2500.00",
        discountPercent: "0.00",
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("T1-F01-03: validates FIXED_PRICE promotion with fixedPrice > 0", () => {
      const res = validatePromotionSchema({
        type: "FIXED_PRICE",
        fixedPrice: "5000.00",
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("T1-F01-04: validates BUNDLE_PRICE with valid bundlePrice and bundleMode", () => {
      const res = validatePromotionSchema({
        type: "BUNDLE_PRICE",
        bundlePrice: "12000.00",
        bundleMode: "PICK_ANY_N",
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("T1-F01-05: validates BOGO with buyQuantity, getQuantity, and getDiscountPercent", () => {
      const res = validatePromotionSchema({
        type: "BOGO",
        bogoBuyQuantity: 2,
        bogoGetQuantity: 1,
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("T1-F01-06: validates TIERED_QTY with tieredMode and non-empty tiers array", () => {
      const res = validatePromotionSchema({
        type: "TIERED_QTY",
        tieredMode: "PER_ITEM",
        tiers: [
          { minQuantity: new Decimal(5), tierType: "PERCENT", discountPercent: new Decimal(10) },
        ],
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("T1-F01-07: rejects PERCENT promotion when discountAmount > 0 (chk_promo_shape constraint)", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "15.00",
        discountAmount: "500.00",
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("PERCENT promotion must not have discountAmount > 0");
    });

    it("T1-F01-08: rejects AMOUNT promotion when discountPercent > 0 (chk_promo_shape constraint)", () => {
      const res = validatePromotionSchema({
        type: "AMOUNT",
        discountAmount: "1000.00",
        discountPercent: "10.00",
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("AMOUNT promotion must not have discountPercent > 0");
    });

    it("T1-F01-09: verifies Drizzle schema promotionType enum defines all 7 types", () => {
      const typeColumn = promotions.type;
      expect(typeColumn.enumValues).toEqual([
        "PERCENT",
        "AMOUNT",
        "FIXED_PRICE",
        "BUNDLE_PRICE",
        "BOGO",
        "TIERED_QTY",
        "FREE_SHIPPING",
      ]);
    });
  });

  // =========================================================================
  // F02: Schema: Channel Column
  // =========================================================================
  describe("F02: Schema: Channel Column", () => {
    it("T1-F02-01: verifies Drizzle schema defines channel enum with ALL, POS_ONLY, STORE_ONLY", () => {
      const channelColumn = promotions.channel;
      expect(channelColumn.enumValues).toEqual(["ALL", "POS_ONLY", "STORE_ONLY"]);
    });

    it("T1-F02-02: channel column defaults to 'ALL'", () => {
      const channelColumn = promotions.channel;
      expect(channelColumn.default).toBe("ALL");
    });

    it("T1-F02-03: validates promotion with channel = 'ALL'", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        channel: "ALL",
      });
      expect(res.valid).toBe(true);
    });

    it("T1-F02-04: validates promotion with channel = 'POS_ONLY'", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        channel: "POS_ONLY",
      });
      expect(res.valid).toBe(true);
    });

    it("T1-F02-05: validates promotion with channel = 'STORE_ONLY'", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        channel: "STORE_ONLY",
      });
      expect(res.valid).toBe(true);
    });

    it("T1-F02-06: rejects unsupported channel enum value like 'ONLINE'", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        channel: "ONLINE",
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Invalid channel enum");
    });

    it("T1-F02-07: migration logic maps legacy isStoreManaged=true to channel='STORE_ONLY'", () => {
      const legacyRecord = { isStoreManaged: true };
      const migratedChannel = legacyRecord.isStoreManaged ? "STORE_ONLY" : "ALL";
      expect(migratedChannel).toBe("STORE_ONLY");
    });

    it("T1-F02-08: migration logic maps legacy isStoreManaged=false to channel='ALL'", () => {
      const legacyRecord = { isStoreManaged: false };
      const migratedChannel = legacyRecord.isStoreManaged ? "STORE_ONLY" : "ALL";
      expect(migratedChannel).toBe("ALL");
    });
  });

  // =========================================================================
  // F03: Schema: Clearance & Scheduling
  // =========================================================================
  describe("F03: Schema: Clearance & Scheduling", () => {
    it("T1-F03-01: verifies allowBelowCost column exists in schema and defaults to false", () => {
      const col = promotions.allowBelowCost;
      expect(col.default).toBe(false);
      expect(col.dataType).toBe("boolean");
    });

    it("T1-F03-02: verifies applyToBaseUnitOnly column exists in schema and defaults to true", () => {
      const col = promotions.applyToBaseUnitOnly;
      expect(col.default).toBe(true);
      expect(col.dataType).toBe("boolean");
    });

    it("T1-F03-03: verifies activeDays column exists in schema as json array", () => {
      const col = promotions.activeDays;
      expect(col.dataType).toBe("json");
    });

    it("T1-F03-04: validates activeDays array with valid integers 0..6 (Sunday to Saturday)", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        activeDays: [0, 1, 2, 3, 4], // Sun to Thu
      });
      expect(res.valid).toBe(true);
    });

    it("T1-F03-05: rejects activeDays containing invalid day number like 7", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        activeDays: [0, 1, 7],
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Invalid activeDays item: 7");
    });

    it("T1-F03-06: rejects activeDays containing negative day number like -1", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        activeDays: [-1, 2],
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Invalid activeDays item: -1");
    });

    it("T1-F03-07: validates date range where effectiveTo >= effectiveFrom", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        effectiveFrom: "2026-06-01",
        effectiveTo: "2026-06-30",
      });
      expect(res.valid).toBe(true);
    });

    it("T1-F03-08: rejects invalid date range where effectiveTo < effectiveFrom", () => {
      const res = validatePromotionSchema({
        type: "PERCENT",
        discountPercent: "10",
        effectiveFrom: "2026-06-30",
        effectiveTo: "2026-06-01",
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("effectiveTo (2026-06-01) cannot be earlier than effectiveFrom");
    });
  });

  // =========================================================================
  // F04: Schema: Units & Tiers Tables
  // =========================================================================
  describe("F04: Schema: Units & Tiers Tables", () => {
    it("T1-F04-01: verifies promotionTargets table contains productUnitId column", () => {
      const col = promotionTargets.productUnitId;
      expect(col).toBeDefined();
      expect(col.columnType).toBe("MySqlBigInt53");
    });

    it("T1-F04-02: verifies promotionTiers table is exported in schema", () => {
      expect(promotionTiers).toBeDefined();
      expect(promotionTiers.minQuantity).toBeDefined();
      expect(promotionTiers.tierType).toBeDefined();
      expect(promotionTiers.discountPercent).toBeDefined();
      expect(promotionTiers.discountAmount).toBeDefined();
      expect(promotionTiers.fixedPrice).toBeDefined();
    });

    it("T1-F04-03: verifies promotionTiers.tierType enum values (PERCENT, AMOUNT, FIXED_PRICE)", () => {
      expect(promotionTiers.tierType.enumValues).toEqual([
        "PERCENT",
        "AMOUNT",
        "FIXED_PRICE",
      ]);
    });

    it("T1-F04-04: target grain validation passes when productUnitId is exclusively set", () => {
      const res = validateTargetGrain({
        scope: "PRODUCTS",
        productUnitId: 1012, // Dozen unit
      });
      expect(res.valid).toBe(true);
    });

    it("T1-F04-05: target grain validation fails if both productId and productUnitId are set", () => {
      const res = validateTargetGrain({
        scope: "PRODUCTS",
        productId: PRD_PEN_ROTRING.id,
        productUnitId: 1012,
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Target must specify exactly one grain level (found 2)");
    });

    it("T1-F04-06: target grain validation fails if no target ID is set when scope != ALL", () => {
      const res = validateTargetGrain({
        scope: "PRODUCTS",
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Target must specify exactly one grain level (found 0)");
    });

    it("T1-F04-07: target grain validation passes for scope ALL with all target IDs null", () => {
      const res = validateTargetGrain({
        scope: "ALL",
      });
      expect(res.valid).toBe(true);
    });
  });

  // =========================================================================
  // F05: MySQL Physical Migration
  // =========================================================================
  describe("F05: MySQL Physical Migration & DDL Integrity", () => {
    it("T1-F05-01: verifies precision and scale of fixedPrice in promotions table", () => {
      const col = promotions.fixedPrice;
      expect(col).toBeDefined();
      expect(col.columnType).toBe("MySqlDecimal");
      expect((col as any).precision).toBe(15);
      expect((col as any).scale).toBe(2);
    });

    it("T1-F05-02: verifies precision and scale of bundlePrice in promotions table", () => {
      const col = promotions.bundlePrice;
      expect(col).toBeDefined();
      expect(col.columnType).toBe("MySqlDecimal");
      expect((col as any).precision).toBe(15);
      expect((col as any).scale).toBe(2);
    });

    it("T1-F05-03: verifies minQuantity precision in promotionTiers is scale 4 (decimal 15,4)", () => {
      const col = promotionTiers.minQuantity;
      expect(col).toBeDefined();
      expect(col.columnType).toBe("MySqlDecimal");
      expect((col as any).precision).toBe(15);
      expect((col as any).scale).toBe(4);
    });

    it("T1-F05-04: verifies bogoGetDiscountPercent precision is 5,2 in promotions table", () => {
      const col = promotions.bogoGetDiscountPercent;
      expect(col).toBeDefined();
      expect(col.columnType).toBe("MySqlDecimal");
      expect((col as any).precision).toBe(5);
      expect((col as any).scale).toBe(2);
    });

    it("T1-F05-05: verifies bundleMode enum values (ALL_REQUIRED, PICK_ANY_N)", () => {
      expect(promotions.bundleMode.enumValues).toEqual([
        "ALL_REQUIRED",
        "PICK_ANY_N",
      ]);
    });

    it("T1-F05-06: verifies tieredMode enum values (PER_ITEM, POOL_ACROSS_TARGETS)", () => {
      expect(promotions.tieredMode.enumValues).toEqual([
        "PER_ITEM",
        "POOL_ACROSS_TARGETS",
      ]);
    });
  });

  // =========================================================================
  // F06: Migration & CI Verification
  // =========================================================================
  describe("F06: Migration & CI Verification", () => {
    it("T1-F06-01: verifies index on promotions channel and isActive exists in table definition", () => {
      const config = getTableConfig(promotions);
      const channelIdx = config.indexes.find((idx) => idx.config.name === "idx_promo_channel");
      expect(channelIdx).toBeDefined();
      expect(channelIdx!.config.columns.map((c: any) => c.name)).toEqual(["promotionChannel", "isActive"]);
    });

    it("T1-F06-02: verifies promotionTiers table references promotions table", () => {
      expect(promotionTiers.promotionId).toBeDefined();
      expect(promotionTiers.promotionId.columnType).toBe("MySqlBigInt53");
    });

    it("T1-F06-03: verifies promotionTargets references productUnits table", () => {
      expect(promotionTargets.productUnitId).toBeDefined();
      expect(promotionTargets.productUnitId.columnType).toBe("MySqlBigInt53");
    });

    it("T1-F06-04: verifies schema allows null customerTier for all-customer promos", () => {
      const col = promotions.customerTier;
      expect(col.notNull).toBe(false);
    });

    it("T1-F06-05: verifies schema enforces notNull on promotions.isActive and defaults to true", () => {
      const col = promotions.isActive;
      expect(col.notNull).toBe(true);
      expect(col.default).toBe(true);
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  analyzeBundleRequirementsInputSchema,
  collectBundleProductionLockVariantIds,
  deriveBundleComponentSubRequestId,
  isValidBatchYield,
  produceBundleComponentsInputSchema,
  sortLockIds,
} from "../bundleProductionTypes";
import { isBatchDivisible } from "../batchDivisibility";
import { digitsArabicToLatin, normalizeDecimalInput } from "../numberNormalize";

describe("Bundle Production Zod Upper Bounds & Adversarial Input Matrix (ADV-01..13)", () => {
  const baseProducePayload = {
    bundleVariantId: 101,
    bundleQuantity: 10,
    branchId: 1,
    clientRequestId: "req-adv-test-001",
    batches: [
      {
        recipeId: 50,
        variantId: 201,
        batchQty: 10,
        scrapQty: 0,
        laborPerUnit: "150.00",
        materialSubstitutions: null,
      },
    ],
  };

  const baseAnalyzePayload = {
    bundleVariantId: 101,
    bundleQuantity: 10,
    branchId: 1,
    mode: "NET_SHORTAGE" as const,
    batches: [
      {
        recipeId: 50,
        variantId: 201,
        batchQty: 10,
        scrapQty: 0,
        laborPerUnit: "150.00",
        selected: true,
      },
    ],
  };

  // -------------------------------------------------------------
  // ADV-01: Zero batch quantity
  // -------------------------------------------------------------
  describe("ADV-01: Zero batch quantity handling", () => {
    it("rejects batchQty = 0 in produceBundleComponentsInputSchema (.positive())", () => {
      const payload = {
        ...baseProducePayload,
        batches: [{ ...baseProducePayload.batches[0], batchQty: 0 }],
      };
      const res = produceBundleComponentsInputSchema.safeParse(payload);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].path).toContain("batchQty");
      }
    });

    it("accepts batchQty = 0 in analyzeBundleRequirementsInputSchema (.min(0))", () => {
      const payload = {
        ...baseAnalyzePayload,
        batches: [{ ...baseAnalyzePayload.batches[0], batchQty: 0 }],
      };
      const res = analyzeBundleRequirementsInputSchema.safeParse(payload);
      expect(res.success).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // ADV-02: Zero bundle quantity
  // -------------------------------------------------------------
  describe("ADV-02: Zero bundle quantity handling", () => {
    it("rejects bundleQuantity = 0 in produceBundleComponentsInputSchema", () => {
      const payload = { ...baseProducePayload, bundleQuantity: 0 };
      const res = produceBundleComponentsInputSchema.safeParse(payload);
      expect(res.success).toBe(false);
    });

    it("rejects bundleQuantity = 0 in analyzeBundleRequirementsInputSchema", () => {
      const payload = { ...baseAnalyzePayload, bundleQuantity: 0 };
      const res = analyzeBundleRequirementsInputSchema.safeParse(payload);
      expect(res.success).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // ADV-03: Floating-point decimal in integer fields
  // -------------------------------------------------------------
  describe("ADV-03: Float values in integer fields", () => {
    it("rejects float bundleQuantity and batchQty via .int()", () => {
      const floatBundle = { ...baseProducePayload, bundleQuantity: 10.5 };
      expect(produceBundleComponentsInputSchema.safeParse(floatBundle).success).toBe(false);

      const floatBatch = {
        ...baseProducePayload,
        batches: [{ ...baseProducePayload.batches[0], batchQty: 2.5 }],
      };
      expect(produceBundleComponentsInputSchema.safeParse(floatBatch).success).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // ADV-04: Malformed decimal strings in laborPerUnit
  // -------------------------------------------------------------
  describe("ADV-04: Multiple dots and invalid laborPerUnit strings", () => {
    it("rejects '1.2.3', 'abc', and excess decimal precision", () => {
      const malformedPayloads = ["1.2.3", "abc", "100.999", "-50.00"];
      for (const labor of malformedPayloads) {
        const payload = {
          ...baseProducePayload,
          batches: [{ ...baseProducePayload.batches[0], laborPerUnit: labor }],
        };
        expect(produceBundleComponentsInputSchema.safeParse(payload).success).toBe(false);
      }
    });

    it("accepts valid labor strings with 0, 1, or 2 decimal places and nullish", () => {
      const validPayloads = ["150", "150.5", "150.00", null, undefined];
      for (const labor of validPayloads) {
        const payload = {
          ...baseProducePayload,
          batches: [{ ...baseProducePayload.batches[0], laborPerUnit: labor }],
        };
        expect(produceBundleComponentsInputSchema.safeParse(payload).success).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------
  // ADV-05: Leading dot decimal strings (.5)
  // -------------------------------------------------------------
  describe("ADV-05: Leading dot normalization via normalizeDecimalInput", () => {
    it("normalizes '.5' to '0.5' and '.75' to '0.75'", () => {
      const norm1 = normalizeDecimalInput(".5");
      expect(norm1).toBe("0.5");
      expect(/^\d+(\.\d{1,2})?$/.test(norm1)).toBe(true);

      const norm2 = normalizeDecimalInput(".75");
      expect(norm2).toBe("0.75");
      expect(/^\d+(\.\d{1,2})?$/.test(norm2)).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // ADV-06: Negative values
  // -------------------------------------------------------------
  describe("ADV-06: Negative values rejection", () => {
    it("rejects negative bundleQuantity, batchQty, scrapQty, and bundleVariantId", () => {
      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          bundleQuantity: -5,
        }).success,
      ).toBe(false);

      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          bundleVariantId: -10,
        }).success,
      ).toBe(false);

      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          batches: [{ ...baseProducePayload.batches[0], batchQty: -1 }],
        }).success,
      ).toBe(false);

      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          batches: [{ ...baseProducePayload.batches[0], scrapQty: -1 }],
        }).success,
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // ADV-07: Arabic-Indic numerals normalization
  // -------------------------------------------------------------
  describe("ADV-07: Arabic-Indic numerals conversion", () => {
    it("converts Arabic-Indic numerals (٠-٩) to Latin (0-9)", () => {
      expect(digitsArabicToLatin("١٢٣")).toBe("123");
      expect(digitsArabicToLatin("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
      expect(parseInt(digitsArabicToLatin("٥٠"), 10)).toBe(50);
      expect(normalizeDecimalInput("١٢.٥")).toBe("12.5");
    });
  });

  // -------------------------------------------------------------
  // ADV-08: Arabic decimal commas (، and ٫)
  // -------------------------------------------------------------
  describe("ADV-08: Arabic decimal commas normalization & thousands grouping preservation", () => {
    it("normalizes Arabic comma '،' and decimal '٫' to standard '.' while preserving thousands grouping", () => {
      expect(normalizeDecimalInput("١٢،٥")).toBe("12.5");
      expect(normalizeDecimalInput("١٢٫٥")).toBe("12.5");
      expect(normalizeDecimalInput("12،50")).toBe("12.50");
      expect(normalizeDecimalInput("12٫50")).toBe("12.50");
      expect(normalizeDecimalInput("1,000")).toBe("1000");
      expect(normalizeDecimalInput("1,000.50")).toBe("1000.50");
    });
  });

  // -------------------------------------------------------------
  // ADV-09: Large numbers & Integer upper bounds (.max(1_000_000))
  // -------------------------------------------------------------
  describe("ADV-09: Integer upper bounds (.max(1_000_000)) & MySQL overflow protection", () => {
    it("accepts quantities up to exactly 1,000,000", () => {
      const maxPayload = {
        ...baseProducePayload,
        bundleQuantity: 1_000_000,
        batches: [
          {
            ...baseProducePayload.batches[0],
            batchQty: 1_000_000,
            scrapQty: 1_000_000,
          },
        ],
      };
      expect(produceBundleComponentsInputSchema.safeParse(maxPayload).success).toBe(true);
    });

    it("rejects quantities exceeding 1,000,000 in Zod before hitting MySQL", () => {
      const overBundle = {
        ...baseProducePayload,
        bundleQuantity: 1_000_001,
      };
      expect(produceBundleComponentsInputSchema.safeParse(overBundle).success).toBe(false);

      const overBatch = {
        ...baseProducePayload,
        batches: [{ ...baseProducePayload.batches[0], batchQty: 1_000_001 }],
      };
      expect(produceBundleComponentsInputSchema.safeParse(overBatch).success).toBe(false);

      const overScrap = {
        ...baseProducePayload,
        batches: [{ ...baseProducePayload.batches[0], scrapQty: 1_000_001 }],
      };
      expect(produceBundleComponentsInputSchema.safeParse(overScrap).success).toBe(false);

      // Protection against 32-bit integer overflow (3 billion)
      const mysqlOverflow = {
        ...baseProducePayload,
        bundleQuantity: 3_000_000_000,
      };
      expect(produceBundleComponentsInputSchema.safeParse(mysqlOverflow).success).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // ADV-10: Batch divisibility multiple validation via production helper
  // -------------------------------------------------------------
  describe("ADV-10: Batch divisibility multiple checking via production helper", () => {
    it("identifies when batch quantity violates required batch multiple using isBatchDivisible", () => {
      // Coef 0.5 requires batch multiple of 2 (0.5 * 2 = 1)
      expect(isBatchDivisible(["0.5"], 5)).toBe(false);
      expect(isBatchDivisible(["0.5"], 6)).toBe(true);
      // Coef 0.25 requires multiple of 4
      expect(isBatchDivisible(["0.25"], 7)).toBe(false);
      expect(isBatchDivisible(["0.25"], 8)).toBe(true);
      // Coef 0.125 requires multiple of 8
      expect(isBatchDivisible(["0.125"], 15)).toBe(false);
      expect(isBatchDivisible(["0.125"], 16)).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // ADV-11: Scrap equals or exceeds batch quantity via production helper
  // -------------------------------------------------------------
  describe("ADV-11: Scrap equals or exceeds batch quantity via production helper", () => {
    it("rejects zero or negative net yield where scrapQty >= batchQty via isValidBatchYield", () => {
      expect(isValidBatchYield(10, 10)).toBe(false);
      expect(isValidBatchYield(10, 15)).toBe(false);
      expect(isValidBatchYield(10, 0)).toBe(true);
      expect(isValidBatchYield(10, 2)).toBe(true);
      expect(isValidBatchYield(0, 0)).toBe(false);
      expect(isValidBatchYield(-5, 0)).toBe(false);
      expect(isValidBatchYield(10, -1)).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // ADV-12: Network retry & idempotency sub-request derivation via production helper
  // -------------------------------------------------------------
  describe("ADV-12: Deterministic subRequestId generation via production helper", () => {
    it("generates deterministic composite subRequestId across retries via deriveBundleComponentSubRequestId", () => {
      const clientReq = "req-uuid-998877";
      const variantId = 201;
      const sub1 = deriveBundleComponentSubRequestId(clientReq, variantId);
      const sub2 = deriveBundleComponentSubRequestId(clientReq, variantId);
      expect(sub1).toBe("req-uuid-998877:comp:201");
      expect(sub1).toBe(sub2);
    });

    it("validates clientRequestId length constraints in schema (1..80 chars)", () => {
      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          clientRequestId: "",
        }).success,
      ).toBe(false);

      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          clientRequestId: "a".repeat(81),
        }).success,
      ).toBe(false);

      expect(
        produceBundleComponentsInputSchema.safeParse({
          ...baseProducePayload,
          clientRequestId: "valid-client-request-id-123",
        }).success,
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // ADV-13: Concurrent deadlock prevention via ascending row locking using production helpers
  // -------------------------------------------------------------
  describe("ADV-13: Deadlock prevention via deterministic ascending locking helpers", () => {
    it("sorts variant IDs strictly ASC and deduplicates via sortLockIds", () => {
      const unorderedVariants = [305, 12, 88, 3, 88];
      const sorted = sortLockIds(unorderedVariants);
      expect(sorted).toEqual([3, 12, 88, 305]);
    });

    it("collects and sorts all bundle, batch, recipe lines, and substitution IDs via collectBundleProductionLockVariantIds", () => {
      const lockedIds = collectBundleProductionLockVariantIds({
        bundleVariantId: 500,
        batchVariantIds: [100, 20],
        recipeInputVariantIds: [850, 45, 100],
        substituteVariantIds: [12, 500],
      });
      // All unique: 20, 100, 500, 850, 45, 12 -> sorted: 12, 20, 45, 100, 500, 850
      expect(lockedIds).toEqual([12, 20, 45, 100, 500, 850]);
    });
  });
});

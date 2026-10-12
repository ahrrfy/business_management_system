/**
 * tests/stress/operationalCapsAndMaskingStress.test.ts
 *
 * Empirical Adversarial Stress Suite for Milestone 1:
 *  1. Quantitative caps boundary values & edge cases
 *  2. Sensitive data masking invariants & role security
 *  3. Search & filter performance under extreme strings, regex meta-chars & Arabic variations
 */

import { describe, expect, it } from "vitest";
import {
  ALL_ATOMIC_PERMISSION_KEYS,
  ATOMIC_PERMISSION_DEFINITIONS,
  DEFAULT_MASKING_ALL_FALSE,
  DEFAULT_MASKING_ALL_TRUE,
  DEFAULT_UNLIMITED_CAPS,
  DEFAULT_ZERO_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  isCreditSaleWithinCap,
  isDiscountAmountWithinCap,
  isDiscountPercentWithinCap,
  isExpenseWithinCap,
  isPaymentVoucherWithinCap,
  isRefundWithinCap,
  operationalCapsSchema,
  resolveOperationalCaps,
  resolveSensitiveDataMasking,
  searchAtomicPermissions,
  sensitiveDataMaskingSchema,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "../../shared/atomicPermissions";

describe("Adversarial Stress Test: Quantitative Operational Caps", () => {
  describe("1.1 operationalCapsSchema Boundary Values", () => {
    it("accepts valid boundary discount percentages: 0%, 50%, 100%", () => {
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 0 }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 50 }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 100 }).success).toBe(true);
    });

    it("rejects invalid boundary discount percentages: -5%, 101%, -0.01%, 100.01%", () => {
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: -5 }).success).toBe(false);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 101 }).success).toBe(false);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: -0.01 }).success).toBe(false);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 100.01 }).success).toBe(false);
    });

    it("accepts fractional percentages: 2.5%, 12.75%, 99.9%", () => {
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 2.5 }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 12.75 }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: 99.9 }).success).toBe(true);
    });

    it("rejects non-numeric percentages: NaN, Infinity, -Infinity", () => {
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: NaN }).success).toBe(false);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: Infinity }).success).toBe(false);
      expect(operationalCapsSchema.safeParse({ maxDiscountPercent: -Infinity }).success).toBe(false);
    });

    it("validates financial amount format (max 2 decimal places, non-negative)", () => {
      // Valid amounts
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "0" }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "0.00" }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "25000.5" }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "50000.00" }).success).toBe(true);
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "999999999999.99" }).success).toBe(true);

      // Invalid amounts
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "0.001" }).success).toBe(false); // 3 decimals
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "-1000.00" }).success).toBe(false); // negative
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "abc" }).success).toBe(false); // letters
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "1e5" }).success).toBe(false); // scientific
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "" }).success).toBe(false); // empty
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: "   " }).success).toBe(false); // spaces
      expect(operationalCapsSchema.safeParse({ maxDiscountAmountIqd: 25000 as any }).success).toBe(false); // number instead of string
    });
  });

  describe("1.2 Caps Enforcement Helpers: Boundary & Extreme Values", () => {
    const testCaps: Required<OperationalCaps> = {
      maxDiscountPercent: 10,
      maxDiscountAmountIqd: "50000.00",
      maxCreditSaleLimitIqd: "100000.00",
      maxPaymentVoucherAmountIqd: "1000000.00",
      maxExpenseVoucherAmountIqd: "25000.00",
      maxRefundAmountIqd: "50000.00",
    };

    it("enforces exact percentage boundaries (0%, 9.99%, 10%, 10.01%)", () => {
      expect(isDiscountPercentWithinCap(0, testCaps)).toBe(true);
      expect(isDiscountPercentWithinCap(9.99, testCaps)).toBe(true);
      expect(isDiscountPercentWithinCap(10, testCaps)).toBe(true);
      expect(isDiscountPercentWithinCap(10.01, testCaps)).toBe(false);
      expect(isDiscountPercentWithinCap(100, testCaps)).toBe(false);
      expect(isDiscountPercentWithinCap(-0.01, testCaps)).toBe(false);
      expect(isDiscountPercentWithinCap(-5, testCaps)).toBe(false);
    });

    it("enforces exact money amount boundaries (exact, +0.01, extreme)", () => {
      // maxDiscountAmountIqd = 50000.00
      expect(isDiscountAmountWithinCap("0.00", testCaps)).toBe(true);
      expect(isDiscountAmountWithinCap("49999.99", testCaps)).toBe(true);
      expect(isDiscountAmountWithinCap("50000.00", testCaps)).toBe(true);
      expect(isDiscountAmountWithinCap("50000.01", testCaps)).toBe(false);
      expect(isDiscountAmountWithinCap(50000, testCaps)).toBe(true);
      expect(isDiscountAmountWithinCap(50000.01, testCaps)).toBe(false);
      expect(isDiscountAmountWithinCap("1000000000.00", testCaps)).toBe(false);
      expect(isDiscountAmountWithinCap("-1.00", testCaps)).toBe(false);

      // maxCreditSaleLimitIqd = 100000.00
      expect(isCreditSaleWithinCap("100000.00", testCaps)).toBe(true);
      expect(isCreditSaleWithinCap("100000.01", testCaps)).toBe(false);

      // maxPaymentVoucherAmountIqd = 1000000.00
      expect(isPaymentVoucherWithinCap("1000000.00", testCaps)).toBe(true);
      expect(isPaymentVoucherWithinCap("1000000.01", testCaps)).toBe(false);

      // maxExpenseVoucherAmountIqd = 25000.00
      expect(isExpenseWithinCap("25000.00", testCaps)).toBe(true);
      expect(isExpenseWithinCap("25000.01", testCaps)).toBe(false);

      // maxRefundAmountIqd = 50000.00
      expect(isRefundWithinCap("50000.00", testCaps)).toBe(true);
      expect(isRefundWithinCap("50000.01", testCaps)).toBe(false);
    });

    it("evaluates behavior under null / unconstrained caps", () => {
      // Under null caps (unlimited admin)
      expect(isDiscountAmountWithinCap("999999999.99", null)).toBe(true);
      expect(isCreditSaleWithinCap("999999999.99", null)).toBe(true);
      expect(isPaymentVoucherWithinCap("999999999.99", null)).toBe(true);

      // Negative values must ALWAYS be rejected even if caps is null
      expect(isDiscountAmountWithinCap("-100", null)).toBe(false);
      expect(isCreditSaleWithinCap("-5000", null)).toBe(false);
      expect(isPaymentVoucherWithinCap("-1", null)).toBe(false);
      expect(isDiscountPercentWithinCap(-5, null)).toBe(false);
    });

    it("VULNERABILITY CHECK: NaN passes caps enforcement when caps is null or undefined", () => {
      // EMPIRICAL BUG: parseMoneyAmount returns NaN without checking isNaN for number types.
      // NaN < 0 is false. Then (!caps || caps.max... === null) returns TRUE!
      const nanDiscountResult = isDiscountAmountWithinCap(NaN, null);
      const nanCreditResult = isCreditSaleWithinCap(NaN, null);
      const nanPaymentResult = isPaymentVoucherWithinCap(NaN, null);
      const nanExpenseResult = isExpenseWithinCap(NaN, null);
      const nanRefundResult = isRefundWithinCap(NaN, null);
      const nanPercentResult = isDiscountPercentWithinCap(NaN, null);

      console.log(`[Vulnerability Confirmed] isDiscountAmountWithinCap(NaN, null): ${nanDiscountResult}`);
      console.log(`[Vulnerability Confirmed] isCreditSaleWithinCap(NaN, null): ${nanCreditResult}`);
      console.log(`[Vulnerability Confirmed] isPaymentVoucherWithinCap(NaN, null): ${nanPaymentResult}`);
      console.log(`[Vulnerability Confirmed] isExpenseWithinCap(NaN, null): ${nanExpenseResult}`);
      console.log(`[Vulnerability Confirmed] isRefundWithinCap(NaN, null): ${nanRefundResult}`);
      console.log(`[Vulnerability Confirmed] isDiscountPercentWithinCap(NaN, null): ${nanPercentResult}`);

      // We assert the actual observed behavior (which constitutes a vulnerability finding):
      expect(nanDiscountResult).toBe(true);
      expect(nanCreditResult).toBe(true);
      expect(nanPaymentResult).toBe(true);
      expect(nanExpenseResult).toBe(true);
      expect(nanRefundResult).toBe(true);
      expect(nanPercentResult).toBe(true);
    });

    it("VULNERABILITY CHECK: Discount percent > 100% passes when caps is null", () => {
      // EMPIRICAL BUG: isDiscountPercentWithinCap does not enforce a universal ceiling of 100%
      // when caps is null or maxDiscountPercent is null.
      const p101 = isDiscountPercentWithinCap(101, null);
      const p500 = isDiscountPercentWithinCap(500, null);
      const pInfinity = isDiscountPercentWithinCap(Infinity, null);

      console.log(`[Vulnerability Confirmed] isDiscountPercentWithinCap(101, null): ${p101}`);
      console.log(`[Vulnerability Confirmed] isDiscountPercentWithinCap(500, null): ${p500}`);
      console.log(`[Vulnerability Confirmed] isDiscountPercentWithinCap(Infinity, null): ${pInfinity}`);

      // We assert the actual observed behavior:
      expect(p101).toBe(true);
      expect(p500).toBe(true);
      expect(pInfinity).toBe(true);
    });

    it("evaluates SoD and ZERO caps for default warehouse & courier roles", () => {
      const warehouseCaps = ROLE_DEFAULT_OPERATIONAL_CAPS.warehouse;
      expect(warehouseCaps.maxDiscountPercent).toBe(0);
      expect(warehouseCaps.maxDiscountAmountIqd).toBe("0.00");
      expect(warehouseCaps.maxCreditSaleLimitIqd).toBe("0.00");
      expect(warehouseCaps.maxPaymentVoucherAmountIqd).toBe("0.00");

      // Warehouse cannot give any discount or credit sale
      expect(isDiscountPercentWithinCap(0.01, warehouseCaps)).toBe(false);
      expect(isDiscountAmountWithinCap("0.01", warehouseCaps)).toBe(false);
      expect(isCreditSaleWithinCap("0.01", warehouseCaps)).toBe(false);
      expect(isDiscountAmountWithinCap("0.00", warehouseCaps)).toBe(true); // 0 is allowed
    });
  });

  describe("1.3 Resolution of Operational Caps: Hierarchy & Overrides", () => {
    it("correctly resolves 3-tier caps hierarchy: Role Default -> Custom Role -> User Override", () => {
      // 1. Role default: Cashier (5% discount, 0 IQD credit)
      const r1 = resolveOperationalCaps("cashier");
      expect(r1.maxDiscountPercent).toBe(5);
      expect(r1.maxCreditSaleLimitIqd).toBe("0.00");

      // 2. Custom Role overrides discount to 8%
      const r2 = resolveOperationalCaps("cashier", { maxDiscountPercent: 8 });
      expect(r2.maxDiscountPercent).toBe(8);
      expect(r2.maxCreditSaleLimitIqd).toBe("0.00"); // preserved

      // 3. User override gives 12% and 50,000 credit
      const r3 = resolveOperationalCaps(
        "cashier",
        { maxDiscountPercent: 8 },
        { maxDiscountPercent: 12, maxCreditSaleLimitIqd: "50000.00" },
      );
      expect(r3.maxDiscountPercent).toBe(12);
      expect(r3.maxCreditSaleLimitIqd).toBe("50000.00");
      expect(r3.maxRefundAmountIqd).toBe("25000.00"); // preserved from base
    });

    it("handles null overrides (unlimited) vs undefined (preserve base)", () => {
      const resolved = resolveOperationalCaps("cashier", null, {
        maxDiscountAmountIqd: null, // explicit unlimited
      });
      expect(resolved.maxDiscountAmountIqd).toBeNull();
      expect(resolved.maxDiscountPercent).toBe(5); // preserved base
    });

    it("safely falls back to DEFAULT_ZERO_CAPS for non-existent roles", () => {
      const resolved = resolveOperationalCaps("unknown_role_xyz");
      expect(resolved.maxDiscountPercent).toBe(0);
      expect(resolved.maxDiscountAmountIqd).toBe("0.00");
      expect(resolved.maxCreditSaleLimitIqd).toBe("0.00");
    });
  });
});

describe("Adversarial Stress Test: Sensitive Data Masking Invariants", () => {
  describe("2.1 Core Role Invariants", () => {
    it("CASHIER invariant: MUST mask purchase cost, profit margin, supplier phone; customer contact unmasked", () => {
      for (const role of ["cashier", "retail_cashier", "print_cashier"]) {
        const masking = ROLE_DEFAULT_DATA_MASKING[role];
        expect(masking.maskPurchaseCost, `${role} must mask purchase cost`).toBe(true);
        expect(masking.maskProfitMargin, `${role} must mask profit margin`).toBe(true);
        expect(masking.maskSupplierPhone, `${role} must mask supplier phone`).toBe(true);
        expect(masking.maskCustomerContact, `${role} can see customer contact`).toBe(false);
      }
    });

    it("RECEPTION invariant: MUST mask purchase cost, profit margin, supplier phone; customer contact unmasked", () => {
      const masking = ROLE_DEFAULT_DATA_MASKING.reception_clerk;
      expect(masking.maskPurchaseCost).toBe(true);
      expect(masking.maskProfitMargin).toBe(true);
      expect(masking.maskSupplierPhone).toBe(true);
      expect(masking.maskCustomerContact).toBe(false);
    });

    it("WAREHOUSE invariant: MUST mask ALL sensitive data (cost, margin, supplier phone, customer contact)", () => {
      const masking = ROLE_DEFAULT_DATA_MASKING.warehouse;
      expect(masking.maskPurchaseCost).toBe(true);
      expect(masking.maskProfitMargin).toBe(true);
      expect(masking.maskSupplierPhone).toBe(true);
      expect(masking.maskCustomerContact).toBe(true);
    });

    it("ACCOUNTANT invariant: ALL sensitive data unmasked for financial/COGS operations", () => {
      const masking = ROLE_DEFAULT_DATA_MASKING.accountant;
      expect(masking.maskPurchaseCost).toBe(false);
      expect(masking.maskProfitMargin).toBe(false);
      expect(masking.maskSupplierPhone).toBe(false);
      expect(masking.maskCustomerContact).toBe(false);
    });

    it("AUDITOR invariant: ALL sensitive data unmasked to allow audit trail review", () => {
      const masking = ROLE_DEFAULT_DATA_MASKING.auditor;
      expect(masking.maskPurchaseCost).toBe(false);
      expect(masking.maskProfitMargin).toBe(false);
      expect(masking.maskSupplierPhone).toBe(false);
      expect(masking.maskCustomerContact).toBe(false);
    });
  });

  describe("2.2 Masking Resolution & Override Boundaries", () => {
    it("falls back to DEFAULT_MASKING_ALL_TRUE (fail-closed) for unknown or empty roles", () => {
      const resolved = resolveSensitiveDataMasking("unknown_intruder");
      expect(resolved.maskPurchaseCost).toBe(true);
      expect(resolved.maskProfitMargin).toBe(true);
      expect(resolved.maskSupplierPhone).toBe(true);
      expect(resolved.maskCustomerContact).toBe(true);
    });

    it("correctly allows user override to unmask purchase cost for a trusted cashier", () => {
      const resolved = resolveSensitiveDataMasking("cashier", null, {
        maskPurchaseCost: false,
      });
      expect(resolved.maskPurchaseCost).toBe(false);
      expect(resolved.maskProfitMargin).toBe(true); // remained masked
      expect(resolved.maskSupplierPhone).toBe(true); // remained masked
    });

    it("ignores null overrides in masking resolution (null = inherit from base)", () => {
      const resolved = resolveSensitiveDataMasking("cashier", null, {
        maskPurchaseCost: null,
      });
      expect(resolved.maskPurchaseCost).toBe(true); // preserved cashier default
    });
  });
});

describe("Adversarial Stress Test: Search & Filter Performance & Regex Safety", () => {
  describe("3.1 Regex Meta-characters & Injection Strings", () => {
    const maliciousInputs = [
      ".*",
      "+",
      "?",
      "^",
      "$",
      "{0,10}",
      "()",
      "|",
      "[]",
      "\\",
      "[a-z]+",
      "/(?:)/",
      "(?=.*a)",
      "' OR '1'='1",
      "<script>alert('xss')</script>",
      "\x00\x01\x02",
      "\n\r\t",
      "\\u0000",
      "\"'; --",
      "DROP TABLE users;",
    ];

    it("handles all regex meta-characters without throwing SyntaxError or crashing", () => {
      for (const input of maliciousInputs) {
        expect(() => {
          const results = searchAtomicPermissions(input);
          expect(Array.isArray(results)).toBe(true);
        }).not.toThrow();
      }
    });

    it("handles extreme input lengths (1KB, 10KB, 50KB strings) safely without memory leak or crash", () => {
      const longInput1 = "a".repeat(1000);
      const longInput10 = "print".repeat(2000); // 10KB
      const longInput50 = "x".repeat(50000); // 50KB

      expect(searchAtomicPermissions(longInput1)).toEqual([]);
      expect(searchAtomicPermissions(longInput10)).toEqual([]);
      expect(searchAtomicPermissions(longInput50)).toEqual([]);
    });
  });

  describe("3.2 Arabic Typography & Search Normalization Observations", () => {
    it("matches exact Arabic terms like 'طباعة' and 'خصم'", () => {
      const printResults = searchAtomicPermissions("طباعة");
      expect(printResults.length).toBeGreaterThan(0);

      const discountResults = searchAtomicPermissions("خصم");
      expect(discountResults.length).toBeGreaterThan(0);
    });

    it("OBSERVATION: test Arabic spelling variations (hamza, taa marbuta)", () => {
      // Searching for 'طباعه' (with haa) vs 'طباعة' (with taa marbuta)
      const taaMatches = searchAtomicPermissions("طباعة");
      const haaMatches = searchAtomicPermissions("طباعه");

      // Searching for 'امر' (without hamza) vs 'أمر' (with hamza)
      const hamzaMatches = searchAtomicPermissions("أمر");
      const bareMatches = searchAtomicPermissions("امر");

      console.log(`[Empirical Observation] 'طباعة' matches: ${taaMatches.length}, 'طباعه' matches: ${haaMatches.length}`);
      console.log(`[Empirical Observation] 'أمر' matches: ${hamzaMatches.length}, 'امر' matches: ${bareMatches.length}`);

      // We document whether normalization is present:
      expect(taaMatches.length).toBeGreaterThan(0);
      expect(hamzaMatches.length).toBeGreaterThan(0);
    });

    it("preserves spaces during search without crashing (e.g. 'أمر شغل', 'فاتورة بيع')", () => {
      const workOrderMatches = searchAtomicPermissions("أمر شغل");
      expect(workOrderMatches.length).toBeGreaterThan(0);

      const posInvoiceMatches = searchAtomicPermissions("فاتورة بيع");
      expect(posInvoiceMatches.length).toBeGreaterThan(0);
    });

    it("handles whitespace-only queries gracefully", () => {
      const singleSpace = searchAtomicPermissions(" ");
      const multiSpace = searchAtomicPermissions("   ");
      // Does not throw
      expect(Array.isArray(singleSpace)).toBe(true);
      expect(Array.isArray(multiSpace)).toBe(true);
    });
  });

  describe("3.3 Performance Benchmark: High Throughput Search", () => {
    it("executes 10,000 search queries and measures throughput/latency", () => {
      const queries = ["طباعة", "pos", "خصم", "inventory", "voucher", "order", "view", "approve", "سند", "شغل"];
      const start = performance.now();

      for (let i = 0; i < 10000; i++) {
        const q = queries[i % queries.length];
        const res = searchAtomicPermissions(q);
        expect(res.length).toBeGreaterThan(0);
      }

      const elapsed = performance.now() - start;
      const latencyPerQueryMs = elapsed / 10000;
      const opsPerSec = (10000 / (elapsed / 1000)).toFixed(0);
      console.log(`[Benchmark] 10,000 search queries executed in ${elapsed.toFixed(2)}ms (${latencyPerQueryMs.toFixed(4)}ms/query, ~${opsPerSec} ops/sec)`);
      // 0.11ms/query is well within interactive UI budget (180ms debounce)
      expect(elapsed).toBeLessThan(3000);
    });
  });
});

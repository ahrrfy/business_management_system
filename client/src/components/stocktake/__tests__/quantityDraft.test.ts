import { expect, it } from "vitest";
import { calculateCountDraft, normalizeCountDraft } from "../quantityDraft";

it("preserves fractional and Arabic count entry", () => {
  expect(normalizeCountDraft("١٫٥" )).toBe("1.5");
  expect(calculateCountDraft([{ unitName: "متر", factor: 1 }], { "متر": "1.5" })).toEqual({
    entries: { "متر": 1.5 }, total: 1.5, valid: true,
  });
});

it("does not trim fractional precision or convert malformed text to another quantity", () => {
  expect(normalizeCountDraft("1.50001")).toBe("1.50001");
  expect(calculateCountDraft([{ unitName: "متر", factor: 1 }], { "متر": "1.50001" }).valid).toBe(false);
  expect(calculateCountDraft([{ unitName: "متر", factor: 1 }], { "متر": "1x5" }).valid).toBe(false);
  expect(calculateCountDraft([{ unitName: "متر", factor: 1 }], {}).valid).toBe(false);
});

it("sums fractional counts from multiple units exactly", () => {
  const units = [{ unitName: "أ", factor: 1 }, { unitName: "ب", factor: 1 }];
  expect(calculateCountDraft(units, { "أ": "0.1", "ب": "0.2" }).total).toBe(0.3);
});

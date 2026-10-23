import { describe, expect, it } from "vitest";
import { sanitizeRecipeClipboard } from "../recipeClipboard";

describe("recipe clipboard quantity and numeric integrity", () => {
  it("preserves sub-cent material quantities when duplicate variants are combined", () => {
    const result = sanitizeRecipeClipboard({
      lines: [
        { inputVariantId: 1, qtyPerOutputBase: "0.0001" },
        { inputVariantId: 1, qtyPerOutputBase: "0.0002" },
      ],
    });
    expect(result?.lines[0].qtyPerOutputBase).toBe("0.0003");
  });

  it("skips malformed quantities without throwing away valid materials", () => {
    const payload = {
      lines: [
        { inputVariantId: 1, qtyPerOutputBase: "1" },
        { inputVariantId: 1, qtyPerOutputBase: "." },
        { inputVariantId: 2, qtyPerOutputBase: "NaN" },
        { inputVariantId: 3, qtyPerOutputBase: "Infinity" },
        { inputVariantId: 4, qtyPerOutputBase: "-1" },
      ],
    };
    expect(() => sanitizeRecipeClipboard(payload)).not.toThrow();
    expect(
      sanitizeRecipeClipboard(payload)?.lines.map(
        (line) => line.inputVariantId,
      ),
    ).toEqual([1]);
  });

  it("rejects non-finite or negative material cost rather than persisting it", () => {
    for (const inputCostPrice of ["NaN", "Infinity", ".", "-4"]) {
      expect(
        sanitizeRecipeClipboard({
          lines: [{ inputVariantId: 1, qtyPerOutputBase: "1", inputCostPrice }],
        }),
      ).toBeNull();
    }
  });

  it("does not copy invalid labour or waste percentages into another editor", () => {
    const payload = { lines: [{ inputVariantId: 1, qtyPerOutputBase: "1" }] };
    for (const laborPerOutputBase of ["NaN", ".", "-1"]) {
      expect(
        sanitizeRecipeClipboard({ ...payload, laborPerOutputBase }),
      ).toBeNull();
    }
    for (const wasteStdPct of ["Infinity", ".", "-0.1", "1"]) {
      expect(sanitizeRecipeClipboard({ ...payload, wasteStdPct })).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";
import { barcodeInputAcceptsScan, DEFAULT_BARCODE_INPUT_MIN_LENGTH } from "./useBarcodeInput";

describe("useBarcodeInput length contract", () => {
  it("keeps a fast two-character human query manual by default", () => {
    expect(DEFAULT_BARCODE_INPUT_MIN_LENGTH).toBe(3);
    expect(barcodeInputAcceptsScan("AB")).toBe(false);
  });

  it("allows a dedicated barcode field to opt into two-character codes", () => {
    expect(barcodeInputAcceptsScan("B1", 2)).toBe(true);
  });
});

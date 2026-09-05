import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { barcodeInputAcceptsScan, DEFAULT_BARCODE_INPUT_MIN_LENGTH } from "./useBarcodeInput";

describe("useBarcodeInput length contract", () => {
  it("keeps a fast two-character human query manual by default", () => {
    expect(DEFAULT_BARCODE_INPUT_MIN_LENGTH).toBe(3);
    expect(barcodeInputAcceptsScan("AB")).toBe(false);
  });

  it("allows a dedicated barcode field to opt into two-character codes", () => {
    expect(barcodeInputAcceptsScan("B1", 2)).toBe(true);
  });

  it.each(["CountPortal", "MyStocktakeWorkspace"])("keeps focused short HID scans available in %s scan-required mode", (page) => {
    const source = readFileSync(new URL(`../pages/${page}.tsx`, import.meta.url), "utf8");
    expect(/useBarcodeInput\([\s\S]*?minLength:\s*scanRequired\s*\?\s*2\s*:\s*3/.test(source)).toBe(true);
  });
});

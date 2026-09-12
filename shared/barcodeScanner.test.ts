import { describe, it, expect } from "vitest";
import {
  normalizeArabicKeyboardToAscii,
  normalizeKnownSystemBarcode,
  looksLikeSystemBarcode,
  KNOWN_SYSTEM_PREFIXES,
} from "./barcodeScanner";

describe("barcodeScanner", () => {
  it("keeps standard ASCII barcodes unchanged", () => {
    expect(normalizeKnownSystemBarcode("ORD-2026-0001")).toBe("ORD-2026-0001");
    expect(normalizeKnownSystemBarcode("CN-2026-0042")).toBe("CN-2026-0042");
    expect(normalizeKnownSystemBarcode("INV-2026-0105")).toBe("INV-2026-0105");
    expect(normalizeKnownSystemBarcode("WO-2026-0089")).toBe("WO-2026-0089");
    expect(normalizeKnownSystemBarcode("RES-2026-0005")).toBe("RES-2026-0005");
    expect(normalizeKnownSystemBarcode("PO-2026-0012")).toBe("PO-2026-0012");
  });

  it("trims whitespace and directional marks", () => {
    expect(normalizeKnownSystemBarcode("  \tORD-2026-0001\n ")).toBe("ORD-2026-0001");
    expect(normalizeKnownSystemBarcode("\u200FCN-2026-0042\u2066")).toBe("CN-2026-0042");
  });

  it("normalizes Arabic-Indic digits to Latin", () => {
    expect(normalizeKnownSystemBarcode("ORD-٢٠٢٦-٠٠٠١")).toBe("ORD-2026-0001");
    expect(normalizeKnownSystemBarcode("CN-٢٠٢٦-٠٠٤٢")).toBe("CN-2026-0042");
    expect(normalizeKnownSystemBarcode("INV-٢٠٢٦-٠١٠٥")).toBe("INV-2026-0105");
  });

  it("translates Arabic 101 keyboard barcode scanner input", () => {
    expect(normalizeKnownSystemBarcode("خقي-2026-0001")).toBe("ORD-2026-0001");
    expect(normalizeKnownSystemBarcode("ؤى-2026-0042")).toBe("CN-2026-0042");
    expect(normalizeKnownSystemBarcode("صخ-2026-0089")).toBe("WO-2026-0089");
    expect(normalizeKnownSystemBarcode("÷آ{-2026-0105")).toBe("INV-2026-0105");
  });

  it("detects system barcode prefixes correctly", () => {
    expect(looksLikeSystemBarcode("ORD-2026-0001")).toBe(true);
    expect(looksLikeSystemBarcode("CN-1234")).toBe(true);
    expect(looksLikeSystemBarcode("INV-5678")).toBe(true);
    expect(looksLikeSystemBarcode("WO-9999")).toBe(true);
    expect(looksLikeSystemBarcode("1234567890")).toBe(false);
    expect(looksLikeSystemBarcode("UNKNOWN-123")).toBe(false);
  });

  it("strips ISO/IEC 15424 AIM symbology identifiers (]E0, ]C1, etc.)", () => {
    expect(normalizeKnownSystemBarcode("]E06281001234567")).toBe("6281001234567");
    expect(normalizeKnownSystemBarcode("]C1INV-2026-0105")).toBe("INV-2026-0105");
    expect(normalizeKnownSystemBarcode("]e01234567890123")).toBe("1234567890123");
    expect(normalizeKnownSystemBarcode("]A0ORD-2026-0001")).toBe("ORD-2026-0001");
  });

  it("includes all known system prefixes", () => {
    for (const p of ["ORD", "CN", "INV", "WO", "RES", "PO", "QUO"]) {
      expect(KNOWN_SYSTEM_PREFIXES).toContain(p);
    }
  });
});

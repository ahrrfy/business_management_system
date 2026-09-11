import assert from "node:assert";
import {
  normalizeArabicKeyboardToAscii,
  normalizeKnownSystemBarcode,
  looksLikeSystemBarcode,
  KNOWN_SYSTEM_PREFIXES,
} from "./barcodeScanner";

console.log("Running barcodeScanner unit tests...");

// ١. الحفاظ على الرموز الإنجليزية
assert.strictEqual(normalizeKnownSystemBarcode("ORD-2026-0001"), "ORD-2026-0001");
assert.strictEqual(normalizeKnownSystemBarcode("CN-2026-0042"), "CN-2026-0042");
assert.strictEqual(normalizeKnownSystemBarcode("INV-2026-0105"), "INV-2026-0105");
assert.strictEqual(normalizeKnownSystemBarcode("WO-2026-0089"), "WO-2026-0089");
assert.strictEqual(normalizeKnownSystemBarcode("RES-2026-0005"), "RES-2026-0005");
assert.strictEqual(normalizeKnownSystemBarcode("PO-2026-0012"), "PO-2026-0012");
console.log("✓ Pass: Standard ASCII barcodes unchanged");

// ٢. تقليم المسافات والأحرف غير المرئية
assert.strictEqual(normalizeKnownSystemBarcode("  \tORD-2026-0001\n "), "ORD-2026-0001");
assert.strictEqual(normalizeKnownSystemBarcode("\u200FCN-2026-0042\u2066"), "CN-2026-0042");
console.log("✓ Pass: Trims whitespace and directional marks");

// ٣. طي الأرقام العربية-الهندية
assert.strictEqual(normalizeKnownSystemBarcode("ORD-٢٠٢٦-٠٠٠١"), "ORD-2026-0001");
assert.strictEqual(normalizeKnownSystemBarcode("CN-٢٠٢٦-٠٠٤٢"), "CN-2026-0042");
assert.strictEqual(normalizeKnownSystemBarcode("INV-٢٠٢٦-٠١٠٥"), "INV-2026-0105");
console.log("✓ Pass: Normalizes Arabic-Indic digits to Latin");

// ٤. تحويل لوحة المفاتيح العربية 101
assert.strictEqual(normalizeKnownSystemBarcode("خقي-2026-0001"), "ORD-2026-0001");
assert.strictEqual(normalizeKnownSystemBarcode("ؤى-2026-0042"), "CN-2026-0042");
assert.strictEqual(normalizeKnownSystemBarcode("صخ-2026-0089"), "WO-2026-0089");
assert.strictEqual(normalizeKnownSystemBarcode("÷آ{-2026-0105"), "INV-2026-0105");
console.log("✓ Pass: Arabic 101 keyboard barcode scanner translation");

// ٥. كشف البادئات
assert.strictEqual(looksLikeSystemBarcode("ORD-2026-0001"), true);
assert.strictEqual(looksLikeSystemBarcode("CN-1234"), true);
assert.strictEqual(looksLikeSystemBarcode("INV-5678"), true);
assert.strictEqual(looksLikeSystemBarcode("WO-9999"), true);
assert.strictEqual(looksLikeSystemBarcode("1234567890"), false);
assert.strictEqual(looksLikeSystemBarcode("UNKNOWN-123"), false);
console.log("✓ Pass: looksLikeSystemBarcode prefix detection");

// ٦. قائمة البادئات
for (const p of ["ORD", "CN", "INV", "WO", "RES", "PO", "QUO"]) {
  assert.ok(KNOWN_SYSTEM_PREFIXES.includes(p as any), `Missing prefix: ${p}`);
}
console.log("✓ Pass: KNOWN_SYSTEM_PREFIXES completeness");

console.log("\nAll barcodeScanner tests passed successfully! (6/6)");

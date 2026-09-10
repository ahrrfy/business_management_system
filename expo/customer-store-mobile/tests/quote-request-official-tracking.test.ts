import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve(process.cwd(), "lib/storefront-api.ts"), "utf8");
const orders = readFileSync(resolve(process.cwd(), "app/(tabs)/orders.tsx"), "utf8");

describe("official quotation tracking contract", () => {
  it("shows the formal quote reference and expiry without exposing a price in the tracking model", () => {
    expect(api).toContain("officialQuotation:");
    expect(api).not.toContain("officialQuotation: {\n    quoteNumber: string;\n    total:");
    expect(orders).toContain("صدر العرض الرسمي رقم {quoteTracking.officialQuotation.quoteNumber}");
    expect(orders).toContain("quoteTracking.officialQuotation.validUntil");
  });
});

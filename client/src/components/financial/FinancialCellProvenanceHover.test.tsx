import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const componentPath = new URL("./FinancialCellProvenanceHover.tsx", import.meta.url);
const componentSource = readFileSync(componentPath, "utf8");

describe("FinancialCellProvenanceHover specifications & contract compliance", () => {
  it("keeps file size strictly below 350 lines (D4 limit <= 400)", () => {
    const lines = componentSource.split("\n").length;
    expect(lines).toBeLessThanOrEqual(350);
  });

  it("configures Radix HoverCard with openDelay=100 and closeDelay=150", () => {
    expect(componentSource).toContain("openDelay={100}");
    expect(componentSource).toContain("closeDelay={150}");
  });

  it("enforces RTL layout with dir='rtl'", () => {
    expect(componentSource).toContain('dir="rtl"');
  });

  it("supports all 6 financial movement types", () => {
    expect(componentSource).toContain("revenue:");
    expect(componentSource).toContain("expense:");
    expect(componentSource).toContain("collection:");
    expect(componentSource).toContain("delivery:");
    expect(componentSource).toContain("balance:");
    expect(componentSource).toContain("difference:");
  });

  it("adheres strictly to semantic color tokens without raw colors", () => {
    expect(componentSource).toContain("--sem-pos");
    expect(componentSource).toContain("--sem-neg");
    expect(componentSource).toContain("--sem-warn");
    expect(componentSource).toContain("--sem-info");
    // Ensure no raw un-tokenized status colors are introduced
    expect(componentSource).not.toMatch(/bg-green-\d{3}/);
    expect(componentSource).not.toMatch(/text-green-\d{3}/);
    expect(componentSource).not.toMatch(/bg-red-\d{3}/);
    expect(componentSource).not.toMatch(/text-red-\d{3}/);
  });

  it("strictly enforces Zero Emoji Policy", () => {
    const emojiRegex =
      /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
    const matches = componentSource.match(emojiRegex);
    expect(matches).toBeNull();
  });

  it("includes scrollable sub-items container with max-h-60 overflow-y-auto", () => {
    expect(componentSource).toContain("max-h-60 overflow-y-auto");
  });

  it("displays 100% mathematical match and discrepancy indicator in footer", () => {
    expect(componentSource).toContain("مطابقة تامة للبنود (100%)");
    expect(componentSource).toContain("تفاوت:");
  });

  it("preserves trigger asChild support for tabular formatting in cells", () => {
    expect(componentSource).toContain("<HoverCardTrigger asChild>");
  });
});

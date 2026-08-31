import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ConsentChoice.tsx", import.meta.url), "utf8");

describe("storefront consent accessibility contract", () => {
  it("uses a modal focus scope with explicit initial focus and safe-area offsets", () => {
    expect(source).toContain("DialogPrimitive.Root");
    expect(source).toContain("DialogPrimitive.Content");
    expect(source).toContain("onOpenAutoFocus");
    expect(source).toContain("DialogPrimitive.Title");
    expect(source).toContain("safe-area-inset-bottom");
  });
});

import { describe, expect, it } from "vitest";

import { formatBaghdadTime, formatIqd } from "../lib/format";

describe("Arabic mobile formatting", () => {
  it("isolates the numeric Iraqi dinar amount for RTL text", () => {
    expect(formatIqd(1200000)).toContain("\u2068");
    expect(formatIqd(1200000)).toContain("د.ع");
  });

  it("formats decimal strings without losing integer precision", () => {
    expect(formatIqd("9007199254740993.49")).toContain("9,007,199,254,740,993");
    expect(formatIqd("9007199254740993.50")).toContain("9,007,199,254,740,994");
  });

  it("formats a valid timestamp in Baghdad time", () => {
    const value = formatBaghdadTime("2026-09-09T09:30:00.000Z");
    expect(value).not.toBeNull();
    expect(value).not.toMatch(/[٠-٩]/);
  });

  it("rejects an invalid timestamp", () => {
    expect(formatBaghdadTime("not-a-date")).toBeNull();
  });
});

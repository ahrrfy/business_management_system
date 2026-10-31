import { describe, expect, it } from "vitest";
import { currentBaghdadMonth } from "./businessMonth";

describe("currentBaghdadMonth", () => {
  it("ينتقل إلى الشهر الجديد عند منتصف ليل بغداد لا منتصف ليل UTC", () => {
    expect(currentBaghdadMonth(new Date("2026-08-31T20:59:59.999Z"))).toBe(
      "2026-08",
    );
    expect(currentBaghdadMonth(new Date("2026-08-31T21:00:00.000Z"))).toBe(
      "2026-09",
    );
  });
});

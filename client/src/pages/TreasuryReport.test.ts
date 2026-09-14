import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./TreasuryReport.tsx", import.meta.url),
  "utf8",
);

describe("عقد صدق تصدير كشف الخزينة", () => {
  it("يصرّح بأن ملف Excel يضم الصفوف المعروضة فقط عند اقتطاع الكشف", () => {
    expect(source).toContain("التصدير يشمل المعروض فقط");
    expect(source).not.toContain("صدّر Excel للتفصيل الكامل");
  });
});

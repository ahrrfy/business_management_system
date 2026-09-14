import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./TreasuryReport.tsx", import.meta.url),
  "utf8",
);

describe("عقد صدق تصدير كشف الخزينة", () => {
  it("يجلب ملف Excel من مسار التصدير الكامل ولا يصفه بالمعروض فقط", () => {
    expect(source).toContain("treasuryStatementExport.fetch");
    expect(source).toContain("تصدير Excel يجلب الحركات كلّها");
    expect(source).not.toContain("التصدير يشمل المعروض فقط");
  });
});

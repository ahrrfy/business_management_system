import { describe, expect, it } from "vitest";
import { clampDoubleEntryReportPeriod } from "./doubleEntryReportPeriod";

describe("clampDoubleEntryReportPeriod", () => {
  it("يبقي الفترة الواقعة بالكامل ضمن تغطية دورة الدفتر", () => {
    const period = {
      from: "2026-08-12",
      to: "2026-08-31",
      preset: "custom" as const,
    };
    expect(clampDoubleEntryReportPeriod(period, "2026-08-11")).toBe(period);
  });

  it("يرفع البداية إلى تاريخ القطع ولا يغيّر نهاية صالحة", () => {
    expect(
      clampDoubleEntryReportPeriod(
        { from: "2026-08-01", to: "2026-08-31", preset: "mtd" },
        "2026-08-11",
      ),
    ).toEqual({ from: "2026-08-11", to: "2026-08-31", preset: "custom" });
  });

  it("يرفع الطرفين إذا كانت الفترة كلها قبل تاريخ القطع", () => {
    expect(
      clampDoubleEntryReportPeriod(
        { from: "2026-07-01", to: "2026-07-31", preset: "lastMonth" },
        "2026-08-11",
      ),
    ).toEqual({ from: "2026-08-11", to: "2026-08-11", preset: "custom" });
  });
});

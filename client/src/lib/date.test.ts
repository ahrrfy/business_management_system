import { describe, expect, it } from "vitest";
import { fmtDate, fmtDateRange, fmtDateTime, fmtTime } from "./date";

describe("date display formatting", () => {
  const date = new Date(2026, 6, 25, 15, 17);

  it("uses an unambiguous fixed-width date and 24-hour time", () => {
    expect(fmtDate(date)).toBe("25/07/2026");
    expect(fmtTime(date)).toBe("15:17");
    expect(fmtDateTime(date)).toBe("25/07/2026، 15:17");
  });

  it("does not emit bidi controls that can reorder dates in RTL tables", () => {
    expect(fmtDateTime(date)).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(fmtDateTime(date)).not.toMatch(/[٠-٩]/u);
  });

  it("keeps date-only inputs on their calendar day and handles empty values", () => {
    expect(fmtDate("2026-07-05")).toBe("05/07/2026");
    expect(fmtDateRange("2026-07-05", "2026-07-25")).toBe("05/07/2026 — 25/07/2026");
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDate("not-a-date")).toBe("—");
  });
});

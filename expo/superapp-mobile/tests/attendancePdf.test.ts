import { describe, expect, it } from "vitest";

import { buildAttendancePdfHtml } from "../lib/attendancePdf";

describe("personal attendance PDF", () => {
  it("escapes employee-controlled strings and never includes excluded compensation fields", () => {
    const html = buildAttendancePdfHtml({
      employeeName: "موظف <script>alert(1)</script>",
      history: {
        range: { from: "2026-08-11", to: "2026-09-10" },
        personal: {
          state: "READY",
          entries: [{
            date: "2026-09-10",
            checkIn: "2026-09-10T06:00:00.000Z",
            checkOut: null,
            status: "PRESENT",
            hours: "8.00",
            state: "RECORDED",
          }],
        },
      },
    });

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("8.00");
    expect(html).not.toMatch(/[٠-٩]/);
    expect(html).not.toMatch(/hourlyRate|salary|deduction|allowance/i);
  });
});

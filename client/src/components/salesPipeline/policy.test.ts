import { describe, expect, it, vi } from "vitest";
import { isLeadOverdue, isOpportunityOverdue, pipelineDate } from "./policy";

describe("sales pipeline UI policy", () => {
  it("does not label terminal records overdue", () => {
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    expect(isLeadOverdue("CONVERTED", "2026-08-01T00:00:00.000Z")).toBe(false);
    expect(isOpportunityOverdue("LOST", "2026-08-01")).toBe(false);
  });

  it("detects open overdue follow-ups and close dates", () => {
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    expect(isLeadOverdue("CONTACTED", "2026-08-30T12:00:00.000Z")).toBe(true);
    expect(isOpportunityOverdue("NEGOTIATION", "2026-08-30")).toBe(true);
  });

  it("formats with latin digits under the Iraqi locale", () => {
    expect(pipelineDate("2026-08-31T00:00:00.000Z")).toMatch(/2026/);
  });
});
